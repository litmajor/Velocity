import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeRig, msToReach, collect, Rig } from './helpers/rig';

const CRASH = 2.0;
const BETTING_MS = 1_000;

async function runRound(rig: Rig, actors: Array<{ user: string; amount: number; cashoutAt?: number }>) {
  rig.game.startBetting(BETTING_MS);
  for (const a of actors) await rig.betting.placeBet(a.user, a.amount);
  rig.game.lockBets();
  rig.game.startRound();
  const sorted = [...actors].filter((a) => a.cashoutAt).sort((a, b) => a.cashoutAt! - b.cashoutAt!);
  let elapsed = 0;
  for (const a of sorted) {
    const target = msToReach(a.cashoutAt!);
    if (target > elapsed) {
      await vi.advanceTimersByTimeAsync(target - elapsed);
      elapsed = target;
    }
    if (a.cashoutAt! < CRASH) await rig.betting.cashout(a.user);
  }
  await vi.advanceTimersByTimeAsync(msToReach(CRASH) + 200 - elapsed);
  expect(rig.game.getPhase()).toBe('CRASHED');
  return rig.settlement.settle();
}

describe('SettlementEngine invariants', () => {
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

  it('settles winners and losers with conservation of funds', async () => {
    const { winners, losers } = await runRound(rig, [
      { user: 'alice', amount: 100, cashoutAt: 1.5 },
      { user: 'bob', amount: 200 }, // rides to crash, loses
    ]);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    const payout = winners[0].payout;
    expect(payout).toBeLessThanOrEqual(100 * CRASH);
    // settlement cannot create funds: total delta == payout - stakes
    const total = rig.wallet.getBalance('alice') + rig.wallet.getBalance('bob');
    expect(total).toBeCloseTo(2_000 - 300 + payout, 2);
  });

  // V-M3: settle() is callable repeatedly while phase is CRASHED and must not
  // credit winners more than once.
  it('INV-S1: a round cannot be settled twice with economic effect', async () => {
    await runRound(rig, [{ user: 'alice', amount: 100, cashoutAt: 1.5 }]);
    const balanceAfterFirst = rig.wallet.getBalance('alice');
    // second settle attempt: whether it throws or no-ops, no funds may move
    try {
      await rig.settlement.settle();
    } catch {}
    try {
      await rig.settlement.settle();
    } catch {}
    expect(rig.wallet.getBalance('alice')).toBe(balanceAfterFirst);
  });

  it('INV-S2: a bet cannot be both refunded/paid and marked lost', async () => {
    await runRound(rig, [
      { user: 'alice', amount: 100, cashoutAt: 1.5 },
      { user: 'bob', amount: 100 },
    ]);
    const state = (await rig.roundRepo.list()).find((r) => r.phase === 'SETTLED');
    expect(state).toBeTruthy();
    const bets = await rig.betRepo.listByRound(state!.roundId);
    for (const b of bets) {
      expect(b.resolved).toBe(true);
      expect(['CASHED_OUT', 'LOST']).toContain(b.status);
      if (b.status === 'LOST') expect(b.payout ?? 0).toBe(0);
    }
  });

  it('INV-S3: settle emits ROUND_SETTLED exactly once per round', async () => {
    const settled = collect('ROUND_SETTLED');
    await runRound(rig, [{ user: 'alice', amount: 100 }]);
    try {
      await rig.settlement.settle();
    } catch {}
    settled.stop();
    const state = (await rig.roundRepo.list())[0];
    expect(settled.events.filter((e) => e.roundId === state.roundId)).toHaveLength(1);
  });

  it('settle refuses to run outside CRASHED/SETTLED phases', async () => {
    await expect(rig.settlement.settle()).rejects.toThrow(/expected CRASHED/);
    rig.game.startBetting(BETTING_MS);
    await expect(rig.settlement.settle()).rejects.toThrow(/expected CRASHED/);
    rig.game.lockBets();
    await expect(rig.settlement.settle()).rejects.toThrow(/expected CRASHED/);
    rig.game.startRound();
    await expect(rig.settlement.settle()).rejects.toThrow(/expected CRASHED/);
    await vi.advanceTimersByTimeAsync(msToReach(CRASH) + 200);
    await rig.settlement.settle(); // now allowed
  });

  it('every accepted bet reaches a terminal state after settlement', async () => {
    await runRound(rig, [
      { user: 'alice', amount: 10, cashoutAt: 1.2 },
      { user: 'bob', amount: 20 },
    ]);
    const state = (await rig.roundRepo.list())[0];
    const bets = await rig.betRepo.listByRound(state.roundId);
    expect(bets).toHaveLength(2);
    for (const b of bets) expect(b.status === 'ACTIVE').toBe(false);
  });
});
