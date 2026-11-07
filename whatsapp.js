import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  normalizeMessageContent,
  Browsers,
} from '@whiskeysockets/baileys';
import * as db from './db.js';
import { runAgent, describeImage, transcribe } from './ai.js';
import { uploadProductImage } from './media.js';
import { createToolbox, toolDefs } from './tools.js';
import { t } from './i18n.js';
import { detectLang, clip } from './util.js';

const AUTH_DIR = 'auth_info';
const SITE = 'https://bazarhng.netlify.app';
const PAIRING_NUMBER = (process.env.PAIRING_NUMBER || '2347066568228').replace(/\D/g, '');
const MAX_ATTEMPTS = 8;
const MAX_PHOTOS = 6;
const PHOTO_TTL = 15 * 60 * 1000;
const RATE_LIMIT = 20; // messages per minute per vendor
const log = pino({ level: process.env.LOG_LEVEL || 'info' });

let attempts = 0;
let stopped = false;
const rejected = new Map(); // phone -> last rejection time
const seen = new Set();     // message id dedupe
const states = new Map();   // phone -> per-vendor working state
const queues = new Map();   // phone -> promise chain (one message at a time per vendor)

const toolbox = createToolbox({ db, media: { uploadProductImage }, siteUrl: SITE, log });
const storeUrl = (biz) => `${SITE}/store/${biz.slug}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getState(phone) {
  let st = states.get(phone);
  if (!st) {
    st = { history: null, photos: [], pending: null, lastTouched: null, turn: 0, hits: [], flushTimer: null, flushToken: 0, lang: 'en', warnedAt: 0, active: Date.now() };
    states.set(phone, st);
  }
  st.active = Date.now();
  return st;
}
setInterval(() => {
  const cutoff = Date.now() - 6 * 3600 * 1000;
  for (const [k, v] of states) if (v.active < cutoff && !v.flushTimer) states.delete(k);
}, 30 * 60 * 1000).unref();

function enqueue(phone, fn) {
  const prev = queues.get(phone) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  queues.set(phone, next);
  next.catch(() => {}).finally(() => { if (queues.get(phone) === next) queues.delete(phone); });
  return next;
}

// ---------- session persistence (Neon) ----------
async function restoreSession() {
  if (fs.existsSync(path.join(AUTH_DIR, 'creds.json'))) return;
  try {
    const rows = await db.loadSessionFiles();
    if (!rows.length) return;
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    for (const r of rows) fs.writeFileSync(path.join(AUTH_DIR, r.file), r.data);
    log.info(`Restored ${rows.length} session files from database`);
  } catch (e) {
    log.warn({ err: e.message }, 'Session restore failed');
  }
}

async function syncSessionNow() {
  for (const f of fs.readdirSync(AUTH_DIR)) {
    await db.saveSessionFile(f, fs.readFileSync(path.join(AUTH_DIR, f), 'utf8'));
  }
}
let syncTimer;
function scheduleSessionSync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(async () => {
    try { await syncSessionNow(); } catch (e) { log.warn({ err: e.message }, 'Session sync failed'); }
  }, 2000);
}
export async function flushSession() {
  clearTimeout(syncTimer);
  try { if (fs.existsSync(AUTH_DIR)) await syncSessionNow(); } catch (e) { log.warn({ err: e.message }, 'Final session sync failed'); }
}

// ---------- helpers ----------
function senderPhone(m) {
  const k = m.key;
  const jid = [k.remoteJidAlt, k.senderPn, k.remoteJid].find((j) => j && j.endsWith('@s.whatsapp.net'));
  return jid ? jid.split('@')[0].split(':')[0] : null;
}

function backoffMs(code) {
  const base = code === 440 ? 30000 : 2000;
  return Math.min(base * 2 ** Math.max(0, attempts - 1), 5 * 60 * 1000);
}

const getMedia = (sock, m) =>
  downloadMediaMessage(m, 'buffer', {}, { logger: log, reuploadRequest: sock.updateMediaMessage });

const freshPhotos = (st) => {
  st.photos = st.photos.filter((p) => Date.now() - p.ts < PHOTO_TTL);
  return st.photos;
};

async function ensureHistory(st, phone) {
  if (st.history) return;
  try { st.history = await db.loadChat(phone); } catch { st.history = []; }
}

// ---------- one conversation turn ----------
async function runTurn({ sock, jid, biz, phone, text, heard = null, noteForHistory = null }) {
  const st = getState(phone);
  const lang = detectLang(text) !== 'en' ? detectLang(text) : st.lang;
  st.lang = lang;
  const send = (msg) => sock.sendMessage(jid, { text: msg });

  await sock.sendPresenceUpdate('composing', jid).catch(() => {});
  await ensureHistory(st, phone);

  const photos = freshPhotos(st);
  if (photos.length && photos[0].vision === undefined) photos[0].vision = await describeImage(photos[0].buffer, photos[0].mime);

  const stats = await db.getStoreStats(biz.id);
  st.turn += 1;
  const ctx = { biz, st, turn: st.turn, cards: [] };

  let reply = '';
  try {
    reply = await runAgent({
      text,
      biz,
      stats,
      history: st.history,
      tools: toolDefs({ hasOrders: db.hasOrders() }),
      execTool: (name, args) => toolbox.exec(name, args, ctx),
      ctx: {
        now: new Date().toLocaleString('en-NG', { timeZone: 'Africa/Lagos', dateStyle: 'full', timeStyle: 'short' }),
        storeUrl: storeUrl(biz),
        siteUrl: SITE,
        photos,
        lastTouched: st.lastTouched,
        pending: st.pending && st.pending.expires > Date.now() ? st.pending : null,
      },
    });
  } catch (e) {
    log.error({ err: e.message }, 'AI failed');
    if (!ctx.cards.length) reply = t(lang, 'aiDown');
  }

  const final = [heard ? `🎙 “${clip(heard, 300)}”` : null, reply.trim() || null, ctx.cards.join('\n\n') || null]
    .filter(Boolean)
    .join('\n\n') || t(lang, 'error');
  await send(final);
  await sock.sendPresenceUpdate('paused', jid).catch(() => {});

  st.history.push(
    { role: 'user', content: clip(noteForHistory || text, 1200) },
    { role: 'assistant', content: clip(final, 1500) }
  );
  st.history = st.history.slice(-16);
  db.saveChat(phone, st.history).catch(() => {});
}

// ---------- incoming messages ----------
async function handleMessage(sock, m) {
  const jid = m.key.remoteJid;
  if (!jid || jid.endsWith('@g.us') || jid === 'status@broadcast' || m.key.fromMe) return;
  if (!m.message || seen.has(m.key.id)) return;
  seen.add(m.key.id);
  if (seen.size > 500) seen.delete(seen.values().next().value);

  const content = normalizeMessageContent(m.message);
  const text = (content?.conversation || content?.extendedTextMessage?.text || content?.imageMessage?.caption || '').trim();
  const hasImage = !!content?.imageMessage;
  const audio = content?.audioMessage || null;
  if (!text && !hasImage && !audio) return;

  const phone = senderPhone(m);
  if (!phone) {
    log.warn({ jid }, 'Could not resolve sender phone (LID without alt). Ignoring.');
    return;
  }
  const send = (msg) => sock.sendMessage(jid, { text: msg });

  const biz = await db.getBusinessByPhone(phone);
  if (!biz) {
    if (Date.now() - (rejected.get(phone) || 0) > 24 * 3600 * 1000) {
      rejected.set(phone, Date.now());
      await send(`Sorry, this number is not registered on BazarhNG. / Number no dey registered. Create your store: ${SITE}`);
    }
    return;
  }

  const st = getState(phone);
  if (!biz.is_active) { await send(t(st.lang, 'inactive')); return; }

  // simple per-vendor rate limit
  const now = Date.now();
  st.hits = st.hits.filter((h) => now - h < 60000);
  st.hits.push(now);
  if (st.hits.length > RATE_LIMIT) {
    if (now - st.warnedAt > 60000) { st.warnedAt = now; await send(t(st.lang, 'rateLimited')); }
    return;
  }

  await enqueue(phone, async () => {
    sock.readMessages([m.key]).catch(() => {});

    // Photos: keep them for the next product action (albums arrive as several messages)
    if (hasImage) {
      try {
        const buffer = await getMedia(sock, m);
        if (freshPhotos(st).length < MAX_PHOTOS) st.photos.push({ buffer, mime: content.imageMessage.mimetype || 'image/jpeg', ts: Date.now() });
      } catch (e) {
        log.error({ err: e.message }, 'Photo download failed');
        await send(t(st.lang, 'error'));
        return;
      }
    }

    // Voice notes -> text
    let heard = null;
    let userText = text;
    if (audio) {
      if ((audio.seconds || 0) > 120) { await send(t(st.lang, 'voiceTooLong')); return; }
      try {
        const buf = await getMedia(sock, m);
        heard = await transcribe(buf, audio.mimetype || 'audio/ogg');
      } catch (e) {
        log.error({ err: e.message }, 'Transcription failed');
      }
      if (!heard) { await send(t(st.lang, 'voiceFail')); return; }
      userText = heard;
    }

    // Photo(s) with no words: wait a moment for more photos or the details, then respond once
    if (!userText) {
      const token = ++st.flushToken;
      clearTimeout(st.flushTimer);
      st.flushTimer = setTimeout(() => {
        st.flushTimer = null;
        enqueue(phone, async () => {
          if (token !== st.flushToken || !freshPhotos(st).length) return;
          const n = st.photos.length;
          try {
            await runTurn({ sock, jid, biz, phone, text: `(The vendor sent ${n} photo${n > 1 ? 's' : ''} with no text.)`, noteForHistory: `[sent ${n} photo${n > 1 ? 's' : ''}]` });
          } catch (e) {
            log.error({ err: e.message, stack: e.stack }, 'Photo turn failed');
            await send(t(st.lang, 'error')).catch(() => {});
          }
        });
      }, 2500);
      return;
    }

    // A real message arrived: cancel any pending photo-only reply, it is handled right now
    st.flushToken++;
    clearTimeout(st.flushTimer);
    st.flushTimer = null;

    const n = freshPhotos(st).length;
    await runTurn({ sock, jid, biz, phone, text: userText, heard, noteForHistory: n ? `${userText} [with ${n} photo${n > 1 ? 's' : ''}]` : null });
  });
}

// ---------- connection ----------
export async function startWhatsApp() {
  if (stopped) return;
  await restoreSession();

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: Browsers.ubuntu('Chrome'),
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });

  sock.ev.on('creds.update', async () => {
    await saveCreds();
    scheduleSessionSync();
  });

  // Pairing code (no QR), only while not registered
  if (!sock.authState.creds.registered) {
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(PAIRING_NUMBER);
        const pretty = code?.match(/.{1,4}/g)?.join('-') || code;
        console.log(`\n========================================\n PAIRING CODE: ${pretty}\n WhatsApp > Linked Devices > Link with phone number\n========================================\n`);
      } catch (e) {
        log.error({ err: e.message }, 'Pairing code request failed');
      }
    }, 3000);
  }

  sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    if (connection === 'open') {
      attempts = 0;
      log.info('WhatsApp connected');
      scheduleSessionSync();
    }
    if (connection !== 'close') return;

    const code = lastDisconnect?.error?.output?.statusCode;
    log.warn(`Connection closed (code ${code})`);

    if (code === DisconnectReason.loggedOut) {
      stopped = true;
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      await db.clearSession().catch(() => {});
      log.error('Logged out from WhatsApp. Session cleared. Restart the service to pair again. Not retrying.');
      return;
    }

    attempts += 1;
    if (attempts > MAX_ATTEMPTS) {
      stopped = true;
      log.error(`Gave up after ${MAX_ATTEMPTS} failed reconnects. Restart the service to try again.`);
      return;
    }
    const wait = backoffMs(code);
    log.info(`Reconnecting in ${Math.round(wait / 1000)}s (attempt ${attempts}/${MAX_ATTEMPTS})`);
    await sleep(wait);
    startWhatsApp().catch((e) => log.error({ err: e.message }, 'Restart failed'));
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const m of messages) {
      try {
        await handleMessage(sock, m);
      } catch (e) {
        log.error({ err: e.message, stack: e.stack }, 'Message handling failed');
        const jid = m.key?.remoteJid;
        const phone = senderPhone(m);
        if (jid && !m.key.fromMe && !jid.endsWith('@g.us')) {
          await sock.sendMessage(jid, { text: t(states.get(phone)?.lang || 'en', 'error') }).catch(() => {});
        }
      }
    }
  });
}
