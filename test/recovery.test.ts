import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { GameEngine } from '../src/core/game-engine';
import { BettingEngine } from '../src/core/betting-engine';
import { SettlementEngine } from '../src/core/settlement-engine';
import { WalletEngine } from '../src/core/wallet-engine';
import { RecoveryEngine } from '../src/core/recovery-engine';
import { FileBetRepository, CorruptStateError } from '../src/core/repositories/bet-repository';
import { FileRoundRepository } from '../src/core/repositories/round-repository';
import type { Bet } from '../src/domains/game';
import { FixedCrashFairness, msToReach } from './helpers/rig';

const CRASH = 2.0;

interface FileRig {
  game: GameEngine;
  betting: BettingEngine;
  settlement: SettlementEngine;
  wallet: WalletEngine;
  betRepo: FileBetRepository;
  roundRepo: FileRoundRepository;
  recovery: RecoveryEngine;
}

/**
 * "Restart" = construct brand-new engine instances pointing at the same
 * data directory. Everything held only in memory is lost, exactly as it
 * would be on a process kill; durable state (wallet ledger, bet files,
 * round files) survives, and RecoveryEngine reconciles it.
 */
describe('crash/restart recovery with durable persistence', () => {
  let dir: string;
  let rig: FileRig;
  const rigs: FileRig[] = [];

  function makeFileRig(wallet?: WalletEngine): FileRig {
    const betRepo = new FileBetRepository(path.join(dir, 'bets'));
    const roundRepo = new FileRoundRepository(path.join(dir, 'rounds'));
    const w = wallet ?? new WalletEngine({ ledgerPath: path.join(dir, 'wallet.ledger') });
    const game = new GameEngine(undefined, new FixedCrashFairness(CRASH), roundRepo);
    const betting = new BettingEngine(game, w, betRepo);
    const settlement = new SettlementEngine(game, betting, w, roundRepo);
    const recovery = new RecoveryEngine(w, betRepo, roundRepo);
    const r = { game, betting, settlement, wallet: w, betRepo, roundRepo, recovery };
    rigs.push(r);
    return r;
  }

  beforeEach(async () => {
    vi.useFakeTimers();
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'velocity-recovery-'));
    rig = makeFileRig();
  });
  afterEach(async () => {
    for (const r of rigs) {
      try { r.game.reset(); } catch {}
      try { r.wallet.close(); } catch {}
    }
    rigs.length = 0;
    vi.useRealTimers();
    await fs.rm(dir, { recursive: true, force: true });
  });

  // The fire-and-forget repo.save() completes on real I/O, so poll the file.
  async function waitForPhase(roundId: string, phase: string) {
    for (let i = 0; i < 200; i++) {
      const r = await rig.roundRepo.get(roundId); // each await crosses the event loop
      if (r?.phase === phase) return r;
    }
    return rig.roundRepo.get(roundId);
  }

  /** Kill the process (drop all memory) and boot a new one. */
  function restart(wallet?: WalletEngine): FileRig {
    rig.game.reset();
    rig.wallet.close();
    return makeFileRig(wallet);
  }

  async function snapshot(users: string[], r: FileRig) {
    const balances = Object.fromEntries(users.map(u => [u, r.wallet.getBalance(u)]));
    const reservations = r.wallet.listReservations().sort((a, b) => a.id.localeCompare(b.id));
    const rounds = (await r.roundRepo.list()).sort((a, b) => a.roundId.localeCompare(b.roundId));
    const betsByRound: Record<string, Bet[]> = {};
    for (const round of rounds) {
      betsByRound[round.roundId] = (await r.betRepo.listByRound(round.roundId))
        .sort((a, b) => a.betId.localeCompare(b.betId));
    }
    return { balances, reservations, rounds, betsByRound };
  }

  // ── betting ────────────────────────────────────────────────────────────────

  it('accepted bets are durably persisted and survive restart, tied to their round', async () => {
    rig.wallet.ensureAccount('alice', 100);
    rig.game.startBetting(1_000);
    const roundId = rig.game.getState()!.roundId;
    const bet = await rig.betting.placeBet('alice', 25);

    const restarted = restart();
    const recovered = await restarted.betRepo.get(bet.betId);
    expect(recovered).toBeTruthy();
    expect(recovered!.amount).toBe(25);
    expect(recovered!.status).toBe('ACTIVE');
    expect(recovered!.roundId).toBe(roundId);
    expect(recovered!.reservationId).toBe(`bet:${bet.betId}`);
    // the stake survived too (committed via the durable ledger)
    expect(restarted.wallet.getBalance('alice')).toBe(75);
  });

  it('round state is persisted at each phase transition', async () => {
    rig.game.startBetting(1_000);
    const roundId = rig.game.getState()!.roundId;
    expect((await waitForPhase(roundId, 'BETTING'))?.phase).toBe('BETTING');
    rig.game.lockBets();
    expect((await waitForPhase(roundId, 'LOCKED'))?.phase).toBe('LOCKED');
    rig.game.startRound();
    await vi.advanceTimersByTimeAsync(msToReach(CRASH) + 200);
    expect((await waitForPhase(roundId, 'CRASHED'))?.phase).toBe('CRASHED');
    await rig.settlement.settle();
    expect((await waitForPhase(roundId, 'SETTLED'))?.phase).toBe('SETTLED');
  });

  it('kill during BETTING: recovery refunds the stake and voids the round', async () => {
    rig.wallet.ensureAccount('alice', 100);
    rig.game.startBetting(1_000);
    const roundId = rig.game.getState()!.roundId;
    await waitForPhase(roundId, 'BETTING');
    const bet = await rig.betting.placeBet('alice', 25);
    expect(rig.wallet.getBalance('alice')).toBe(75);

    const restarted = restart();
    await restarted.recovery.recover();

    expect(restarted.wallet.getBalance('alice')).toBe(100); // stake back
    const b = await restarted.betRepo.get(bet.betId);
    expect(b!.status).toBe('REFUNDED');
    expect(b!.resolved).toBe(true);
    const round = await restarted.roundRepo.get(roundId);
    expect(round!.phase).toBe('SETTLED');
    expect(round!.recovered).toBe(true);
  });

  it('kill after reserve but before bet save: orphan reservation is rolled back (no orphaned stake)', async () => {
    rig.wallet.ensureAccount('alice', 100);
    // simulate the exact boundary: reservation durably recorded, bet file never written
    rig.wallet.reserve('alice', 25, 'bet:never-saved');
    expect(rig.wallet.getReservedTotal('alice')).toBe(25);

    const restarted = restart();
    const report = await restarted.recovery.recover();

    expect(report.reservationsRolledBack).toContain('bet:never-saved');
    expect(restarted.wallet.getReservedTotal('alice')).toBe(0);
    expect(restarted.wallet.getBalance('alice')).toBe(100);
  });

  it('kill after bet save but before commit: recovery commits the reservation (stake captured once)', async () => {
    rig.wallet.ensureAccount('alice', 100);
    rig.game.startBetting(1_000);
    const roundId = rig.game.getState()!.roundId;
    await waitForPhase(roundId, 'BETTING');
    rig.game.lockBets();
    rig.game.startRound();
    await vi.advanceTimersByTimeAsync(msToReach(CRASH) + 200);
    await waitForPhase(roundId, 'CRASHED');
    // simulate: bet was saved for the (now crashed) round but the commit never ran
    const betId = 'interrupted-commit';
    rig.wallet.reserve('alice', 25, `bet:${betId}`);
    await rig.betRepo.save({
      betId, userId: 'alice', roundId, amount: 25, placedAt: Date.now(),
      status: 'ACTIVE', reservationId: `bet:${betId}`,
    });

    const restarted = restart();
    const report = await restarted.recovery.recover();

    expect(report.reservationsCommitted).toContain(`bet:${betId}`);
    expect(restarted.wallet.getBalance('alice')).toBe(75); // captured exactly once
    expect((await restarted.betRepo.get(betId))!.status).toBe('LOST'); // crashed round completes
    // second recovery run cannot capture it again
    await restarted.recovery.recover();
    expect(restarted.wallet.getBalance('alice')).toBe(75);
  });

  it('kill mid-RUNNING: round is voided — ACTIVE bets refunded, no orphans remain', async () => {
    rig.wallet.ensureAccount('alice', 100);
    rig.game.startBetting(1_000);
    const roundId = rig.game.getState()!.roundId;
    const bet = await rig.betting.placeBet('alice', 25);
    rig.game.lockBets();
    rig.game.startRound();
    await vi.advanceTimersByTimeAsync(200); // killed while RUNNING
    await waitForPhase(roundId, 'RUNNING');

    const restarted = restart();
    await restarted.recovery.recover();

    const b = await restarted.betRepo.get(bet.betId);
    expect(b!.status).toBe('REFUNDED');
    expect(restarted.wallet.getBalance('alice')).toBe(100);
    const round = await restarted.roundRepo.get(roundId);
    expect(round!.phase).toBe('SETTLED');
    expect(round!.recovered).toBe(true);
    // the recovered round can never be settled (and paid) through the normal path
    await expect(restarted.settlement.settle()).rejects.toThrow();
  });

  it('no duplicate bet can appear through recovery', async () => {
    rig.wallet.ensureAccount('alice', 100);
    rig.game.startBetting(1_000);
    const roundId = rig.game.getState()!.roundId;
    await rig.betting.placeBet('alice', 25);

    const restarted = restart();
    await restarted.recovery.recover();
    await restarted.recovery.recover();

    const bets = await restarted.betRepo.listByRound(roundId);
    expect(bets).toHaveLength(1);
  });

  // ── cashout ────────────────────────────────────────────────────────────────

  async function playRoundWithCashout(target = 1.5) {
    rig.wallet.ensureAccount('alice', 100);
    rig.game.startBetting(1_000);
    const roundId = rig.game.getState()!.roundId;
    await waitForPhase(roundId, 'BETTING');
    const bet = await rig.betting.placeBet('alice', 50);
    rig.game.lockBets();
    rig.game.startRound();
    await vi.advanceTimersByTimeAsync(msToReach(target));
    const out = await rig.betting.cashout('alice');
    return { roundId, betId: bet.betId, payout: out.payout! };
  }

  it('kill after cashout but before settlement: winner is paid exactly once by recovery', async () => {
    const { roundId, betId, payout } = await playRoundWithCashout();
    await vi.advanceTimersByTimeAsync(msToReach(CRASH) + 200);
    await waitForPhase(roundId, 'CRASHED');
    // killed before settle() ran

    const restarted = restart();
    const report = await restarted.recovery.recover();

    expect(report.payoutsPaid).toContain(betId);
    expect(restarted.wallet.getBalance('alice')).toBeCloseTo(50 + payout, 2);
    expect((await restarted.betRepo.get(betId))!.payoutPaid).toBe(true);
    // running recovery again cannot pay again
    await restarted.recovery.recover();
    expect(restarted.wallet.getBalance('alice')).toBeCloseTo(50 + payout, 2);
  });

  it('kill after winner credit but before payoutPaid marker: retry reconciles without double pay', async () => {
    const { roundId, betId, payout } = await playRoundWithCashout();
    await vi.advanceTimersByTimeAsync(msToReach(CRASH) + 200);
    await waitForPhase(roundId, 'CRASHED');
    // simulate settle() dying between the wallet credit and the bet update:
    rig.wallet.credit('alice', payout, `payout:${betId}`);
    expect((await rig.betRepo.get(betId))!.payoutPaid).toBeUndefined();

    const restarted = restart();
    await restarted.recovery.recover();

    // ledger tx id deduped the retry — paid exactly once
    expect(restarted.wallet.getBalance('alice')).toBeCloseTo(50 + payout, 2);
    expect((await restarted.betRepo.get(betId))!.payoutPaid).toBe(true);
  });

  it('a bet that LOST at crash cannot be resurrected by recovery', async () => {
    rig.wallet.ensureAccount('alice', 100);
    rig.game.startBetting(1_000);
    const roundId = rig.game.getState()!.roundId;
    const bet = await rig.betting.placeBet('alice', 50);
    rig.game.lockBets();
    rig.game.startRound();
    await vi.advanceTimersByTimeAsync(msToReach(CRASH) + 200); // no cashout → LOST
    await waitForPhase(roundId, 'CRASHED');
    await rig.settlement.settle();

    const restarted = restart();
    await restarted.recovery.recover();

    const b = await restarted.betRepo.get(bet.betId);
    expect(b!.status).toBe('LOST');
    expect(b!.payout).toBe(0);
    expect(restarted.wallet.getBalance('alice')).toBe(50); // stake stays lost
  });

  // ── settlement ─────────────────────────────────────────────────────────────

  it('settlement interrupted before any payout (round CRASHED): recovery completes it', async () => {
    const { roundId, betId, payout } = await playRoundWithCashout();
    await vi.advanceTimersByTimeAsync(msToReach(CRASH) + 200);
    await waitForPhase(roundId, 'CRASHED');

    const restarted = restart();
    await restarted.recovery.recover();

    expect(restarted.wallet.getBalance('alice')).toBeCloseTo(50 + payout, 2);
    const round = await restarted.roundRepo.get(roundId);
    expect(round!.phase).toBe('SETTLED');
    expect((await restarted.betRepo.get(betId))!.payoutPaid).toBe(true);
  });

  it('settlement interrupted after completion (round SETTLED): recovery is a no-op', async () => {
    const { roundId, payout } = await playRoundWithCashout();
    await vi.advanceTimersByTimeAsync(msToReach(CRASH) + 200);
    await waitForPhase(roundId, 'CRASHED');
    await rig.settlement.settle();
    const paid = rig.wallet.getBalance('alice');
    expect(paid).toBeCloseTo(50 + payout, 2);

    const restarted = restart();
    const before = await snapshot(['alice'], restarted);
    await restarted.recovery.recover();
    const after = await snapshot(['alice'], restarted);

    expect(after).toEqual(before);
    expect(restarted.wallet.getBalance('alice')).toBeCloseTo(paid, 2);
  });

  it('restart replay cannot double-pay: settle() refuses an already-settled round', async () => {
    const { roundId, payout } = await playRoundWithCashout();
    await vi.advanceTimersByTimeAsync(msToReach(CRASH) + 200);
    await waitForPhase(roundId, 'CRASHED');
    await rig.settlement.settle();
    const paid = rig.wallet.getBalance('alice');

    // same instance retry
    await expect(rig.settlement.settle()).rejects.toThrow(/already settled/);
    expect(rig.wallet.getBalance('alice')).toBeCloseTo(paid, 2);
    void payout;
  });

  it('failed winner credit is durably visible and retried by recovery (idempotently)', async () => {
    // wallet whose credits fail — simulates an I/O failure during settlement
    class FlakyWallet extends WalletEngine {
      failCredits = false;
      credit(userId: string, amount: number, txId?: string): boolean {
        if (this.failCredits) throw new Error('injected credit failure');
        return super.credit(userId, amount, txId);
      }
    }
    const flaky = new FlakyWallet({ ledgerPath: path.join(dir, 'wallet.ledger') });
    rig.game.reset();
    rig.wallet.close();
    rig = makeFileRig(flaky);

    const { roundId, betId, payout } = await playRoundWithCashout();
    await vi.advanceTimersByTimeAsync(msToReach(CRASH) + 200);
    await waitForPhase(roundId, 'CRASHED');

    flaky.failCredits = true;
    await rig.settlement.settle(); // credit fails, is logged, round settles
    expect(rig.wallet.getBalance('alice')).toBe(50); // unpaid
    // the unpaid winner is durably identifiable
    const unpaid = (await rig.betRepo.listByRound(roundId))
      .filter(b => b.status === 'CASHED_OUT' && b.payout && !b.payoutPaid);
    expect(unpaid.map(b => b.betId)).toEqual([betId]);

    // restart with a healthy wallet: recovery retries the payout
    const restarted = restart();
    const report = await restarted.recovery.recover();
    expect(report.payoutsPaid).toContain(betId);
    expect(restarted.wallet.getBalance('alice')).toBeCloseTo(50 + payout, 2);
    // retry is idempotent
    await restarted.recovery.recover();
    expect(restarted.wallet.getBalance('alice')).toBeCloseTo(50 + payout, 2);
  });

  // ── idempotency and invariants ─────────────────────────────────────────────

  it('running startup recovery N times produces the identical final state', async () => {
    rig.wallet.ensureAccount('alice', 100);
    rig.wallet.ensureAccount('bob', 100);
    rig.game.startBetting(1_000);
    const roundId = rig.game.getState()!.roundId;
    await waitForPhase(roundId, 'BETTING');
    await rig.betting.placeBet('alice', 30);
    await rig.betting.placeBet('bob', 20);
    rig.game.lockBets();
    rig.game.startRound();
    await vi.advanceTimersByTimeAsync(msToReach(1.5));
    await rig.betting.cashout('alice');
    await vi.advanceTimersByTimeAsync(100); // killed while RUNNING
    await waitForPhase(roundId, 'RUNNING');

    const restarted = restart();
    await restarted.recovery.recover();
    const first = await snapshot(['alice', 'bob'], restarted);
    await restarted.recovery.recover();
    await restarted.recovery.recover();
    const third = await snapshot(['alice', 'bob'], restarted);

    expect(third).toEqual(first);
    // invariants after recovery of a completed/voided round:
    for (const bets of Object.values(third.betsByRound)) {
      for (const b of bets) expect(b.status).not.toBe('ACTIVE'); // no orphans
      for (const b of bets) {
        if (b.status === 'CASHED_OUT' && b.payout) expect(b.payoutPaid).toBe(true); // no unpaid winner
      }
    }
    for (const bal of Object.values(third.balances)) expect(bal).toBeGreaterThanOrEqual(0);
    // conservation: alice cashed out (paid), bob refunded (round voided mid-run)
    const alicePayout = (await restarted.betRepo.listByRound(roundId))
      .find(b => b.userId === 'alice')!.payout!;
    expect(third.balances.alice).toBeCloseTo(100 - 30 + alicePayout, 2);
    expect(third.balances.bob).toBeCloseTo(100, 2);
  });

  // ── persistence file handling ──────────────────────────────────────────────

  it('a torn (corrupt) bet file fails closed instead of vanishing', async () => {
    const repo = new FileBetRepository(path.join(dir, 'bets'));
    await fs.mkdir(path.join(dir, 'bets'), { recursive: true });
    await fs.writeFile(path.join(dir, 'bets', 'torn.json'), '{"betId":"torn","amou'); // torn write
    await expect(repo.get('torn')).rejects.toThrow(CorruptStateError);
    await expect(repo.listByRound('any')).rejects.toThrow(CorruptStateError);
  });

  it('a missing persistence file is treated as absent (null), not an error', async () => {
    const repo = new FileBetRepository(path.join(dir, 'bets'));
    expect(await repo.get('does-not-exist')).toBeNull();
  });

  it('an interrupted atomic replacement leaves the previous complete file visible', async () => {
    const repo = new FileBetRepository(path.join(dir, 'bets'));
    const bet: Bet = {
      betId: 'b1', userId: 'alice', roundId: 'r1', amount: 10,
      placedAt: Date.now(), status: 'ACTIVE',
    };
    await repo.save(bet);
    // simulate a crash mid-replace: a partial temp file next to the good file
    await fs.writeFile(path.join(dir, 'bets', 'b1.json.deadbeef.tmp'), '{"betId":"b1","amou');
    expect((await repo.get('b1'))!.amount).toBe(10);
    expect(await repo.listByRound('r1')).toHaveLength(1); // tmp ignored
  });

  it('saves are atomic replacements: no partial content is ever visible under the target name', async () => {
    const repo = new FileBetRepository(path.join(dir, 'bets'));
    const bet: Bet = {
      betId: 'b2', userId: 'alice', roundId: 'r1', amount: 10,
      placedAt: Date.now(), status: 'ACTIVE',
    };
    await Promise.all([repo.save(bet), repo.save({ ...bet, amount: 20 }), repo.save({ ...bet, amount: 30 })]);
    const b = await repo.get('b2'); // must parse — whichever version won the rename
    expect([10, 20, 30]).toContain(b!.amount);
  });

  it('recovery fails closed when persisted state is corrupt', async () => {
    await fs.mkdir(path.join(dir, 'rounds'), { recursive: true });
    await fs.writeFile(path.join(dir, 'rounds', 'bad.json'), '{"roundId": ');
    const restarted = restart();
    await expect(restarted.recovery.recover()).rejects.toThrow(CorruptStateError);
  });
});
