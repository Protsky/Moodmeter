import { NEEDS, NEED_KEYS, AVATARS, POKES, moodFor } from './moods.js';
import { createGauge } from './gauge.js';
import { Room, DEFAULT_SERVER, newRoomCode, normalizeCode, isValidCode, formatCode } from './sync.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ntfy.sh tiene i messaggi ~12h: ripubblichiamo il nostro ultimo stato ogni 3h
// così lo ritrova anche chi apre l'app molto dopo.
const REPUBLISH_MS = 3 * 3600e3;
const STALE_MS = 24 * 3600e3;
const LOG_MAX = 80;
const POKE_MAX_AGE = 6 * 3600e3;
const TODO_MAX = 100;
const TOMBSTONE_MS = 30 * 86400e3;
// Un messaggio ntfy può essere al massimo 4096 byte: dopo cifratura e base64 restiamo sotto.
const CHUNK_BYTES = 2400;
const utf8 = new TextEncoder();

const store = {
  get(k, fallback) {
    try {
      const v = localStorage.getItem('mm.' + k);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem('mm.' + k, JSON.stringify(v));
    } catch {
      /* storage pieno o bloccato: l'app continua a funzionare in memoria */
    }
  },
  clear() {
    try {
      Object.keys(localStorage).filter((k) => k.startsWith('mm.')).forEach((k) => localStorage.removeItem(k));
    } catch {
      /* niente da fare */
    }
  },
};

const state = {
  profile: store.get('profile', null), // { id, name, avatar }
  room: store.get('room', null), // codice stanza normalizzato
  server: store.get('server', DEFAULT_SERVER),
  me: store.get('me', { mood: 60, needs: [], note: '', ts: 0 }),
  pendingSend: store.get('pendingSend', false),
  lastPub: store.get('lastPub', 0),
  delivered: store.get('delivered', 0),
  peers: store.get('peers', {}),
  log: store.get('log', []),
  notify: store.get('notify', false),
  seenPokes: store.get('seenPokes', []),
  todos: store.get('todos', {}), // id -> voce; quelle eliminate restano come "tombstone" per la sincronizzazione
  lastTodoPub: store.get('lastTodoPub', 0),
  pendingTodos: store.get('pendingTodos', false),
};
const draft = { mood: state.me.mood, needs: [...state.me.needs], note: state.me.note };
const bootTime = Date.now();
let room = null;
let peerGauge = null;
let meGauge = null;
let installEvent = null;
let helloTimer = 0;
let lastPeerSeen = 0;

/* ---------- utilità ---------- */

const rtf = new Intl.RelativeTimeFormat('it', { numeric: 'auto' });
function ago(ts) {
  const s = Math.round((ts - Date.now()) / 1000);
  const abs = Math.abs(s);
  if (abs < 45) return 'adesso';
  if (abs < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(s / 3600), 'hour');
  return rtf.format(Math.round(s / 86400), 'day');
}

function clock(ts) {
  const d = new Date(ts);
  const sameDay = d.toDateString() === new Date().toDateString();
  const time = d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  return sameDay ? time : `${d.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit' })} ${time}`;
}

function uid() {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');
}

function cleanText(v, max) {
  return typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max) : '';
}

function roomLink() {
  const url = new URL(location.href);
  url.hash = '';
  url.search = '';
  const params = new URLSearchParams({ r: formatCode(state.room) });
  if (state.server !== DEFAULT_SERVER) params.set('s', state.server);
  return `${url.href.replace(/#$/, '')}#${params}`;
}

// Accetta sia un codice sia un link intero incollato.
function parseRoomInput(input) {
  const raw = String(input || '').trim();
  const hashAt = raw.indexOf('#');
  if (hashAt >= 0) {
    const params = new URLSearchParams(raw.slice(hashAt + 1));
    if (params.get('r')) return { code: normalizeCode(params.get('r')), server: params.get('s') || DEFAULT_SERVER };
  }
  return { code: normalizeCode(raw), server: DEFAULT_SERVER };
}

function vibrate(pattern) {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* non supportato */
  }
}

/* ---------- toast e notifiche ---------- */

function toast(html, { kind = 'info', timeout = 4500 } = {}) {
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.innerHTML = `<div class="toast-bar">${kind === 'peer' ? 'NUOVO MESSAGGIO' : 'SISTEMA'}<span aria-hidden="true">×</span></div><div class="toast-body"></div>`;
  $('.toast-body', el).append(html);
  el.addEventListener('click', () => el.remove());
  $('#toasts').append(el);
  setTimeout(() => el.classList.add('out'), timeout);
  setTimeout(() => el.remove(), timeout + 400);
}

async function notify(title, body) {
  if (!state.notify || document.visibilityState === 'visible') return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    const opts = { body, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', tag: 'mm-peer', renotify: true };
    if (reg) await reg.showNotification(title, opts);
    else new Notification(title, opts);
  } catch {
    /* notifiche non disponibili */
  }
}

let unseen = 0;
function bumpTitle() {
  if (document.visibilityState === 'visible') return;
  unseen++;
  document.title = `(${unseen}) Mood Meter`;
}

/* ---------- log ---------- */

function addLog(entry) {
  state.log.push(entry);
  if (state.log.length > LOG_MAX) state.log.splice(0, state.log.length - LOG_MAX);
  store.set('log', state.log);
  renderLog();
}

function renderLog() {
  const ol = $('#log');
  ol.textContent = '';
  if (!state.log.length) {
    const li = document.createElement('li');
    li.className = 'log-empty';
    li.textContent = '> nessun evento. ancora.';
    ol.append(li);
    return;
  }
  for (const e of [...state.log].reverse()) {
    const li = document.createElement('li');
    li.className = e.who === 'me' ? 'log-me' : 'log-peer';
    const head = `[${clock(e.ts)}] ${e.avatar} ${e.name}`;
    if (e.kind === 'poke') {
      li.textContent = `${head} → ${e.emoji} ${e.label}`;
    } else {
      const m = moodFor(e.mood);
      const needs = (e.needs || []).map((k) => NEEDS.find((n) => n.key === k)?.emoji).join('');
      li.textContent = `${head} → ${m.emoji} ${m.label} (${e.mood}%) ${needs}`;
      if (e.note) {
        const q = document.createElement('span');
        q.className = 'log-note';
        q.textContent = `  “${e.note}”`;
        li.append(q);
      }
      li.style.setProperty('--c', m.color);
    }
    ol.append(li);
  }
}

/* ---------- rendering ---------- */

function renderReadout(prefix, mood) {
  const m = moodFor(mood);
  $(`#${prefix}Pct`).textContent = mood;
  $(`#${prefix}Emoji`).textContent = m.emoji;
  $(`#${prefix}Label`).textContent = m.label;
  $(`#${prefix}Hint`).textContent = m.hint;
}

function currentPeer() {
  const peers = Object.entries(state.peers).filter(([id]) => id !== state.profile?.id);
  if (!peers.length) return null;
  peers.sort((a, b) => b[1].ts - a[1].ts);
  return peers[0][1];
}

function renderPeer() {
  const p = currentPeer();
  $('#peerEmpty').hidden = !!p;
  $('#peerView').hidden = !p;
  if (!p) {
    $('#peerTitle').textContent = 'in_attesa.exe';
    return;
  }
  $('#peerTitle').textContent = `${p.name.toLowerCase().replace(/\s+/g, '_')}_adesso.exe`;
  $('#peerAvatar').textContent = p.avatar;
  $('#peerName').textContent = p.name;
  peerGauge.set(p.mood);
  renderReadout('peer', p.mood);
  const ul = $('#peerNeeds');
  ul.textContent = '';
  for (const key of p.needs) {
    const n = NEEDS.find((x) => x.key === key);
    if (!n) continue;
    const li = document.createElement('li');
    li.textContent = `${n.emoji} ${n.label}`;
    ul.append(li);
  }
  ul.hidden = !p.needs.length;
  ul.setAttribute('aria-label', `Cosa serve a ${p.name}`);
  $('#peerNote').hidden = !p.note;
  $('#peerNote').textContent = p.note;
  renderPeerAgo();
}

function renderPeerAgo() {
  const p = currentPeer();
  if (!p) return;
  $('#peerAgo').textContent = `aggiornato ${ago(p.ts)}`;
  $('#peerStale').hidden = Date.now() - p.ts < STALE_MS;
}

function isDirty() {
  const me = state.me;
  return (
    !me.ts ||
    draft.mood !== me.mood ||
    draft.note.trim() !== me.note ||
    draft.needs.length !== me.needs.length ||
    draft.needs.some((k) => !me.needs.includes(k))
  );
}

function renderEditor() {
  renderReadout('me', draft.mood);
  const range = $('#moodRange');
  range.value = draft.mood;
  const m = moodFor(draft.mood);
  range.setAttribute('aria-valuetext', `${draft.mood}% — ${m.label}`);
  range.style.setProperty('--fill', `${draft.mood}%`);
  $$('#needPicker button').forEach((b) => b.setAttribute('aria-pressed', String(draft.needs.includes(b.dataset.key))));
  $('#noteCounter').textContent = `${draft.note.length}/140`;
  renderSendStatus();
}

function renderSendStatus(override) {
  const el = $('#sendStatus');
  const btn = $('#sendBtn');
  const dirty = isDirty();
  btn.classList.toggle('pulse', dirty);
  if (override) {
    el.textContent = override;
    return;
  }
  if (dirty) el.textContent = '• modifiche non inviate';
  else if (state.pendingSend) el.textContent = '⏳ in attesa di connessione…';
  else if (state.delivered === state.me.ts) el.textContent = `✓✓ inviato ${ago(state.me.ts)}`;
  else el.textContent = `✓ inviato ${ago(state.me.ts)}`;
}

function renderProfile() {
  const p = state.profile;
  $('#meAvatar').textContent = p.avatar;
  $('#meName').textContent = p.name;
}

function setNet(status) {
  const el = $('#net');
  el.dataset.status = status;
  el.textContent = { online: 'online', connecting: 'connessione…', offline: 'offline', idle: 'offline' }[status];
}

function buildAvatarPicker(container, selected, onPick) {
  container.textContent = '';
  for (const a of AVATARS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'avatar-opt';
    b.textContent = a;
    b.setAttribute('aria-pressed', String(a === selected));
    b.setAttribute('aria-label', `Avatar ${a}`);
    b.addEventListener('click', () => {
      $$('button', container).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      onPick(a);
    });
    container.append(b);
  }
}

function fillShareBoxes() {
  if (!state.room) return;
  const link = roomLink();
  const text = `Entra nel nostro Mood Meter 🎛️ ${link}`;
  for (const box of $$('[data-share]')) {
    if (!box.firstElementChild) box.append($('#shareTpl').content.cloneNode(true));
    $('.share-url', box).value = link;
    $('[data-act="wa"]', box).href = `https://wa.me/?text=${encodeURIComponent(text)}`;
    const shareBtn = $('[data-act="share"]', box);
    shareBtn.hidden = !navigator.share;
    if (box.dataset.bound) continue;
    box.dataset.bound = '1';
    $('[data-act="copy"]', box).addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(roomLink());
        toast('Link copiato 📋');
      } catch {
        $('.share-url', box).select();
        toast('Seleziona e copia il link a mano');
      }
    });
    shareBtn.addEventListener('click', () => {
      navigator.share({ title: 'Mood Meter', text: 'Entra nel nostro Mood Meter 🎛️', url: roomLink() }).catch(() => {});
    });
  }
  $('#roomCode').textContent = formatCode(state.room);
}

/* ---------- schermate ---------- */

function show(screen) {
  $('#onboarding').hidden = screen === 'dash';
  $('#dash').hidden = screen !== 'dash';
  $('#settingsBtn').hidden = screen !== 'dash';
  for (const id of ['stepProfile', 'stepRoom', 'stepShare']) $('#' + id).hidden = id !== screen;
  const focusTarget = screen === 'dash' ? null : $(`#${screen} input, #${screen} button`);
  focusTarget?.focus({ preventScroll: true });
}

function route() {
  if (!state.profile) return show('stepProfile');
  if (!state.room) return show('stepRoom');
  renderProfile();
  show('dash');
}

/* ---------- sincronizzazione ---------- */

function sanitizeState(p) {
  const mood = Math.max(0, Math.min(100, Math.round(Number(p.mood))));
  const ts = Number(p.ts);
  if (!Number.isFinite(mood) || !Number.isFinite(ts) || ts <= 0 || ts > Date.now() + 5 * 60e3) return null;
  return {
    name: cleanText(p.name, 24) || '???',
    avatar: cleanText(p.avatar, 8) || '👤',
    mood,
    needs: Array.isArray(p.needs) ? p.needs.filter((k) => NEED_KEYS.has(k)).slice(0, NEEDS.length) : [],
    note: cleanText(p.note, 140),
    ts,
  };
}

function onMessage({ payload, serverTime }) {
  if (!payload || typeof payload !== 'object' || typeof payload.id !== 'string') return;
  const live = serverTime >= bootTime - 5000;

  if (payload.id === state.profile.id) {
    // Eco del nostro messaggio: conferma che è arrivato al server.
    if (payload.kind === 'state' && Number(payload.ts) === state.me.ts && state.delivered !== state.me.ts) {
      state.delivered = state.me.ts;
      store.set('delivered', state.delivered);
      renderSendStatus();
    }
    return;
  }

  lastPeerSeen = Math.max(lastPeerSeen, serverTime);

  if (payload.kind === 'hello') {
    // Dall'altra parte manca qualcosa: ripubblichiamo subito umore e lista.
    if (live) {
      if (state.me.ts) publishState({ republish: true });
      const all = Object.values(state.todos);
      if (all.length) publishTodos(all, { snapshot: true });
    }
    return;
  }

  if (payload.kind === 'todos') {
    onTodos(payload, serverTime, live);
    return;
  }

  if (payload.kind === 'poke') {
    const poke = POKES.find((x) => x.emoji === payload.emoji);
    // Mostriamo anche quelli arrivati mentre l'app era chiusa (fino a POKE_MAX_AGE), ma una volta sola.
    if (!poke || typeof payload.pid !== 'string' || serverTime < Date.now() - POKE_MAX_AGE) return;
    if (state.seenPokes.includes(payload.pid)) return;
    state.seenPokes = [...state.seenPokes, payload.pid].slice(-50);
    store.set('seenPokes', state.seenPokes);
    const name = cleanText(payload.name, 24) || '???';
    const avatar = cleanText(payload.avatar, 8) || '👤';
    addLog({ ts: serverTime || Date.now(), who: 'peer', kind: 'poke', name, avatar, emoji: poke.emoji, label: poke.label });
    const big = document.createElement('div');
    big.className = 'poke-toast';
    big.innerHTML = `<span class="poke-emoji" aria-hidden="true"></span><span></span>`;
    big.firstChild.textContent = poke.emoji;
    big.lastChild.textContent = `${avatar} ${name}: ${poke.label}${live ? '' : ` (${ago(serverTime)})`}`;
    toast(big, { kind: 'peer' });
    if (live) {
      vibrate([60, 40, 60]);
      notify(`${avatar} ${name}`, `${poke.emoji} ${poke.label}`);
      bumpTitle();
    }
    return;
  }

  if (payload.kind !== 'state') return;
  const s = sanitizeState(payload);
  if (!s) return;
  const prev = state.peers[payload.id];
  if (prev && prev.ts >= s.ts) return;
  state.peers[payload.id] = s;
  store.set('peers', state.peers);
  renderPeer();
  if (!state.log.some((e) => e.who === 'peer' && e.id === payload.id && e.ts === s.ts)) {
    addLog({ who: 'peer', kind: 'state', id: payload.id, ...s });
  }
  if (live) {
    const m = moodFor(s.mood);
    toast(`${s.avatar} ${s.name} → ${m.emoji} ${m.label} (${s.mood}%)`, { kind: 'peer' });
    vibrate(40);
    notify(`${s.avatar} ${s.name}: ${m.emoji} ${m.label}`, s.note || `${s.mood}% — ${m.hint}`);
    bumpTitle();
    $('#peerView').classList.remove('flash');
    void $('#peerView').offsetWidth;
    $('#peerView').classList.add('flash');
  }
}

async function publishState({ republish = false } = {}) {
  if (!room?.key || !state.me.ts) return;
  const { name, avatar, id } = state.profile;
  const { mood, needs, note, ts } = state.me;
  try {
    await room.publish({ v: 1, kind: 'state', id, name, avatar, mood, needs, note, ts });
    state.lastPub = Date.now();
    store.set('lastPub', state.lastPub);
    if (state.pendingSend) {
      state.pendingSend = false;
      store.set('pendingSend', false);
    }
    if (!republish) renderSendStatus();
  } catch {
    if (!republish) {
      state.pendingSend = true;
      store.set('pendingSend', true);
      renderSendStatus('⚠ non inviato: riprovo appena torna la connessione');
    }
  }
}

function maybeRepublish() {
  if (state.pendingSend) publishState();
  else if (state.me.ts && Date.now() - state.lastPub > REPUBLISH_MS) publishState({ republish: true });
  const all = Object.values(state.todos);
  if (state.pendingTodos || (all.length && Date.now() - state.lastTodoPub > REPUBLISH_MS)) {
    publishTodos(all, { snapshot: true });
  }
}

async function startRoom() {
  room?.close();
  clearTimeout(helloTimer);
  helloTimer = 0;
  lastPeerSeen = 0;
  const current = (room = new Room(state.room, state.server));
  room.addEventListener('status', (e) => {
    setNet(e.detail);
    if (e.detail !== 'online') return;
    maybeRepublish();
    // ntfy rimanda subito i messaggi delle ultime ~12 ore. Se lì dentro non c'è niente
    // dall'altro telefono, gli chiediamo di ripubblicare umore e lista (una volta per stanza).
    if (helloTimer) return;
    helloTimer = setTimeout(() => {
      if (room === current && Date.now() - lastPeerSeen > 11 * 3600e3) {
        room.publish({ v: 1, kind: 'hello', id: state.profile.id }).catch(() => {});
      }
    }, 4000);
  });
  room.addEventListener('message', (e) => onMessage(e.detail));
  try {
    await room.init();
  } catch {
    setNet('offline');
    toast('Questo browser non supporta la crittografia necessaria (serve HTTPS).', { kind: 'error', timeout: 9000 });
    return;
  }
  room.connect();
}

function joinRoom(code, server = DEFAULT_SERVER) {
  const changed = code !== state.room;
  state.room = code;
  state.server = server;
  store.set('room', code);
  store.set('server', server);
  if (changed) {
    state.peers = {};
    store.set('peers', {});
    state.delivered = 0;
    store.set('delivered', 0);
    state.lastPub = 0;
    store.set('lastPub', 0);
    // Il nostro ultimo stato e la lista vanno reinviati nella nuova stanza.
    if (state.me.ts) {
      state.pendingSend = true;
      store.set('pendingSend', true);
    }
    state.lastTodoPub = 0;
    store.set('lastTodoPub', 0);
    if (Object.keys(state.todos).length) {
      state.pendingTodos = true;
      store.set('pendingTodos', true);
    }
  }
  fillShareBoxes();
  renderPeer();
  startRoom();
}

/* ---------- lista delle cose da fare (condivisa) ---------- */

// Ogni voce si sincronizza da sola: vince la versione con `updated` più recente.
// Le voci eliminate restano come tombstone per un po', così l'eliminazione arriva anche dall'altra parte.

function sanitizeTodo(t) {
  if (!t || typeof t !== 'object' || typeof t.id !== 'string' || !/^[0-9a-f]{8,32}$/.test(t.id)) return null;
  const created = Number(t.created);
  const updated = Number(t.updated);
  if (!Number.isFinite(created) || !Number.isFinite(updated) || updated > Date.now() + 5 * 60e3) return null;
  const deleted = t.deleted === true;
  const text = deleted ? '' : cleanText(t.text, 120);
  if (!deleted && !text) return null;
  return {
    id: t.id,
    text,
    done: t.done === true,
    deleted,
    created,
    updated,
    by: cleanText(t.by, 8) || '👤',
    byName: cleanText(t.byName, 24),
    doneBy: cleanText(t.doneBy, 8),
  };
}

// a vince su b? A parità di orario decide il contenuto, così i due telefoni arrivano allo stesso risultato.
function wins(a, b) {
  if (!b) return true;
  if (a.updated !== b.updated) return a.updated > b.updated;
  const key = (t) => `${t.deleted ? 1 : 0}${t.done ? 1 : 0}${t.text}`;
  return key(a) > key(b);
}

function saveTodos() {
  const cutoff = Date.now() - TOMBSTONE_MS;
  for (const [id, t] of Object.entries(state.todos)) {
    if (t.deleted && t.updated < cutoff) delete state.todos[id];
  }
  store.set('todos', state.todos);
}

function chunkTodos(items) {
  const chunks = [];
  let cur = [];
  for (const t of items) {
    cur.push(t);
    if (cur.length > 1 && utf8.encode(JSON.stringify(cur)).length > CHUNK_BYTES) {
      cur.pop();
      chunks.push(cur);
      cur = [t];
    }
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

function markTodosPending() {
  state.pendingTodos = true;
  store.set('pendingTodos', true);
}

// snapshot = tutta la lista ripubblicata per sincronizzare: dall'altra parte non genera avvisi.
async function publishTodos(items, { snapshot = false } = {}) {
  if (!room?.key) return markTodosPending();
  // Se un invio precedente è fallito, mandiamo tutta la lista così non si perde niente.
  if (state.pendingTodos) {
    items = Object.values(state.todos);
    snapshot = true;
  }
  const { id, name, avatar } = state.profile;
  try {
    for (const chunk of chunkTodos(items)) {
      await room.publish({ v: 1, kind: 'todos', id, name, avatar, snap: snapshot, items: chunk });
    }
    state.lastTodoPub = Date.now();
    store.set('lastTodoPub', state.lastTodoPub);
    if (state.pendingTodos) {
      state.pendingTodos = false;
      store.set('pendingTodos', false);
    }
  } catch {
    markTodosPending();
  }
}

function onTodos(payload, serverTime, live) {
  if (!Array.isArray(payload.items)) return;
  const name = cleanText(payload.name, 24) || '???';
  const avatar = cleanText(payload.avatar, 8) || '👤';
  const events = [];
  let changed = false;
  for (const raw of payload.items.slice(0, 2 * TODO_MAX)) {
    const t = sanitizeTodo(raw);
    if (!t) continue;
    const prev = state.todos[t.id];
    if (!wins(t, prev)) continue;
    state.todos[t.id] = t;
    changed = true;
    // Avvisiamo solo per modifiche appena fatte, non per le ripubblicazioni della lista intera.
    if (!live || payload.snap === true || t.deleted || t.updated < serverTime - 120e3) continue;
    if (!prev || prev.deleted) events.push(['📝', `ha aggiunto: ${t.text}`]);
    else if (t.done && !prev.done) events.push(['✅', `ha fatto: ${t.text}`]);
  }
  if (!changed) return;
  saveTodos();
  renderTodos();
  if (!events.length) return;
  const shown = events.length > 2 ? [['📝', `ha aggiornato la lista (${events.length} cose)`]] : events;
  for (const [icon, msg] of shown) toast(`${icon} ${avatar} ${name} ${msg}`, { kind: 'peer' });
  vibrate(30);
  notify(`${avatar} ${name}`, `${shown[0][0]} ${shown[0][1]}`);
  bumpTitle();
}

function commitTodos(items) {
  for (const t of items) state.todos[t.id] = t;
  saveTodos();
  renderTodos();
  publishTodos(items);
}

const bump = (t) => Math.max(Date.now(), t.updated + 1);

function addTodo(text) {
  const active = Object.values(state.todos).filter((t) => !t.deleted).length;
  if (active >= TODO_MAX) {
    toast(`La lista è piena (${TODO_MAX} voci): togli qualcosa di fatto.`, { kind: 'error' });
    return false;
  }
  const now = Date.now();
  const { avatar, name } = state.profile;
  commitTodos([{ id: uid(), text, done: false, deleted: false, created: now, updated: now, by: avatar, byName: name, doneBy: '' }]);
  return true;
}

function toggleTodo(id) {
  const prev = state.todos[id];
  if (!prev || prev.deleted) return;
  const done = !prev.done;
  commitTodos([{ ...prev, done, doneBy: done ? state.profile.avatar : '', updated: bump(prev) }]);
  if (done) vibrate(10);
}

function deleteTodo(id) {
  const prev = state.todos[id];
  if (!prev || prev.deleted) return;
  commitTodos([{ ...prev, deleted: true, text: '', updated: bump(prev) }]);
  const undo = document.createElement('div');
  undo.className = 'undo-toast';
  undo.innerHTML = `<span></span><button class="btn btn-small" type="button">Annulla</button>`;
  undo.firstChild.textContent = `🗑️ Eliminato: ${prev.text}`;
  undo.lastChild.addEventListener('click', () => {
    const cur = state.todos[id];
    if (cur?.deleted) commitTodos([{ ...prev, updated: bump(cur) }]);
  });
  toast(undo, { timeout: 6000 });
}

function clearDoneTodos() {
  const done = Object.values(state.todos).filter((t) => t.done && !t.deleted);
  if (done.length) commitTodos(done.map((t) => ({ ...t, deleted: true, text: '', updated: bump(t) })));
}

function renderTodos() {
  const list = $('#todoList');
  // Il rendering ricrea le righe: ricordiamo dov'era il focus per non perderlo (tastiera / screen reader).
  const focused = document.activeElement?.closest?.('.todo-item');
  const focusId = focused?.dataset.id;
  const focusDel = document.activeElement?.classList.contains('todo-del');

  const items = Object.values(state.todos).filter((t) => !t.deleted);
  const open = items.filter((t) => !t.done).sort((a, b) => a.created - b.created);
  const done = items.filter((t) => t.done).sort((a, b) => b.updated - a.updated);
  list.textContent = '';
  for (const t of [...open, ...done]) {
    const li = document.createElement('li');
    li.className = `todo-item${t.done ? ' done' : ''}`;
    li.dataset.id = t.id;
    li.innerHTML = `<label class="todo-check"><input type="checkbox"><span class="todo-box" aria-hidden="true"></span><span class="todo-text"></span></label><span class="todo-who"></span><button class="todo-del" type="button">×</button>`;
    $('input', li).checked = t.done;
    $('.todo-text', li).textContent = t.text;
    const who = $('.todo-who', li);
    who.textContent = t.by;
    who.title = t.byName ? `Aggiunto da ${t.byName}` : '';
    who.setAttribute('aria-label', who.title || 'Aggiunto');
    $('.todo-del', li).setAttribute('aria-label', `Elimina: ${t.text}`);
    list.append(li);
  }
  $('#todoEmpty').hidden = items.length > 0;
  $('#todoCount').textContent = open.length ? `${open.length} da fare` : items.length ? 'tutto fatto ✨' : '';
  $('#todoClear').hidden = !done.length;

  if (focusId) {
    const row = $(`.todo-item[data-id="${focusId}"]`, list);
    (row && $(focusDel ? '.todo-del' : 'input', row))?.focus({ preventScroll: true });
  }
}

function initTodos() {
  const input = $('#todoInput');
  $('#todoForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = cleanText(input.value, 120);
    if (!text) return input.focus();
    if (addTodo(text)) input.value = '';
    input.focus();
  });
  $('#todoList').addEventListener('change', (e) => {
    const row = e.target.closest('.todo-item');
    if (row && e.target.matches('input[type=checkbox]')) toggleTodo(row.dataset.id);
  });
  $('#todoList').addEventListener('click', (e) => {
    const del = e.target.closest('.todo-del');
    if (del) deleteTodo(del.closest('.todo-item').dataset.id);
  });
  $('#todoClear').addEventListener('click', clearDoneTodos);
}

/* ---------- eventi UI ---------- */

function initOnboarding() {
  let chosen = state.profile?.avatar || AVATARS[0];
  buildAvatarPicker($('#avatarPicker'), chosen, (a) => (chosen = a));

  $('#stepProfile').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = cleanText($('#nameInput').value, 24);
    if (!name) return $('#nameInput').focus();
    state.profile = { id: state.profile?.id || uid(), name, avatar: chosen };
    store.set('profile', state.profile);
    if (pendingJoin) {
      joinRoom(pendingJoin.code, pendingJoin.server);
      pendingJoin = null;
      toast('Sei dentro la stanza ✓');
    }
    route();
    if (state.room && !room) startRoom();
  });

  $('#createRoomBtn').addEventListener('click', () => {
    joinRoom(newRoomCode());
    show('stepShare');
  });

  $('#joinForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const { code, server } = parseRoomInput($('#joinInput').value);
    if (!isValidCode(code)) {
      $('#joinError').textContent = 'Codice non valido: sono 20 caratteri (lettere e numeri).';
      return;
    }
    $('#joinError').textContent = '';
    joinRoom(code, server);
    route();
  });

  $('#shareDoneBtn').addEventListener('click', route);
}

function initEditor() {
  meGauge = createGauge($('#meGauge'), {
    interactive: true,
    onInput(v, bucketChanged) {
      draft.mood = v;
      if (bucketChanged) vibrate(8);
      renderEditor();
    },
  });
  peerGauge = createGauge($('#peerGauge'));
  meGauge.set(draft.mood);

  $('#moodRange').addEventListener('input', (e) => {
    draft.mood = Number(e.target.value);
    meGauge.set(draft.mood);
    renderEditor();
  });

  const needs = $('#needPicker');
  for (const n of NEEDS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.dataset.key = n.key;
    b.innerHTML = `<span aria-hidden="true"></span> `;
    b.firstChild.textContent = n.emoji;
    b.append(n.label);
    b.addEventListener('click', () => {
      const i = draft.needs.indexOf(n.key);
      if (i >= 0) draft.needs.splice(i, 1);
      else draft.needs.push(n.key);
      renderEditor();
    });
    needs.append(b);
  }

  const note = $('#noteInput');
  note.value = draft.note;
  note.addEventListener('input', () => {
    draft.note = note.value.slice(0, 140);
    renderEditor();
  });

  $('#meForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const ts = Date.now();
    state.me = { mood: draft.mood, needs: NEEDS.map((n) => n.key).filter((k) => draft.needs.includes(k)), note: cleanText(draft.note, 140), ts };
    store.set('me', state.me);
    draft.note = state.me.note;
    const { name, avatar } = state.profile;
    addLog({ who: 'me', kind: 'state', name, avatar, ...state.me });
    renderEditor();
    renderSendStatus('⏳ invio…');
    $('#sendBtn').classList.remove('sent');
    void $('#sendBtn').offsetWidth;
    $('#sendBtn').classList.add('sent');
    vibrate(15);
    await publishState();
  });

  const pokes = $('#pokePicker');
  for (const p of POKES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip chip-poke';
    b.innerHTML = `<span aria-hidden="true"></span> `;
    b.firstChild.textContent = p.emoji;
    b.append(p.label);
    b.addEventListener('click', async () => {
      if (!room?.key) return;
      const { id, name, avatar } = state.profile;
      try {
        await room.publish({ v: 1, kind: 'poke', id, pid: uid(), name, avatar, emoji: p.emoji });
        addLog({ ts: Date.now(), who: 'me', kind: 'poke', name, avatar, emoji: p.emoji, label: p.label });
        toast(`${p.emoji} inviato!`);
        vibrate(15);
      } catch {
        toast('Niente connessione, riprova tra poco.', { kind: 'error' });
      }
    });
    pokes.append(b);
  }
}

function initSettings() {
  const dlg = $('#settings');
  let chosen = state.profile?.avatar;
  $('#settingsBtn').addEventListener('click', () => {
    chosen = state.profile.avatar;
    $('#setName').value = state.profile.name;
    buildAvatarPicker($('#setAvatar'), chosen, (a) => (chosen = a));
    $('#notifyToggle').checked = state.notify && 'Notification' in window && Notification.permission === 'granted';
    $('#switchInput').value = '';
    $('#switchError').textContent = '';
    fillShareBoxes();
    dlg.showModal();
  });
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg || e.target.closest('[data-close]')) dlg.close();
  });

  $('#profileForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = cleanText($('#setName').value, 24);
    if (!name) return;
    state.profile = { ...state.profile, name, avatar: chosen };
    store.set('profile', state.profile);
    renderProfile();
    if (state.me.ts) publishState({ republish: true });
    toast('Profilo salvato ✓');
  });

  $('#switchForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const { code, server } = parseRoomInput($('#switchInput').value);
    if (!isValidCode(code)) {
      $('#switchError').textContent = 'Codice non valido: sono 20 caratteri (lettere e numeri).';
      return;
    }
    joinRoom(code, server);
    dlg.close();
    toast('Stanza cambiata ✓');
  });

  $('#notifyToggle').addEventListener('change', async (e) => {
    if (!e.target.checked) {
      state.notify = false;
      store.set('notify', false);
      return;
    }
    if (!('Notification' in window)) {
      e.target.checked = false;
      toast('Notifiche non supportate qui. Su iPhone installa prima l’app nella Home.', { kind: 'error', timeout: 7000 });
      return;
    }
    const perm = await Notification.requestPermission();
    state.notify = perm === 'granted';
    store.set('notify', state.notify);
    e.target.checked = state.notify;
    if (!state.notify) toast('Permesso negato dal browser.', { kind: 'error' });
  });

  $('#resetBtn').addEventListener('click', () => {
    if (!confirm('Cancellare profilo, stanza e storico da questo dispositivo?')) return;
    room?.close();
    store.clear();
    location.hash = '';
    location.reload();
  });
}

function initInstall() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installEvent = e;
    $('#installBtn').hidden = false;
  });
  $('#installBtn').addEventListener('click', async () => {
    if (!installEvent) return;
    installEvent.prompt();
    await installEvent.userChoice.catch(() => {});
    installEvent = null;
    $('#installBtn').hidden = true;
  });
  window.addEventListener('appinstalled', () => {
    $('#installBtn').hidden = true;
  });
  if (matchMedia('(display-mode: standalone)').matches || navigator.standalone) {
    $('#installSection').hidden = true;
  }
}

/* ---------- avvio ---------- */

let pendingJoin = null;

function readHash() {
  if (!location.hash.includes('r=')) return;
  const parsed = parseRoomInput(location.hash);
  history.replaceState(null, '', location.pathname + location.search);
  if (!isValidCode(parsed.code)) {
    toast('Link della stanza non valido.', { kind: 'error' });
    return;
  }
  if (parsed.code === state.room) return;
  if (!state.profile) {
    pendingJoin = parsed;
    return;
  }
  if (state.room && !confirm('Questo link ti porta in un’altra stanza. Vuoi lasciare quella attuale?')) return;
  joinRoom(parsed.code, parsed.server);
  toast('Sei dentro la stanza ✓');
}

function init() {
  initOnboarding();
  initEditor();
  initSettings();
  initInstall();
  initTodos();
  renderEditor();
  renderTodos();
  renderLog();
  renderPeer();
  readHash();
  if (state.profile) $('#nameInput').value = state.profile.name;
  route();
  if (state.profile && state.room) {
    fillShareBoxes();
    if (!room) startRoom();
  }

  window.addEventListener('hashchange', () => {
    readHash();
    route();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    unseen = 0;
    document.title = 'Mood Meter';
    room?.wake();
    maybeRepublish();
  });
  window.addEventListener('online', () => room?.connect());
  setInterval(() => {
    renderPeerAgo();
    if (!isDirty()) renderSendStatus();
    if (document.visibilityState === 'visible') maybeRepublish();
  }, 30000);

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
