import { SITE } from './config.js';

// Background jobs that run inside the bot (the bot is the one thing that is always on):
//  1. keep-alive: pings itself so Render's free plan does not put it to sleep
//  2. email cron: asks the website to send its queued emails every 5 minutes (needs CRON_SECRET)
export function startJobs({ log }) {
  const self = process.env.KEEP_ALIVE_URL || process.env.RENDER_EXTERNAL_URL;
  if (self) {
    const url = `${self.replace(/[/]+$/, '')}/health`;
    setInterval(() => { fetch(url, { signal: AbortSignal.timeout(15000) }).catch(() => {}); }, 10 * 60 * 1000).unref();
    log.info(`Keep-alive on: ${url}`);
  } else {
    log.info('Keep-alive off (no RENDER_EXTERNAL_URL). Use an uptime monitor instead.');
  }

  const secret = process.env.CRON_SECRET;
  if (secret) {
    setInterval(async () => {
      try {
        const r = await fetch(`${SITE}/api/cron/process-emails`, {
          headers: { Authorization: `Bearer ${secret}` },
          signal: AbortSignal.timeout(30000),
        });
        if (!r.ok) log.warn(`Email cron answered ${r.status}`);
      } catch (e) {
        log.warn({ err: e.message }, 'Email cron failed');
      }
    }, 5 * 60 * 1000).unref();
    log.info(`Email cron on: ${SITE}/api/cron/process-emails every 5 minutes`);
  } else {
    log.info('Email cron off (set CRON_SECRET on Render to turn it on).');
  }
}
