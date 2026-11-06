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

let isPairingRequested = false;

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info");

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
    browser: Browsers.macOS("Chrome"),
    syncFullHistory: false,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 30000,
    retryRequestDelayMs: 2000,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const errorMessage = lastDisconnect?.error?.message;
      console.log(`Connection closed (Status: ${statusCode || 'unknown'}, Error: ${errorMessage || 'none'}). Reconnecting in 5s...`);
      
      if (statusCode !== DisconnectReason.loggedOut) {
        setTimeout(connectToWhatsApp, 5000);
      } else {
        console.log("Device logged out. Clearing auth_info...");
        fs.rmSync("auth_info", { recursive: true, force: true });
        setTimeout(connectToWhatsApp, 5000);
      }
    } 
    else if (connection === "open") {
      console.log("\n==================================================");
      console.log("✅ WHATSAPP BOT CONNECTED & ONLINE SUCCESSFULLY!");
      console.log("==================================================\n");
    }
  });

  sock.ev.on("messages.upsert", async (m) => {
    try {
      const msg = m.messages[0];
      if (!msg || msg.key.fromMe) return;

      const jid = msg.key.remoteJid;
      if (!jid || !jid.endsWith("@s.whatsapp.net")) return;

      const senderPhone = jid.split("@")[0];
      console.log(`\n📥 Raw Message received from JID: ${jid}`);

      const rawText =
        msg.message?.imageMessage?.caption ||
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        "";

      const hasImage = !!msg.message?.imageMessage;
      console.log(`💬 Extracted Text: "${rawText}" | Has Image: ${hasImage}`);

      if (!rawText && !hasImage) return;

      const storeContext = await getStoreContextByPhone(senderPhone);
      console.log(`🏪 Store Context Found for ${senderPhone}:`, storeContext ? storeContext.store.name : "None");

      const response = await processUserMessage(rawText, hasImage, storeContext);
      console.log(`🤖 Groq Response Intent:`, response.intent, `| Reply:`, response.reply);

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
