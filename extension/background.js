// lwagent — toolbar toggle for local agent access.
//
// OFF by default and inert: no WebSocket, no listeners, no content scripts.
// Clicking the toolbar button connects to the local bridge (agent-server.js)
// and allows commands until you click it off again.
//
// The whole point of this over --remote-debugging-port is that nothing here
// is observable by a page: navigator.webdriver stays false, so Akamai /
// PerimeterX / Cloudflare treat the browser as an ordinary one.

// MV2 exposes browserAction, MV3 exposes action. Shim so this file works under both.
const action = (typeof browser !== 'undefined' && (browser.action || browser.browserAction)) || null;

const BRIDGE = 'ws://127.0.0.1:8844/ws';
const HTTP = 'http://127.0.0.1:8844';
const RETRY_MS = 3000;
const WS_FAILS_BEFORE_FALLBACK = 2;

// Under MV2 these come with the install. Kept as a safety net in case the
// manifest ever goes back to MV3, where origin controls mean host_permissions
// are not granted until the user agrees.
const BRIDGE_ORIGINS = ['ws://127.0.0.1/*', 'http://127.0.0.1/*'];

let enabled = false;
let ws = null;
let retry = null;
let lastError = '';
let wsFails = 0;
let polling = false;   // using the HTTP long-poll fallback

// ------------------------------------------------------------------- state --

async function ensurePermissions() {
  // Under MV2 these are granted at install, so never block on the check --
  // only ask if the browser says we are actually missing them.
  try {
    if (await browser.permissions.contains({ origins: BRIDGE_ORIGINS })) return true;
  } catch {
    return true;   // API unavailable or pattern unsupported: proceed anyway
  }
  try {
    return await browser.permissions.request({ origins: BRIDGE_ORIGINS });
  } catch (e) {
    console.warn('lwagent: permission request failed, continuing:', (e && e.message) || e);
    return true;
  }
}

async function setEnabled(on) {
  if (on && !(await ensurePermissions())) {
    lastError = lastError || 'localhost permission denied';
    enabled = false;
    await paint();
    return;
  }
  enabled = on;
  lastError = '';
  await browser.storage.local.set({ enabled: on });
  await paint();
  if (on) connect(); else disconnect();
}

async function paint() {
  const connected = (ws && ws.readyState === WebSocket.OPEN) || polling;
  const how = polling ? ' via http' : '';
  const state = !enabled ? 'OFF'
    : connected ? `ON${how}`
    : `ON (bridge down${lastError ? ': ' + lastError : ''})`;
  await action.setTitle({ title: `lwagent: agent access ${state}` });
  await action.setBadgeText({ text: !enabled ? '' : connected ? 'on' : '...' });
  await action.setBadgeBackgroundColor({
    color: connected ? '#4c9a2a' : '#a05a00',
  });
}

// ------------------------------------------------------------------ bridge --

function connect() {
  if (!enabled || (ws && ws.readyState <= WebSocket.OPEN)) return;
  clearTimeout(retry);
  try {
    ws = new WebSocket(BRIDGE);
  } catch (e) {
    lastError = String((e && e.message) || e);
    console.error('lwagent: WebSocket ctor failed:', lastError);
    paint();
    retry = setTimeout(connect, RETRY_MS);
    return;
  }
  ws.onopen = () => { lastError = ''; console.log('lwagent: bridge connected'); paint(); };
  ws.onclose = (ev) => {
    ws = null;
    if (ev && ev.code !== 1000 && !lastError) lastError = `closed (code ${ev.code})`;
    console.warn('lwagent: bridge closed', ev && ev.code, lastError);
    paint();
    if (!enabled) return;
    // If ws:// simply will not open here, stop fighting it and long-poll.
    if (++wsFails >= WS_FAILS_BEFORE_FALLBACK) {
      console.warn('lwagent: falling back to HTTP long-poll');
      startPolling();
      return;
    }
    retry = setTimeout(connect, RETRY_MS);
  };
  ws.onerror = () => {
    lastError = 'cannot reach ' + BRIDGE;
    console.error('lwagent:', lastError, '-- is agent-server.js running, and is the localhost permission granted?');
    paint();
  };
  ws.onmessage = async (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    let result;
    try {
      result = await handle(msg);
    } catch (e) {
      result = { error: String((e && e.message) || e) };
    }
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ id: msg.id, ...result }));
    }
  };
}

function disconnect() {
  clearTimeout(retry);
  polling = false;
  wsFails = 0;
  // Toggling off has to leave the browser exactly as it found it.
  captures.clear();
  patchRules = [];
  unwireIfIdle();
  if (ws) { try { ws.close(); } catch {} ws = null; }
  paint();
}

// HTTP long-poll fallback: hold a GET open until the bridge hands us a
// command, run it, POST the result, repeat. Same command surface as the
// socket, just a different pipe.
async function startPolling() {
  if (polling) return;
  polling = true;
  lastError = '';
  paint();
  while (enabled && polling) {
    let msg = null;
    try {
      const res = await fetch(`${HTTP}/ext/poll`, { cache: 'no-store' });
      msg = await res.json();
    } catch (e) {
      lastError = 'cannot reach ' + HTTP;
      polling = false;
      paint();
      if (enabled) retry = setTimeout(() => { wsFails = 0; connect(); }, RETRY_MS);
      return;
    }
    if (!msg || !msg.action) continue;      // 25s idle turnaround
    let result;
    try { result = await handle(msg); }
    catch (e) { result = { error: String((e && e.message) || e) }; }
    try {
      await fetch(`${HTTP}/ext/result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: msg.id, ...result }),
      });
    } catch { /* next poll will re-establish */ }
  }
}

// ----------------------------------------------------------------- capture --
//
// Capture is per-tab and only runs while the toggle is on AND that tab has
// been explicitly started. Nothing is hooked otherwise -- a page can detect a
// wrapped console, so the default state has to stay untouched.

const captures = new Map();       // tabId -> { startedAt, url }
let patchRules = [];              // see patch_set
const wired = [];                 // {event, fn} so they can be removed again
let webRequestWired = false;

const BODY_CAP = 512 * 1024;      // tee at most this much per response
const TEXTUAL = /^(text\/|application\/(json|javascript|x-javascript|xml|xhtml))/i;

function anyActive() { return captures.size > 0 || patchRules.length > 0; }

function findRule(url) {
  return patchRules.find((r) => r && r.match && url.includes(r.match));
}

function headerValue(headers, name) {
  const h = (headers || []).find((x) => x.name.toLowerCase() === name);
  return h ? h.value : '';
}

// requestBody is READ-ONLY here, but readable -- which BiDi cannot do at all
// (postData() throws UnsupportedOperation). Rewriting it is the one thing
// a WebDriver BiDi session can still do that this cannot.
function readRequestBody(rb) {
  if (!rb) return null;
  if (rb.formData) return rb.formData;
  if (rb.raw && rb.raw.length) {
    try {
      const dec = new TextDecoder('utf-8', { fatal: false });
      return rb.raw.map((p) => (p.bytes ? dec.decode(p.bytes) : '')).join('').slice(0, 8000);
    } catch { return '<unreadable>'; }
  }
  return null;
}

function postEvent(ev) {
  const body = JSON.stringify({ ts: new Date().toISOString(), ...ev });
  fetch(`${HTTP}/ext/event`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
  }).catch(() => { /* the bridge may be down; events are best-effort */ });
}

function on(event, fn, extra) {
  const filter = { urls: ['<all_urls>'] };
  // Passing an undefined extraInfoSpec is NOT the same as omitting it --
  // onCompleted/onErrorOccurred reject it with "Incorrect argument types",
  // which silently cost us every loading_failed event.
  if (extra) event.addListener(fn, filter, extra);
  else event.addListener(fn, filter);
  wired.push({ event, fn });
}

// Blocking listeners on <all_urls> cost something on every page load across
// the whole browser, so they are only installed while a capture or a patch
// rule is actually live, and torn down again the moment nothing is.
const WIRE_COUNT = 5;

function wireWebRequest() {
  if (webRequestWired || !anyActive()) return;
  webRequestWired = true;
  try {
    wireAll();
  } catch (e) {
    // Half-wired is worse than not wired: capture would look armed and drop
    // whole event classes. Tear down and surface it.
    console.error('lwagent: wiring failed, tearing down:', (e && e.message) || e);
    for (const { event, fn } of wired) { try { event.removeListener(fn); } catch {} }
    wired.length = 0;
    webRequestWired = false;
    throw e;
  }
  if (wired.length !== WIRE_COUNT) {
    console.error(`lwagent: expected ${WIRE_COUNT} listeners, got ${wired.length}`);
  }
}

function wireAll() {

  on(browser.webRequest.onBeforeRequest, (d) => {
    const rule = findRule(d.url);
    if (rule && rule.drop) {
      postEvent({ type: 'modified', action: 'drop', tabId: d.tabId, url: d.url });
      return { cancel: true };
    }
    if (rule && rule.redirect) {
      postEvent({
        type: 'modified', action: 'redirect', tabId: d.tabId, url: d.url, to: rule.redirect,
        note: d.method !== 'GET' ? `method was ${d.method}; a redirect makes it GET and drops the body` : undefined,
      });
      return { redirectUrl: rule.redirect };
    }
    if (captures.has(d.tabId)) {
      postEvent({
        type: 'request', tabId: d.tabId, method: d.method, url: d.url,
        resourceType: d.type, postData: readRequestBody(d.requestBody),
      });
    }
  }, ['blocking', 'requestBody']);

  on(browser.webRequest.onBeforeSendHeaders, (d) => {
    const rule = findRule(d.url);
    if (!rule || !rule.headers) return;
    // Merge into the real headers -- replacing the set wholesale would strip
    // Cookie/Authorization and silently change what the site sees.
    const headers = (d.requestHeaders || []).slice();
    for (const [name, value] of Object.entries(rule.headers)) {
      const i = headers.findIndex((h) => h.name.toLowerCase() === name.toLowerCase());
      if (i >= 0) headers[i] = { name: headers[i].name, value: String(value) };
      else headers.push({ name, value: String(value) });
    }
    postEvent({ type: 'modified', action: 'headers', tabId: d.tabId, url: d.url, headers: rule.headers });
    return { requestHeaders: headers };
  }, ['blocking', 'requestHeaders']);

  // Content-Type is only known here, which is why the body tee attaches at
  // this stage rather than onBeforeRequest.
  on(browser.webRequest.onHeadersReceived, (d) => {
    const rule = findRule(d.url);
    const ct = headerValue(d.responseHeaders, 'content-type');

    if (rule && rule.respBody !== undefined) {
      replaceBody(d, rule.respBody);
      postEvent({ type: 'modified', action: 'respBody', tabId: d.tabId, url: d.url });
    } else if (captures.has(d.tabId) && d.statusCode !== 204 && TEXTUAL.test(ct)) {
      teeBody(d, ct);
    }

    if (rule && rule.respHeaders) {
      const headers = (d.responseHeaders || []).slice();
      for (const [name, value] of Object.entries(rule.respHeaders)) {
        const i = headers.findIndex((h) => h.name.toLowerCase() === name.toLowerCase());
        if (i >= 0) headers[i] = { name: headers[i].name, value: String(value) };
        else headers.push({ name, value: String(value) });
      }
      postEvent({ type: 'modified', action: 'respHeaders', tabId: d.tabId, url: d.url });
      return { responseHeaders: headers };
    }
  }, ['blocking', 'responseHeaders']);

  on(browser.webRequest.onCompleted, (d) => {
    if (!captures.has(d.tabId)) return;
    postEvent({
      type: 'response', tabId: d.tabId, url: d.url,
      status: d.statusCode, notable: d.statusCode >= 400, resourceType: d.type,
    });
  });

  // The one that matters for "something isn't loading" -- a request blocked
  // by uBlock or Pi-hole shows up here and produces NO console error at all.
  on(browser.webRequest.onErrorOccurred, (d) => {
    if (!captures.has(d.tabId)) return;
    postEvent({ type: 'loading_failed', tabId: d.tabId, url: d.url, error: d.error, resourceType: d.type });
  });
}

function unwireIfIdle() {
  if (anyActive() || !webRequestWired) return;
  for (const { event, fn } of wired) {
    try { event.removeListener(fn); } catch {}
  }
  wired.length = 0;
  webRequestWired = false;
}

// Copy the body through while keeping at most BODY_CAP of it. Always write
// every chunk straight back -- withholding bytes stalls the page.
function teeBody(d, ct) {
  let filter;
  try { filter = browser.webRequest.filterResponseData(d.requestId); }
  catch (e) {
    postEvent({ type: 'response_body_unavailable', tabId: d.tabId, url: d.url, error: String(e.message || e) });
    return;
  }
  const chunks = [];
  let total = 0, truncated = false;
  filter.ondata = (e) => {
    filter.write(e.data);
    if (total < BODY_CAP) { chunks.push(new Uint8Array(e.data)); total += e.data.byteLength; }
    else truncated = true;
  };
  filter.onstop = () => {
    filter.close();
    let text;
    try {
      const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
      let off = 0;
      for (const c of chunks) { all.set(c, off); off += c.length; }
      // Decode once over the whole buffer: a multibyte char can straddle a chunk.
      text = new TextDecoder('utf-8', { fatal: false }).decode(all);
    } catch (e) {
      postEvent({ type: 'response_body_unavailable', tabId: d.tabId, url: d.url, error: String(e.message || e) });
      return;
    }
    postEvent({
      type: 'response_body', tabId: d.tabId, url: d.url,
      contentType: ct, bytes: total, truncated, text: text.slice(0, BODY_CAP),
    });
  };
  filter.onerror = () => postEvent({
    type: 'response_body_unavailable', tabId: d.tabId, url: d.url, error: filter.error,
  });
}

// Swallow the original and emit a replacement. Waiting for onstop rather than
// writing at onstart keeps the request lifecycle intact.
function replaceBody(d, body) {
  let filter;
  try { filter = browser.webRequest.filterResponseData(d.requestId); }
  catch (e) {
    postEvent({ type: 'patch_error', tabId: d.tabId, url: d.url, error: String(e.message || e) });
    return;
  }
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  filter.ondata = () => { /* discard the original */ };
  filter.onstop = () => {
    try { filter.write(new TextEncoder().encode(payload)); } catch {}
    filter.close();
  };
  filter.onerror = () => postEvent({
    type: 'patch_error', tabId: d.tabId, url: d.url, error: filter.error,
  });
}

// Runs in the PAGE world: wraps console and catches thrown errors, then hands
// them to the isolated relay via postMessage (page world cannot reach
// browser.runtime).
function consoleHook() {
  if (window.__lwagentHooked) return;
  window.__lwagentHooked = true;
  const send = (p) => { try { window.postMessage({ __lwagent: true, ...p }, '*'); } catch {} };
  const fmt = (a) => {
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a); } catch { return String(a); }
  };
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const orig = console[level];
    if (typeof orig !== 'function') continue;
    console[level] = function (...args) {
      send({ type: 'console', level, text: args.map(fmt).join(' ').slice(0, 4000) });
      return orig.apply(this, args);
    };
  }
  window.addEventListener('error', (e) => send({
    type: 'exception', text: String(e.message), source: e.filename, line: e.lineno,
  }));
  window.addEventListener('unhandledrejection', (e) => send({
    type: 'exception',
    text: 'unhandled rejection: ' + String((e.reason && e.reason.message) || e.reason),
  }));
}

// Runs in the ISOLATED world: the only side that can talk to the background.
function consoleRelay() {
  if (window.__lwagentRelay) return;
  window.__lwagentRelay = true;
  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.__lwagent !== true) return;
    const { __lwagent, ...rest } = d;
    browser.runtime.sendMessage({ __lwagentEvent: rest }).catch(() => {});
  });
}

async function injectHooks(tabId) {
  // Relay first, so it is listening before the page world starts posting.
  await browser.scripting.executeScript({ target: { tabId }, world: 'ISOLATED', func: consoleRelay });
  await browser.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: consoleHook });
}

browser.runtime.onMessage.addListener((msg, sender) => {
  const tabId = sender && sender.tab && sender.tab.id;
  if (!msg || !msg.__lwagentEvent || !captures.has(tabId)) return;
  postEvent({ tabId, url: sender.tab.url, ...msg.__lwagentEvent });
});

// Re-hook after navigation -- executeScript does not survive a page load.
// Hooking at 'loading' catches most of a page's own startup logging; anything
// logged before the document exists is unavoidably missed.
browser.tabs.onUpdated.addListener((tabId, info) => {
  if (!captures.has(tabId)) return;
  if (info.status === 'loading' || info.status === 'complete') {
    injectHooks(tabId).catch(() => {});
  }
});

browser.tabs.onRemoved.addListener((tabId) => {
  if (captures.delete(tabId)) {
    postEvent({ type: 'capture_stopped', tabId, reason: 'tab closed' });
    unwireIfIdle();
  }
});

// ---------------------------------------------------------------- commands --

async function activeTab() {
  const [t] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!t) throw new Error('no active tab');
  return t;
}

// executeScript fails opaquely ("An unexpected error occurred") on privileged
// pages and on discarded tabs, which are the two cases that actually come up:
// about:* / view-source, and the sleeping tabs a big pinned set accumulates.
// Say which it is instead.
const PRIVILEGED = /^(about|moz-extension|chrome|resource|view-source|data):/;

async function injectableTab(tabId) {
  const t = await browser.tabs.get(tabId);
  if (t.discarded) {
    throw new Error(`tab ${tabId} is discarded (sleeping) -- open it, or pass reload:true`);
  }
  if (PRIVILEGED.test(t.url || '')) {
    throw new Error(`tab ${tabId} is a privileged page (${(t.url || '').split(/[?#]/)[0]}) -- extensions cannot run there`);
  }
  return t;
}

async function handle(msg) {
  if (!enabled) return { error: 'agent access is toggled OFF' };

  switch (msg.action) {
    case 'ping':
      return { ok: true };

    case 'tabs': {
      const tabs = await browser.tabs.query({});
      return {
        tabs: tabs.map((t) => ({
          id: t.id, url: t.url, title: t.title,
          active: t.active, pinned: t.pinned, discarded: !!t.discarded,
        })),
      };
    }

    // Evaluate an expression in PAGE context (world: MAIN), so it sees the
    // page's own globals -- the content-script world would not.
    case 'eval': {
      const tabId = msg.tabId || (await activeTab()).id;
      if (!msg.expr) return { error: 'missing expr' };
      await injectableTab(tabId);

      // Many pages render their real content in a cross-origin child frame,
      // and executeScript targets only the top document unless it is told
      // otherwise - so every read of a framed page came back as the host page
      // chrome and nothing else. `frames` opts in to allFrames and returns one
      // result PER FRAME. Default stays top-frame-only: the single-result
      // shape is what every existing caller parses.
      const evalFunc = (expr) => {
        let v;
        try {
          v = (0, eval)(expr);   // indirect eval -> global scope
        } catch (e) {
          return { error: String((e && e.message) || e) };
        }
        if (v === undefined) return { value: null };
        // Fall back to a string for DOM nodes, cyclic objects, etc.
        try { return { value: JSON.parse(JSON.stringify(v)) }; }
        catch { return { value: String(v) }; }
      };

      const isCsp = (r) => !!(r && r.error && /CSP|Content Security Policy/i.test(r.error));

      const run = async (world) => {
        const [res] = await browser.scripting.executeScript({
          target: { tabId }, world, args: [msg.expr], func: evalFunc,
        });
        return (res && res.result) || { error: 'no result' };
      };

      const runFrames = async (world) => {
        const res = await browser.scripting.executeScript({
          target: { tabId, allFrames: true }, world, args: [msg.expr], func: evalFunc,
        });
        return res.map((r) => ({ frameId: r.frameId, ...(r.result || { error: 'no result' }) }));
      };

      if (msg.frames) {
        const w = (msg.world || 'MAIN').toUpperCase();
        let frames = await runFrames(w);
        // Retry ONLY the frames the page CSP refused, and say which world each
        // answer came from - a silent mixed-world result is a lie about scope.
        if (w === 'MAIN' && frames.some(isCsp)) {
          const iso = new Map((await runFrames('ISOLATED')).map((f) => [f.frameId, f]));
          frames = frames.map((f) => (isCsp(f) && iso.has(f.frameId)
            ? { ...iso.get(f.frameId), world: 'ISOLATED' } : f));
        }
        return { frames };
      }

      const world = (msg.world || 'MAIN').toUpperCase();
      let out = await run(world);

      // Sites with a strict CSP (many retail sites, most banks) block eval() in the page
      // world. The ISOLATED content-script world is exempt from page CSP and
      // still shares the DOM, so retry there -- it only loses the page's own
      // JS globals, which most reads do not need.
      if (world === 'MAIN' && isCsp(out)) {
        const retry = await run('ISOLATED');
        if (!retry.error) return { ...retry, world: 'ISOLATED', note: 'page CSP blocked eval in the page world; ran isolated (no page globals)' };
        return retry;
      }
      return out;
    }

    // Readable page text, for "what does that page actually say".
    case 'text': {
      const tabId = msg.tabId || (await activeTab()).id;
      await injectableTab(tabId);
      const textFunc = () => ({
        url: location.href,
        title: document.title,
        text: (document.body ? document.body.innerText : '').slice(0, 20000),
      });
      if (msg.frames) {
        const res = await browser.scripting.executeScript({
          target: { tabId, allFrames: true }, world: 'MAIN', func: textFunc,
        });
        return { frames: res.map((r) => ({ frameId: r.frameId, ...(r.result || { error: 'no result' }) })) };
      }
      const [res] = await browser.scripting.executeScript({
        target: { tabId }, world: 'MAIN', func: textFunc,
      });
      return res ? res.result : { error: 'no result' };
    }

    case 'capture_start': {
      const tabId = msg.tabId || (await activeTab()).id;
      const t = await injectableTab(tabId);
      if (captures.has(tabId)) return { tabId, url: t.url, already: true };
      // State FIRST: wireWebRequest() no-ops unless anyActive() is already
      // true, so wiring before the map is populated silently installs nothing
      // and capture looks armed while receiving no events.
      captures.set(tabId, { startedAt: Date.now(), url: t.url });
      wireWebRequest();
      await injectHooks(tabId);
      postEvent({ type: 'capture_started', tabId, url: t.url });
      return { tabId, url: t.url };
    }

    case 'capture_stop': {
      const tabId = msg.tabId || (await activeTab()).id;
      if (!captures.delete(tabId)) return { error: `tab ${tabId} is not being captured` };
      postEvent({ type: 'capture_stopped', tabId });
      unwireIfIdle();
      return { tabId, stopped: true };
    }

    // Rule shapes:
    //   {match, drop}                 -> cancel the request
    //   {match, headers:{...}}        -> merge into REQUEST headers
    // webRequest can do these, BiDi cannot:
    //   {match, redirect:"url"}       -> redirect
    //   {match, respBody: ... }       -> replace the RESPONSE body
    //   {match, respHeaders:{...}}    -> merge into RESPONSE headers
    case 'patch_set': {
      let rules = msg.rules;
      if (typeof rules === 'string') {
        try { rules = JSON.parse(rules); } catch (e) { return { error: 'rules is not valid JSON: ' + e.message }; }
      }
      if (!Array.isArray(rules)) return { error: 'rules must be a JSON array' };
      for (const r of rules) {
        if (!r || typeof r.match !== 'string' || !r.match) {
          return { error: 'every rule needs a non-empty "match" substring' };
        }
        if ('body' in r && !('respBody' in r)) {
          return { error: 'lwagent cannot rewrite a REQUEST body -- Firefox has no API for it ' +
                          '(requestBody is read-only). Use a WebDriver BiDi session for that, or "respBody" ' +
                          'if you meant the response.' };
        }
      }
      patchRules = rules;
      wireWebRequest();
      return { rules: patchRules.length };
    }

    case 'patch_clear':
      patchRules = [];
      unwireIfIdle();
      return { cleared: true };

    case 'patches':
      return { rules: patchRules };

    case 'captures':
      return {
        wired: webRequestWired,   // false with a live capture => listeners missing
        listeners: wired.length,  // must be WIRE_COUNT; fewer = a class of events is lost
        captures: [...captures.entries()].map(([tabId, c]) => ({
          tabId, url: c.url, startedAt: new Date(c.startedAt).toISOString(),
        })),
      };

    default:
      return { error: `unknown action: ${msg.action}` };
  }
}

// ------------------------------------------------------------------- wiring --

action.onClicked.addListener(() => setEnabled(!enabled));

// Ctrl+Shift+U as well: with unified extensions on, the toolbar button lives
// inside the puzzle-piece menu until it is pinned, which makes it easy to
// miss.
if (browser.commands && browser.commands.onCommand) {
  browser.commands.onCommand.addListener((cmd) => {
    if (cmd === 'toggle') setEnabled(!enabled);
  });
}

// Startup self-test. Logs from the REAL background page, so it reports the
// actual CSP/permission situation -- evaluating the same fetch by hand in the
// devtools console runs in a sandbox with its own stricter CSP and reports a
// "default-src 'none'" block that does not apply here.
fetch(`${HTTP}/health`, { cache: 'no-store' })
  .then((r) => r.json())
  .then((h) => console.log('lwagent selftest: bridge reachable ->', JSON.stringify(h)))
  .catch((e) => console.error('lwagent selftest: CANNOT reach', HTTP, '->', (e && e.message) || e));

// Restore the toggle across restarts, but never default to on.
browser.storage.local.get('enabled').then((s) => {
  enabled = !!(s && s.enabled);
  paint();
  if (enabled) connect();
});
