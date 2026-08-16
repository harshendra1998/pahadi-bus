/* ─────────────────────────────────────────────────────────────
   Pahadi Bus — static files + live chat.

   No database on purpose: messages live in an array and die with
   the process. That is the whole persistence story.
   ───────────────────────────────────────────────────────────── */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { WebSocketServer } from 'ws';

const PORT = process.env.PORT || 8123;
const ROOT = import.meta.dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
};

/* ── Static files ─────────────────────────────────────────────── */

const server = createServer(async (req, res) => {
  let rel;
  try {
    rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }
  if (rel === '/') rel = '/index.html';

  /* Allowlist, not denylist. The traversal guard below only proves a path
     stays inside ROOT — and ROOT also holds server.js, package.json and
     the tests, all of which were happily served as source before this.
     An allowlist makes every server-side file added later private by
     default, instead of public until someone remembers to deny it. */
  if (!/^\/(index\.html|styles\.css|app\.js|tracks\.json|assets\/[\w./-]+)$/.test(rel)) {
    res.writeHead(404).end('Not found');
    return;
  }

  const file = normalize(join(ROOT, rel));
  if (!file.startsWith(ROOT + sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('Not found');
  }
});

/* ── Live chat ────────────────────────────────────────────────── */

const wss = new WebSocketServer({ server, maxPayload: 4096 });

const MAX_TEXT = 500;
const MAX_NAME = 24;
const BACKLOG = 10;
/* Overridable so the test can exercise the real limiter at a speed a test
   can wait for. Nothing sets it in production, where 30s is the rule. */
const COOLDOWN = Number(process.env.CHAT_COOLDOWN_MS ?? 30_000);

const CONTROL_CHARS = new RegExp("[\u0000-\u001f\u007f]", "g");

/* The whole store: last 10 lines, in memory, gone when the process
   restarts. A cache, not a database. */
const recent = [];
let seq = 0;

/* One message per IP per 30s. Keyed by IP, not by socket — a socket is
   free to open, so per-socket limiting is bypassed by reconnecting.
   ponytail: behind a reverse proxy every client shares the proxy's
   address and so shares one quota. Read a trusted forwarded-for header
   here if it ever sits behind one — but only then, since a client can
   set that header itself when it doesn't. */
const lastSent = new Map();
const ipOf = (req) => String(req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');

/* Once the socket lives on its own host it answers the whole internet, so
   say which pages may open it. This list is only for CROSS-origin pages —
   the Firebase domains, comma separated, set as ALLOWED_ORIGINS on Render.
   A page served by this server is same-origin and never needs listing.

   This stops other websites from opening a socket in a visitor's browser.
   It is not authentication — a script outside a browser can send any
   Origin it likes. The rate limit is what actually bounds abuse. */
const ALLOWED = [
  'http://localhost',
  'http://127.0.0.1',
  ...String(process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
];

const originOk = (origin, host) => {
  if (!origin) return true; // non-browser client; no Origin header to check
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }

  /* Same origin always passes. This server also serves the page, so when
     it is reached directly its own address is the Origin the browser
     sends — requiring that to be configured means the site refuses its
     own chat until someone remembers an env var. Compared including port,
     so localhost:8123 and localhost:5500 stay distinct. */
  if (host && url.host === host) return true;

  // Cross-origin (the page on Firebase, socket here) must be listed.
  // Compared as parsed parts, never a prefix: "https://pahadi-bus.web.app
  // .evil.com" would sail straight through a startsWith() check.
  return ALLOWED.some((a) => {
    const u = new URL(a);
    return u.protocol === url.protocol && u.hostname === url.hostname;
  });
};

const clean = (value, max) =>
  String(value ?? '')
    .replace(CONTROL_CHARS, ' ')
    .trim()
    .slice(0, max);

const send = (ws, msg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));
const broadcast = (msg) => wss.clients.forEach((c) => send(c, msg));
const announceCount = () => broadcast({ type: 'presence', count: wss.clients.size });

wss.on('connection', (ws, req) => {
  if (!originOk(req.headers.origin, req.headers.host)) {
    ws.close(1008, 'origin not allowed');
    return;
  }

  ws.alive = true;
  ws.ip = ipOf(req);
  ws.name = `ड्राइवर ${++seq}`;

  send(ws, { type: 'hello', name: ws.name, history: recent });
  announceCount();

  ws.on('pong', () => {
    ws.alive = true;
  });

  ws.on('message', (raw) => {
    /* Checked before JSON.parse, and stamped whether or not the frame
       turns out to be valid, so a flood of garbage costs no parsing and
       still burns the sender's own quota. The client sends nothing but
       chat lines, so there is no legitimate traffic to starve. */
    const now = Date.now();
    const waited = now - (lastSent.get(ws.ip) ?? -COOLDOWN);
    if (waited < COOLDOWN) {
      send(ws, { type: 'slow', retryIn: Math.ceil((COOLDOWN - waited) / 1000) });
      return;
    }
    lastSent.set(ws.ip, now);

    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg?.type !== 'chat') return;

    const text = clean(msg.text, MAX_TEXT);
    if (!text) return;

    ws.name = clean(msg.name, MAX_NAME) || ws.name;

    const out = { type: 'chat', name: ws.name, text, at: Date.now() };
    recent.push(out);
    if (recent.length > BACKLOG) recent.shift();
    broadcast(out);
  });

  ws.on('close', announceCount);
});

const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.alive) return ws.terminate();
    ws.alive = false;
    ws.ping();
  });
}, 30_000);

/* lastSent would otherwise grow one entry per IP forever. An entry older
   than the cooldown can never block anything, so it is safe to drop. */
const prune = setInterval(() => {
  const cutoff = Date.now() - COOLDOWN;
  for (const [ip, at] of lastSent) if (at < cutoff) lastSent.delete(ip);
}, COOLDOWN);

wss.on('close', () => {
  clearInterval(heartbeat);
  clearInterval(prune);
});

server.listen(PORT, () => console.log(`Pahadi Bus on http://localhost:${PORT}`));

/* Exported so the test can shut the process down by closing what it opened,
   rather than calling process.exit() out from under a socket mid-teardown. */
export { server, wss };
