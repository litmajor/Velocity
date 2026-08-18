// Deterministic mock state source (SSA /runtime layer). CLEARLY MOCK:
// simulates the BETTING -> LOCKED -> RUNNING -> CRASHED -> SETTLED lifecycle,
// mock players, cashouts, wallet changes and fairness placeholder fields so
// the UI can be exercised without a backend. It reuses NO production engine
// logic and its crash points are NOT drawn from the production distribution.

import type { GameClient } from './game-client.js';
import type { ClientGameEvent } from '../domains/game/events.js';
import type { PlayerRow } from '../core/types.js';

const BETTING_MS = 6_000;
const LOCKED_MS = 1_500;
const CRASHED_MS = 2_500;
const SETTLED_MS = 1_500;
const TICK_MS = 60;
const GROWTH_PER_SEC = 0.35; // multiplier = e^(GROWTH_PER_SEC * t)

// mulberry32: tiny deterministic PRNG so every page load replays the same rounds
const mulberry32 = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const MOCK_NAMES = ['nova', 'kite', 'jax', 'zuri', 'moss', 'ember', 'rix', 'tala'];

interface MockPlayer extends PlayerRow {
  cashoutAt: number | null; // multiplier at which this mock player cashes out
}

export class MockGameClient implements GameClient {
  private handlers: Array<(ev: ClientGameEvent) => void> = [];
  private rand: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private phaseTimer: ReturnType<typeof setTimeout> | null = null;

  private roundNumber = 0;
  private roundId = '';
  private phase: 'BETTING' | 'LOCKED' | 'RUNNING' | 'CRASHED' | 'SETTLED' = 'SETTLED';
  private crashPoint = 1;
  private runStartedAt = 0;
  private multiplier = 1;
  private players: MockPlayer[] = [];

  private balance = 1_000;
  private myStake = 0;
  private myAutoCashout: number | null = null;
  private myBetLive = false;
  private txSeq = 0;

  constructor(seed = 20260218) {
    this.rand = mulberry32(seed);
  }

  connect(): void {
    this.emit({ type: 'IDENTITY_SET', userId: 'you' });
    this.emit({ type: 'CONNECTION_CHANGED', status: 'MOCK' });
    this.emit({ type: 'WALLET_BALANCE_UPDATED', balance: this.balance });
    this.pushTx('DEPOSIT', this.balance);
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.startBetting();
  }

  disconnect(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.phaseTimer) clearTimeout(this.phaseTimer);
    this.timer = null;
    this.phaseTimer = null;
  }

  onEvent(handler: (ev: ClientGameEvent) => void): void {
    this.handlers.push(handler);
  }

  placeBet(stake: number, autoCashout: number | null): void {
    if (this.phase !== 'BETTING') {
      this.emit({ type: 'BET_REJECTED', reason: 'Betting is closed' });
      return;
    }
    if (this.myBetLive) {
      this.emit({ type: 'BET_REJECTED', reason: 'You already have a bet this round' });
      return;
    }
    if (!Number.isFinite(stake) || stake < 0.01) {
      this.emit({ type: 'BET_REJECTED', reason: 'Invalid amount' });
      return;
    }
    if (stake > this.balance) {
      this.emit({ type: 'BET_REJECTED', reason: 'Insufficient balance' });
      return;
    }
    this.balance = Math.round((this.balance - stake) * 100) / 100;
    this.myStake = stake;
    this.myAutoCashout = autoCashout;
    this.myBetLive = true;
    this.emit({ type: 'WALLET_BALANCE_UPDATED', balance: this.balance });
    this.pushTx('BET', -stake);
    this.emit({ type: 'BET_ACCEPTED', stake, autoCashout });
    this.players = [
      { userId: 'you', stake, autoCashout, status: 'ACTIVE', cashedOutMultiplier: null, payout: null, cashoutAt: null },
      ...this.players.filter((p) => p.userId !== 'you'),
    ];
    this.publishPlayers();
  }

  cashout(): void {
    if (this.phase !== 'RUNNING' || !this.myBetLive) {
      this.emit({ type: 'CASHOUT_REJECTED', reason: this.myBetLive ? 'Round is not running' : 'No active bet' });
      return;
    }
    this.settleMyCashout(this.multiplier);
  }

  // -- internal lifecycle -----------------------------------------------

  private startBetting(): void {
    this.roundNumber += 1;
    this.roundId = `mock-round-${this.roundNumber}`;
    this.phase = 'BETTING';
    this.multiplier = 1;
    this.myBetLive = false;
    this.myStake = 0;
    this.myAutoCashout = null;
    this.crashPoint = this.drawCrashPoint();
    this.players = this.drawPlayers();

    this.emit({
      type: 'ROUND_STARTED',
      roundId: this.roundId,
      roundNumber: this.roundNumber,
      serverHash: this.hex(64),
      paramsCommit: this.hex(64),
      clientSeed: this.hex(16),
      nonce: this.roundNumber,
      bettingEndsAt: Date.now() + BETTING_MS,
    });
    this.publishPlayers();
    this.schedule(() => this.lock(), BETTING_MS);
  }

  private lock(): void {
    this.phase = 'LOCKED';
    this.emit({ type: 'ROUND_LOCKED', roundId: this.roundId });
    this.schedule(() => this.run(), LOCKED_MS);
  }

  private run(): void {
    this.phase = 'RUNNING';
    this.runStartedAt = Date.now();
    this.emit({ type: 'ROUND_RUNNING', roundId: this.roundId });
  }

  private crash(): void {
    this.phase = 'CRASHED';
    if (this.myBetLive) this.myBetLive = false;
    this.emit({
      type: 'ROUND_CRASHED',
      roundId: this.roundId,
      crashPoint: this.crashPoint,
      serverSeed: this.hex(64),
      shapingParams: { houseEdge: 0.01, volatility: 1, mock: true },
      volatilitySnapshot: { state: 'CALM', profile: { beta: 0.04, lambda: 1.2 }, mock: true },
    });
    this.schedule(() => this.settle(), CRASHED_MS);
  }

  private settle(): void {
    this.phase = 'SETTLED';
    this.emit({ type: 'ROUND_SETTLED', roundId: this.roundId });
    this.schedule(() => this.startBetting(), SETTLED_MS);
  }

  private tick(): void {
    this.emit({ type: 'CLOCK_TICKED', now: Date.now() });
    if (this.phase !== 'RUNNING') return;

    const t = (Date.now() - this.runStartedAt) / 1000;
    this.multiplier = Math.min(this.crashPoint, Math.floor(Math.exp(GROWTH_PER_SEC * t) * 100) / 100);
    this.emit({ type: 'MULTIPLIER_UPDATED', roundId: this.roundId, multiplier: this.multiplier });

    let changed = false;
    for (const p of this.players) {
      if (p.status !== 'ACTIVE' || p.userId === 'you') continue;
      const target = p.cashoutAt ?? p.autoCashout;
      if (target !== null && this.multiplier >= target && target < this.crashPoint) {
        p.status = 'CASHED_OUT';
        p.cashedOutMultiplier = target;
        p.payout = Math.floor(p.stake * target * 100) / 100;
        changed = true;
      }
    }
    if (this.myBetLive && this.myAutoCashout !== null && this.multiplier >= this.myAutoCashout) {
      this.settleMyCashout(this.myAutoCashout);
      changed = true;
    }
    if (changed) this.publishPlayers();

    if (this.multiplier >= this.crashPoint) this.crash();
  }

  private settleMyCashout(multiplier: number): void {
    const payout = Math.floor(this.myStake * multiplier * 100) / 100;
    this.balance = Math.round((this.balance + payout) * 100) / 100;
    this.myBetLive = false;
    this.emit({ type: 'CASHOUT_ACCEPTED', multiplier, payout });
    this.emit({ type: 'WALLET_BALANCE_UPDATED', balance: this.balance });
    this.pushTx('PAYOUT', payout);
    const me = this.players.find((p) => p.userId === 'you');
    if (me) {
      me.status = 'CASHED_OUT';
      me.cashedOutMultiplier = multiplier;
      me.payout = payout;
      this.publishPlayers();
    }
  }

  // -- deterministic data generation --------------------------------------

  private drawCrashPoint(): number {
    // Mock-only shape (inverse-uniform with a 3% instant-crash band); NOT the
    // production distribution — see src/core/volatility-engine for the real one.
    const r = this.rand();
    if (r < 0.03) return 1.0;
    return Math.min(50, Math.max(1.01, Math.floor((1 / (1 - r * 0.97)) * 100) / 100));
  }

  private drawPlayers(): MockPlayer[] {
    const n = 3 + Math.floor(this.rand() * 5);
    const out: MockPlayer[] = [];
    for (let i = 0; i < n; i++) {
      const stake = Math.floor((5 + this.rand() * 195) * 100) / 100;
      const auto = this.rand() < 0.4 ? Math.floor((1.2 + this.rand() * 3) * 100) / 100 : null;
      out.push({
        userId: `${MOCK_NAMES[i % MOCK_NAMES.length]}_${(this.roundNumber + i) % 97}`,
        stake,
        autoCashout: auto,
        status: 'ACTIVE',
        cashedOutMultiplier: null,
        payout: null,
        cashoutAt: auto ?? (this.rand() < 0.7 ? Math.floor((1.1 + this.rand() * 4) * 100) / 100 : null),
      });
    }
    return out;
  }

  private publishPlayers(): void {
    this.emit({
      type: 'PLAYERS_UPDATED',
      players: this.players.map(({ cashoutAt: _cashoutAt, ...row }) => row),
    });
  }

  private pushTx(kind: 'BET' | 'PAYOUT' | 'REFUND' | 'DEPOSIT', amount: number): void {
    this.txSeq += 1;
    this.emit({ type: 'WALLET_TRANSACTION_APPENDED', id: `tx-${this.txSeq}`, kind, amount, ts: Date.now() });
  }

  private hex(len: number): string {
    let s = '';
    while (s.length < len) s += Math.floor(this.rand() * 16).toString(16);
    return s.slice(0, len);
  }

  private schedule(fn: () => void, ms: number): void {
    if (this.phaseTimer) clearTimeout(this.phaseTimer);
    this.phaseTimer = setTimeout(fn, ms);
  }

  private emit(ev: ClientGameEvent): void {
    for (const h of this.handlers) h(ev);
  }
}
