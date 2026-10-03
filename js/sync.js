// Sincronizzazione tra i due telefoni.
//
// Usa un server ntfy (https://ntfy.sh di default, gratuito e senza account)
// come semplice bacheca pub/sub. Il codice della stanza non lascia mai il
// dispositivo: da esso si derivano
//   - il nome del "topic" ntfy (un hash, non reversibile)
//   - una chiave AES-GCM con cui ogni messaggio è cifrato end-to-end.
// Il server vede solo testo cifrato. ntfy.sh conserva i messaggi per ~12 ore,
// quindi l'app ripubblica periodicamente l'ultimo stato (vedi app.js).

export const DEFAULT_SERVER = 'https://ntfy.sh';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32
const CODE_LENGTH = 20; // 100 bit
const PREFIX = 'mm1.';
const enc = new TextEncoder();
const dec = new TextDecoder();

export function newRoomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  return Array.from(bytes, (b) => ALPHABET[b & 31]).join('');
}

export function normalizeCode(input) {
  return String(input || '')
    .toUpperCase()
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .split('')
    .filter((c) => ALPHABET.includes(c))
    .join('');
}

export function isValidCode(input) {
  return normalizeCode(input).length === CODE_LENGTH;
}

export function formatCode(input) {
  return (normalizeCode(input).match(/.{1,5}/g) || []).join('-');
}

function toHex(buf) {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

function toB64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(str) {
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

async function deriveRoom(code) {
  const base = await crypto.subtle.importKey('raw', enc.encode(code), 'HKDF', false, ['deriveKey', 'deriveBits']);
  const salt = enc.encode('moodmeter/v1');
  const topicBits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode('topic') },
    base,
    128,
  );
  const key = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode('aes-gcm') },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  return { topic: 'mm-' + toHex(topicBits), key };
}

export class Room extends EventTarget {
  constructor(code, server = DEFAULT_SERVER) {
    super();
    this.code = normalizeCode(code);
    this.server = String(server || DEFAULT_SERVER).replace(/\/+$/, '');
    this.status = 'idle';
    this.es = null;
    this.seen = new Set();
    this.retry = 0;
    this.retryTimer = 0;
    this.lastActivity = 0;
    this.watchdog = 0;
  }

  async init() {
    if (!this.key) Object.assign(this, await deriveRoom(this.code));
    return this;
  }

  connect() {
    this._closeStream();
    clearTimeout(this.retryTimer);
    this._setStatus('connecting');
    const es = new EventSource(`${this.server}/${this.topic}/sse?since=all`);
    this.es = es;
    const touch = () => {
      this.lastActivity = Date.now();
    };
    es.onopen = () => {
      touch();
      this.retry = 0;
      this._setStatus('online');
    };
    es.addEventListener('keepalive', touch);
    es.onmessage = (e) => {
      touch();
      this._onRaw(e.data);
    };
    es.onerror = () => {
      if (es !== this.es) return;
      if (es.readyState === EventSource.CLOSED) {
        this._setStatus('offline');
        this._scheduleReconnect();
      } else {
        this._setStatus('connecting');
      }
    };
    // ntfy manda un keepalive ogni ~45s: se tace troppo a lungo la connessione è morta.
    clearInterval(this.watchdog);
    this.watchdog = setInterval(() => {
      if (this.status === 'online' && Date.now() - this.lastActivity > 120000) this.connect();
    }, 30000);
  }

  // Da chiamare quando l'app torna in primo piano (su mobile gli stream muoiono in background).
  wake() {
    if (!this.es || this.status !== 'online' || Date.now() - this.lastActivity > 60000) this.connect();
  }

  close() {
    clearTimeout(this.retryTimer);
    clearInterval(this.watchdog);
    this._closeStream();
    this._setStatus('idle');
  }

  async publish(payload) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, this.key, enc.encode(JSON.stringify(payload))),
    );
    const blob = new Uint8Array(iv.length + ct.length);
    blob.set(iv);
    blob.set(ct, iv.length);
    // POST JSON sulla root: niente header custom, quindi nessuna richiesta CORS preflight.
    const res = await fetch(`${this.server}/`, {
      method: 'POST',
      body: JSON.stringify({ topic: this.topic, message: PREFIX + toB64url(blob) }),
    });
    if (!res.ok) throw new Error(`ntfy ${res.status}`);
  }

  async _onRaw(data) {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (msg.event !== 'message' || typeof msg.message !== 'string' || !msg.message.startsWith(PREFIX)) return;
    if (this.seen.has(msg.id)) return;
    this.seen.add(msg.id);
    try {
      const blob = fromB64url(msg.message.slice(PREFIX.length));
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: blob.slice(0, 12) }, this.key, blob.slice(12));
      const payload = JSON.parse(dec.decode(plain));
      this.dispatchEvent(new CustomEvent('message', { detail: { payload, serverTime: (msg.time || 0) * 1000 } }));
    } catch {
      // Messaggio non nostro o corrotto: ignorato.
    }
  }

  _scheduleReconnect() {
    clearTimeout(this.retryTimer);
    const delay = Math.min(30000, 1000 * 2 ** this.retry++);
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  _closeStream() {
    if (this.es) {
      this.es.onopen = this.es.onmessage = this.es.onerror = null;
      this.es.close();
      this.es = null;
    }
  }

  _setStatus(status) {
    if (status === this.status) return;
    this.status = status;
    this.dispatchEvent(new CustomEvent('status', { detail: status }));
  }
}
