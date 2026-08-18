export type SystemState = 'CALM' | 'TENSION' | 'CHAOS' | 'RESET';

export interface PlayerMix {
  conservative?: number;
  greedy?: number;
  tilted?: number;
}

export interface PlayerMixParams {
  conservativePushFactor: number;
  conservative3xChanceFactor: number;
  conservative3xMultiplier: number;
  greedyPushFactor: number;
  greedySpikeProbFactor: number;
  greedySpikeBase: number;
  greedySpikeScale: number;
  tiltedNearProbFactor: number;
  tiltedNearMax: number;
  tiltedNearBase: number;
}

/**
 * The complete set of volatility inputs that shape a crash point beyond the
 * seed-derived baseCrash. Captured at seed-allocation time, committed to
 * (blinded) before betting opens, and revealed at crash so an outside
 * verifier can reconstruct the exact final crash point.
 */
export interface VolatilitySnapshot {
  state: SystemState;
  tiltNextLow: boolean;
  playerMix: PlayerMix;
  playerMixParams: PlayerMixParams;
  elasticity: number;
}

export interface AdjustResult {
  adjusted: number;
  // whether a sharp low crash should be scheduled for the NEXT round
  scheduleTiltNextLow: boolean;
}

export class VolatilityEngine {
  // Optional player composition mix used to bias global distribution
  private playerMix: { conservative?: number; greedy?: number; tilted?: number } = {};
  // Internal flag to force a low crash following a near-miss (for tilted players)
  private tiltNextLow = false;
  private history: number[] = [];
  private state: SystemState = 'CALM';
  private readonly maxHistory = 64;

  // tunable parameters for player-mix shaping (defaults chosen conservatively)
  private playerMixParams: PlayerMixParams = {
    conservativePushFactor: 0.25,
    conservative3xChanceFactor: 0.06,
    conservative3xMultiplier: 3,
    greedyPushFactor: 0.4,
    greedySpikeProbFactor: 0.002,
    greedySpikeBase: 15,
    greedySpikeScale: 35,
    tiltedNearProbFactor: 0.35,
    tiltedNearMax: 1.75,
    tiltedNearBase: 1.05,
  };

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

  // Compute elasticity >0 where >1 expands volatility (bigger multipliers),
  // <1 contracts volatility. Bound to [0.7, 2.0]. Based on loss/win imbalance.
  getElasticity(): number {
    const wins = this.winSum || 0.0001;
    const losses = this.lossSum || 0.0001;
    // ratio >1 means more losses than wins -> enlarge volatility
    const ratio = losses / wins;
    // map ratio to elasticity via gentle scaling
    const raw = 1 + (ratio - 1) * 0.25; // scale down sensitivity
    const clamped = Math.max(0.7, Math.min(2.0, raw));
    return clamped;
  }

  // Accept aggregated player mix to influence global shaping behavior
  setPlayerMix(mix: PlayerMix) {
    this.playerMix = { ...this.playerMix, ...mix };
  }

  // Capture every input that adjustCrash depends on, so the exact mapping
  // used for a round can be committed to and later revealed/verified.
  getSnapshot(): VolatilitySnapshot {
    return {
      state: this.getState(),
      tiltNextLow: this.tiltNextLow,
      playerMix: { ...this.playerMix },
      playerMixParams: { ...this.playerMixParams },
      elasticity: this.getElasticity(),
    };
  }

  // Apply the tilt side effect produced by adjustCrashPure for a round that
  // was actually allocated (verification-only recomputations must not mutate).
  applySchedule(result: AdjustResult) {
    this.tiltNextLow = result.scheduleTiltNextLow;
  }

  // Allow external tuning of the internal probability/weight parameters
  setPlayerMixParams(params: Partial<typeof this.playerMixParams>) {
    this.playerMixParams = { ...this.playerMixParams, ...params };
  }

  getPlayerMixParams() {
    return { ...this.playerMixParams };
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

  // Given a base crash and a hex-derived uniform value [0,1), deterministically
  // compute an adjusted crash according to the current state and elasticity.
  // Mutates the tilt schedule; use adjustCrashPure + applySchedule to separate
  // computation from the side effect.
  adjustCrash(baseCrash: number, hexEntropy: string): number {
    const result = VolatilityEngine.adjustCrashPure(baseCrash, hexEntropy, this.getSnapshot());
    this.applySchedule(result);
    return result.adjusted;
  }

  // Pure, static form of the crash adjustment: everything it depends on is in
  // the snapshot, so an outside verifier holding the revealed snapshot can
  // reproduce the exact final crash point. Never touches engine state.
  static adjustCrashPure(baseCrash: number, hexEntropy: string, snap: VolatilitySnapshot): AdjustResult {
    const ranges: Record<SystemState, [number, number]> = {
      CALM: [0.7, 1.0],
      TENSION: [0.9, 1.2],
      CHAOS: [1.2, 3.0],
      RESET: [0.8, 1.3],
    };

    const [minM, maxM] = ranges[snap.state];

    // Derive a uniform number u in [0,1) from a slice of the hex entropy
    const slice = hexEntropy.slice(13, 21) || hexEntropy.slice(0,8);
    const u = parseInt(slice, 16) / Math.pow(2, slice.length * 4);

    let modifier = minM + (maxM - minM) * u;

    // Apply biases based on player composition (global shaping only)
    const cons = snap.playerMix.conservative ?? 0;
    const greedy = snap.playerMix.greedy ?? 0;
    const tilted = snap.playerMix.tilted ?? 0;
    const params = snap.playerMixParams;

    // If a tilt sequence was requested previously, force a sharp low crash now
    if (snap.tiltNextLow) {
      const lowSlice = hexEntropy.slice(21, 25) || '0';
      const lowU = (parseInt(lowSlice, 16) % 1000) / 1000;
      const low = 1.01 + lowU * 0.2;
      return { adjusted: Math.max(1.01, Math.floor(low * 100) / 100), scheduleTiltNextLow: false };
    }

    // Conservative players: bias mass toward modest multipliers (1.2-1.5)
    if (cons > 0.4) {
      // push modifier toward lower-mid range
      modifier = modifier * (1 - params.conservativePushFactor * cons) + 1.25 * (params.conservativePushFactor * cons);
      // occasional nicer win (3x) with small chance proportional to cons
      const chanceSlice = hexEntropy.slice(21, 25) || '0';
      const chance = (parseInt(chanceSlice, 16) % 1000) / 1000;
      if (chance < params.conservative3xChanceFactor * cons) {
        return { adjusted: Math.max(1.01, Math.floor(baseCrash * params.conservative3xMultiplier * 100) / 100), scheduleTiltNextLow: false };
      }
    }

    // Greedy players: create many near-zero wins and rare spikes
    if (greedy > 0.4) {
      // nudge modifier down toward 1.0 for many small crashes
      modifier = modifier * (1 - params.greedyPushFactor * greedy) + 1.0 * (params.greedyPushFactor * greedy);
      // rare spike (e.g., 20x) with tiny probability proportional to greedy
      const spikeSlice = hexEntropy.slice(5, 9) || '0';
      const spikeChance = (parseInt(spikeSlice, 16) % 10000) / 10000;
      if (spikeChance < params.greedySpikeProbFactor * greedy) {
        return { adjusted: Math.max(1.01, Math.floor(baseCrash * (params.greedySpikeBase + Math.floor(params.greedySpikeScale * greedy)) * 100) / 100), scheduleTiltNextLow: false };
      }
    }

    // Tilted players: create near-miss outcomes and then schedule a sharp loss next
    if (tilted > 0.3) {
      const nearSlice = hexEntropy.slice(9, 13) || '0';
      const nearVal = (parseInt(nearSlice, 16) % 1000) / 1000;
      // produce a near-miss in the 1.1-1.8 band with probability scaled by tilted
      if (nearVal < params.tiltedNearProbFactor * tilted) {
        // choose a multiplier modestly above 1, appearing as a near-miss
        const near = params.tiltedNearBase + params.tiltedNearMax * nearVal;
        // schedule a sharp loss for the next round
        return { adjusted: Math.max(1.01, Math.floor(near * 100) / 100), scheduleTiltNextLow: true };
      }
    }

    // Apply elasticity captured in the snapshot
    modifier = modifier * snap.elasticity;

    // clamp modifier to a safe range to avoid runaway multipliers
    modifier = Math.max(0.5, Math.min(modifier, 4.0));

    const adjusted = Math.max(1.01, Math.floor(baseCrash * modifier * 100) / 100);
    return { adjusted, scheduleTiltNextLow: snap.tiltNextLow };
  }
}

export default VolatilityEngine;
