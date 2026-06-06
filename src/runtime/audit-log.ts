import fs from 'fs/promises';
import path from 'path';
import { eventBus } from './event-bus';

const LOG_DIR = path.resolve(process.cwd(), 'data', 'events');
const LOG_FILE = path.join(LOG_DIR, 'events.log');

async function ensureDir() {
  try { await fs.mkdir(LOG_DIR, { recursive: true }); } catch {}
}

// Append each EVENT_APPEND envelope as a single JSON line for an append-only audit log
eventBus.on('EVENT_APPEND' as any, async (envelope: any) => {
  try {
    await ensureDir();
    const line = JSON.stringify({ ts: Date.now(), envelope });
    await fs.appendFile(LOG_FILE, line + '\n', 'utf8');
  } catch (err) {
    // don't throw — audit logging should not block the engine
    // but log to console for local debugging
    // eslint-disable-next-line no-console
    console.error('[Audit] failed to append event', err);
  }
});

export {};
