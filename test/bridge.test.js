// Tests for agent-server.js and lwagent-cli.js against a FAKE extension.
//
// No browser is involved. The fake speaks raw RFC-6455 frames (masked, as a
// real browser client must) over a plain TCP socket, so the bridge's own
// handshake and framing code is what gets exercised.
//
// Run: node --test test/
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, execFile } = require('node:child_process');
const net = require('node:net');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PORT = 20000 + Math.floor(Math.random() * 20000);   // never the real 8844
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lwagent-test-'));
const LOG = path.join(TMP, 'console.jsonl');
const ENV = { ...process.env, LWAGENT_PORT: String(PORT), LWAGENT_LOG: LOG };

let server;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function health() {
  return (await fetch(`http://127.0.0.1:${PORT}/health`)).json();
}

function cli(args) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    execFile('node', [path.join(ROOT, 'lwagent-cli.js'), ...args], { env: ENV },
      (err, stdout, stderr) => resolve({
        code: err ? err.code : 0, stdout, stderr, ms: Date.now() - t0,
      }));
  });
}

// ---- a fake extension: client side of RFC 6455 ---------------------------

function maskedFrame(str) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) { header = Buffer.alloc(2); header[1] = 0x80 | len; }
  else if (len < 65536) { header = Buffer.alloc(4); header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2); }
  header[0] = 0x81;
  const mask = crypto.randomBytes(4);
  const body = Buffer.from(payload);
  for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
  return Buffer.concat([header, mask, body]);
}

// Server->client frames are unmasked.
function readFrames(buf) {
  const out = [];
  let off = 0;
  for (;;) {
    if (buf.length - off < 2) break;
    let len = buf[off + 1] & 0x7f, p = off + 2;
    if (len === 126) { if (buf.length - p < 2) break; len = buf.readUInt16BE(p); p += 2; }
    else if (len === 127) { if (buf.length - p < 8) break; len = Number(buf.readBigUInt64BE(p)); p += 8; }
    if (buf.length - p < len) break;
    out.push({ opcode: buf[off] & 0x0f, text: buf.subarray(p, p + len).toString('utf8') });
    off = p + len;
  }
  return { frames: out, rest: buf.subarray(off) };
}

// handler(msg) -> result object, like background.js's handle()
function fakeExtension(handler) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const expect = crypto.createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    const s = net.connect(PORT, '127.0.0.1');
    let buf = Buffer.alloc(0), upgraded = false;
    s.on('error', reject);
    s.on('connect', () => s.write(
      `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\nUpgrade: websocket\r\n` +
      `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`));
    s.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!upgraded) {
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        const head = buf.subarray(0, end).toString();
        buf = buf.subarray(end + 4);
        upgraded = true;
        resolve({ socket: s, head, expect });
      }
      const { frames, rest } = readFrames(buf);
      buf = rest;
      for (const f of frames) {
        if (f.opcode !== 1) continue;
        const msg = JSON.parse(f.text);
        s.write(maskedFrame(JSON.stringify({ id: msg.id, ...handler(msg) })));
      }
    });
  });
}

const BIG = 'x'.repeat(70 * 1024);   // > 65535: the 64-bit length path

const handler = (msg) => {
  if (msg.action === 'ping') return { ok: true };
  if (msg.action === 'tabs') {
    return { tabs: [
      { id: 7, url: 'https://example.com/', title: 'Example', active: true, pinned: false, discarded: false },
      { id: 9, url: 'https://example.org/', title: 'Other', active: false, pinned: true, discarded: true },
    ] };
  }
  if (msg.action === 'eval') {
    if (msg.expr === 'big') return { value: BIG };
    return { value: `tab=${msg.tabId} expr=${msg.expr.length}` };
  }
  return { error: `unknown action: ${msg.action}` };
};

before(async () => {
  server = spawn('node', [path.join(ROOT, 'agent-server.js')], { env: ENV, stdio: ['ignore', 'ignore', 'pipe'] });
  for (let i = 0; i < 50; i++) {
    try { await health(); return; } catch { await sleep(100); }
  }
  throw new Error('bridge did not start');
});

after(() => {
  server.kill();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('no extension: health says disconnected and the CLI exits 2', async () => {
  assert.equal((await health()).connected, false);
  const r = await cli(['tabs']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /not connected/);
});

test('websocket path: handshake, round trips, large frames, disconnect', async () => {
  const ext = await fakeExtension(handler);
  assert.match(ext.head, /^HTTP\/1\.1 101/);
  assert.ok(ext.head.includes(`Sec-WebSocket-Accept: ${ext.expect}`), 'accept key');
  await sleep(50);
  const h = await health();
  assert.equal(h.connected, true);
  assert.equal(h.transport, 'websocket');

  const tabs = await cli(['tabs']);
  assert.equal(tabs.code, 0, tabs.stderr);
  assert.match(tabs.stdout, /^\s+7\s+\*\s+https:\/\/example\.com\//m);
  assert.match(tabs.stdout, /^\s+9\s+ Pz https:\/\/example\.org\//m);

  // client -> server: 70 KB masked frame, 64-bit length
  const big = await cli(['eval', 'big']);
  assert.equal(big.code, 0, big.stderr);
  assert.equal(big.stdout.trim(), BIG);

  // server -> client: 70 KB command, and a 16-bit-length one
  for (const n of [70 * 1024, 1000]) {
    const r = await cli(['eval', '--tab=42', 'y'.repeat(n)]);
    assert.equal(r.stdout.trim(), `tab=42 expr=${n}`);
  }

  // Peer sends FIN: health must flip and the CLI must fail fast, not hang
  // until the 20 s command timeout.
  ext.socket.end();
  await sleep(100);
  assert.equal((await health()).connected, false);
  const r = await cli(['ping']);
  assert.equal(r.code, 2);
  assert.ok(r.ms < 2000, `CLI took ${r.ms} ms`);
});

test('a request carrying an Origin header (a web page) is refused', async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/cmd`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', Origin: 'https://evil.example' },
    body: JSON.stringify({ action: 'eval', expr: '1' }),
  });
  assert.equal(res.status, 403);
});

test('HTTP long-poll fallback carries a command and its result', async () => {
  // Hold a poll open the way background.js does when ws:// will not open.
  const poll = fetch(`http://127.0.0.1:${PORT}/ext/poll`).then((r) => r.json());
  await sleep(50);
  assert.equal((await health()).transport, 'longpoll');
  const cmd = fetch(`http://127.0.0.1:${PORT}/cmd`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'eval', expr: 'document.title' }),
  }).then((r) => r.json());
  const msg = await poll;
  assert.equal(msg.action, 'eval');
  await fetch(`http://127.0.0.1:${PORT}/ext/result`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: msg.id, value: 'Example Domain' }),
  });
  const out = await cmd;
  assert.equal(out.value, 'Example Domain');
});

test('capture events land in the JSONL log and the CLI reads them', async () => {
  const events = [
    { type: 'request', tabId: 7, method: 'GET', url: 'https://example.com/app.js' },
    { type: 'loading_failed', tabId: 7, url: 'https://example.com/widget.js', error: 'NS_ERROR_ABORT' },
    { type: 'response_body', tabId: 7, url: 'https://example.com/api/items', contentType: 'application/json', bytes: 11, truncated: false, text: '{"items":1}' },
  ];
  for (const e of events) {
    await fetch(`http://127.0.0.1:${PORT}/ext/event`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ts: new Date().toISOString(), ...e }),
    });
  }
  assert.equal(fs.readFileSync(LOG, 'utf8').trim().split('\n').length, 3);

  const log = await cli(['log', 'loading_failed']);
  assert.equal(log.code, 0);
  assert.match(log.stdout, /loading_failed\s+NS_ERROR_ABORT https:\/\/example\.com\/widget\.js/);
  assert.doesNotMatch(log.stdout, /app\.js/);

  const body = await cli(['body', 'api/items']);
  assert.equal(body.code, 0);
  assert.equal(body.stdout.trim(), '{"items":1}');
});
