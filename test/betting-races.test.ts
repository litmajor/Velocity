import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeRig, msToReach, holdBetLock, collect, Rig } from './helpers/rig';

// Crash point fixed at 2.00x => crash tick fires at ~4000ms of RUNNING time.
const CRASH = 2.0;
const BETTING_MS = 1_000;

describe('betting/cashout race conditions', () => {
  let rig: Rig;
  beforeEach(() => {
    vi.useFakeTimers();
    rig = makeRig({ crashPoint: CRASH });
    rig.wallet.ensureAccount('alice', 1_000);
    rig.wallet.ensureAccount('bob', 1_000);
  });
  afterEach(() => {
    try {
      rig.game.reset();
    } catch {}
    vi.useRealTimers();
  });

  it('accepts a bet immediately before lock and rejects at/after lock', async () => {
    rig.game.startBetting(BETTING_MS);
    const bet = await rig.betting.placeBet('alice', 100);
    expect(bet.status).toBe('ACTIVE');
    expect(rig.wallet.getBalance('alice')).toBe(900);

    rig.game.lockBets();
    // exactly at lock (phase already LOCKED) and after lock must be rejected
    await expect(rig.betting.placeBet('bob', 50)).rejects.toThrow(/closed/);
    expect(rig.wallet.getBalance('bob')).toBe(1_000); // no economic effect
  });

  it('rejects bets during RUNNING and after CRASH', async () => {
    rig.game.startBetting(BETTING_MS);
    rig.game.lockBets();
    rig.game.startRound();
    await expect(rig.betting.placeBet('alice', 100)).rejects.toThrow(/closed/);
    await vi.advanceTimersByTimeAsync(msToReach(CRASH) + 200);
    expect(rig.game.getPhase()).toBe('CRASHED');
    await expect(rig.betting.placeBet('alice', 100)).rejects.toThrow(/closed/);
    expect(rig.wallet.getBalance('alice')).toBe(1_000);
  });

  it('cashout immediately before crash succeeds at the current multiplier', async () => {
    rig.game.startBetting(BETTING_MS);
    await rig.betting.placeBet('alice', 100);
    rig.game.lockBets();
    rig.game.startRound();
    await vi.advanceTimersByTimeAsync(msToReach(1.5));
    const bet = await rig.betting.cashout('alice');
    expect(bet.status).toBe('CASHED_OUT');
    expect(bet.cashedOutMultiplier).toBeGreaterThanOrEqual(1.49);
    expect(bet.cashedOutMultiplier).toBeLessThan(CRASH);
    // payout only lands on the balance at settlement
    expect(rig.wallet.getBalance('alice')).toBe(900);
  });

  it('rejects cashout at/after crash', async () => {
    rig.game.startBetting(BETTING_MS);
    await rig.betting.placeBet('alice', 100);
    rig.game.lockBets();
    rig.game.startRound();
    await vi.advanceTimersByTimeAsync(msToReach(CRASH) + 200);
    expect(rig.game.getPhase()).toBe('CRASHED');
    await expect(rig.betting.cashout('alice')).rejects.toThrow(/Cannot cashout/);
  });

  // V-R2: a cashout that passes the phase check while RUNNING but acquires the
  // bet lock only after the crash tick must NOT produce a payout.
  it('cashout interleaved across the crash boundary has no economic effect', async () => {
    rig.game.startBetting(BETTING_MS);
    const bet = await rig.betting.placeBet('alice', 100);
    rig.game.lockBets();
    rig.game.startRound();
    await vi.advanceTimersByTimeAsync(msToReach(1.5));

    // Hold the per-bet lock so the cashout stalls after its phase check.
    const { release } = holdBetLock(rig.betting, bet.betId);
    const pending = rig.betting.cashout('alice');
    pending.catch(() => {}); // avoid unhandled rejection noise
    // Crash happens while the cashout is queued on the lock.
    await vi.advanceTimersByTimeAsync(msToReach(CRASH) + 200);
    expect(rig.game.getPhase()).toBe('CRASHED');
    release();

    await expect(pending).rejects.toThrow();
    const stored = await rig.betRepo.get(bet.betId);
    expect(stored?.status).not.toBe('CASHED_OUT');

    const { winners, losers } = await rig.settlement.settle();
    expect(winners).toHaveLength(0);
    expect(losers).toHaveLength(1);
    expect(rig.wallet.getBalance('alice')).toBe(900); // stake lost, nothing paid
  });

  it('duplicate sequential cashout is rejected with exactly-once payout', async () => {
    rig.game.startBetting(BETTING_MS);
    await rig.betting.placeBet('alice', 100);
    rig.game.lockBets();
    rig.game.startRound();
    await vi.advanceTimersByTimeAsync(msToReach(1.5));
    const first = await rig.betting.cashout('alice');
    await expect(rig.betting.cashout('alice')).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(msToReach(CRASH) + 200);
    await rig.settlement.settle();
    expect(rig.wallet.getBalance('alice')).toBeCloseTo(900 + first.payout!, 2);
  });

  it('concurrent duplicate cashouts collapse to a single economic effect', async () => {
    rig.game.startBetting(BETTING_MS);
    await rig.betting.placeBet('alice', 100);
    rig.game.lockBets();
    rig.game.startRound();
    await vi.advanceTimersByTimeAsync(msToReach(1.5));
    const results = await Promise.allSettled([
      rig.betting.cashout('alice'),
      rig.betting.cashout('alice'),
      rig.betting.cashout('alice'),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    expect(ok.length).toBeGreaterThanOrEqual(1);
    const payouts = new Set(ok.map((r: any) => r.value.payout));
    expect(payouts.size).toBe(1); // single-flight: same bet resolution
    await vi.advanceTimersByTimeAsync(msToReach(CRASH) + 200);
    await rig.settlement.settle();
    const payout = [...payouts][0] as number;
    expect(rig.wallet.getBalance('alice')).toBeCloseTo(900 + payout, 2);
  });

  // V-R1: concurrent duplicate bet submissions must not create two ACTIVE bets.
  it('concurrent duplicate bet submissions create at most one bet', async () => {
    rig.game.startBetting(BETTING_MS);
    const results = await Promise.allSettled([
      rig.betting.placeBet('alice', 100),
      rig.betting.placeBet('alice', 100),
      rig.betting.placeBet('alice', 100),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    expect(ok).toHaveLength(1);
    const state = rig.game.getState()!;
    const bets = await rig.betRepo.listByRound(state.roundId);
    expect(bets).toHaveLength(1);
    expect(rig.wallet.getBalance('alice')).toBe(900); // debited exactly once
  });

  it('sequential duplicate bet in the same round is rejected', async () => {
    rig.game.startBetting(BETTING_MS);
    await rig.betting.placeBet('alice', 100);
    await expect(rig.betting.placeBet('alice', 50)).rejects.toThrow(/Already/);
    expect(rig.wallet.getBalance('alice')).toBe(900);
  });

  it('mixed concurrent actions against the same bet settle to exactly one terminal state', async () => {
    rig.game.startBetting(BETTING_MS);
    const bet = await rig.betting.placeBet('alice', 100);
    rig.game.lockBets();
    rig.game.startRound();
    await vi.advanceTimersByTimeAsync(msToReach(1.3));
    const actions = await Promise.allSettled([
      rig.betting.cashout('alice'),
      rig.betting.cashout('alice'),
      rig.betting.placeBet('alice', 100), // invalid while RUNNING
    ]);
    void actions;
    await vi.advanceTimersByTimeAsync(msToReach(CRASH) + 200);
    await rig.settlement.settle();
    const stored = await rig.betRepo.get(bet.betId);
    expect(['CASHED_OUT', 'LOST']).toContain(stored!.status);
    expect(stored!.resolved).toBe(true);
    // wallet reflects exactly one outcome
    const expected = stored!.status === 'CASHED_OUT' ? 900 + stored!.payout! : 900;
    expect(rig.wallet.getBalance('alice')).toBeCloseTo(expected, 2);
  });

  it('auto-cashout triggers exactly once per bet', async () => {
    rig.game.startBetting(BETTING_MS);
    const bet = await rig.betting.placeBet('alice', 100);
    (bet as any).autoCashout = 1.2;
    await rig.betRepo.update(bet);
    rig.game.lockBets();
    rig.game.startRound();
    const cashed = collect('PLAYER_CASHED_OUT');
    await vi.advanceTimersByTimeAsync(msToReach(CRASH) + 200);
    cashed.stop();
    expect(cashed.events.filter((e) => e.betId === bet.betId)).toHaveLength(1);
  });
});
