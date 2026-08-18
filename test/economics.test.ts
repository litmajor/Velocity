import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { recomputeCrashPoint, PublishedShapingParams } from '../src/core/fairness-engine/verifier';
import {
  VolatilityEngine,
  VolatilitySnapshot,
  SystemState,
  PlayerMix,
  BETA_MAX,
  HOUSE_EDGE_MAX,
  CRASH_CAP,
} from '../src/core/volatility-engine';

/**
 * Economic regression suite (audit item E-1, docs/ECONOMICS.md).
 *
 * Contract under test: for EVERY committed configuration and EVERY cashout
 * multiplier m in (1, CRASH_CAP],
 *   RTP(m) = m × P(crash ≥ m) ∈ [(1-h)(1-BETA_MAX), 1-h]
 * i.e. the effective house edge stays within [1%, ~6%] and no publicly
 * observable regime/strategy is player-positive.
 *
 * Statistical methodology: deterministic seed streams; empirical RTP compared
 * against the closed-form theoretical RTP of the committed distribution with
 * a 4σ tolerance (σ = m·√(p(1−p)/N)), never fragile exact values.
 */

const H = 0.01;
const RTP_MAX = 1 - H;
const RTP_MIN = (1 - H) * (1 - BETA_MAX);
const DEFAULT_SHAPING: PublishedShapingParams = { instantCrashDivisor: 33, volatility: 1, houseEdge: H };

function snap(state: SystemState, mix: PlayerMix, elasticity: number, shapingVolatility = 1): VolatilitySnapshot {
  return {
    state,
    playerMix: mix,
    elasticity,
    profile: VolatilityEngine.deriveProfile(state, mix, elasticity, shapingVolatility),
  };
}

function seedStream(tag: string, i: number): string {
  return crypto.createHash('sha256').update(`econ:${tag}:${i}`).digest('hex');
}

function simulateCrashes(tag: string, n: number, shaping: PublishedShapingParams, snapshot: VolatilitySnapshot): number[] {
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    out[i] = recomputeCrashPoint(seedStream(tag, i), 'econ-client', i + 1, shaping, snapshot);
  }
  return out;
}

const STATES: SystemState[] = ['CALM', 'TENSION', 'CHAOS', 'RESET'];
const CASHOUTS = [1.2, 1.5, 2, 3, 5, 10];
const N = 30_000;

const CONFIGS: Array<{ name: string; shaping: PublishedShapingParams; snapshot: VolatilitySnapshot }> = [
  ...STATES.map(s => ({ name: `state=${s}`, shaping: DEFAULT_SHAPING, snapshot: snap(s, {}, 1) })),
  { name: 'elasticity=0.7', shaping: DEFAULT_SHAPING, snapshot: snap('CALM', {}, 0.7) },
  { name: 'elasticity=2.0', shaping: DEFAULT_SHAPING, snapshot: snap('CALM', {}, 2.0) },
  { name: 'conservative=0.6', shaping: DEFAULT_SHAPING, snapshot: snap('CALM', { conservative: 0.6 }, 1) },
  { name: 'greedy=0.6', shaping: DEFAULT_SHAPING, snapshot: snap('CALM', { greedy: 0.6 }, 1) },
  { name: 'tilted=0.9', shaping: DEFAULT_SHAPING, snapshot: snap('CALM', { tilted: 0.9 }, 1) },
  {
    name: 'exposure-steered (vol=1.5)',
    shaping: { instantCrashDivisor: 20, volatility: 1.5, houseEdge: H },
    snapshot: snap('CALM', {}, 1, 1.5),
  },
  {
    name: 'worst case (tilted=1, steered, e=0.7)',
    shaping: { instantCrashDivisor: 20, volatility: 1.5, houseEdge: H },
    snapshot: snap('CALM', { tilted: 1 }, 0.7, 1.5),
  },
];

describe('economic contract: analytic bounds over the ENTIRE multiplier range', () => {
  // log-spaced sweep of the whole supported range, not just the six test points
  const sweep: number[] = [];
  for (let x = Math.log(1.01); x <= Math.log(CRASH_CAP); x += 0.05) sweep.push(Math.exp(x));

  it('theoretical RTP(m) stays inside [RTP_MIN, RTP_MAX] for every config and every m', () => {
    for (const cfg of CONFIGS) {
      for (const m of sweep) {
        const rtp = m * VolatilityEngine.theoreticalSurvival(m, cfg.shaping.houseEdge ?? H, cfg.snapshot);
        expect(rtp, `${cfg.name} @ ${m.toFixed(2)}x`).toBeLessThanOrEqual(RTP_MAX + 1e-12);
        expect(rtp, `${cfg.name} @ ${m.toFixed(2)}x`).toBeGreaterThanOrEqual(RTP_MIN - 1e-12);
      }
    }
  });

  it('hostile committed profiles are re-clamped: bounds hold even for out-of-range beta/lambda/houseEdge', () => {
    const hostiles: VolatilitySnapshot[] = [
      { ...snap('CALM', {}, 1), profile: { beta: 5, lambda: 1000 } },
      { ...snap('CHAOS', {}, 1), profile: { beta: -3, lambda: -8 } },
      { ...snap('RESET', {}, 1), profile: { beta: NaN as unknown as number, lambda: 0 } },
    ];
    for (const s of hostiles) {
      for (const m of sweep) {
        // houseEdge is also clamped: 0.5 can never push RTP below the contract
        const rtp = m * VolatilityEngine.theoreticalSurvival(m, 0.5, s);
        expect(rtp).toBeLessThanOrEqual(1 - 0.001 + 1e-12);
        expect(rtp).toBeGreaterThanOrEqual((1 - HOUSE_EDGE_MAX) * (1 - BETA_MAX) - 1e-12);
      }
    }
  });
});

describe('economic contract: empirical RTP matches theory (4σ) and stays in band', () => {
  for (const cfg of CONFIGS) {
    it(`config ${cfg.name}`, () => {
      const crashes = simulateCrashes(cfg.name, N, cfg.shaping, cfg.snapshot).sort((a, b) => a - b);
      const h = cfg.shaping.houseEdge ?? H;
      for (const m of CASHOUTS) {
        let lo = 0, hi = crashes.length;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (crashes[mid] < m) lo = mid + 1; else hi = mid; }
        const p = (crashes.length - lo) / N;
        const empirical = m * p;
        const theory = m * VolatilityEngine.theoreticalSurvival(m, h, cfg.snapshot);
        const sigma = m * Math.sqrt((p * (1 - p)) / N);
        // empirical matches the committed distribution
        expect(Math.abs(empirical - theory), `${cfg.name} RTP@${m}x`).toBeLessThanOrEqual(4 * sigma + 0.01);
        // and stays inside the contract band (cent flooring is house-favoring)
        expect(empirical, `${cfg.name} RTP@${m}x`).toBeLessThanOrEqual(RTP_MAX + 4 * sigma);
        expect(empirical, `${cfg.name} RTP@${m}x`).toBeGreaterThanOrEqual(RTP_MIN - 4 * sigma - 0.01);
      }
    });
  }
});

describe('distribution properties, not only RTP', () => {
  it('quantiles and instant-crash probability match the committed distribution', () => {
    const cfg = CONFIGS[0]; // CALM baseline
    const crashes = simulateCrashes('quantiles', N, cfg.shaping, cfg.snapshot).sort((a, b) => a - b);
    const q = (p: number) => crashes[Math.floor(p * N)];

    // instant crash: P(crash = 1.00) = h ± 4σ
    const pInstant = crashes.filter(c => c <= 1.0).length / N;
    const sigmaInst = Math.sqrt((H * (1 - H)) / N);
    expect(Math.abs(pInstant - H)).toBeLessThanOrEqual(4 * sigmaInst);

    // theoretical quantile: S(m) = p ⇒ median ≈ m where S(m) = 0.5
    const survivalAt = (m: number) => VolatilityEngine.theoreticalSurvival(m, H, cfg.snapshot);
    for (const p of [0.5, 0.1, 0.01]) {
      const empirical = q(1 - p);
      // invert S numerically over a fine grid
      let theoretical = 1.01;
      for (let m = 1.01; m < 2000; m *= 1.001) {
        if (survivalAt(m) <= p) { theoretical = m; break; }
      }
      // relative quantile SE for a Pareto-like tail ≈ 1/√(N·p); allow 4σ
      const tolerance = 4 / Math.sqrt(N * p) + 0.01;
      expect(Math.abs(empirical - theoretical) / theoretical, `quantile@${1 - p}`).toBeLessThanOrEqual(tolerance);
    }

    // extreme tail: max is capped
    expect(crashes[crashes.length - 1]).toBeLessThanOrEqual(CRASH_CAP);
  });
});

describe('adaptive strategies on publicly observable state (no systematic +EV)', () => {
  // One shared deterministic round stream with REAL regime evolution: the
  // volatility engine's state transitions are driven by actual crash history,
  // exactly as in production, and strategies observe the pre-round state
  // (public via ROUND_STARTED history) before deciding.
  interface SimRound { state: SystemState; crash: number; history: number[] }

  function simulateStream(n: number): SimRound[] {
    const v = new VolatilityEngine();
    const rounds: SimRound[] = [];
    const history: number[] = [];
    for (let i = 0; i < n; i++) {
      const snapshot = v.getSnapshot();
      const crash = recomputeCrashPoint(seedStream('stream', i), 'stream-client', i + 1, DEFAULT_SHAPING, snapshot);
      rounds.push({ state: snapshot.state, crash, history: history.slice(-5) });
      history.push(crash);
      v.recordRound(crash);
    }
    return rounds;
  }

  const STREAM = simulateStream(150_000);

  // A strategy returns the auto-cashout multiplier to bet at, or null to skip.
  type Strategy = (r: SimRound) => number | null;

  const strategies: Record<string, Strategy> = {
    'always 1.2x': () => 1.2,
    'always 1.5x': () => 1.5,
    'always 2x': () => 2,
    'always 3x': () => 3,
    'always 5x': () => 5,
    'always 10x': () => 10,
    'wait for CHAOS, bet 3x': r => (r.state === 'CHAOS' ? 3 : null),
    'skip CALM, bet 2x': r => (r.state === 'CALM' ? null : 2),
    'bet 2x after 3 consecutive lows': r =>
      r.history.length >= 3 && r.history.slice(-3).every(c => c < 1.5) ? 2 : null,
    'regime-switched multiplier': r => (r.state === 'CHAOS' ? 3 : r.state === 'RESET' ? 5 : 1.5),
    'exploit regime transition (bet 5x on fresh CHAOS)': r =>
      r.state === 'CHAOS' && r.history.length > 0 && r.history[r.history.length - 1] >= 1.5 ? 5 : null,
  };

  for (const [name, strat] of Object.entries(strategies)) {
    it(`strategy "${name}" is not +EV`, () => {
      let staked = 0;
      let returned = 0;
      let varianceSum = 0;
      let bets = 0;
      for (const r of STREAM) {
        const m = strat(r);
        if (m === null) continue;
        bets++;
        staked += 1;
        const win = r.crash >= m;
        returned += win ? m : 0;
        varianceSum += m * m; // upper bound on per-round payout variance
      }
      expect(bets).toBeGreaterThan(100); // the strategy actually fires
      const rtp = returned / staked;
      const sigma = Math.sqrt(varianceSum) / staked;
      // no publicly observable strategy beats the contract ceiling
      expect(rtp, `${name}: rtp=${rtp.toFixed(4)} over ${bets} bets`).toBeLessThanOrEqual(RTP_MAX + 4 * sigma);
      // and the house never takes more than the contract floor allows
      expect(rtp).toBeGreaterThanOrEqual(RTP_MIN - 4 * sigma - 0.01);
    });
  }
});

describe('cryptographic fairness regressions (must survive the economic redesign)', () => {
  it('no Math.random in any outcome-path source file', () => {
    const files = [
      'src/core/volatility-engine/index.ts',
      'src/core/fairness-engine/index.ts',
      'src/core/fairness-engine/verifier.ts',
    ];
    for (const f of files) {
      const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
      expect(src.includes('Math.random'), f).toBe(false);
    }
  });

  it('the uniform draw is never warped: same r maps monotonically for any profile', () => {
    // monotonicity of the quantile: larger u = 1-r ⇒ smaller crash
    const s = snap('CHAOS', { tilted: 1 }, 2, 1.5);
    let prev = Infinity;
    for (let r = 0.02; r < 1; r += 0.02) {
      const c = VolatilityEngine.crashFromRPure(1 - r, H, s);
      expect(c).toBeLessThanOrEqual(prev + 1e-9);
      prev = c;
    }
  });
});
