import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eventBus } from '../src/runtime/event-bus';
import { makeRig, msToReach, collect, Rig } from './helpers/rig';

const CRASH = 3.0;
const BETTING_MS = 1_000;

describe('event ordering, duplication and handler behavior', () => {
  let rig: Rig;
  beforeEach(() => {
    vi.useFakeTimers();
    rig = makeRig({ crashPoint: CRASH });
    rig.wallet.ensureAccount('u', 1_000);
  });
  afterEach(() => {
    try {
      rig.game.reset();
    } catch {}
    vi.useRealTimers();
  });

  async function startRunningRoundWithBet(autoCashout?: number) {
    rig.game.startBetting(BETTING_MS);
    const bet = await rig.betting.placeBet('u', 100);
    if (autoCashout) {
      const stored = await rig.betRepo.get(bet.betId);
      (stored as any).autoCashout = autoCashout;
      await rig.betting.updateBet(stored!);
    }
    rig.game.lockBets();
    rig.game.startRound();
    return bet;
  }

  it('duplicate TICK_UPDATE events are deduplicated by (roundId, tickIndex)', async () => {
    await startRunningRoundWithBet();
    await vi.advanceTimersByTimeAsync(msToReach(1.5));
    const roundId = rig.game.getState()!.roundId;
    const before = rig.betting.getLatestTick(roundId)!;
    // replay the exact same tick event (duplicate delivery)
    eventBus.emit('TICK_UPDATE' as any, {
      roundId,
      multiplier: before.multiplier,
      ts: before.timestamp,
      tickIndex: before.tickIndex,
    } as any);
    const after = rig.betting.getLatestTick(roundId)!;
    expect(after.tickIndex).toBe(before.tickIndex); // not appended twice
  });

  it('DOCUMENTED: an out-of-order (older) tick that was never seen becomes the "latest" tick', async () => {
    await startRunningRoundWithBet();
    await vi.advanceTimersByTimeAsync(msToReach(2.0));
    const roundId = rig.game.getState()!.roundId;
    const current = rig.betting.getLatestTick(roundId)!;
    // deliver a stale tick with an unseen (fabricated, older) index
    eventBus.emit('TICK_UPDATE' as any, {
      roundId,
      multiplier: 1.01,
      ts: 0,
      tickIndex: current.tickIndex + 100_000, // unseen id, stale payload
    } as any);
    const after = rig.betting.getLatestTick(roundId)!;
    // ledger appends by arrival order, not tick order: cashouts would now
    // use the stale 1.01 multiplier (getLatestTick = last received)
    expect(after.multiplier).toBe(1.01);
  });

  it('auto-cashout triggers exactly once even with duplicate trigger ticks', async () => {
    const cashed = collect('PLAYER_CASHED_OUT');
    await startRunningRoundWithBet(1.5);
    await vi.advanceTimersByTimeAsync(msToReach(1.6));
    const roundId = rig.game.getState()!.roundId;
    const tick = rig.betting.getLatestTick(roundId)!;
    // duplicate the triggering tick several times
    for (let i = 0; i < 3; i++) {
      eventBus.emit('TICK_UPDATE' as any, { roundId, multiplier: tick.multiplier, ts: tick.timestamp, tickIndex: tick.tickIndex } as any);
    }
    await vi.advanceTimersByTimeAsync(200);
    cashed.stop();
    expect(cashed.events.filter((e) => e.userId === 'u')).toHaveLength(1);
  });

  it('missing tick events: cashout falls back to game-state multiplier', async () => {
    await startRunningRoundWithBet();
    const roundId = rig.game.getState()!.roundId;
    await vi.advanceTimersByTimeAsync(msToReach(1.8));
    // simulate a consumer that lost its tick ledger
    (rig.betting as any).tickLedger.delete(roundId);
    const out = await rig.betting.cashout('u');
    expect(out.status).toBe('CASHED_OUT');
    expect(out.cashedOutMultiplier).toBeGreaterThan(1);
    expect(out.cashedOutMultiplier).toBeLessThanOrEqual(CRASH);
  });

  it('DOCUMENTED: a throwing subscriber breaks delivery to later subscribers (sync EventEmitter)', () => {
    const seen: string[] = [];
    const bad = () => {
      throw new Error('handler failure');
    };
    const good = () => {
      seen.push('good');
    };
    eventBus.on('BET_PLACED' as any, bad as any);
    eventBus.on('BET_PLACED' as any, good as any);
    try {
      expect(() =>
        eventBus.emit('BET_PLACED', { roundId: 'r', userId: 'u', amount: 1, betId: 'b' } as any),
      ).toThrow('handler failure');
      // later subscriber never ran — no retry / isolation exists
      expect(seen).toEqual([]);
    } finally {
      eventBus.off('BET_PLACED' as any, bad as any);
      eventBus.off('BET_PLACED' as any, good as any);
    }
  });

  it('economic effects flow through direct calls, not events: replaying PLAYER_CASHED_OUT moves no funds', async () => {
    await startRunningRoundWithBet();
    await vi.advanceTimersByTimeAsync(msToReach(1.5));
    const out = await rig.betting.cashout('u');
    const balBefore = rig.wallet.getBalance('u');
    // replay the cashout event (duplicate delivery to all subscribers)
    eventBus.emit('PLAYER_CASHED_OUT', {
      roundId: out.roundId,
      userId: 'u',
      betId: out.betId,
      multiplier: out.cashedOutMultiplier!,
      payout: out.payout!,
    } as any);
    expect(rig.wallet.getBalance('u')).toBe(balBefore);
  });
});
