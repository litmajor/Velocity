import crypto from 'crypto';
import fs from 'fs/promises';

/** A persistence file exists but cannot be parsed. Callers must fail closed. */
export class CorruptStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CorruptStateError';
  }
}

/**
 * Atomic replace: write to a temp file, fsync it, then rename over the
 * target. A crash at any point leaves either the previous complete file or
 * the new complete file; leftover *.tmp files are ignored by readers.
 */
export async function writeFileAtomic(filePath: string, data: string): Promise<void> {
  // unique tmp name so concurrent writers to the same target cannot collide
  const tmp = `${filePath}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const fh = await fs.open(tmp, 'w');
  try {
    await fh.writeFile(data, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, filePath);
}

/**
 * Read a JSON file. Missing file → null. Unparseable file → CorruptStateError:
 * a corrupt persistence file is NOT equivalent to an empty database.
 */
export async function readJsonFailClosed<T>(filePath: string): Promise<T | null> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err: any) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new CorruptStateError(`corrupt persistence file: ${filePath}`);
  }
}
