import 'dotenv/config';
import http from 'node:http';
import pino from 'pino';
import { initDb } from './db.js';
import { startWhatsApp, flushSession, getStatus } from './whatsapp.js';
import { startJobs } from './jobs.js';

const required = ['DATABASE_URL', 'GROQ_API_KEY', 'CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing env vars: ${missing.join(', ')}`);
  process.exit(1);
}
const log = pino({ level: process.env.LOG_LEVEL || 'info' });

// Health check for Render and uptime monitors
const port = process.env.PORT || 10000;
http
  .createServer((req, res) => {
    if (req.url && req.url.startsWith('/health')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...getStatus() }));
      return;
    }
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
startJobs({ log });
await startWhatsApp();
