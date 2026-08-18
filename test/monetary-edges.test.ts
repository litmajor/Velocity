import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeRig, msToReach, Rig } from './helpers/rig';

const CRASH = 3.0;
const BETTING_MS = 1_000;

describe('monetary edge cases through the betting flow', () => {
  let rig: Rig;
  beforeEach(() => {
    vi.useFakeTimers();
    rig = makeRig({ crashPoint: CRASH });
  });
  afterEach(() => {
    try {
      rig.game.reset();
    } catch {}
    vi.useRealTimers();
  });

  it('rejects zero, negative, NaN and Infinity bet amounts with no effect', async () => {
    rig.wallet.ensureAccount('u', 100);
    rig.game.startBetting(BETTING_MS);
    for (const bad of [0, -5, NaN, Infinity, -Infinity]) {
      await expect(rig.betting.placeBet('u', bad)).rejects.toThrow();
    }
    expect(rig.wallet.getBalance('u')).toBe(100);
    const bets = await rig.betRepo.listByRound(rig.game.getState()!.roundId);
    expect(bets).toHaveLength(0);
  });

  // V-M1: a raw amount of e.g. 0.004999 rounds to a 0.00 debit while the bet
  // records the raw amount, letting a zero-balance user mint payouts.
  it('INV-M1: a bet cannot cost less than it can pay out (sub-cent exploit)', async () => {
    rig.wallet.ensureAccount('broke', 0);
    rig.game.startBetting(BETTING_MS);
    await expect(rig.betting.placeBet('broke', 0.004999)).rejects.toThrow();
    expect(rig.wallet.getBalance('broke')).toBe(0);
    const bets = await rig.betRepo.listByRound(rig.game.getState()!.roundId);
    expect(bets).toHaveLength(0);
  });

  it('bet amounts are quantized to cents so payout matches the debited stake', async () => {
    rig.wallet.ensureAccount('u', 100);
    rig.game.startBetting(BETTING_MS);
    const bet = await rig.betting.placeBet('u', 10.006);
    expect(bet.amount).toBeCloseTo(10.01, 10);
    expect(rig.wallet.getBalance('u')).toBeCloseTo(100 - 10.01, 10);
  });

  it('rejects a bet exceeding the available balance, exactly-at-balance succeeds', async () => {
    rig.wallet.ensureAccount('u', 100);
    rig.game.startBetting(BETTING_MS);
    await expect(rig.betting.placeBet('u', 100.01)).rejects.toThrow(/insufficient/);
    expect(rig.wallet.getBalance('u')).toBe(100);
    const bet = await rig.betting.placeBet('u', 100);
    expect(bet.status).toBe('ACTIVE');
    expect(rig.wallet.getBalance('u')).toBe(0);
  });

  it('minimum valid bet (0.01) round-trips without value creation', async () => {
    rig.wallet.ensureAccount('u', 0.01);
    rig.game.startBetting(BETTING_MS);
    const bet = await rig.betting.placeBet('u', 0.01);
    rig.game.lockBets();
    rig.game.startRound();
    await vi.advanceTimersByTimeAsync(msToReach(1.5));
    const out = await rig.betting.cashout('u');
    await vi.advanceTimersByTimeAsync(msToReach(CRASH) + 200);
    await rig.settlement.settle();
    // payout floored to cents; must not exceed amount * multiplier
    expect(out.payout!).toBeLessThanOrEqual(bet.amount * out.cashedOutMultiplier! + 1e-9);
    expect(rig.wallet.getBalance('u')).toBeCloseTo(out.payout!, 10);
  });

  it('very large bets stay consistent (no overflow-driven value creation)', async () => {
    const big = 1_000_000_000; // 1e9
    rig.wallet.ensureAccount('whale', big);
    rig.game.startBetting(BETTING_MS);
    await rig.betting.placeBet('whale', big);
    expect(rig.wallet.getBalance('whale')).toBe(0);
    rig.game.lockBets();
    rig.game.startRound();
    await vi.advanceTimersByTimeAsync(msToReach(2.0));
    const out = await rig.betting.cashout('whale');
    await vi.advanceTimersByTimeAsync(msToReach(CRASH) + 200);
    await rig.settlement.settle();
    expect(Number.isSafeInteger(Math.round(out.payout! * 100))).toBe(true);
    expect(rig.wallet.getBalance('whale')).toBeCloseTo(out.payout!, 2);
  });

  it('repeated deposit/bet/cashout cycles conserve funds across rounds', async () => {
    rig.wallet.ensureAccount('u', 500);
    let expected = 500;
    for (let i = 0; i < 3; i++) {
      rig.game.startBetting(BETTING_MS);
      await rig.betting.placeBet('u', 50);
      expected -= 50;
      rig.game.lockBets();
      rig.game.startRound();
      await vi.advanceTimersByTimeAsync(msToReach(1.4));
      const out = await rig.betting.cashout('u');
      expected += out.payout!;
      await vi.advanceTimersByTimeAsync(msToReach(CRASH) + 200);
      await rig.settlement.settle();
      rig.game.reset();
      expect(rig.wallet.getBalance('u')).toBeCloseTo(expected, 2);
    }
  });

  it('many simultaneous players settle with exact conservation', async () => {
    const N = 40;
    const users = Array.from({ length: N }, (_, i) => `p${i}`);
    for (const u of users) rig.wallet.ensureAccount(u, 100);
    rig.game.startBetting(BETTING_MS);
    await Promise.all(users.map((u, i) => rig.betting.placeBet(u, 1 + (i % 10))));
    rig.game.lockBets();
    rig.game.startRound();
    // half the players cash out at staggered multipliers below crash
    let elapsed = 0;
    for (let i = 0; i < N; i += 2) {
      const target = msToReach(1.1 + (i / N) * 1.5);
      if (target > elapsed) {
        await vi.advanceTimersByTimeAsync(target - elapsed);
        elapsed = target;
      }
      await rig.betting.cashout(users[i]);
    }
    await vi.advanceTimersByTimeAsync(msToReach(CRASH) + 200 - elapsed);
    const { winners, losers } = await rig.settlement.settle();
    expect(winners.length + losers.length).toBe(N);
    const totalStakes = users.reduce((s, _, i) => s + 1 + (i % 10), 0);
    const totalPayout = winners.reduce((s, w) => s + w.payout, 0);
    const totalBalances = users.reduce((s, u) => s + rig.wallet.getBalance(u), 0);
    expect(totalBalances).toBeCloseTo(N * 100 - totalStakes + totalPayout, 1);
  });
});
