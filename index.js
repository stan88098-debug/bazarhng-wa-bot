import makeWASocket, { useMultiFileAuthState } from '@whiskeysockets/baileys';
import pkg from 'pg';
import Groq from 'groq-sdk';
import fetch from 'node-fetch';

const { Pool } = pkg;

// Neon PostgreSQL connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Groq AI client
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const BOT_SECRET = process.env.WHATSAPP_BOT_SECRET || 'bazarhng_sec_99f4a8b2c1e7';
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://bazarhng.netlify.app';

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  const sock = makeWASocket({ 
    auth: state, 
    printQRInTerminal: true 
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const m = messages[0];
    if (!m.message || m.key.fromMe) return;

    const senderJid = m.key.remoteJid;
    const rawPhone = senderJid.replace('@s.whatsapp.net', '').replace('+', '');
    const messageText = m.message.conversation || m.message.extendedTextMessage?.text;

    if (!messageText) return;

    try {
      // 1. Verify if WhatsApp number belongs to a registered vendor in DB
      const client = await pool.connect();
      const storeQuery = await client.query(
        'SELECT id, business_name, owner_name, slug, whatsapp_number FROM businesses WHERE whatsapp_number LIKE $1 LIMIT 1',
        [`%${rawPhone.slice(-10)}%`]
      );
      client.release();

      if (storeQuery.rows.length === 0) {
        await sock.sendMessage(senderJid, {
          text: `👋 Hello! Your WhatsApp number isn't registered to any BazarhNG store yet.\n\nOpen your store in 2 minutes here:\n👉 ${APP_URL}/sell`
        });
        return;
      }

      const store = storeQuery.rows[0];
      const ownerName = store.owner_name || store.business_name || 'Vendor';
      const storeSlug = store.slug;
      const businessId = store.id;

      // 2. Greet vendor by name and process product text via Groq AI
      await sock.sendMessage(senderJid, { 
        text: `Hey ${ownerName}! 👋 Reading your product details with Groq AI 🤖...` 
      });

      const completion = await groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages: [
          {
            role: 'system',
            content: 'You are an e-commerce assistant. Extract product details from the vendor text. Return ONLY a valid JSON object with keys: "title", "price" (number only in Naira), "category", and "description". If price is missing, estimate or put 0.'
          },
          { role: 'user', content: messageText }
        ],
        response_format: { type: 'json_object' }
      });

      const productData = JSON.parse(completion.choices[0].message.content);

      // 3. Post parsed product payload to Next.js API route on Netlify
      const ingestEndpoint = `${APP_URL}/api/whatsapp/ingest`;
      const apiResponse = await fetch(ingestEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-bot-secret': BOT_SECRET
        },
        body: JSON.stringify({
          title: productData.title,
          price: productData.price,
          category: productData.category || 'General',
          description: productData.description || '',
          businessId: businessId
        })
      });

      const result = await apiResponse.json();

      if (result.success) {
        const storeLink = `${APP_URL}/store/${storeSlug}`;
        await sock.sendMessage(senderJid, {
          text: `✅ *Product Draft Created for ${store.business_name}!*\n\n📦 *Title:* ${productData.title}\n💰 *Price:* ₦${Number(productData.price).toLocaleString()}\n📂 *Category:* ${productData.category}\n\nTap here to view and manage your store:\n👉 ${storeLink}`
        });
      } else {
        await sock.sendMessage(senderJid, { 
          text: `❌ Error saving product draft: ${result.error || 'Server error'}` 
        });
      }

    } catch (err) {
      console.error('Bot Error:', err);
      await sock.sendMessage(senderJid, { 
        text: '⚠️ Sorry, I could not understand the product format. Try sending it like:\n"Red Leather Shoes for 25000 naira, size 42"' 
      });
    }
  });
}

startBot();
