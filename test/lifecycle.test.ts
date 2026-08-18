import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeRig, msToReach, collect, Rig } from './helpers/rig';

const CRASH = 1.8;
const BETTING_MS = 1_000;

describe('round lifecycle invariants', () => {
  let rig: Rig;
  beforeEach(() => {
    vi.useFakeTimers();
    rig = makeRig({ crashPoint: CRASH });
    rig.wallet.ensureAccount('alice', 1_000);
  });
  afterEach(() => {
    try {
      rig.game.reset();
    } catch {}
    vi.useRealTimers();
  });

  it('INV-L1: states cannot be skipped', () => {
    expect(() => rig.game.lockBets()).toThrow(/expected phase BETTING/);
    expect(() => rig.game.startRound()).toThrow(/expected phase LOCKED/);
    rig.game.startBetting(BETTING_MS);
    expect(() => rig.game.startRound()).toThrow(/expected phase LOCKED/);
  });

  it('INV-L2: states cannot transition backwards', () => {
    rig.game.startBetting(BETTING_MS);
    rig.game.lockBets();
    expect(() => rig.game.startBetting(BETTING_MS)).toThrow(/state must be null/);
    expect(() => rig.game.lockBets()).toThrow(/expected phase BETTING/);
    rig.game.startRound();
    expect(() => rig.game.lockBets()).toThrow(/expected phase BETTING/);
    expect(() => rig.game.startRound()).toThrow(/expected phase LOCKED/);
    expect(() => rig.game.startBetting(BETTING_MS)).toThrow(/state must be null/);
  });

  it('INV-L3: full lifecycle BETTING → LOCKED → RUNNING → CRASHED with a single crash event', async () => {
    const crashes = collect('ROUND_CRASHED');
    const state = rig.game.startBetting(BETTING_MS);
    expect(state.phase).toBe('BETTING');
    rig.game.lockBets();
    expect(rig.game.getPhase()).toBe('LOCKED');
    rig.game.startRound();
    expect(rig.game.getPhase()).toBe('RUNNING');
    await vi.advanceTimersByTimeAsync(msToReach(CRASH) + 500);
    crashes.stop();
    expect(rig.game.getPhase()).toBe('CRASHED');
    const mine = crashes.events.filter((e) => e.roundId === state.roundId);
    expect(mine).toHaveLength(1);
    expect(mine[0].crashPoint).toBe(CRASH);
    // multiplier lands exactly on crashPoint and never exceeds it
    expect(rig.game.getState()!.multiplier).toBe(CRASH);
  });

  it('INV-L4: multiplier never exceeds crashPoint on any tick', async () => {
    rig.game.startBetting(BETTING_MS);
    rig.game.lockBets();
    rig.game.startRound();
    const ticks = collect('TICK_UPDATE');
    await vi.advanceTimersByTimeAsync(msToReach(CRASH) + 500);
    ticks.stop();
    expect(ticks.events.length).toBeGreaterThan(0);
    for (const t of ticks.events) expect(t.multiplier).toBeLessThanOrEqual(CRASH);
  });

  it('INV-L5: consecutive rounds do not contaminate each other', async () => {
    const roundIds = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const s = rig.game.startBetting(BETTING_MS);
      expect(roundIds.has(s.roundId)).toBe(false);
      roundIds.add(s.roundId);
      await rig.betting.placeBet('alice', 10);
      rig.game.lockBets();
      rig.game.startRound();
      await vi.advanceTimersByTimeAsync(msToReach(CRASH) + 200);
      const { winners, losers } = await rig.settlement.settle();
      // only this round's single bet is settled
      expect(winners.length + losers.length).toBe(1);
      rig.game.reset();
      expect(rig.game.getState()).toBeNull();
    }
    // every bet across rounds reached a terminal state
    for (const rid of roundIds) {
      for (const b of await rig.betRepo.listByRound(rid)) {
        expect(b.status).not.toBe('ACTIVE');
      }
    }
  });

  it('INV-L6: startBetting after an unsettled CRASHED round recovers rather than corrupting state', async () => {
    rig.game.startBetting(BETTING_MS);
    rig.game.lockBets();
    rig.game.startRound();
    await vi.advanceTimersByTimeAsync(msToReach(CRASH) + 200);
    expect(rig.game.getPhase()).toBe('CRASHED');
    // documented behavior: startBetting() from CRASHED runs recover() and starts a new round
    const s2 = rig.game.startBetting(BETTING_MS);
    expect(s2.phase).toBe('BETTING');
    rig.game.reset();
  });

  it('BOUNDED RISK: reset() during RUNNING orphans active bets (documented)', async () => {
    rig.game.startBetting(BETTING_MS);
    const bet = await rig.betting.placeBet('alice', 100);
    rig.game.lockBets();
    rig.game.startRound();
    await vi.advanceTimersByTimeAsync(200);
    rig.game.reset(); // no guard against mid-round reset
    expect(rig.game.getState()).toBeNull();
    const stored = await rig.betRepo.get(bet.betId);
    // The stake was debited but the bet never reaches a terminal state.
    expect(stored!.status).toBe('ACTIVE');
    expect(rig.wallet.getBalance('alice')).toBe(900);
  });

  it('getState() exposes an immutable snapshot', () => {
    rig.game.startBetting(BETTING_MS);
    const snap = rig.game.getState()!;
    expect(() => {
      (snap as any).phase = 'CRASHED';
    }).toThrow();
    expect(rig.game.getPhase()).toBe('BETTING');
  });
});
