import makeWASocket, { useMultiFileAuthState, DisconnectReason } from "@whiskeysockets/baileys";
import { processUserMessage } from "./src/services/groq.js";
import { getStoreContextByPhone, insertProductDraft } from "./src/db.js";
import http from "http";
import pino from "pino";
import fs from "fs";

const PORT = process.env.PORT || 10000;
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("BazarhNG Bot Service Active\n");
}).listen(PORT, () => {
  console.log(`🚀 Render HTTP Health Check server listening on port ${PORT}`);
});

let isPairingRequested = false;

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info");

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 0,
    keepAliveIntervalMs: 25000,
    browser: ["Ubuntu", "Chrome", "20.0.04"],
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      console.log(`Connection closed (Status: ${statusCode}). Reconnecting...`);
      if (statusCode === DisconnectReason.loggedOut) {
        fs.rmSync("auth_info", { recursive: true, force: true });
        isPairingRequested = false;
      }
      setTimeout(connectToWhatsApp, 5000);
    } else if (connection === "open") {
      console.log("✅ WHATSAPP BOT CONNECTED & ONLINE SUCCESSFULLY!");
      isPairingRequested = false;
    }
  });

  if (!sock.authState.creds.registered && !isPairingRequested) {
    isPairingRequested = true;
    const phoneNumber = process.env.PHONE_NUMBER;
    if (phoneNumber) {
      setTimeout(async () => {
        try {
          const cleanPhone = phoneNumber.replace(/[^0-9]/g, "");
          const code = await sock.requestPairingCode(cleanPhone);
          console.log(`👉 PAIRING CODE FOR WHATSAPP: ${code} 👈`);
        } catch (err) {
          console.error("Pairing error:", err.message);
          isPairingRequested = false;
        }
      }, 10000);
    }
  }

  // Catch-all raw event logger to see if WhatsApp is talking to us
  sock.ev.on("messages.upsert", async (m) => {
    console.log("🔥 RAW MESSAGES EVENT FIRED:", JSON.stringify(m, null, 2));
    try {
      const msg = m.messages[0];
      if (!msg) return;
      
      console.log("📥 Message payload detected from:", msg.key.remoteJid);
      if (msg.key.fromMe) {
        console.log("⚠️ Ignored: Message sent by self.");
        return;
      }

      const jid = msg.key.remoteJid;
      const senderPhone = jid.split("@")[0];
      const rawText =
        msg.message?.imageMessage?.caption ||
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        "";

      const hasImage = !!msg.message?.imageMessage;
      console.log(`📝 Text: "${rawText}" | Image: ${hasImage}`);

      if (!rawText && !hasImage) return;

      const storeContext = await getStoreContextByPhone(senderPhone);
      const response = await processUserMessage(rawText, hasImage, storeContext);

      if (response.intent === "ADD_PRODUCT" && response.product?.title && response.product?.price) {
        let dbSaved = false;
        if (storeContext?.store) {
          const savedItem = await insertProductDraft(storeContext.store.id, response.product);
          if (savedItem) dbSaved = true;
        }
        await sock.sendMessage(jid, {
          text: `✅ *Added to shop drafts!*${dbSaved ? " (Saved to Database)" : ""}\n\n📦 *Item:* ${response.product.title}\n💰 *Price:* ₦${Number(response.product.price).toLocaleString()}`
        });
      } else if (response.reply) {
        await sock.sendMessage(jid, { text: response.reply });
      }
    } catch (err) {
      console.error("❌ Error handling message:", err);
    }
  });
}

connectToWhatsApp();
