#!/usr/bin/env node
// Bridge between a CLI (an agent, or you) and the lwagent browser extension.
//
// Why this exists instead of --remote-debugging-port: opening the BiDi port
// sets navigator.webdriver = true on every page, with no client attached and
// no pref to suppress it, so Akamai/PerimeterX/Cloudflare challenge ordinary
// browsing. An extension is in-browser, needs no port, and leaves the browser
// indistinguishable from a normal one. See README.md.
//
// The extension cannot listen on a socket, so it dials out: background.js
// holds a WebSocket to /ws here, and commands are pushed down it. No polling.
//
// Raw RFC-6455 implementation on purpose -- no `ws` dependency, so this stays
// a single file with nothing to install.

'use strict';
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = Number(process.env.LWAGENT_PORT || 8844);
const LOG = process.env.LWAGENT_LOG ||
  path.join(os.homedir(), '.cache', 'lwagent', 'console.jsonl');
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

let sock = null;              // the one connected extension
let nextId = 1;
const pending = new Map();    // id -> {resolve, timer}

// ---------------------------------------------------------------- framing --

function encodeFrame(str) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x81; // FIN + text
  return Buffer.concat([header, payload]);
}

// Returns [{opcode, payload}], leaving any partial frame in the returned rest.
function decodeFrames(buf) {
  const out = [];
  let off = 0;
  for (;;) {
    if (buf.length - off < 2) break;
    const b0 = buf[off], b1 = buf[off + 1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let p = off + 2;
    if (len === 126) {
      if (buf.length - p < 2) break;
      len = buf.readUInt16BE(p); p += 2;
    } else if (len === 127) {
      if (buf.length - p < 8) break;
      len = Number(buf.readBigUInt64BE(p)); p += 8;
    }
    let mask = null;
    if (masked) {
      if (buf.length - p < 4) break;
      mask = buf.subarray(p, p + 4); p += 4;
    }
    if (buf.length - p < len) break;
    const payload = Buffer.from(buf.subarray(p, p + len));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    out.push({ opcode, payload });
    off = p + len;
  }
  return { frames: out, rest: buf.subarray(off) };
}

// ------------------------------------------------------------------ bridge --

// Two transports. WebSocket is preferred, but an MV3 extension can fail to
// open ws:// for reasons that are hard to see from outside, so there is also
// an HTTP long-poll path: the extension GETs /ext/poll and the request is held
// until a command exists. Whichever the extension uses, `command()` is the same.
const queue = [];          // commands waiting for a long-poll to collect
let waiter = null;         // the held /ext/poll response, if any
let lastPollAt = 0;

function extConnected() {
  if (sock && !sock.destroyed) return true;
  return Date.now() - lastPollAt < 40000;   // a poller is alive
}

function dispatch(obj) {
  if (sock && !sock.destroyed) { sock.write(encodeFrame(JSON.stringify(obj))); return; }
  if (waiter) { const w = waiter; waiter = null; clearTimeout(w.timer); w.send(obj); return; }
  queue.push(obj);
}

function command(payload, timeoutMs = 20000) {
  return new Promise((resolve) => {
    if (!extConnected()) {
      return resolve({ error: 'extension not connected -- is the toolbar toggle on?' });
    }
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ error: `timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    pending.set(id, { resolve, timer });
    dispatch({ id, ...payload });
  });
}

function settle(msg) {
  const slot = pending.get(msg.id);
  if (slot) { clearTimeout(slot.timer); pending.delete(msg.id); slot.resolve(msg); }
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
  });
}

// -------------------------------------------------------------------- http --

const server = http.createServer(async (req, res) => {
  const json = (code, obj) => {
    const body = JSON.stringify(obj);
    // Same-origin is irrelevant here (localhost CLI), but be explicit.
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  };

  if (req.method === 'GET' && req.url === '/health') {
    return json(200, {
      ok: true,
      connected: extConnected(),
      transport: sock && !sock.destroyed ? 'websocket' : (Date.now() - lastPollAt < 40000 ? 'longpoll' : null),
    });
  }
  if (req.method === 'POST' && req.url === '/cmd') {
    // The CLI sends no Origin header; a browser always does. Without this,
    // any web page open in the browser could POST here (a text/plain POST
    // needs no CORS preflight) and run eval in another tab while the toggle
    // is on.
    if (req.headers.origin) return json(403, { error: 'requests from a web page are refused' });
    const body = await readBody(req);
    if (!body.action) return json(400, { error: 'missing action' });
    return json(200, await command(body));
  }

  // --- HTTP long-poll transport, for when the extension cannot open ws:// ---
  if (req.method === 'GET' && req.url === '/ext/poll') {
    lastPollAt = Date.now();
    if (queue.length) return json(200, queue.shift());
    if (waiter) { clearTimeout(waiter.timer); waiter.send(null); }  // only one holder
    let answered = false;
    const send = (obj) => { answered = true; lastPollAt = Date.now(); json(200, obj || {}); };
    const timer = setTimeout(() => { if (waiter && waiter.send === send) waiter = null; send(null); }, 25000);
    waiter = { send, timer };
    req.on('close', () => {
      if (waiter && waiter.send === send) { clearTimeout(timer); waiter = null; }
      // Closed while we were still holding it => the extension went away.
      // Without this the 40s grace window keeps reporting it connected and
      // commands queue up for a client that is never coming back.
      if (!answered) { lastPollAt = 0; queue.length = 0; }
    });
    return;
  }
  if (req.method === 'POST' && req.url === '/ext/result') {
    lastPollAt = Date.now();
    settle(await readBody(req));
    return json(200, { ok: true });
  }

  // Capture events from the extension. JSONL on purpose: it grows without
  // bound during a capture, so it is meant to be grepped and tailed, never
  // loaded whole.
  if (req.method === 'POST' && req.url === '/ext/event') {
    const ev = await readBody(req);
    try {
      fs.mkdirSync(path.dirname(LOG), { recursive: true });
      fs.appendFileSync(LOG, JSON.stringify(ev) + '\n');
    } catch (e) {
      console.error('lwagent: cannot write', LOG, e.message);
    }
    return json(200, { ok: true });
  }

  json(404, { error: 'not found' });
});

// WebSocket upgrade — the extension connects here and stays connected.
server.on('upgrade', (req, socket) => {
  if (!req.url.startsWith('/ws')) return socket.destroy();
  const key = req.headers['sec-websocket-key'];
  if (!key) return socket.destroy();
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );

  if (sock && !sock.destroyed) sock.destroy();   // only one extension at a time
  sock = socket;
  console.error('lwagent: extension connected');

  let buf = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    const { frames, rest } = decodeFrames(buf);
    buf = rest;
    for (const f of frames) {
      if (f.opcode === 0x8) { socket.destroy(); return; }        // close
      if (f.opcode === 0x9) { socket.write(Buffer.from([0x8a, 0])); continue; } // ping->pong
      if (f.opcode !== 0x1) continue;
      let msg;
      try { msg = JSON.parse(f.payload.toString('utf8')); } catch { continue; }
      settle(msg);
    }
  });
  const drop = () => {
    if (sock === socket) { sock = null; console.error('lwagent: extension disconnected'); }
    if (!socket.destroyed) socket.destroy();
  };
  // 'end' matters: when the browser goes away the peer sends FIN and Node
  // emits 'end', not 'close'. Without this the socket sits in CLOSE-WAIT and
  // /health keeps claiming the extension is connected, so every command
  // blocks until its timeout instead of failing immediately.
  socket.on('end', drop);
  socket.on('close', drop);
  socket.on('error', drop);
});

server.listen(PORT, '127.0.0.1', () => {
  console.error(`lwagent: bridge on 127.0.0.1:${PORT} — waiting for the extension`);
});
