import http from "http";
import fs from "fs";
import path from "path";
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  downloadMediaMessage,
} from "@whiskeysockets/baileys";
import { v2 as cloudinary } from "cloudinary";
import pino from "pino";

import {
  ensureSchema,
  getStoreContextByPhone,
  getStoreStats,
  insertProductDraft,
} from "./src/db.js";
import { processUserMessage } from "./src/services/groq.js";

cloudinary.config({
  cloud_name: String(process.env.CLOUDINARY_CLOUD_NAME || "").trim(),
  api_key: String(process.env.CLOUDINARY_API_KEY || "").trim(),
  api_secret: String(process.env.CLOUDINARY_API_SECRET || "").trim(),
});

const AUTH_DIR = path.join(process.cwd(), "auth_info");
const PORT = Number(process.env.PORT) || 10000;
const LOCK_FILE = path.join(process.cwd(), ".bot.instance.lock");
const PAIRING_NUMBER = "2347066568228";

// Force-wipe auth_info on fresh boot to guarantee pairing code prompt appears
try {
  if (fs.existsSync(AUTH_DIR)) {
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    console.log("[auth] Cleared old auth_info for fresh pairing code generation.");
  }
} catch (e) {
  console.error("[auth] clear error:", e.message);
}

function acquireInstanceLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const prev = Number(fs.readFileSync(LOCK_FILE, "utf8").trim());
      if (prev && prev !== process.pid) {
        try { process.kill(prev, 0); } catch {}
      }
    }
    fs.writeFileSync(LOCK_FILE, String(process.pid), "utf8");
  } catch (err) {}
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

function confirmationMessage(product, storeName) {
  return (
    `✅ Added to shop drafts for ${storeName}!\n\n` +
    `📦 Item: ${product.title}\n` +
    `💰 Price: ₦${formatNaira(product.price)}\n` +
    `📊 Stock: ${product.stock}\n\n` +
    `🔗 View Store: https://bazarhng.netlify.app\n\n` +
    `Log into your BazarhNG dashboard to publish it live!`
  );
}

async function uploadWhatsAppImageToCloudinary(msg) {
  try {
    const buffer = await downloadMediaMessage(
      msg,
      "buffer",
      {},
      { logger, reuploadRequest: sock => sock.updateMediaMessage }
    );
    if (!buffer) return null;

    const base64Data = `data:image/jpeg;base64,${buffer.toString("base64")}`;
    const result = await cloudinary.uploader.upload(base64Data, {
      folder: "bazarhng_products",
      resource_type: "auto"
    });
    return result?.secure_url || null;
  } catch (err) {
    console.error("[cloudinary] upload error:", err.message);
    return null;
  }
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
      browser: ["Chrome (Linux)", "Chrome", "120.0.0.0"],
      getMessage: async () => undefined,
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect } = update;
      
      if (connection === "open") {
        connecting = false;
        console.log("[wa] connected successfully and session saved permanently");
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      }

      if (connection === "close") {
        connecting = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        console.log(`[wa] connection closed, statusCode: ${statusCode}`);

        if (statusCode === DisconnectReason.loggedOut) {
          console.log("[wa] logged out by WhatsApp.");
          return;
        }

        if (!reconnectTimer) {
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            startSock();
          }, 5_000);
        }
      }
    });

    // Request pairing code immediately if unregistered
    if (!sock.authState.creds.registered) {
      setTimeout(async () => {
        try {
          console.log("[pairing] requesting pairing code for:", PAIRING_NUMBER);
          const code = await sock.requestPairingCode(PAIRING_NUMBER);
          console.log(`\n========================================`);
          console.log(`PAIRING CODE FOR ${PAIRING_NUMBER}: ${code}`);
          console.log(`========================================\n`);
        } catch (err) {
          console.error("[pairing] error requesting code:", err.message);
        }
      }, 5000);
    }

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      for (const msg of messages) {
        try {
          const remoteJid = msg.key.remoteJid;
          if (!msg.message || msg.key.fromMe || !remoteJid) continue;
          if (remoteJid.includes("status") || remoteJid.includes("newsletter") || remoteJid.endsWith("@g.us")) continue;

          const senderPhone = jidToPhone(remoteJid);
          if (!senderPhone) continue;

          const storeContext = await getStoreContextByPhone(senderPhone);
          if (!storeContext) continue;

          const rawText = extractText(msg).trim();
          const hasImage = hasImageMessage(msg);
          if (!rawText && !hasImage) continue;

          let imageUrl = null;
          if (hasImage) {
            console.log("[media] uploading product photo to Cloudinary...");
            imageUrl = await uploadWhatsAppImageToCloudinary(msg);
          }

          const storeStats = await getStoreStats(storeContext.id);
          const result = await processUserMessage(rawText, hasImage, storeContext, storeStats);
          console.log(`[ai] intent resolved for ${storeContext.name}: ${result.intent}`);

          if (result.intent === "ADD_PRODUCT") {
            if (imageUrl) {
              result.product.image_url = imageUrl;
            }
            if (result.product.title) {
              result.product.title = String(result.product.title).slice(0, 150);
            }

            const row = await insertProductDraft(storeContext.id, result.product);
            const body = confirmationMessage(row, storeContext.name);
            await sock.sendMessage(remoteJid, { text: body });
          } else {
            const replyText = result.reply || `Hello from ${storeContext.name}! How can I assist you today?`;
            await sock.sendMessage(remoteJid, { text: replyText });
          }
        } catch (err) {
          console.error("[msg] handler error:", err.message || err);
        }
      }
    });
  } catch (err) {
    connecting = false;
    console.error("[wa] startSock catch error:", err.message);
    if (!reconnectTimer) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        startSock();
      }, 10_000);
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
