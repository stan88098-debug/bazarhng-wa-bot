import makeWASocket, { useMultiFileAuthState, DisconnectReason, Browsers } from "@whiskeysockets/baileys";
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

let sock = null;
let isConnecting = false;

async function connectToWhatsApp() {
  if (isConnecting) return;
  isConnecting = true;

  const { state, saveCreds } = await useMultiFileAuthState("auth_info");

  sock = makeWASocket({
    auth: state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
    browser: Browsers.macOS("Chrome"),
    syncFullHistory: false,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 30000,
    retryRequestDelayMs: 3000,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === "close") {
      isConnecting = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const errorMessage = lastDisconnect?.error?.message;
      console.log(`Connection closed (Status: ${statusCode || 'unknown'}, Error: ${errorMessage || 'none'}). Reconnecting in 10s...`);
      
      const delay = statusCode === 440 ? 15000 : 5000;
      setTimeout(connectToWhatsApp, delay);
    } 
    else if (connection === "open") {
      isConnecting = false;
      console.log("\n==================================================");
      console.log("✅ WHATSAPP BOT CONNECTED & ONLINE SUCCESSFULLY!");
      console.log("==================================================\n");
    }
  });

  sock.ev.on("messages.upsert", async (m) => {
    try {
      console.log("🔔 messages.upsert event triggered:", JSON.stringify(m, null, 2));
      
      const msg = m.messages[0];
      if (!msg || msg.key.fromMe) return;

      const jid = msg.key.remoteJid;
      if (!jid) return;

      const senderPhone = jid.split("@")[0];
      console.log(`📥 Incoming message from JID: ${jid}, Phone: ${senderPhone}`);

      const rawText =
        msg.message?.imageMessage?.caption ||
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        "";

      const hasImage = !!msg.message?.imageMessage;
      console.log(`💬 Text: "${rawText}" | Has Image: ${hasImage}`);

      if (!rawText && !hasImage) {
        console.log("⚠️ Ignored: Message has no text or image content.");
        return;
      }

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
      } else {
        const replyText = response.reply || "Hello! 👋 Welcome to our store. Send a product picture with the title and price in the caption to add items to your shop!";
        await sock.sendMessage(jid, { text: replyText });
      }
    } catch (err) {
      console.error("❌ Message Processing Error:", err);
    }
  });
}

connectToWhatsApp();
