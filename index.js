import http from "http";
import fs from "fs";
import path from "path";
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} from "@whiskeysockets/baileys";
import pino from "pino";
import { Boom } from "@hapi/boom";

import {
  ensureSchema,
  getStoreContextByPhone,
  insertProductDraft,
} from "./src/db.js";
import { processUserMessage } from "./src/services/groq.js";

const AUTH_DIR = path.join(process.cwd(), "auth_info");
const PORT = Number(process.env.PORT) || 10000;
const LOCK_FILE = path.join(process.cwd(), ".bot.instance.lock");

function acquireInstanceLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const prev = Number(fs.readFileSync(LOCK_FILE, "utf8").trim());
      if (prev && prev !== process.pid) {
        try {
          process.kill(prev, 0);
          console.error(`[guard] another bot instance is running (pid ${prev}). Exit.`);
          process.exit(1);
        } catch {}
      }
    }
    fs.writeFileSync(LOCK_FILE, String(process.pid), "utf8");
  } catch (err) {
    console.error("[guard] lock failed:", err.message);
    process.exit(1);
  }
}

function releaseInstanceLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const cur = Number(fs.readFileSync(LOCK_FILE, "utf8").trim());
      if (cur === process.pid) fs.unlinkSync(LOCK_FILE);
    }
  } catch {}
}

process.on("exit", releaseInstanceLock);
process.on("SIGINT", () => { releaseInstanceLock(); process.exit(0); });
process.on("SIGTERM", () => { releaseInstanceLock(); process.exit(0); });

acquireInstanceLock();

const healthServer = http.createServer((req, res) => {
  if (req.url === "/health" || req.url === "/") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "bazarhng-whatsapp-bot", pid: process.pid }));
    return;
  }
  res.writeHead(404);
  res.end();
});

healthServer.listen(PORT, () => {
  console.log(`[http] health server on :${PORT}`);
});

const logger = pino({ level: "silent" });

function jidToPhone(jid) {
  if (!jid) return "";
  return String(jid).split("@")[0].split(":")[0];
}

function extractText(msg) {
  const m = msg.message || {};
  return m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.videoMessage?.caption || m.documentMessage?.caption || "";
}

function hasImageMessage(msg) {
  return Boolean(msg.message?.imageMessage);
}

function formatNaira(n) {
  const num = Number(n) || 0;
  return num.toLocaleString("en-NG");
}

function confirmationMessage(product) {
  return (
    `✅ Added to shop drafts!\n\n` +
    `📦 Item: ${product.title}\n` +
    `💰 Price: ₦${formatNaira(product.price)}\n` +
    `📊 Stock: ${product.stock}\n\n` +
    `Log into your BazarhNG dashboard to publish it live!`
  );
}

let sock = null;
let reconnectTimer = null;
let connecting = false;

async function startSock() {
  if (connecting) return;
  connecting = true;

  try {
    if (!fs.existsSync(AUTH_DIR)) {
      fs.mkdirSync(AUTH_DIR, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      logger,
      printQRInTerminal: false,
      syncFullHistory: false,
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,
      browser: ["BazarhNG", "Chrome", "1.0.0"],
      getMessage: async () => undefined,
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect } = update;
      if (connection === "open") {
        connecting = false;
        console.log("[wa] connected");
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      }
      if (connection === "close") {
        connecting = false;
        if (!reconnectTimer) {
          reconnectTimer = setTimeout(() => { reconnectTimer = null; startSock(); }, 5_000);
        }
      }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;

      for (const msg of messages) {
        try {
          if (!msg.message || msg.key.fromMe || msg.key.remoteJid === "status@broadcast" || msg.key.remoteJid?.endsWith("@g.us")) continue;

          const remoteJid = msg.key.remoteJid;
          const senderPhone = jidToPhone(remoteJid);
          if (!senderPhone) continue;

          const rawText = extractText(msg).trim();
          const hasImage = hasImageMessage(msg);
          if (!rawText && !hasImage) continue;

          const storeContext = await getStoreContextByPhone(senderPhone);
          if (!storeContext) {
            await sock.sendMessage(remoteJid, { text: "⚠️ No business store found linked to this WhatsApp number." });
            continue;
          }

          const result = await processUserMessage(rawText, hasImage, storeContext);

          if (result.intent === "ADD_PRODUCT") {
            const row = await insertProductDraft(storeContext.id, result.product);
            const body = confirmationMessage(row);
            await sock.sendMessage(remoteJid, { text: body });
            console.log(`[product] draft #${row.id} for store ${storeContext.id}: ${row.title}`);
          } else {
            await sock.sendMessage(remoteJid, { text: result.reply || `Hi from ${storeContext.name}! How can I help your shop today?` });
          }
        } catch (err) {
          console.error("[msg] handler error:", err.message || err);
          try {
            if (msg?.key?.remoteJid) {
              await sock.sendMessage(msg.key.remoteJid, { text: "Something went wrong saving that. Please try again in a moment." });
            }
          } catch {}
        }
      }
    });
  } catch (err) {
    connecting = false;
    if (!reconnectTimer) {
      reconnectTimer = setTimeout(() => { reconnectTimer = null; startSock(); }, 10_000);
    }
  }
}

(async () => {
  try {
    await ensureSchema();
  } catch (err) {
    console.error("[boot] schema failed:", err.message || err);
    process.exit(1);
  }
  await startSock();
})();
