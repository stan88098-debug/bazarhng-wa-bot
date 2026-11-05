const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  downloadMediaMessage
} = require('@whiskeysockets/baileys');

const pino = require('pino');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const AUTH_FOLDER = path.join(__dirname, 'auth_info');
if (!fs.existsSync(AUTH_FOLDER)) {
  fs.mkdirSync(AUTH_FOLDER, { recursive: true });
}

const BAZARH_API_URL = process.env.BAZARH_API_URL || 'https://your-bazarhng-site.netlify.app';
const BOT_API_SECRET = process.env.WHATSAPP_BOT_SECRET || 'bazarhng_secure_secret_123';

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
    },
    generateHighQualityLinkPreview: true,
    syncFullHistory: false,
    markOnlineOnConnect: true,
  });

  sock.ev.on('creds.update', saveCreds);

  // Auto pairing code logic for cloud deployment
  if (!sock.authState.creds.registered && process.env.BOT_PHONE) {
    setTimeout(async () => {
      try {
        let code = await sock.requestPairingCode(process.env.BOT_PHONE.replace(/[^0-9]/g, ''));
        code = code?.match(/.{1,4}/g)?.join('-') || code;
        console.log(`\n🔑 Your Pairing Code is: [ ${code} ]\n`);
      } catch (err) {
        console.error('Failed to request pairing code:', err.message);
      }
    }, 4000);
  }

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'close') {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Bot connection closed. Reconnecting:', shouldReconnect);
      if (shouldReconnect) startBot();
    } else if (connection === 'open') {
      console.log('✅ BazarhNG WhatsApp Bot is online!');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const from = msg.key.remoteJid;
    const senderPhone = from.split('@')[0];

    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      msg.message.imageMessage?.caption ||
      '';

    if (!text) return;
    const lowerText = text.toLowerCase().trim();

    if (lowerText === 'help' || lowerText === 'menu') {
      await sock.sendMessage(from, {
        text: `🛒 *BazarhNG Seller Bot*\n\nSend item details in this format to save a draft:\n\n` +
              `Title: Nike Air Force 1\n` +
              `Price: 45000\n` +
              `Description: Size 42-45 available\n` +
              `Category: Shoes\n\n` +
              `_You can attach a product photo with this text as the caption!_`
      });
      return;
    }

    if (lowerText.includes('title:') && lowerText.includes('price:')) {
      try {
        const lines = text.split('\n');
        let title = '';
        let price = '';
        let description = '';
        let category = '';

        lines.forEach(line => {
          const l = line.toLowerCase().trim();
          if (l.startsWith('title:')) title = line.substring(line.indexOf(':') + 1).trim();
          if (l.startsWith('price:')) price = line.replace(/[^0-9]/g, '');
          if (l.startsWith('description:')) description = line.substring(line.indexOf(':') + 1).trim();
          if (l.startsWith('category:')) category = line.substring(line.indexOf(':') + 1).trim();
        });

        if (!title || !price) {
          await sock.sendMessage(from, { text: '⚠️ Please include both *Title:* and *Price:*.' });
          return;
        }

        let base64Image = null;
        if (msg.message.imageMessage) {
          const buffer = await downloadMediaMessage(msg, 'buffer', {});
          base64Image = `data:image/jpeg;base64,${buffer.toString('base64')}`;
        }

        const response = await axios.post(`${BAZARH_API_URL}/api/whatsapp/ingest`, {
          phone: senderPhone,
          name: title,
          price: parseInt(price, 10),
          description,
          category,
          imageUrl: base64Image
        }, {
          headers: { 'Authorization': `Bearer ${BOT_API_SECRET}` }
        });

        if (response.data.success) {
          await sock.sendMessage(from, {
            text: `✅ *Draft Created!* \n\nItem *"${title}"* has been added to *${response.data.storeName}* as a draft. Log into your dashboard to confirm and post it live!`
          });
        }
      } catch (err) {
        console.error('API Error:', err.response?.data || err.message);
        await sock.sendMessage(from, {
          text: `❌ Could not save draft: ${err.response?.data?.message || 'Ensure your phone number matches an approved store.'}`
        });
      }
    }
  });
}

startBot().catch(console.error);
