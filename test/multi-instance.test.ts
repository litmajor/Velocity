import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'child_process';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import fsSync from 'fs';
import { WalletEngine } from '../src/core/wallet-engine';
import { FileBetRepository } from '../src/core/repositories/bet-repository';
import { FileRoundRepository } from '../src/core/repositories/round-repository';
import { SettlementClaimStore } from '../src/core/repositories/settlement-claim';
import { InstanceLock, InstanceLockError } from '../src/runtime/instance-lock';
import type { Bet, RoundState } from '../src/domains/game';

const ROOT = path.resolve(__dirname, '..');
const TSX = path.join(ROOT, 'node_modules', '.bin', 'tsx');
const WORKER = path.join(ROOT, 'test', 'helpers', 'instance-worker.ts');

interface WorkerResult { code: number | null; signal: NodeJS.Signals | null; out: any | null; stderr: string }

/** Spawn a REAL separate OS process running the instance worker. */
function spawnWorker(args: Record<string, unknown>): { done: Promise<WorkerResult> } {
  const child = spawn(TSX, [WORKER, JSON.stringify(args)], { cwd: ROOT });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', d => { stdout += d.toString(); });
  child.stderr.on('data', d => { stderr += d.toString(); });
  const done = new Promise<WorkerResult>(resolve => {
    child.on('close', (code, signal) => {
      let out: any = null;
      const line = stdout.split('\n').find(l => l.trim().startsWith('{'));
      if (line) { try { out = JSON.parse(line); } catch {} }
      resolve({ code, signal, out, stderr });
    });
  });
  return { done };
}

async function waitForFile(p: string, timeoutMs = 20_000) {
  const start = Date.now();
  while (!fsSync.existsSync(p)) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${p}`);
    await new Promise(res => setTimeout(res, 10));
  }
}

/** Read all wallet ledger records with a given tx id. */
async function ledgerTxRecords(dir: string, txId: string): Promise<any[]> {
  const raw = await fs.readFile(path.join(dir, 'wallet.ledger'), 'utf8');
  return raw.split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => r.tx === txId);
}

describe('two-process safety (real OS processes sharing one data directory)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'velocity-multi-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  /** Durable fixture: a CRASHED round with a cashed-out winner and a losing active bet. */
  async function seedCrashedRound() {
    const roundRepo = new FileRoundRepository(path.join(dir, 'rounds'));
    const betRepo = new FileBetRepository(path.join(dir, 'bets'));
    const wallet = new WalletEngine({ ledgerPath: path.join(dir, 'wallet.ledger') });
    wallet.ensureAccount('alice', 100);
    wallet.ensureAccount('bob', 100);
    // stakes captured exactly as placeBet does: reserve then commit
    wallet.reserve('alice', 50, 'bet:w1');
    wallet.commit('bet:w1');
    wallet.reserve('bob', 25, 'bet:l1');
    wallet.commit('bet:l1');

    const round: RoundState = {
      roundId: 'round-1', roundNumber: 1, phase: 'CRASHED',
      serverSeed: 's', serverHash: 'h', clientSeed: 'c', nonce: 1,
      crashPoint: 2.0, multiplier: 2.0, roundStartedAt: Date.now(),
      bettingOpensAt: Date.now() - 5000, bettingEndsAt: Date.now() - 4000,
    };
    await roundRepo.save(round);

    const winner: Bet = {
      betId: 'w1', userId: 'alice', roundId: 'round-1', amount: 50,
      placedAt: Date.now(), status: 'CASHED_OUT', cashedOutMultiplier: 1.5,
      payout: 75, resolved: true, reservationId: 'bet:w1',
    };
    const loser: Bet = {
      betId: 'l1', userId: 'bob', roundId: 'round-1', amount: 25,
      placedAt: Date.now(), status: 'ACTIVE', reservationId: 'bet:l1',
    };
    await betRepo.save(winner);
    await betRepo.save(loser);
    wallet.close();
  }

  it('concurrent settlement from two processes: exactly one settles, winner credited exactly once', async () => {
    await seedCrashedRound();
    const barrier = path.join(dir, 'go');
    const ready1 = path.join(dir, 'ready1');
    const ready2 = path.join(dir, 'ready2');

    const w1 = spawnWorker({ dir, action: 'settle', roundId: 'round-1', barrier, readyFile: ready1 });
    const w2 = spawnWorker({ dir, action: 'settle', roundId: 'round-1', barrier, readyFile: ready2 });
    await waitForFile(ready1);
    await waitForFile(ready2);
    await fs.writeFile(barrier, '1');

    const [r1, r2] = await Promise.all([w1.done, w2.done]);
    const oks = [r1.out, r2.out].filter(o => o?.ok);
    const fails = [r1.out, r2.out].filter(o => o && !o.ok);
    expect(oks).toHaveLength(1);
    expect(fails).toHaveLength(1);
    expect(fails[0].error).toMatch(/already (settled|claimed)/);

    // economic effects exactly once, verified from durable state
    expect(await ledgerTxRecords(dir, 'payout:w1')).toHaveLength(1);
    const wallet = new WalletEngine({ ledgerPath: path.join(dir, 'wallet.ledger') });
    expect(wallet.getBalance('alice')).toBeCloseTo(50 + 75, 2); // 100 - 50 stake + 75 payout
    expect(wallet.getBalance('bob')).toBe(75); // stake lost
    wallet.close();

    const betRepo = new FileBetRepository(path.join(dir, 'bets'));
    expect((await betRepo.get('w1'))!.payoutPaid).toBe(true);
    expect((await betRepo.get('l1'))!.status).toBe('LOST');
    const roundRepo = new FileRoundRepository(path.join(dir, 'rounds'));
    expect((await roundRepo.get('round-1'))!.phase).toBe('SETTLED');
  });

  it('concurrent settlement claims from two processes: exactly one wins the claim', async () => {
    const barrier = path.join(dir, 'go');
    const ready1 = path.join(dir, 'ready1');
    const ready2 = path.join(dir, 'ready2');
    const w1 = spawnWorker({ dir, action: 'claim', roundId: 'r-race', barrier, readyFile: ready1 });
    const w2 = spawnWorker({ dir, action: 'claim', roundId: 'r-race', barrier, readyFile: ready2 });
    await waitForFile(ready1);
    await waitForFile(ready2);
    await fs.writeFile(barrier, '1');
    const [r1, r2] = await Promise.all([w1.done, w2.done]);
    const claims = [r1.out?.claimed, r2.out?.claimed];
    expect(claims.filter(c => c === true)).toHaveLength(1);
    expect(claims.filter(c => c === false)).toHaveLength(1);
  });

  it('concurrent recovery from two processes: the instance lock admits exactly one', async () => {
    // an interrupted RUNNING round with an ACTIVE bet whose stake was captured
    const roundRepo = new FileRoundRepository(path.join(dir, 'rounds'));
    const betRepo = new FileBetRepository(path.join(dir, 'bets'));
    const wallet = new WalletEngine({ ledgerPath: path.join(dir, 'wallet.ledger') });
    wallet.ensureAccount('alice', 100);
    wallet.reserve('alice', 25, 'bet:b1');
    wallet.commit('bet:b1');
    await roundRepo.save({
      roundId: 'round-2', roundNumber: 1, phase: 'RUNNING',
      serverSeed: 's', serverHash: 'h', clientSeed: 'c', nonce: 1,
      crashPoint: 2.0, multiplier: 1.2, roundStartedAt: Date.now(),
      bettingOpensAt: Date.now() - 5000, bettingEndsAt: Date.now() - 4000,
    });
    await betRepo.save({
      betId: 'b1', userId: 'alice', roundId: 'round-2', amount: 25,
      placedAt: Date.now(), status: 'ACTIVE', reservationId: 'bet:b1',
    });
    wallet.close();

    const barrier = path.join(dir, 'go');
    const ready1 = path.join(dir, 'ready1');
    const ready2 = path.join(dir, 'ready2');
    const w1 = spawnWorker({ dir, action: 'recover', userId: 'alice', barrier, readyFile: ready1, holdMs: 250 });
    const w2 = spawnWorker({ dir, action: 'recover', userId: 'alice', barrier, readyFile: ready2, holdMs: 250 });
    await waitForFile(ready1);
    await waitForFile(ready2);
    await fs.writeFile(barrier, '1');

    const [r1, r2] = await Promise.all([w1.done, w2.done]);
    const oks = [r1.out, r2.out].filter(o => o?.ok);
    const locked = [r1.out, r2.out].filter(o => o && !o.ok && o.error === 'locked');
    expect(oks).toHaveLength(1);
    expect(locked).toHaveLength(1);

    // the single recovery refunded the voided stake exactly once
    expect(oks[0].betsRefunded).toContain('b1');
    expect(await ledgerTxRecords(dir, 'refund:b1')).toHaveLength(1);
    const w = new WalletEngine({ ledgerPath: path.join(dir, 'wallet.ledger') });
    expect(w.getBalance('alice')).toBe(100);
    w.close();
  });

  it('seed allocation across a real process restart: no commit is ever re-issued', async () => {
    const r1 = await spawnWorker({ dir, action: 'allocate', count: 4 }).done;
    expect(r1.out?.ok).toBe(true);
    // second process = restart with the same data dir
    const r2 = await spawnWorker({ dir, action: 'allocate', count: 4 }).done;
    expect(r2.out?.ok).toBe(true);

    const commits = [...r1.out.commits, ...r2.out.commits];
    expect(new Set(commits).size).toBe(commits.length); // no reuse

    // every published commit is durably recorded as used
    const persisted = JSON.parse(await fs.readFile(path.join(dir, 'fairness.json'), 'utf8'));
    for (const c of r2.out.commits) expect(persisted.usedCommits).toContain(c);
  });

  describe('instance lock', () => {
    it('two processes racing to own the same data directory: exactly one wins', async () => {
      const barrier = path.join(dir, 'go');
      const ready1 = path.join(dir, 'r1');
      const ready2 = path.join(dir, 'r2');
      const w1 = spawnWorker({ dir, action: 'lock-hold', holdMs: 400, barrier, readyFile: ready1 });
      const w2 = spawnWorker({ dir, action: 'lock-hold', holdMs: 400, barrier, readyFile: ready2 });
      await waitForFile(ready1);
      await waitForFile(ready2);
      await fs.writeFile(barrier, '1');
      const [r1, r2] = await Promise.all([w1.done, w2.done]);
      const oks = [r1.out, r2.out].filter(o => o?.ok);
      expect(oks).toHaveLength(1);
      expect([r1.out, r2.out].filter(o => o && !o.ok)).toHaveLength(1);
    });

    it('a lock left by a killed process is stale and can be taken over', async () => {
      const r = await spawnWorker({ dir, action: 'lock-die' }).done;
      expect(r.out?.ok).toBe(true);
      // tsx wraps the worker in a child node process, so the SIGKILL surfaces
      // as a non-zero exit rather than a signal on the wrapper
      expect(r.code === 0 && r.signal === null).toBe(false);
      expect(fsSync.existsSync(InstanceLock.lockPathFor(dir))).toBe(true); // stale lock left behind
      // a new process detects the dead owner and takes over
      const lock = InstanceLock.acquire(dir);
      expect(lock.isHeld).toBe(true);
      lock.release();
    });

    it('a live in-process lock blocks a second acquire and releases cleanly', () => {
      const lock = InstanceLock.acquire(dir);
      expect(() => InstanceLock.acquire(dir)).toThrow(InstanceLockError);
      lock.release();
      const again = InstanceLock.acquire(dir);
      expect(again.isHeld).toBe(true);
      again.release();
    });
  });

  describe('crash injection at real persistence boundaries (SIGKILL)', () => {
    it('killed immediately after claiming settlement: recovery completes payment exactly once', async () => {
      await seedCrashedRound();
      const r = await spawnWorker({ dir, action: 'settle', roundId: 'round-1', killAt: 'after-claim' }).done;
      expect(r.out).toBeNull(); // killed before it could report anything
      // claim exists but no economic effect happened yet
      const claims = new SettlementClaimStore(path.join(dir, 'settlements'));
      expect(claims.isClaimed('round-1')).toBe(true);
      expect(await ledgerTxRecords(dir, 'payout:w1')).toHaveLength(0);

      // restart: recovery completes the CRASHED round from durable state
      const rec = await spawnWorker({ dir, action: 'recover', userId: 'alice' }).done;
      expect(rec.out?.ok).toBe(true);
      expect(rec.out.payoutsPaid).toContain('w1');
      expect(await ledgerTxRecords(dir, 'payout:w1')).toHaveLength(1);
      const w = new WalletEngine({ ledgerPath: path.join(dir, 'wallet.ledger') });
      expect(w.getBalance('alice')).toBeCloseTo(125, 2);
      w.close();

      // and no later process can re-run settle() for this round
      const retry = await spawnWorker({ dir, action: 'settle', roundId: 'round-1' }).done;
      expect(retry.out?.ok).toBe(false);
      expect(retry.out?.error).toMatch(/already (settled|claimed)/);
    });

    it('killed immediately after the winner credit (before payoutPaid marker): no double pay on recovery', async () => {
      await seedCrashedRound();
      const r = await spawnWorker({ dir, action: 'settle', roundId: 'round-1', killAt: 'after-credit' }).done;
      expect(r.out).toBeNull(); // killed before it could report anything
      // the credit is durably in the ledger, the marker is not
      expect(await ledgerTxRecords(dir, 'payout:w1')).toHaveLength(1);
      const betRepo = new FileBetRepository(path.join(dir, 'bets'));
      expect((await betRepo.get('w1'))!.payoutPaid).toBeUndefined();

      const rec = await spawnWorker({ dir, action: 'recover', userId: 'alice' }).done;
      expect(rec.out?.ok).toBe(true);
      // the tx id deduped the retry: still exactly one durable credit
      expect(await ledgerTxRecords(dir, 'payout:w1')).toHaveLength(1);
      const w = new WalletEngine({ ledgerPath: path.join(dir, 'wallet.ledger') });
      expect(w.getBalance('alice')).toBeCloseTo(125, 2); // paid exactly once
      w.close();
      expect((await betRepo.get('w1'))!.payoutPaid).toBe(true);
    });
  });
});
