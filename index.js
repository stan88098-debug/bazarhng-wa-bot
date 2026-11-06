import makeWASocket, { useMultiFileAuthState, DisconnectReason } from "@whiskeysockets/baileys";
import { processUserMessage } from "./src/services/groq.js";
import { getStoreContextByPhone, insertProductDraft } from "./src/db.js";
import http from "http";
import pino from "pino";

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
    browser: ["Chrome", "Macintosh", "120.0.0.0"],
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !sock.authState.creds.registered && !isPairingRequested) {
      isPairingRequested = true;
      const phoneNumber = process.env.PHONE_NUMBER;
      
      if (phoneNumber) {
        setTimeout(async () => {
          try {
            const cleanPhone = phoneNumber.replace(/[^0-9]/g, "");
            console.log(`Requesting pairing code for ${cleanPhone}...`);
            const code = await sock.requestPairingCode(cleanPhone);
            console.log(`\n========================================`);
            console.log(`👉 PAIRING CODE FOR WHATSAPP: ${code} 👈`);
            console.log(`========================================\n`);
          } catch (err) {
            console.error("Pairing code error:", err.message);
            isPairingRequested = false;
          }
        }, 5000);
      }
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      console.log(`Connection closed (Status: ${statusCode}). Reconnecting in 5s...`);
      setTimeout(connectToWhatsApp, 5000);
    } 
    else if (connection === "open") {
      console.log("\n==================================================");
      console.log("✅ WHATSAPP BOT CONNECTED & ONLINE SUCCESSFULLY!");
      console.log("==================================================\n");
      isPairingRequested = false;
    }
  });

  sock.ev.on("messages.upsert", async (m) => {
    try {
      const msg = m.messages[0];
      if (!msg || msg.key.fromMe) return;

      const jid = msg.key.remoteJid;
      if (!jid || !jid.endsWith("@s.whatsapp.net")) return;

      const senderPhone = jid.split("@")[0];
      console.log(`\n📥 Message received from ${senderPhone}`);

      const rawText =
        msg.message?.imageMessage?.caption ||
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        "";

      const hasImage = !!msg.message?.imageMessage;
      if (!rawText && !hasImage) return;

      const storeContext = await getStoreContextByPhone(senderPhone);
      const response = await processUserMessage(rawText, hasImage, storeContext);

      if (response.intent === "ADD_PRODUCT" && response.product?.title && response.product?.price) {
        let dbSaved = false;
        if (storeContext?.store) {
          const savedItem = await insertProductDraft(storeContext.store.id, response.product);
          if (savedItem) dbSaved = true;
        }

        const confirmText =
          `✅ *Added to shop drafts!*${dbSaved ? " (Saved to Database)" : ""}\n\n` +
          `📦 *Item:* ${response.product.title}\n` +
          `💰 *Price:* ₦${Number(response.product.price).toLocaleString()}\n` +
          `📊 *Stock:* ${response.product.stock || 1}\n\n` +
          `Log into your BazarhNG dashboard to publish it live!`;

        await sock.sendMessage(jid, { text: confirmText });
      } else if (response.reply) {
        await sock.sendMessage(jid, { text: response.reply });
      }
    } catch (err) {
      console.error("❌ Message Processing Error:", err);
    }
  });
}

connectToWhatsApp();
