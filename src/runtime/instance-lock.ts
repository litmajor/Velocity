import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Exclusive single-writer ownership of a data directory.
 *
 * Every durable store under `data/` (wallet ledger, bet/round files,
 * fairness state, tick ledger) assumes exactly one owning process: in-memory
 * caches, idempotency sets and invariant checks are all rebuilt from disk at
 * startup and then maintained in memory. A second process attached to the
 * same directory operates on stale views and can violate economic invariants
 * (double settlement emission, over-reservation, lost fairness commits).
 *
 * The lock is a file created with O_EXCL (`wx`) containing the owner's pid,
 * hostname and start time. Acquisition fails fast if a live owner exists.
 * A lock left behind by a crashed process (pid no longer alive on this host)
 * is treated as stale and taken over. This is intentionally a same-machine
 * mechanism: it does NOT make a shared network filesystem safe (O_EXCL and
 * pid liveness are not reliable across hosts) — see docs/DEPLOYMENT.md.
 */

export class InstanceLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InstanceLockError';
  }
}

export interface LockInfo {
  pid: number;
  hostname: string;
  acquiredAt: number;
}

export class InstanceLock {
  private held = false;

  private constructor(private lockPath: string, readonly info: LockInfo) {
    this.held = true;
  }

  static lockPathFor(dataDir: string): string {
    return path.join(dataDir, 'instance.lock');
  }

  /**
   * Acquire exclusive ownership of `dataDir`. Throws InstanceLockError if a
   * live process on this host already holds it. A stale lock (dead pid on
   * this host) is removed and acquisition retried once.
   */
  static acquire(dataDir: string): InstanceLock {
    fs.mkdirSync(dataDir, { recursive: true });
    const lockPath = InstanceLock.lockPathFor(dataDir);
    for (let attempt = 0; attempt < 2; attempt++) {
      const info: LockInfo = { pid: process.pid, hostname: os.hostname(), acquiredAt: Date.now() };
      let fd: number;
      try {
        fd = fs.openSync(lockPath, 'wx');
      } catch (err: any) {
        if (err?.code !== 'EEXIST') throw err;
        const existing = InstanceLock.readLock(lockPath);
        if (existing && InstanceLock.isStale(existing)) {
          // dead owner on this host: remove and retry once
          try { fs.unlinkSync(lockPath); } catch {}
          continue;
        }
        throw new InstanceLockError(
          `data directory ${dataDir} is owned by another instance` +
          (existing ? ` (pid ${existing.pid} on ${existing.hostname})` : ` (unreadable lock file ${lockPath})`),
        );
      }
      try {
        fs.writeSync(fd, JSON.stringify(info), null, 'utf8');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      return new InstanceLock(lockPath, info);
    }
    throw new InstanceLockError(`could not acquire instance lock for ${dataDir}`);
  }

  private static readLock(lockPath: string): LockInfo | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      if (typeof parsed?.pid !== 'number') return null;
      return parsed as LockInfo;
    } catch {
      return null;
    }
  }

  /** Stale = owner pid on this host is no longer alive. Locks from other hosts are never stale. */
  private static isStale(info: LockInfo): boolean {
    if (info.hostname !== os.hostname()) return false;
    try {
      process.kill(info.pid, 0);
      return false; // alive
    } catch (err: any) {
      if (err?.code === 'ESRCH') return true; // no such process
      return false; // EPERM etc: process exists but not ours
    }
  }

  get isHeld(): boolean {
    return this.held;
  }

  release(): void {
    if (!this.held) return;
    this.held = false;
    try {
      // only remove the lock if we still own it (pid check guards against
      // releasing a lock taken over after our own stale-detection window)
      const current = InstanceLock.readLock(this.lockPath);
      if (current && current.pid === this.info.pid && current.acquiredAt === this.info.acquiredAt) {
        fs.unlinkSync(this.lockPath);
      }
    } catch {}
  }
}
