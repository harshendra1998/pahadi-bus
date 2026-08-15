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

const { server, wss } = await import('./server.js');

const BACKLOG = 10; // must match server.js
const gap = () => new Promise((r) => setTimeout(r, COOLDOWN + 40));

/* Buffers every frame from the moment the socket is constructed.
   The server sends `hello` the instant it accepts the connection, and ws
   can emit 'open' and that first 'message' in the same tick — so a helper
   that attaches its listener in a microtask after 'open' misses it and
   then waits forever. Buffer first, match later. */
function client() {
  const ws = new WebSocket('ws://localhost:8199');
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
const origin = (value) =>
  new Promise((resolve) => {
    const ws = new WebSocket('ws://localhost:8199', { origin: value });
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
assert.equal(await origin('https://evil.example'), 'refused', 'unknown origin refused');
assert.equal(
  await origin('https://pahadi-bus.web.app.evil.example'),
  'refused',
  'lookalike suffix must not pass',
);

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
