#!/usr/bin/env node
// CLI for the lwagent extension. Talks to agent-server.js, which pushes the
// command down the WebSocket the extension holds open.
//
//   lwagent-cli tabs
//   lwagent-cli eval "document.title"
//   lwagent-cli eval --tab=42 "location.href"
//   lwagent-cli text                      # readable text of the active tab
//   lwagent-cli capture_start --tab=42    # console + network -> console.jsonl
//   lwagent-cli capture_stop  --tab=42
//   lwagent-cli captures                  # what is being captured
//   lwagent-cli log [pattern]             # tail/grep the capture log
//   lwagent-cli patch_set --rules='[{"match":"/api","headers":{"X-T":"1"}}]'
//   lwagent-cli patch_clear
//   lwagent-cli patches
//
// Requires: the bridge running (agent-server.js) and the toolbar
// toggle ON. Both are deliberate — default state is a browser that no site
// can distinguish from a stock one.

'use strict';
const PORT = Number(process.env.LWAGENT_PORT || 8844);
const os = require('os'), path = require('path'), fs = require('fs');
const LOG = process.env.LWAGENT_LOG ||
  path.join(os.homedir(), '.cache', 'lwagent', 'console.jsonl');

const argv = process.argv.slice(2);
const action = argv.shift();
let tabId, rules, world, frames = false;
const rest = [];
for (const a of argv) {
  const mt = /^--tab=(\d+)$/.exec(a);
  const mr = /^--rules=([\s\S]*)$/.exec(a);
  const mw = /^--world=(main|isolated)$/i.exec(a);
  if (mt) tabId = Number(mt[1]);
  else if (mr) rules = mr[1];
  else if (mw) world = mw[1];
  else if (a === '--frames') frames = true;   // read child frames too, one result each
  else rest.push(a);
}

if (!action || action === '-h' || action === '--help') {
  console.log('usage: lwagent-cli <tabs|eval|text|ping|capture_start|capture_stop|captures|log|body|patch_set|patch_clear|patches> [--tab=<id>] [--frames] [--rules=<json>] [expr]');
  process.exit(action ? 0 : 1);
}

// `body <url-substring>` prints the full captured response text; `log` only
// ever shows its size, because one body can be half a megabyte.
if (action === 'body') {
  let lines = [];
  try { lines = fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean); }
  catch { console.error(`lwagent: no capture log at ${LOG}`); process.exit(1); }
  const needle = rest.join(' ');
  if (!needle) { console.error('usage: lwagent body <url-substring>'); process.exit(1); }
  const hits = lines
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((e) => e && e.type === 'response_body' && (e.url || '').includes(needle));
  if (!hits.length) { console.error(`lwagent: no captured body matching "${needle}"`); process.exit(1); }
  const e = hits[hits.length - 1];          // most recent wins
  if (hits.length > 1) console.error(`# ${hits.length} matches, showing the newest`);
  console.error(`# ${e.url}\n# ${e.contentType} ${e.bytes}B${e.truncated ? ' (truncated)' : ''}\n`);
  console.log(e.text);
  process.exit(0);
}

if (action === 'log') {
  let lines = [];
  try { lines = fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean); }
  catch { console.error(`lwagent: no capture log at ${LOG}`); process.exit(1); }
  const pat = rest.join(' ');
  const re = pat ? new RegExp(pat, 'i') : null;
  for (const l of lines.slice(-500)) {
    if (re && !re.test(l)) continue;
    let e; try { e = JSON.parse(l); } catch { continue; }
    if (tabId && e.tabId !== tabId) continue;
    const t = (e.ts || '').slice(11, 19);
    const tag = e.level ? `${e.type}/${e.level}` : e.type;
    const detail = e.type === 'response_body'
      ? `${e.bytes}B ${e.truncated ? '(truncated) ' : ''}${e.contentType || ''} ${e.url || ''}`
      : (e.text || `${e.status || e.error || e.method || ''} ${e.url || ''}`.trim());
    console.log(`${t} ${String(tag).padEnd(18)} ${String(detail).slice(0, 200)}`);
  }
  process.exit(0);
}

async function post(path, body) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

(async () => {
  try {
    const health = await fetch(`http://127.0.0.1:${PORT}/health`).then((r) => r.json());
    if (!health.connected) {
      console.error('lwagent: bridge is up but the extension is not connected.');
      console.error('         Click the lwagent toolbar button to toggle agent access ON.');
      process.exit(2);
    }
  } catch {
    console.error(`lwagent: no bridge on 127.0.0.1:${PORT}.`);
    console.error('         Start it: node agent-server.js &  (from this repo)');
    process.exit(2);
  }

  const out = await post('/cmd', { action, tabId, rules, world, frames, expr: rest.join(' ') });

  if (out.error) { console.error('error:', out.error); process.exit(1); }
  if (out.tabs) {
    for (const t of out.tabs) {
      const flags = `${t.active ? '*' : ' '}${t.pinned ? 'P' : ' '}${t.discarded ? 'z' : ' '}`;
      console.log(`${String(t.id).padStart(4)}  ${flags} ${t.url}\t${t.title || ''}`);
    }
    return;
  }
  if (out.frames) {
    for (const f of out.frames) {
      const tag = `# frame ${f.frameId}${f.world ? ' [' + f.world + ']' : ''}`;
      if (f.text !== undefined) console.log(`${tag} ${f.url}\n# ${f.title || ''}\n\n${f.text}\n`);
      else if (f.error) console.log(`${tag}  error: ${f.error}`);
      else console.log(`${tag}  ${typeof f.value === 'string' ? f.value : JSON.stringify(f.value)}`);
    }
    return;
  }
  if (out.text !== undefined) {
    console.log(`# ${out.title}\n# ${out.url}\n`);
    console.log(out.text);
    return;
  }
  if (out.rules !== undefined) { console.log(JSON.stringify(out.rules, null, 2)); return; }
  if (out.note) console.error('# ' + out.note);
  if ('value' in out) { console.log(typeof out.value === 'string' ? out.value : JSON.stringify(out.value, null, 2)); return; }
  console.log(JSON.stringify(out, null, 2));
})();
