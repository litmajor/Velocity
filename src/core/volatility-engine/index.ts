export type SystemState = 'CALM' | 'TENSION' | 'CHAOS' | 'RESET';

export interface PlayerMix {
  conservative?: number;
  greedy?: number;
  tilted?: number;
}

/**
 * The committed economic shape of a round (see docs/ECONOMICS.md).
 *
 * The crash survival function is
 *   S(m) = P(crash >= m) = (1 - h) * phi(m) / m
 *   phi(m) = 1 - beta * (1 - m^(-lambda))
 * so the return of a fixed cashout at m is
 *   RTP(m) = m * S(m) = (1 - h) * phi(m)  in  [(1-h)(1-BETA_MAX), 1-h]
 * for EVERY multiplier m — bounded, never player-positive.
 *
 * `beta`   = extra edge accrued in the tail (0 = pure base curve).
 * `lambda` = where the extra edge accrues (large = early / thin tail,
 *            small = late / relatively generous mid-tail).
 */
export interface EdgeProfile {
  beta: number;
  lambda: number;
}

/**
 * The complete set of volatility inputs that shape a crash point. Captured at
 * seed-allocation time, committed to (blinded) before betting opens, and
 * revealed at crash so an outside verifier can reconstruct the exact final
 * crash point. `profile` is the resolved, clamped EdgeProfile actually used.
 */
export interface VolatilitySnapshot {
  state: SystemState;
  playerMix: PlayerMix;
  elasticity: number;
  profile: EdgeProfile;
}

// Hard economic bounds enforced INSIDE the pure derivation, so no committed
// snapshot — however constructed — can escape the contract.
export const BETA_MAX = 0.05;
export const LAMBDA_MIN = 0.05;
export const LAMBDA_MAX = 3.0;
export const HOUSE_EDGE_MIN = 0.001;
export const HOUSE_EDGE_MAX = 0.02;
export const CRASH_CAP = 10_000;

// NaN/Infinity-safe clamp: non-finite input fails safe to the LOWER bound
// (for beta that is 0 extra edge; for lambda the earliest-accrual shape).
const clamp = (x: number, lo: number, hi: number) =>
  Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : lo;

// Per-regime base profiles: same bounded edge contract, different shape.
// CALM harvests its extra edge early (thin tail); CHAOS accrues it very late
// (relatively generous mid-tail); see docs/ECONOMICS.md for the derivation.
const STATE_PROFILES: Record<SystemState, EdgeProfile> = {
  CALM:    { beta: 0.04,  lambda: 1.2 },
  TENSION: { beta: 0.03,  lambda: 0.5 },
  CHAOS:   { beta: 0.02,  lambda: 0.1 },
  RESET:   { beta: 0.015, lambda: 0.3 },
};

export class VolatilityEngine {
  // Optional player composition mix used to bias the committed profile
  private playerMix: PlayerMix = {};
  private history: number[] = [];
  private state: SystemState = 'CALM';
  private readonly maxHistory = 64;

  // track monetary sums for wins/losses to compute elasticity
  private winSum = 0;
  private lossSum = 0;
  private windowRounds = 64;
  private windowWins: number[] = [];
  private windowLosses: number[] = [];

  // Record a round crashPoint into history and update the system state.
  recordRound(crashPoint: number) {
    this.history.push(crashPoint);
    if (this.history.length > this.maxHistory) this.history.shift();
    this.updateState();
  }

  getState(): SystemState {
    return this.state;
  }

  // Record a player win (payout) to the recent window.
  recordWin(amount: number) {
    this.windowWins.push(amount);
    this.winSum += amount;
    if (this.windowWins.length > this.windowRounds) {
      const removed = this.windowWins.shift()!;
      this.winSum -= removed;
    }
  }

  // Record a player loss (stake) to the recent window.
  recordLoss(amount: number) {
    this.windowLosses.push(amount);
    this.lossSum += amount;
    if (this.windowLosses.length > this.windowRounds) {
      const removed = this.windowLosses.shift()!;
      this.lossSum -= removed;
    }
  }

  // Compute elasticity >0 where >1 shifts edge accrual later (feels more
  // generous mid-tail), <1 earlier. Bound to [0.7, 2.0]. Based on loss/win
  // imbalance. Affects SHAPE only — the RTP band is unchanged.
  getElasticity(): number {
    const wins = this.winSum || 0.0001;
    const losses = this.lossSum || 0.0001;
    const ratio = losses / wins;
    const raw = 1 + (ratio - 1) * 0.25;
    return clamp(raw, 0.7, 2.0);
  }

  // Accept aggregated player mix to influence the committed profile
  setPlayerMix(mix: PlayerMix) {
    this.playerMix = { ...this.playerMix, ...mix };
  }

  // Capture every input that shapes a crash point, with the resolved profile,
  // so the exact mapping used for a round can be committed and verified.
  // `shapingVolatility` is the legacy ShapingParams.volatility knob: it no
  // longer warps the uniform draw; it shifts the committed edge within bounds.
  getSnapshot(shapingVolatility = 1): VolatilitySnapshot {
    const state = this.getState();
    const playerMix = { ...this.playerMix };
    const elasticity = this.getElasticity();
    return {
      state,
      playerMix,
      elasticity,
      profile: VolatilityEngine.deriveProfile(state, playerMix, elasticity, shapingVolatility),
    };
  }

  // Determine state from recent history using simple heuristics.
  private updateState() {
    const last10 = this.history.slice(-10);
    if (last10.length === 0) { this.state = 'CALM'; return; }

    const avg = last10.reduce((a,b) => a+b, 0) / last10.length;

    const recentBigWin = this.history.some(v => v >= 50);
    const streakOfMid = this.history.slice(-5).every(v => v >= 1.2 && v <= 3.0);

    if (avg < 1.5) {
      this.state = 'CHAOS';
    } else if (recentBigWin) {
      this.state = 'RESET';
    } else if (streakOfMid) {
      this.state = 'TENSION';
    } else {
      this.state = 'CALM';
    }
  }

  /**
   * Pure, deterministic profile derivation. All regime / player-mix /
   * elasticity / steering influence funnels through here, and the result is
   * clamped to the economic bounds — so every input combination stays inside
   * the contract band.
   */
  static deriveProfile(
    state: SystemState,
    playerMix: PlayerMix,
    elasticity: number,
    shapingVolatility = 1,
  ): EdgeProfile {
    const base = STATE_PROFILES[state];
    let beta = base.beta;
    let lambda = base.lambda;

    // Legacy volatility knob (exposure steering / presets): >1 adds bounded
    // edge, <1 removes it. vol=1.5 -> +0.01 edge; vol=0.6 -> -0.008.
    beta += 0.02 * clamp(shapingVolatility - 1, -0.5, 1);

    // Tilted players: bounded extra edge (declared, committed, capped).
    const tilted = playerMix.tilted ?? 0;
    if (tilted > 0.3) beta += 0.02 * tilted;

    // Conservative mix: edge accrues earlier (front-loaded modest outcomes).
    const cons = playerMix.conservative ?? 0;
    if (cons > 0.4) lambda *= 1 + 0.5 * cons;

    // Greedy mix: edge accrues later (relatively richer mid-tail).
    const greedy = playerMix.greedy ?? 0;
    if (greedy > 0.4) lambda *= 1 - 0.4 * greedy;

    // Elasticity shifts edge accrual later when players are net losing.
    lambda /= clamp(elasticity, 0.7, 2.0);

    return {
      beta: clamp(beta, 0, BETA_MAX),
      lambda: clamp(lambda, LAMBDA_MIN, LAMBDA_MAX),
    };
  }

  /**
   * Pure crash derivation from the seed-derived uniform r in [0,1) and a
   * committed snapshot. Implements the inverse of
   *   S(m) = (1 - h) * (1 - beta * (1 - m^(-lambda))) / m
   * i.e. solves  u*m = (1-h)*phi(m)  for m, where u = 1 - r, via a fixed
   * 64-step bisection on [1, CRASH_CAP] (deterministic and reproducible by
   * outside verifiers), then floors to cents (house-favoring).
   *
   * r < h  =>  instant crash at 1.00 (exactly the u > (1-h)*phi(1) region).
   * The house edge and profile are re-clamped here so NO committed values can
   * produce a crash distribution outside the contract band.
   */
  static crashFromRPure(r: number, houseEdge: number, snap: VolatilitySnapshot): number {
    const h = clamp(houseEdge, HOUSE_EDGE_MIN, HOUSE_EDGE_MAX);
    if (r < h) return 1.0;

    const beta = clamp(snap.profile.beta, 0, BETA_MAX);
    const lambda = clamp(snap.profile.lambda, LAMBDA_MIN, LAMBDA_MAX);
    const u = 1 - r; // in (0, 1-h]

    const phi = (m: number) => 1 - beta * (1 - Math.pow(m, -lambda));

    // Above the cap the tail is truncated: crash = CRASH_CAP.
    if (u * CRASH_CAP < (1 - h) * phi(CRASH_CAP)) {
      return CRASH_CAP;
    }

    // f(m) = u*m - (1-h)*phi(m): f(1) = u-(1-h) <= 0, f(cap) >= 0, strictly
    // increasing => unique root; 64 bisection steps reach double precision.
    let lo = 1;
    let hi = CRASH_CAP;
    for (let i = 0; i < 64; i++) {
      const mid = (lo + hi) / 2;
      if (mid * u - (1 - h) * phi(mid) < 0) lo = mid;
      else hi = mid;
    }

    return Math.max(1.01, Math.floor(hi * 100) / 100);
  }

  /**
   * Closed-form survival probability of the committed distribution:
   *   P(crash >= m) = (1 - h) * phi(m) / m   for m in (1, CRASH_CAP]
   * Used by the economic test suite to compare empirical results against the
   * intended theoretical distribution.
   */
  static theoreticalSurvival(m: number, houseEdge: number, snap: VolatilitySnapshot): number {
    const h = clamp(houseEdge, HOUSE_EDGE_MIN, HOUSE_EDGE_MAX);
    if (m <= 1) return 1;
    if (m > CRASH_CAP) return 0;
    const beta = clamp(snap.profile.beta, 0, BETA_MAX);
    const lambda = clamp(snap.profile.lambda, LAMBDA_MIN, LAMBDA_MAX);
    const phi = 1 - beta * (1 - Math.pow(m, -lambda));
    return ((1 - h) * phi) / m;
  }
}

export default VolatilityEngine;
