/* Smallest thing that fails if the chat logic breaks.
   Boots the real server on a spare port, drives it with three clients.
   Run: npm test */

import assert from 'node:assert/strict';
import { WebSocket } from 'ws';

process.env.PORT = '8199';
process.env.ALLOWED_ORIGINS = 'https://pahadi-bus.web.app';
/* The real limiter, just fast enough to wait on. Every client here shares
   one loopback address, so at the production 30s only the first message of
   the whole run would ever land. */
const COOLDOWN = 120;
process.env.CHAT_COOLDOWN_MS = String(COOLDOWN);
/* Stand in for Render. Without this the server ignores x-forwarded-for,
   which is what the last block below is about. */
process.env.TRUST_PROXY = '1';

const { server, wss } = await import('./server.js');

const BACKLOG = 10; // must match server.js
const gap = () => new Promise((r) => setTimeout(r, COOLDOWN + 40));

/* Buffers every frame from the moment the socket is constructed.
   The server sends `hello` the instant it accepts the connection, and ws
   can emit 'open' and that first 'message' in the same tick — so a helper
   that attaches its listener in a microtask after 'open' misses it and
   then waits forever. Buffer first, match later. */
function client(headers) {
  const ws = new WebSocket('ws://localhost:8199', headers ? { headers } : {});
  const seen = [];
  const waiting = [];

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    const i = waiting.findIndex((w) => w.match(msg));
    if (i === -1) return seen.push(msg);
    const [w] = waiting.splice(i, 1);
    clearTimeout(w.timer);
    w.resolve(msg);
  });

  ws.ready = new Promise((res) => ws.once('open', () => res(ws)));

  // For negative assertions. want() can't express "never arrives" — its
  // waiter rejects on timeout, so racing it leaves a live rejection behind.
  ws.seen = seen;

  // Matched frames are consumed, so waiting for presence:1 at the end of a
  // run can't be satisfied by the presence:1 from the start of it.
  ws.want = (match) => {
    const pred = typeof match === 'string' ? (m) => m.type === match : match;
    const i = seen.findIndex(pred);
    if (i !== -1) return Promise.resolve(seen.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const w = { match: pred, resolve };
      w.timer = setTimeout(() => reject(new Error(`timed out waiting for ${match}`)), 5000);
      waiting.push(w);
    });
  };

  // Every send costs a cooldown window, so space them or the next one is
  // rejected rather than processed — which would quietly void the assertion.
  ws.say = async (obj) => {
    ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj));
    await gap();
  };

  return ws;
}

const a = client();
await a.ready;

const hello = await a.want('hello');
assert.match(hello.name, /^ड्राइवर \d+$/, 'server hands out a name');
assert.deepEqual(hello.history, [], 'first client sees an empty backlog');
assert.equal((await a.want('presence')).count, 1, 'presence starts at one');

const b = client();
await b.ready;
await b.want('hello');
assert.equal((await a.want('presence')).count, 2, 'presence counts both sockets');

// A message from one client reaches the other. Sent raw, with no trailing
// gap, so the rate-limit check below lands inside the same window.
a.send(JSON.stringify({ type: 'chat', name: 'Bahadur', text: 'oye' }));
const got = await b.want('chat');
assert.equal(got.text, 'oye');
assert.equal(got.name, 'Bahadur');
assert.equal(typeof got.at, 'number', 'server stamps the time');

// Rate limit: a second message inside the window is refused, not queued,
// and the sender is told how long to wait rather than left guessing.
a.send(JSON.stringify({ type: 'chat', name: 'Bahadur', text: 'again' }));
const slow = await a.want('slow');
assert.equal(typeof slow.retryIn, 'number', 'server says when to retry');
await gap();
assert.ok(
  !b.seen.some((m) => m.text === 'again'),
  'the refused message must not reach anyone',
);

// Oversized input is clamped, not rejected outright.
await a.say({ type: 'chat', name: 'x'.repeat(99), text: 'y'.repeat(999) });
const clamped = await b.want('chat');
assert.equal(clamped.text.length, 500, 'text clamped to MAX_TEXT');
assert.equal(clamped.name.length, 24, 'name clamped to MAX_NAME');

// Control characters are scrubbed.
await a.say({ type: 'chat', name: 'n', text: `a${String.fromCharCode(7)}b` });
assert.equal((await b.want('chat')).text, 'a b', 'control chars replaced');

// Markup passes through as literal characters. The client renders with
// textContent, so this must arrive intact rather than escaped or stripped —
// if it ever comes back as HTML, the rendering path is the thing to fix.
const payload = '<img src=x onerror=alert(1)>';
await a.say({ type: 'chat', name: 'n', text: payload });
assert.equal((await b.want('chat')).text, payload, 'markup stays text');

// Garbage and wrong shapes are ignored rather than crashing the server.
await a.say('not json');
await a.say({ type: 'nonsense' });
await a.say({ type: 'chat' });
await a.say({ type: 'chat', text: '   ' });

// A late joiner gets the backlog, which proves the server survived all that.
const c = client();
await c.ready;
const late = await c.want('hello');
assert.equal(late.history.length, 4, 'backlog replayed to a new client');
assert.equal(late.history.at(-1).text, payload);

// The store is a cache, not a log: it keeps the last BACKLOG lines and
// forgets the rest. Push past the cap and the oldest must be gone.
for (let i = 0; i < BACKLOG; i++) await a.say({ type: 'chat', name: 'n', text: `m${i}` });

const d = client();
await d.ready;
const capped = await d.want('hello');
assert.equal(capped.history.length, BACKLOG, `backlog capped at ${BACKLOG}`);
assert.equal(capped.history.at(-1).text, `m${BACKLOG - 1}`, 'newest line kept');
assert.equal(capped.history.at(0).text, 'm0', 'oldest line dropped');
assert.ok(!capped.history.some((m) => m.text === payload), 'pre-cap lines evicted');

// Closing sockets drops the count.
d.close();
c.close();
b.close();
assert.equal((await a.want((m) => m.type === 'presence' && m.count === 1)).count, 1, 'presence falls');

a.close();

/* Origin allowlist. The socket is publicly reachable once it lives on its
   own host, so only the configured pages may open one. Compared as parsed
   host + protocol, never as a prefix — a lookalike domain must not pass. */
const origin = (value, host) =>
  new Promise((resolve) => {
    const ws = new WebSocket('ws://localhost:8199', {
      origin: value,
      // Overriding Host lets us reproduce a deployed hostname against the
      // local server, which is the only way to test the same-origin rule
      // without one of localhost/web.app doing the work for us.
      ...(host ? { headers: { Host: host } } : {}),
    });
    // A refusal closes the socket; an accepted one sends `hello` first.
    ws.on('message', () => {
      ws.close();
      resolve('accepted');
    });
    ws.on('close', () => resolve('refused'));
    ws.on('error', () => resolve('refused'));
  });

assert.equal(await origin('https://pahadi-bus.web.app'), 'accepted', 'configured origin allowed');
assert.equal(await origin('http://localhost:8123'), 'accepted', 'localhost always allowed');
/* Same origin: the page served by this very server, on a host nobody
   configured. Missing this is what made the deployed site refuse its own
   chat — the Render address is neither localhost nor in ALLOWED_ORIGINS.
   Note the host below is deliberately absent from both, or one of those
   rules would pass the test for the wrong reason. */
assert.equal(
  await origin('https://pahadi-bus.onrender.com', 'pahadi-bus.onrender.com'),
  'accepted',
  'a server must always allow the page it serves itself',
);

// Same host, but the browser came from somewhere else. Still cross-origin.
assert.equal(
  await origin('https://evil.example', 'pahadi-bus.onrender.com'),
  'refused',
  'matching Host must not launder a foreign Origin',
);
assert.equal(await origin('https://evil.example'), 'refused', 'unknown origin refused');
assert.equal(
  await origin('https://pahadi-bus.web.app.evil.example'),
  'refused',
  'lookalike suffix must not pass',
);

/* Rate limit is per visitor, not per site. Behind a proxy every socket
   shares one remote address, so keying on that alone means the first
   person to speak silences everybody else for the whole window. Two
   clients, two forwarded addresses, no gap between them: both must land. */
const p = client({ 'X-Forwarded-For': '203.0.113.7' });
const q = client({ 'X-Forwarded-For': '198.51.100.9, 203.0.113.1' });
await p.ready;
await q.ready;
await p.want('hello');
await q.want('hello');

p.send(JSON.stringify({ type: 'chat', name: 'p', text: 'first' }));
q.send(JSON.stringify({ type: 'chat', name: 'q', text: 'second' }));
assert.equal(
  (await q.want((m) => m.type === 'chat' && m.text === 'second')).name,
  'q',
  'one visitor speaking must not rate-limit another',
);
assert.ok(!q.seen.some((m) => m.type === 'slow'), 'and must not be told to slow down');

// Same forwarded client twice over: still one quota, or the limit is a
// no-op that anyone bypasses by opening a second socket.
const r = client({ 'X-Forwarded-For': '203.0.113.7' });
await r.ready;
await r.want('hello');
r.send(JSON.stringify({ type: 'chat', name: 'r', text: 'again' }));
assert.equal(typeof (await r.want('slow')).retryIn, 'number', 'same address shares a quota');

await gap();
p.close();
q.close();
r.close();

/* Static routes. The interesting half is what must NOT be served: ROOT
   holds the server and its tests alongside the site, so a guard that only
   checks "is it inside ROOT" happily hands out source. */
const status = async (p) => (await fetch(`http://localhost:8199${p}`)).status;

for (const p of ['/', '/styles.css', '/app.js', '/assets/favicon.svg', '/assets/assets/busmodal.webp'])
  assert.equal(await status(p), 200, `${p} should be served`);

for (const p of ['/server.js', '/../server.js', '/test-chat.mjs', '/package.json', '/nope'])
  assert.equal(await status(p), 404, `${p} must not be served`);

/* Close what we opened and let the loop drain on its own. process.exit()
   here aborts libuv on Windows if any socket is still mid-teardown — which
   exits 127 and reports a green run as a failure. closeAllConnections is
   the part that matters: fetch keeps its sockets alive, and those alone
   hold the server open long past the last assertion. */
wss.close();
server.closeAllConnections();
server.close();

console.log('chat: all assertions passed');
