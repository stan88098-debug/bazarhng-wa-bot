import makeWASocket, { useMultiFileAuthState, DisconnectReason } from "@whiskeysockets/baileys";
import { processUserMessage } from "./src/services/groq.js";
import pino from "pino";

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info");

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: "silent" }), // Keeps logs clean
    printQRInTerminal: false, // We use pairing code instead
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

  // If not registered, request pairing code via phone number (Set your phone number in Railway env vars as PHONE_NUMBER, e.g., 23480xxxxxxxx)
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
    } else {
      console.log("⚠️ No PHONE_NUMBER environment variable set in Railway. Set it to generate a pairing code.");
    }
  }

  sock.ev.on("messages.upsert", async (m) => {
    const msg = m.messages[0];
    if (!msg || msg.key.fromMe) return;

    const jid = msg.key.remoteJid;
    if (!jid) return;

    const rawText =
      msg.message?.imageMessage?.caption ||
      msg.message?.conversation ||
      msg.message?.extendedTextMessage?.text ||
      "";

    const hasImage = !!msg.message?.imageMessage;

    if (!rawText && !hasImage) return;

    try {
      const response = await processUserMessage(rawText, hasImage);

      if (response.intent === "ADD_PRODUCT" && response.product && response.product.title && response.product.price) {
        const confirmText =
          `✅ *Added to your shop draft!*\n\n` +
          `📦 *Item:* ${response.product.title}\n` +
          `💰 *Price:* ₦${Number(response.product.price).toLocaleString()}\n` +
          `📊 *Stock:* ${response.product.stock || 1}\n\n` +
          `Check your BazarhNG dashboard to publish it live!`;

        await sock.sendMessage(jid, { text: confirmText });
      } else if (response.reply) {
        await sock.sendMessage(jid, { text: response.reply });
      }
    } catch (err) {
      console.error("Groq Handling Error:", err);
      await sock.sendMessage(jid, {
        text: "I had a small glitch processing that. Send the photo with the name and price in the caption!",
      });
    }
  });
}

connectToWhatsApp();
