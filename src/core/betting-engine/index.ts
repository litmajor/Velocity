import crypto from 'crypto';
import { eventBus } from '../../runtime/event-bus';
import { ExposureEngine } from '../exposure-engine';
import { UserBehaviorEngine } from '../user-behavior';

interface Tick {
  roundId: string;
  tickIndex: number;
  multiplier: number;
  timestamp: number;
}
import type { Bet, GameEvents } from '../../domains/game';
import type { GameEngine } from '../game-engine';
import type { WalletEngine } from '../wallet-engine';
import type { BetRepository } from '../repositories/bet-repository';
import { saveJSON, loadJSON, ensureDataDir } from '../../runtime/persistence';

export class BettingEngine {
  // deterministic tick ledger to avoid relying on mutable gameEngine state
  // roundId -> Tick[]
  private tickLedger = new Map<string, Tick[]>();
  private readonly TICK_LEDGER_MAX = 4096;
  private processedEvents = new Set<string>();
  private readonly PROCESSED_EVENTS_MAX = 8192;
  private bets      = new Map<string, Bet>();         // betId → Bet
  private userRound = new Map<string, string>();      // `${userId}:${roundId}` → betId
  private roundBets = new Map<string, Set<string>>(); // roundId → Set<betId>
  private inflightCashouts = new Map<string, Promise<Bet>>(); // `${roundId}:${userId}` -> Promise
  private pendingBets = new Set<string>(); // `${userId}:${roundId}` claimed synchronously to serialize duplicate submissions
  // per-bet async locks to enforce atomic updates
  private betLocks = new Map<string, Promise<void>>();

  constructor(private gameEngine: GameEngine, private wallet: WalletEngine, private repo: BetRepository) {
    this.ensureSubscribed();
    this.exposure = new ExposureEngine();
    this.userBehavior = new UserBehaviorEngine();
    // bootstrap in-memory indexes from repository for any active round
    void this.bootstrap();
    // also load persisted tick ledger if present
    void this.loadTickLedger();
    // periodic flush of tick ledger
    setInterval(() => { void this.saveTickLedger(); }, 5000);
  }

  // bootstrap in-memory indexes from repository for any active round
  private async bootstrap() {
    try {
      const state = this.gameEngine.getState();
      if (!state) return;
      const bets = await this.repo.listByRound(state.roundId);
      for (const b of bets) {
        this.bets.set(b.betId, b);
        this.userRound.set(`${b.userId}:${b.roundId}`, b.betId);
        const set = this.roundBets.get(b.roundId) ?? new Set<string>();
        set.add(b.betId);
        this.roundBets.set(b.roundId, set);
      }
    } catch (e) {
      // ignore bootstrap errors
    }
  }

  private exposure: ExposureEngine;
  public userBehavior: UserBehaviorEngine;
  // threshold in currency units for total liability that triggers steering
  private LIABILITY_THRESHOLD = Number(process.env.LIABILITY_THRESHOLD ?? 10000);

  private multiplierHandler = async (data: GameEvents['MULTIPLIER_UPDATED']) => {
    const { roundId, multiplier, tickIndex } = data as any;
    const id = `auto:${roundId}:${tickIndex ?? '0'}`;
    if (this.processedEvents.has(id)) return;
    this.processedEvents.add(id);
    const betIds = Array.from(this.roundBets.get(roundId) ?? []);
    if (betIds.length === 0) return;
    for (const id of betIds) {
      const b = this.bets.get(id);
      if (!b || b.status !== 'ACTIVE') continue;
      if (b.autoCashout && multiplier >= b.autoCashout) {
        this.cashout(b.userId).catch(() => {});
      }
    }
  };

  private tickHandler = (data: any) => {
    try {
      const { roundId, multiplier, ts, tickIndex } = data as { roundId: string; multiplier: number; ts?: number; tickIndex?: number };
      const idx = typeof tickIndex === 'number' ? tickIndex : Math.floor((ts ?? Date.now()) / this.TICK_LEDGER_MAX);
      const id = `tick:${roundId}:${idx}`;
      if (this.processedEvents.has(id)) return;
      this.processedEvents.add(id);
      if (this.processedEvents.size > this.PROCESSED_EVENTS_MAX) {
        // simple eviction: clear half
        const it = this.processedEvents.values();
        for (let i = 0; i < Math.floor(this.PROCESSED_EVENTS_MAX / 2); i++) { const v = it.next(); if (v.done) break; this.processedEvents.delete(v.value); }
      }
      const tick: Tick = { roundId, tickIndex: idx, multiplier, timestamp: ts ?? Date.now() };
      const arr = this.tickLedger.get(roundId) ?? [];
      arr.push(tick);
      if (arr.length > this.TICK_LEDGER_MAX) arr.shift();
      this.tickLedger.set(roundId, arr);
    } catch (e) {}
  };

  private readonly TICK_PERSIST_FILE = 'tick_ledger.json';

  private async saveTickLedger() {
    try {
      await ensureDataDir();
      const serial: { [k: string]: Tick[] } = {};
      for (const [k, v] of this.tickLedger.entries()) serial[k] = v;
      await saveJSON(this.TICK_PERSIST_FILE, serial);
    } catch (e) {}
  }

  private async loadTickLedger() {
    try {
      await ensureDataDir();
      const obj = await loadJSON<{ [k: string]: Tick[] }>(this.TICK_PERSIST_FILE);
      if (!obj) return;
      for (const k of Object.keys(obj)) this.tickLedger.set(k, obj[k]);
    } catch (e) {}
  }

  // Public API to flush persisted tick ledger
  public async persistTickLedger() {
    await this.saveTickLedger();
  }

  getLatestTick(roundId: string): Tick | null {
    const arr = this.tickLedger.get(roundId);
    if (!arr || arr.length === 0) return null;
    return arr[arr.length - 1];
  }

  // subscribe to multiplier updates for auto-cashout
  private ensureSubscribed() {
    // attach once on creation — prefer TICK_UPDATE as the authoritative tick ledger
    eventBus.on('TICK_UPDATE' as any, this.multiplierHandler as any);
    eventBus.on('TICK_UPDATE' as any, this.tickHandler as any);
    // keep legacy MULTIPLIER_UPDATED for compatibility but don't rely on it
    eventBus.on('MULTIPLIER_UPDATED' as any, this.multiplierHandler as any);
    eventBus.on('MULTIPLIER_UPDATED' as any, this.tickHandler as any);
  }

  async placeBet(userId: string, amount: number): Promise<Bet> {
    const state = this.gameEngine.getState();

    if (!state || state.phase !== 'BETTING') {
      const reason = !state ? 'No active round' : `Betting is closed (phase: ${state.phase})`;
      eventBus.emit('BET_REJECTED', { roundId: state?.roundId ?? 'none', userId, reason });
      throw new Error(reason);
    }

    if (!Number.isFinite(amount) || amount <= 0) {
      const reason = 'Bet amount must be positive';
      eventBus.emit('BET_REJECTED', { roundId: state.roundId, userId, reason });
      throw new Error(reason);
    }

    // Quantize the stake to cents so the recorded bet amount always equals the
    // amount actually reserved/debited (sub-cent amounts cannot mint payouts).
    const stake = Math.round(amount * 100) / 100;
    if (stake < 0.01) {
      const reason = 'Bet amount below minimum (0.01)';
      eventBus.emit('BET_REJECTED', { roundId: state.roundId, userId, reason });
      throw new Error(reason);
    }

    // Claim the (user, round) slot synchronously so concurrent duplicate
    // submissions cannot interleave past the async repository check.
    const dupKey = `${userId}:${state.roundId}`;
    if (this.pendingBets.has(dupKey) || this.userRound.has(dupKey)) {
      const reason = 'Already have an active bet this round';
      eventBus.emit('BET_REJECTED', { roundId: state.roundId, userId, reason });
      throw new Error(reason);
    }
    this.pendingBets.add(dupKey);
    try {
      return await this.placeBetInner(userId, stake, state, dupKey);
    } finally {
      this.pendingBets.delete(dupKey);
    }
  }

  private async placeBetInner(
    userId: string,
    amount: number,
    state: NonNullable<ReturnType<GameEngine['getState']>>,
    dupKey: string,
  ): Promise<Bet> {
    // check existing bet for user in this round (durable duplicate check)
    const existing = (await this.repo.listByRound(state.roundId)).find(b => b.userId === userId && b.status === 'ACTIVE');
    if (existing) {
      const reason = 'Already have an active bet this round';
      eventBus.emit('BET_REJECTED', { roundId: state.roundId, userId, reason });
      throw new Error(reason);
    }

    // ensure user has an account and reserve funds. The reservation id is
    // derived from the betId so startup recovery can link an orphaned
    // reservation back to its bet (or lack of one) after a process failure.
    this.wallet.ensureAccount(userId);
    const betId = crypto.randomUUID();
    const resId = `bet:${betId}`;
    try {
      this.wallet.reserve(userId, amount, resId);
    } catch (err) {
      const reason = (err as Error).message || 'insufficient funds';
      eventBus.emit('BET_REJECTED', { roundId: state?.roundId ?? 'none', userId, reason });
      throw new Error(reason);
    }

    const bet: Bet = {
      betId,
      userId,
      roundId:  state.roundId,
      amount,
      placedAt: Date.now(),
      status:   'ACTIVE',
      reservationId: resId,
    } as Bet;

    try {
      await this.repo.save(bet);
    } catch (err) {
      // rollback reservation on failure
      try { this.wallet.rollback(resId); } catch (e) {}
      const reason = (err as Error).message || 'persist error';
      eventBus.emit('BET_REJECTED', { roundId: state?.roundId ?? 'none', userId, reason });
      throw err;
    }
    // Maintain in-memory authoritative indexes immediately after persistence
    this.bets.set(bet.betId, bet);
    this.userRound.set(dupKey, bet.betId);
    const set = this.roundBets.get(state.roundId) ?? new Set<string>();
    set.add(bet.betId);
    this.roundBets.set(state.roundId, set);
    // commit reservation (resId); on failure the open reservation is
    // reconciled by startup recovery (bet exists -> commit)
    try { this.wallet.commit(resId); } catch (e) { console.error('[Betting] commit failed for', resId, e); }
    try { this.userBehavior.recordBet(userId, amount); } catch (e) {}

    eventBus.emit('BET_PLACED', {
      roundId: state.roundId,
      userId,
      amount,
      betId:   bet.betId,
    });

    // update exposure snapshot and steer shaping params if necessary
    try {
      const bets = await this.repo.listByRound(state.roundId);
      const snap = this.exposure.computeSnapshot(bets);
      if (snap.totalLiability > this.LIABILITY_THRESHOLD) {
        // bias next rounds toward CALM/RESET by reducing volatility and increasing
        // instant crash divisor to limit extreme payouts. This is a soft steering
        // that still remains provable via published shaping params.
        this.gameEngine.setShapingParams({ volatility: 1.5, instantCrashDivisor: 20 });
        eventBus.emit('EVENT_APPEND', { envelope: { event: 'EXPOSURE_ALERT', data: snap, timestamp: Date.now() } });
      }
    } catch (e) {
      // ignore exposure errors
    }

    // Recompute player composition and inform GameEngine/Fairness for global shaping
    try {
      const profiles = this.userBehavior.listProfiles();
      if (profiles && profiles.length > 0) {
        let cons = 0, greedy = 0, tilted = 0;
        for (const p of profiles) {
          if (p.avgCashoutMultiplier >= 1.3 && p.avgCashoutMultiplier <= 2.5) cons += 1;
          if (p.avgCashoutMultiplier >= 5 || p.betSizeGrowth >= 1.5) greedy += 1;
          if (p.betSizeGrowth > 1.2 || p.lossStreak > 2) tilted += 1;
        }
        const total = Math.max(1, cons + greedy + tilted);
        const mix = { conservative: cons / total, greedy: greedy / total, tilted: tilted / total };
        try { this.gameEngine.setPlayerMix(mix); } catch (e) {}
      }
    } catch (e) {}

    return bet;
  }

  async cashout(userId: string): Promise<Bet> {
    const state = this.gameEngine.getState();

    if (!state || state.phase !== 'RUNNING') {
      const reason = !state ? 'No active round' : `Cannot cashout during ${state.phase}`;
      eventBus.emit('CASHOUT_REJECTED', { userId, reason });
      throw new Error(reason);
    }

    const key = `${state.roundId}:${userId}`;
    if (this.inflightCashouts.has(key)) return this.inflightCashouts.get(key)!;

    const promise = (async () => {
      const betId = this.userRound.get(`${userId}:${state.roundId}`);
      if (!betId) {
        const reason = 'No bet found for user this round';
        eventBus.emit('CASHOUT_REJECTED', { userId, reason });
        throw new Error(reason);
      }

      // Acquire per-bet lock to make cashout atomic with settlement
      return await this.withBetLock(betId, async () => {
        // Re-check the phase now that we hold the lock: the round may have
        // crashed while this cashout was queued behind another operation.
        const phaseNow = this.gameEngine.getPhase();
        if (phaseNow !== 'RUNNING') {
          const reason = `Cannot cashout during ${phaseNow}`;
          eventBus.emit('CASHOUT_REJECTED', { userId, reason });
          throw new Error(reason);
        }
        // read authoritative in-memory bet
        let fresh = this.bets.get(betId) ?? null;
        if (!fresh) {
          // fallback to repo for bootstrapping (rare)
          fresh = await this.repo.get(betId) as any;
          if (!fresh) {
            const reason = 'No bet found (post-lock)';
            eventBus.emit('CASHOUT_REJECTED', { userId, reason });
            throw new Error(reason);
          }
          // populate in-memory store
          this.bets.set(betId, fresh);
          this.userRound.set(`${fresh.userId}:${fresh.roundId}`, betId);
          const set = this.roundBets.get(fresh.roundId) ?? new Set<string>();
          set.add(betId);
          this.roundBets.set(fresh.roundId, set);
        }

        // If already resolved or not ACTIVE, reject
        if (fresh.resolved || fresh.status !== 'ACTIVE') {
          const reason = 'Already resolved or not active';
          eventBus.emit('CASHOUT_REJECTED', { userId, reason });
          throw new Error(reason);
        }

        // Lock-in multiplier at exact moment of cashout (server authoritative)
        const tick = this.getLatestTick(state.roundId);
        const multiplier = tick?.multiplier ?? state.multiplier;
        const payout     = Math.floor(fresh.amount * multiplier * 100) / 100;

        // perform atomic in-memory transition before persisting
        fresh.status              = 'CASHED_OUT';
        fresh.cashedOutAt         = Date.now();
        fresh.cashedOutMultiplier = multiplier;
        fresh.payout              = payout;
        fresh.resolved            = true;

        // persist
        await this.repo.update(fresh);

        // update indexes
        this.bets.set(betId, fresh);
        const roundSet = this.roundBets.get(fresh.roundId);
        if (roundSet) roundSet.delete(betId);
        this.userRound.delete(`${userId}:${fresh.roundId}`);

        eventBus.emit('PLAYER_CASHED_OUT', {
          roundId:    state.roundId,
          userId,
          betId:      fresh.betId,
          multiplier,
          payout,
        });

        // Report win to volatility engine (elasticity shaping)
        try { this.gameEngine.recordWin(payout ?? 0); } catch (e) {}
        // Update per-user behavior metrics
        try { this.userBehavior.recordCashout(userId, multiplier, payout); } catch (e) {}

        // Re-evaluate exposure after this cashout and relax steering if liability reduced
        try {
          const betsNow = Array.from(this.roundBets.get(state.roundId) ?? []).map(id => this.bets.get(id)).filter(Boolean) as Bet[];
          const snapNow = this.exposure.computeSnapshot(betsNow);
          if (snapNow.totalLiability < this.LIABILITY_THRESHOLD) {
            this.gameEngine.setShapingParams({ volatility: 1, instantCrashDivisor: 33 });
            eventBus.emit('EVENT_APPEND', { envelope: { event: 'EXPOSURE_NORMALIZED', data: snapNow, timestamp: Date.now() } });
          }
        } catch (e) {}

        return fresh as Bet;
      });
    })();

    this.inflightCashouts.set(key, promise);
    promise.finally(() => this.inflightCashouts.delete(key)).catch(() => {});
    return promise;
  }

  async getBetsForRound(roundId: string): Promise<Bet[]> {
    return this.repo.listByRound(roundId);
  }

  async getBet(betId: string): Promise<Bet | null> {
    return this.repo.get(betId);
  }

  // Persist an updated bet back to the repository. Used by SettlementEngine
  // to ensure LOST/CASHED_OUT states are durable (especially for file repos).
  async updateBet(bet: Bet): Promise<void> {
    await this.repo.update(bet);
    // keep in-memory indexes consistent
    this.bets.set(bet.betId, bet);
    if (bet.status === 'ACTIVE') {
      this.userRound.set(`${bet.userId}:${bet.roundId}`, bet.betId);
      const set = this.roundBets.get(bet.roundId) ?? new Set<string>();
      set.add(bet.betId);
      this.roundBets.set(bet.roundId, set);
    } else {
      // resolved or cashed out or lost — remove from active maps
      this.userRound.delete(`${bet.userId}:${bet.roundId}`);
      const set = this.roundBets.get(bet.roundId);
      if (set) set.delete(bet.betId);
    }
  }

  // Execute a function while holding an async lock for a specific betId
  async withBetLock<T>(betId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.betLocks.get(betId) ?? Promise.resolve();
    let release: () => void = () => {};
    const next = new Promise<void>(res => { release = res; });
    // chain the next promise after the previous
    this.betLocks.set(betId, prev.then(() => next));
    try {
      // wait for previous to finish
      await prev;
      // run critical section
      return await fn();
    } finally {
      // release and allow next in chain to run
      release();
      // clean up if there is no chained waiter
      const current = this.betLocks.get(betId);
      if (current === next) this.betLocks.delete(betId);
    }
  }
}
