import { WASocket } from "@whiskeysockets/baileys";
import { processUserMessage } from "../services/groq";

export function setupBotHandlers(sock: WASocket) {
  sock.ev.on("messages.upsert", async (m) => {
    const msg = m.messages[0];
    if (!msg || msg.key.fromMe) return;

    const jid = msg.key.remoteJid;
    if (!jid) return;

    // Capture captions across multi-line text or regular messages
    const rawCaption =
      msg.message?.imageMessage?.caption ||
      msg.message?.conversation ||
      msg.message?.extendedTextMessage?.text ||
      "";

    if (!rawCaption && !msg.message?.imageMessage) return;

    const hasImage = !!msg.message?.imageMessage;
    const response = await processUserMessage(rawCaption, hasImage);

    if (response.intent === "ADD_PRODUCT" && response.product?.title && response.product?.price) {
      const confirmText = 
        `✅ *Added to your shop draft!*\n\n` +
        `📦 *Item:* ${response.product.title}\n` +
        `💰 *Price:* ₦${response.product.price.toLocaleString()}\n` +
        `📊 *Stock:* ${response.product.stock}\n\n` +
        `Check your BazarhNG dashboard to publish it live!`;

      await sock.sendMessage(jid, { text: confirmText });
    } else if (response.reply) {
      await sock.sendMessage(jid, { text: response.reply });
    }
  });
}

/**
 * Send real-time store activity notifications to vendors
 */
export async function sendVendorNotification(
  sock: WASocket,
  vendorPhoneJid: string,
  event: { type: "NEW_ORDER" | "OUT_OF_STOCK" | "PAYOUT"; data: any }
) {
  let messageText = "";

  switch (event.type) {
    case "NEW_ORDER":
      messageText = 
        `🎉 *NEW ORDER RECEIVED!*\n\n` +
        `🛒 *Order ID:* #${event.data.orderId}\n` +
        `📦 *Item:* ${event.data.itemTitle}\n` +
        `💵 *Amount:* ₦${event.data.amount.toLocaleString()}\n` +
        `👤 *Customer:* ${event.data.customerName} (${event.data.customerPhone})\n\n` +
        `Open your dashboard to fulfill delivery!`;
      break;

    case "OUT_OF_STOCK":
      messageText = 
        `⚠️ *STOCK ALERT*\n\n` +
        `Your item *${event.data.itemTitle}* is out of stock. Update your quantity on the dashboard.`;
      break;

    case "PAYOUT":
      messageText = 
        `💸 *PAYOUT CONFIRMED*\n\n` +
        `₦${event.data.amount.toLocaleString()} has been sent to your bank account.`;
      break;
  }

  if (messageText) {
    await sock.sendMessage(vendorPhoneJid, { text: messageText });
  }
}
