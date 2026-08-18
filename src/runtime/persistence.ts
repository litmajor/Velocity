import fs from 'fs';
import path from 'path';
import { writeFileAtomic, writeFileAtomicSync } from '../core/repositories/atomic-json';

// Resolved lazily so DATA_DIR set at bootstrap (or by tests) is honored and
// all stores (fairness state, tick ledger, repos, ledger) share one directory.
function dataDir(): string {
  return path.resolve(process.cwd(), process.env.DATA_DIR ?? 'data');
}

export async function ensureDataDir() {
  try {
    await fs.promises.mkdir(dataDir(), { recursive: true });
  } catch (e) {}
}

export async function saveJSON(filename: string, obj: any) {
  await ensureDataDir();
  const p = path.join(dataDir(), filename);
  await writeFileAtomic(p, JSON.stringify(obj));
}

export async function loadJSON<T = any>(filename: string): Promise<T | null> {
  const p = path.join(dataDir(), filename);
  try {
    const raw = await fs.promises.readFile(p, { encoding: 'utf8' });
    return JSON.parse(raw) as T;
  } catch (e) {
    return null;
  }
}

/** Synchronous durable save: the state is on disk when this returns. */
export function saveJSONSync(filename: string, obj: any) {
  fs.mkdirSync(dataDir(), { recursive: true });
  writeFileAtomicSync(path.join(dataDir(), filename), JSON.stringify(obj));
}

export function loadJSONSync<T = any>(filename: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir(), filename), 'utf8')) as T;
  } catch (e) {
    return null;
  }
}

export function dataPath(filename: string) {
  return path.join(dataDir(), filename);
}

export default { saveJSON, loadJSON, saveJSONSync, loadJSONSync, ensureDataDir, dataPath };
