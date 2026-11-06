import makeWASocket, { useMultiFileAuthState, DisconnectReason } from "@whiskeysockets/baileys";
import { processUserMessage } from "./src/services/groq.js";
import { getStoreContextByPhone, insertProductDraft } from "./src/db.js";
import pino from "pino";

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info");

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === "close") {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log("Connection closed, reconnecting: ", shouldReconnect);
      if (shouldReconnect) {
        connectToWhatsApp();
      }
    } else if (connection === "open") {
      console.log("WhatsApp Bot Connected & Online Successfully!");
    }
  });

  if (!sock.authState.creds.registered) {
    const phoneNumber = process.env.PHONE_NUMBER;
    if (phoneNumber) {
      setTimeout(async () => {
        try {
          const code = await sock.requestPairingCode(phoneNumber);
          console.log(`\n========================================`);
          console.log(`PAIRING CODE FOR WHATSAPP: ${code}`);
          console.log(`========================================\n`);
        } catch (err) {
          console.error("Error requesting pairing code:", err);
        }
      }, 3000);
    }
  }

  sock.ev.on("messages.upsert", async (m) => {
    try {
      const msg = m.messages[0];
      if (!msg || msg.key.fromMe) return;

      const jid = msg.key.remoteJid;
      if (!jid || !jid.endsWith("@s.whatsapp.net")) return;

      const senderPhone = jid.split("@")[0];
      console.log(`📥 Incoming message from ${senderPhone}`);

      const rawText =
        msg.message?.imageMessage?.caption ||
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        "";

      const hasImage = !!msg.message?.imageMessage;
      console.log(`📝 Text: "${rawText}" | Image: ${hasImage}`);

      if (!rawText && !hasImage) return;

      // Fetch store context safely
      const storeContext = await getStoreContextByPhone(senderPhone);
      
      // Process with Groq
      const response = await processUserMessage(rawText, hasImage, storeContext);
      console.log("💡 Groq Intent:", response.intent);

      if (response.intent === "ADD_PRODUCT" && response.product && response.product.title && response.product.price) {
        let dbSaved = false;
        if (storeContext && storeContext.store) {
          const savedItem = await insertProductDraft(storeContext.store.id, response.product);
          if (savedItem) dbSaved = true;
        }

        const confirmText =
          `✅ *Added to your shop draft!*${dbSaved ? " (Saved to DB)" : ""}\n\n` +
          `📦 *Item:* ${response.product.title}\n` +
          `💰 *Price:* ₦${Number(response.product.price).toLocaleString()}\n` +
          `📊 *Stock:* ${response.product.stock || 1}\n\n` +
          `Check your BazarhNG dashboard to publish it live!`;

        await sock.sendMessage(jid, { text: confirmText });
      } else {
        await sock.sendMessage(jid, { text: response.reply || "Hello! I am your BazarhNG assistant." });
      }
      console.log("📤 Reply sent successfully!");
    } catch (err) {
      console.error("❌ CRITICAL HANDLER ERROR:", err);
    }
  });
}

connectToWhatsApp();
