import fs from 'fs';
import path from 'path';

/**
 * Durable, cross-process exactly-once claim on a round's settlement.
 *
 * The claim is a per-round file created with O_EXCL: the filesystem makes
 * creation atomic, so at most one process can ever own the settlement of a
 * given round — even if two processes bypass the instance lock and share a
 * data directory. Claims are never released: a claim outliving a crashed
 * settlement is safe because startup recovery completes CRASHED rounds
 * directly from durable bet state (with idempotent `payout:<betId>` tx ids)
 * without calling settle() again.
 */
export class SettlementClaimStore {
  constructor(private dir: string) {}

  /** Atomically claim settlement of a round. True = caller owns it, false = already claimed. */
  claim(roundId: string): boolean {
    fs.mkdirSync(this.dir, { recursive: true });
    const p = path.join(this.dir, `${roundId}.claim`);
    let fd: number;
    try {
      fd = fs.openSync(p, 'wx');
    } catch (err: any) {
      if (err?.code === 'EEXIST') return false;
      throw err;
    }
    try {
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }), null, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return true;
  }

  isClaimed(roundId: string): boolean {
    return fs.existsSync(path.join(this.dir, `${roundId}.claim`));
  }
}
