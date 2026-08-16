/* ─────────────────────────────────────────────────────────────
   Pahadi Bus
   Sound comes from a 1×1 YouTube iframe parked off-screen;
   every control you can see is ours.
   ───────────────────────────────────────────────────────────── */

const $ = (id) => document.getElementById(id);

const el = {
  player: $('player'),
  cover: $('cover'),
  title: $('title'),
  artist: $('artist'),
  seek: $('seek'),
  seekFill: $('seekFill'),
  seekKnob: $('seekKnob'),
  tCur: $('tCur'),
  tDur: $('tDur'),
  play: $('play'),
  prev: $('prev'),
  next: $('next'),
  shuffle: $('shuffle'),
  listBtn: $('listBtn'),
  list: $('list'),
  listItems: $('listItems'),
  clock: $('clock'),
  listeners: $('listeners'),
  bumperText: $('bumperText'),
  bumperNext: $('bumperNext'),
  horn: $('horn'),
  fullscreen: $('fullscreen'),
  chat: $('chat'),
  chatToggle: $('chatToggle'),
  chatClose: $('chatClose'),
  chatBar: $('chatBar'),
  chatLog: $('chatLog'),
  chatDot: $('chatDot'),
  chatInput: $('chatInput'),
  nameBox: $('nameBox'),
  nameForm: $('nameForm'),
  nameInput: $('nameInput'),
  nameCancel: $('nameCancel'),
};

const state = {
  tracks: [],
  order: [], // indices into tracks, in play order
  pos: 0, // index into order
  shuffle: true,
  ready: false,
  playing: false,
  started: false,
  scrubbing: false,
};

let yt = null;

const fmt = (s) => {
  if (!Number.isFinite(s) || s < 0) s = 0;
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** Fisher–Yates, in place. Every index equally likely in every position. */
function shuffled(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const buildOrder = () => {
  const seq = state.tracks.map((_, i) => i);
  return state.shuffle ? shuffled(seq) : seq;
};

const track = () => state.tracks[state.order[state.pos]];

/* ── Rendering ───────────────────────────────────────────────── */

let swapTimer = null;

function renderTrack() {
  const t = track();
  if (!t) return;

  // Fade the old title out and back in
  if (el.title.dataset.rendered) {
    el.player.classList.add('is-swapping');
    clearTimeout(swapTimer);
    swapTimer = setTimeout(() => el.player.classList.remove('is-swapping'), 180);
  }
  el.title.dataset.rendered = '1';

  el.title.textContent = t.title;
  el.artist.textContent = t.artist || t.rawTitle || '';
  el.cover.src = t.cover || '';
  el.cover.alt = `${t.title} artwork`;
  el.cover.classList.toggle('is-letterboxed', (t.cover || '').includes('ytimg.com'));
  if (state.started) document.title = `${t.title} — पहाड़ी बस`;

  [...el.listItems.children].forEach((li, i) => li.classList.toggle('is-current', i === state.pos));
  const active = el.listItems.children[state.pos];
  if (active && el.list.classList.contains('is-open')) {
    active.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

function renderList() {
  const frag = document.createDocumentFragment();
  state.order.forEach((trackIdx, i) => {
    const t = state.tracks[trackIdx];
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';

    const title = document.createElement('span');
    title.className = 't-title';
    title.textContent = t.title;

    const artist = document.createElement('span');
    artist.className = 't-artist';
    artist.textContent = t.artist || '';

    btn.append(title, artist);
    btn.addEventListener('click', () => {
      go(i);
      yt?.playVideo();
    });
    li.append(btn);
    frag.append(li);
  });
  el.listItems.replaceChildren(frag);
}

function renderPlaying(on) {
  state.playing = on;
  el.player.classList.toggle('is-playing', on);
  el.play.setAttribute('aria-label', on ? 'Pause' : 'Play');
}

/* ── Playback ────────────────────────────────────────────────── */

function go(newPos) {
  const n = state.order.length;
  state.pos = ((newPos % n) + n) % n;
  renderTrack();
  if (!yt) return;
  state.started = true;
  yt.loadVideoById(track().id);
}

function toggle() {
  if (!yt || !state.ready) return;
  if (state.playing) {
    yt.pauseVideo();
  } else {
    state.started = true;
    yt.playVideo();
  }
}

/* ── Progress ──────────────────────────────────────────────────── */
const poll = { at: 0, time: 0, duration: 0 };
let lastShown = -1;

function samplePlayer() {
  if (typeof yt?.getCurrentTime !== 'function') return;
  poll.time = yt.getCurrentTime() || 0;
  poll.duration = yt.getDuration() || 0;
  poll.at = performance.now();
}

function paintProgress() {
  requestAnimationFrame(paintProgress);
  if (state.scrubbing || !poll.duration) return;

  const drift = state.playing ? (performance.now() - poll.at) / 1000 : 0;
  const t = clamp(poll.time + drift, 0, poll.duration);
  const pct = (t / poll.duration) * 100;

  el.seekFill.style.width = `${pct}%`;
  el.seekKnob.style.left = `${pct}%`;

  const sec = Math.floor(t);
  if (sec !== lastShown) {
    lastShown = sec;
    el.tCur.textContent = fmt(t);
    el.tDur.textContent = fmt(poll.duration);
    el.seek.setAttribute('aria-valuenow', Math.round(pct));
    el.seek.setAttribute('aria-valuetext', `${fmt(t)} of ${fmt(poll.duration)}`);
  }
}

const fractionFromEvent = (e) => {
  const r = el.seek.getBoundingClientRect();
  return clamp((e.clientX - r.left) / r.width, 0, 1);
};

function previewSeek(f) {
  el.seekFill.style.width = `${f * 100}%`;
  el.seekKnob.style.left = `${f * 100}%`;
  el.tCur.textContent = fmt(f * poll.duration);
}

el.seek.addEventListener('pointerdown', (e) => {
  if (!poll.duration) return;
  state.scrubbing = true;
  el.seek.classList.add('is-scrubbing');
  el.seek.setPointerCapture(e.pointerId);
  previewSeek(fractionFromEvent(e));
});

el.seek.addEventListener('pointermove', (e) => {
  if (state.scrubbing) previewSeek(fractionFromEvent(e));
});

el.seek.addEventListener('pointerup', (e) => {
  if (!state.scrubbing) return;
  state.scrubbing = false;
  el.seek.classList.remove('is-scrubbing');
  const t = fractionFromEvent(e) * poll.duration;
  yt?.seekTo(t, true);
  poll.time = t;
  poll.at = performance.now();
});

el.seek.addEventListener('keydown', (e) => {
  const step = { ArrowLeft: -5, ArrowRight: 5, ArrowDown: -5, ArrowUp: 5 }[e.key];
  if (!step || !poll.duration) return;
  e.preventDefault();
  const t = clamp(poll.time + step, 0, poll.duration);
  yt?.seekTo(t, true);
  poll.time = t;
  poll.at = performance.now();
});

/* ── Horn ──────────────────────────────────────────────────────── */
const horn = new Audio('assets/assets/BusHorn.mp3');
horn.preload = 'auto';
horn.volume = 0.7;

/* The song's volume before we ducked it, or null when nothing is ducked.
   Held across honks so a second press mid-blast doesn't save the already
   ducked level as the one to go back to. */
let preHonk = null;

/* Restored on the horn's own `ended` rather than a timer: the clip decides
   how long it is, and a re-press restarts it without firing this, so the
   song comes back when the horn actually stops instead of one honk early. */
horn.addEventListener('ended', () => {
  if (preHonk !== null) yt?.setVolume?.(preHonk);
  preHonk = null;
});

function honk() {
  horn.currentTime = 0;
  /* Duck only once playback is real. Before the first gesture the browser
     refuses to play, and ducking then would strand the song quiet forever
     waiting for an `ended` that never comes. */
  horn.play().then(() => {
    if (!yt?.getVolume || preHonk !== null) return;
    preHonk = yt.getVolume();
    yt.setVolume(Math.round(preHonk * 0.35));
  }, () => {});

  el.horn.classList.add('is-honking');
  setTimeout(() => el.horn.classList.remove('is-honking'), 160);
}

/* ── Bumper lines ──────────────────────────────────────────────── */
const BUMPER_LINES = [
  'हॉर्न ओके प्लीज़',
  'पहाड़ी बस, मस्त सफर',
  'बुरी नज़र वाले तेरा मुँह काला',
  'माँ का आशीर्वाद',
  'सड़क का राजा',
  'फिर मिलेंगे, हँसते हँसते',
  'जय माता दी',
  'चलती का नाम गाड़ी',
  'दम है तो पास कर, वरना बर्दाश्त कर',
  'देख मगर प्यार से',
  'रुक जाना नहीं तू कहीं हार के',
  'सफर सुहाना, साथी पुराना',
];

const bumperBag = [];
function nextBumper() {
  if (!bumperBag.length) bumperBag.push(...shuffled([...BUMPER_LINES]));
  el.bumperText.textContent = bumperBag.pop();
}

/* ── Top bar trivia ──────────────────────────────────────────── */

function tickClock() {
  el.clock.textContent = new Date().toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

/* ── Live chat ───────────────────────────────────────────────────
   The log is always on screen; the composer is what opens and closes.
   Nothing here persists server-side beyond the last 10 lines. */
const NAME_KEY = 'pahadibus.name';
const KEEP = 10; // must not exceed the server's BACKLOG, or history arrives clipped

const chat = { ws: null, retry: 0, name: '', fallbackName: '', pending: '' };

function addChatLine({ name, text, note }) {
  const li = document.createElement('li');
  if (note) {
    li.className = 'is-note';
    li.textContent = note;
  } else {
    if (name === chat.name) li.classList.add('is-me');
    const who = document.createElement('span');
    who.className = 'chat__who';
    who.textContent = name;
    // textContent only, never innerHTML: this string came off the wire.
    li.append(who, document.createTextNode(text));
  }

  el.chatLog.append(li);
  // The corner would otherwise grow without limit over a long session.
  while (el.chatLog.children.length > KEEP) el.chatLog.firstElementChild.remove();
}

/* Transient lines — connection state, rate-limit warnings — replace each
   other instead of stacking up, so a flaky link can't fill the corner. */
function setNote(text) {
  el.chatLog.querySelector('.is-status')?.remove();
  if (!text) return;
  const li = document.createElement('li');
  li.className = 'is-note is-status';
  li.textContent = text;
  el.chatLog.append(li);
}

/* The dot on the toggle. Driven by the socket, not by having ever
   connected, so a dropped link goes red and the reconnect turns it back. */
function setLive(live) {
  el.chat.classList.toggle('is-live', live);
  el.chatDot.setAttribute('aria-label', live ? 'Live' : 'Offline');
}

/* In production the page comes from Firebase Hosting, which is static and
   cannot carry a WebSocket, so the socket lives on a separate host. Set
   this to your Render URL, hostname only, no protocol.
   Locally `npm start` serves both from one origin, so localhost keeps
   talking to itself and you can develop without deploying anything. */
const CHAT_HOST = 'pahadi-bus.onrender.com';

function chatUrl() {
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  if (local) return `ws://${location.host}`;
  return `wss://${CHAT_HOST}`;
}

function connectChat() {
  chat.ws = new WebSocket(chatUrl());

  chat.ws.addEventListener('open', () => {
    chat.retry = 0;
    setNote('');
    setLive(true);
  });

  chat.ws.addEventListener('message', (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }

    if (msg.type === 'hello') {
      // The server's assigned name is only a fallback — a name the user
      // chose, on this device, wins and survives the next session.
      chat.fallbackName = msg.name;
      chat.name = localStorage.getItem(NAME_KEY) || '';
      el.chatLog.replaceChildren();
      msg.history?.slice(-KEEP).forEach(addChatLine);
    } else if (msg.type === 'chat') {
      addChatLine(msg);
    } else if (msg.type === 'presence') {
      el.listeners.textContent = msg.count;
    } else if (msg.type === 'slow') {
      // "एक मिनट" read fine at a 30s limit; at 2s it now says a minute
      // while the number next to it says 2.
      setNote(`ज़रा रुकें — ${msg.retryIn}s बाद फिर भेजें।`);
    }
  });

  chat.ws.addEventListener('close', () => {
    setLive(false);
    setNote('कनेक्ट हो रहा है…');
    const wait = Math.min(1000 * 2 ** chat.retry++, 15000);
    setTimeout(connectChat, wait);
  });

  chat.ws.addEventListener('error', () => chat.ws.close());
}

/* ── Composer ─────────────────────────────────────────────────── */

function openComposer(open) {
  el.chatToggle.hidden = open;
  el.chatBar.hidden = !open;
  el.chatToggle.setAttribute('aria-expanded', String(open));
  /* Only closing arms the fade — the class is absent at load, so the log
     is readable from the start without anyone having to open the composer
     to see it. CSS owns the 5s; see .chat.is-idle. */
  el.chat.classList.toggle('is-idle', !open);
  if (open) el.chatInput.focus();
  else el.chatToggle.focus();
}

function post(text) {
  if (chat.ws?.readyState !== WebSocket.OPEN) return;
  chat.ws.send(JSON.stringify({ type: 'chat', name: chat.name, text }));
  el.chatInput.value = '';
}

el.chatToggle.addEventListener('click', () => openComposer(true));
el.chatClose.addEventListener('click', () => openComposer(false));

el.chatBar.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = el.chatInput.value.trim();
  if (!text) return;

  // First message ever on this device: ask who they are, then send what
  // they already typed rather than making them type it twice.
  if (!chat.name) {
    chat.pending = text;
    el.nameInput.value = chat.fallbackName;
    el.nameBox.showModal();
    return;
  }
  post(text);
});

el.nameForm.addEventListener('submit', () => {
  // method="dialog" closes it for us; this only runs on a valid submit.
  chat.name = el.nameInput.value.trim() || chat.fallbackName;
  localStorage.setItem(NAME_KEY, chat.name);
  if (chat.pending) post(chat.pending);
  chat.pending = '';
});

el.nameCancel.addEventListener('click', () => {
  chat.pending = '';
  el.nameBox.close();
});

/* ── Wiring ──────────────────────────────────────────────────── */

el.play.addEventListener('click', toggle);
el.next.addEventListener('click', () => go(state.pos + 1));
el.prev.addEventListener('click', () => {
  if (poll.time > 4) yt?.seekTo(0, true);
  else go(state.pos - 1);
});

el.shuffle.addEventListener('click', () => {
  state.shuffle = !state.shuffle;
  el.shuffle.classList.toggle('is-on', state.shuffle);
  el.shuffle.setAttribute('aria-pressed', String(state.shuffle));

  const playingIdx = state.order[state.pos];
  state.order = buildOrder();
  state.pos = state.order.indexOf(playingIdx);
  renderList();
  renderTrack();
});

el.listBtn.addEventListener('click', () => {
  const open = el.list.classList.toggle('is-open');
  el.listBtn.classList.toggle('is-on', open);
  el.listBtn.setAttribute('aria-expanded', String(open));
  if (open) el.listItems.children[state.pos]?.scrollIntoView({ block: 'center' });
});

document.addEventListener('click', (e) => {
  if (!el.list.classList.contains('is-open')) return;
  if (el.list.contains(e.target) || el.listBtn.contains(e.target)) return;
  el.listBtn.click();
});

el.bumperNext.addEventListener('click', nextBumper);
el.horn.addEventListener('click', honk);

/* ── Full screen ─────────────────────────────────────────────────
   Safari still needs the webkit- names, so every call has a fallback.
   iOS Safari has no Fullscreen API at all — there the button stays
   hidden rather than sitting there doing nothing. */
const fsElement = () => document.fullscreenElement ?? document.webkitFullscreenElement;

if (document.fullscreenEnabled || document.webkitFullscreenEnabled) {
  el.fullscreen.hidden = false;
}

function syncFullscreen() {
  const on = !!fsElement();
  el.fullscreen.classList.toggle('is-full', on);
  el.fullscreen.setAttribute('aria-pressed', String(on));
  el.fullscreen.setAttribute('aria-label', on ? 'Exit full screen' : 'Full screen');
}

el.fullscreen.addEventListener('click', async () => {
  const root = document.documentElement;
  try {
    if (fsElement()) {
      await (document.exitFullscreen?.() ?? document.webkitExitFullscreen?.());
    } else {
      // Rejects if the browser refuses (permissions policy, no gesture).
      // Nothing to recover — just don't let it surface as an unhandled error.
      await (root.requestFullscreen?.() ?? root.webkitRequestFullscreen?.());
    }
  } catch {
    /* ignore */
  }
});

// The state can change without our button: Esc, F11, the OS. Listen rather
// than assume the click is the only way in and out.
document.addEventListener('fullscreenchange', syncFullscreen);
document.addEventListener('webkitfullscreenchange', syncFullscreen);
syncFullscreen();

document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea') || e.metaKey || e.ctrlKey) return;
  if (e.key === ' ') {
    e.preventDefault();
    toggle();
  } else if (e.key === 'h') honk();
  else if (e.key === 'n') go(state.pos + 1);
  else if (e.key === 'p') go(state.pos - 1);
});

/* ── YouTube ─────────────────────────────────────────────────── */

const preferAudio = () => {
  try {
    yt?.setPlaybackQuality?.('tiny');
  } catch {
    /* ignore */
  }
};

window.onYouTubeIframeAPIReady = () => {
  yt = new YT.Player('yt-player', {
    height: '1',
    width: '1',
    videoId: track().id,
    playerVars: { playsinline: 1, controls: 0, disablekb: 1, modestbranding: 1, rel: 0 },
    events: {
      onReady: () => {
        state.ready = true;
        el.play.disabled = false;
        preferAudio();
      },
      onStateChange: (e) => {
        const S = YT.PlayerState;
        if (e.data === S.PLAYING) {
          renderPlaying(true);
          preferAudio();
        } else if (e.data === S.ENDED) go(state.pos + 1);
        else if (e.data === S.PAUSED) renderPlaying(false);
      },
      onError: () => {
        if (state.started) go(state.pos + 1);
      },
    },
  });

  setInterval(samplePlayer, 250);
  requestAnimationFrame(paintProgress);
};

/* ── Start ───────────────────────────────────────────────────── */

(async function init() {
  tickClock();
  setInterval(tickClock, 1000);
  connectChat();
  nextBumper();

  try {
    state.tracks = await (await fetch('tracks.json')).json();
  } catch {
    el.title.textContent = 'प्लेलिस्ट लोड नहीं हो सकी';
    el.artist.textContent = 'tracks.json चेक करें';
    return;
  }

  if (!state.tracks.length) {
    el.title.textContent = 'कोई गाना नहीं मिला';
    el.artist.textContent = 'Run: node scripts/build-tracks.mjs';
    return;
  }

  state.order = buildOrder();
  renderList();
  renderTrack();

  const s = document.createElement('script');
  s.src = 'https://www.youtube.com/iframe_api';
  document.head.append(s);
})();
