import crypto from 'crypto';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';

/** A persistence file exists but cannot be parsed. Callers must fail closed. */
export class CorruptStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CorruptStateError';
  }
}

/**
 * Atomic replace: write to a temp file, fsync it, rename over the target,
 * then fsync the parent directory. A crash at any point leaves either the
 * previous complete file or the new complete file; leftover *.tmp files are
 * ignored by readers. The directory fsync makes the rename itself durable
 * against power loss (without it, a machine failure after rename can revert
 * the directory entry to the old file — atomic visibility is not the same
 * as power-loss durability).
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
  await fsyncDir(path.dirname(filePath));
}

/** Synchronous variant of writeFileAtomic, for callers that must be durable before returning. */
export function writeFileAtomicSync(filePath: string, data: string): void {
  const tmp = `${filePath}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const fd = fsSync.openSync(tmp, 'w');
  try {
    fsSync.writeSync(fd, data, null, 'utf8');
    fsSync.fsyncSync(fd);
  } finally {
    fsSync.closeSync(fd);
  }
  fsSync.renameSync(tmp, filePath);
  try {
    const dfd = fsSync.openSync(path.dirname(filePath), 'r');
    try { fsSync.fsyncSync(dfd); } finally { fsSync.closeSync(dfd); }
  } catch {}
}

/** Best-effort directory fsync: not supported on some platforms/filesystems. */
async function fsyncDir(dir: string): Promise<void> {
  let dh: fs.FileHandle | null = null;
  try {
    dh = await fs.open(dir, 'r');
    await dh.sync();
  } catch {
    // e.g. Windows cannot open directories; the write is still atomic,
    // only power-loss durability of the rename is reduced on such platforms.
  } finally {
    await dh?.close().catch(() => {});
  }
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
