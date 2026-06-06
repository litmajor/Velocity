import fs from 'fs';
import path from 'path';

const DATA_DIR = path.resolve(process.cwd(), 'data');

export async function ensureDataDir() {
  try {
    await fs.promises.mkdir(DATA_DIR, { recursive: true });
  } catch (e) {}
}

export async function saveJSON(filename: string, obj: any) {
  await ensureDataDir();
  const p = path.join(DATA_DIR, filename);
  const tmp = p + '.tmp';
  await fs.promises.writeFile(tmp, JSON.stringify(obj), { encoding: 'utf8' });
  await fs.promises.rename(tmp, p);
}

export async function loadJSON<T = any>(filename: string): Promise<T | null> {
  const p = path.join(DATA_DIR, filename);
  try {
    const raw = await fs.promises.readFile(p, { encoding: 'utf8' });
    return JSON.parse(raw) as T;
  } catch (e) {
    return null;
  }
}

export function dataPath(filename: string) {
  return path.join(DATA_DIR, filename);
}

export default { saveJSON, loadJSON, ensureDataDir, dataPath };
