import 'dotenv/config';
import http from 'node:http';
import { initDb } from './db.js';
import { startWhatsApp, flushSession } from './whatsapp.js';

const required = ['DATABASE_URL', 'GROQ_API_KEY', 'CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing env vars: ${missing.join(', ')}`);
  process.exit(1);
}

// Render health check
const port = process.env.PORT || 10000;
http
  .createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('BazarhNG WhatsApp Bot is running');
  })
  .listen(port, () => console.log(`Health server on ${port}`));

process.on('unhandledRejection', (e) => console.error('Unhandled rejection:', e));
process.on('uncaughtException', (e) => console.error('Uncaught exception:', e));

// Save the WhatsApp session before Render stops/redeploys the service
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    await flushSession();
    process.exit(0);
  });
}

await initDb();
await startWhatsApp();
