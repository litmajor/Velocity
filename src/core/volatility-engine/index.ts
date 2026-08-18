export type SystemState = 'CALM' | 'TENSION' | 'CHAOS' | 'RESET';

export class VolatilityEngine {
  // Optional player composition mix used to bias global distribution
  private playerMix: { conservative?: number; greedy?: number; tilted?: number } = {};
  // Internal flag to force a low crash following a near-miss (for tilted players)
  private tiltNextLow = false;
  private history: number[] = [];
  private state: SystemState = 'CALM';
  private readonly maxHistory = 64;

  // tunable parameters for player-mix shaping (defaults chosen conservatively)
  private playerMixParams: {
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
  } = {
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
  setPlayerMix(mix: { conservative?: number; greedy?: number; tilted?: number }) {
    this.playerMix = { ...this.playerMix, ...mix };
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
  adjustCrash(baseCrash: number, hexEntropy: string): number {
    const ranges: Record<SystemState, [number, number]> = {
      CALM: [0.7, 1.0],
      TENSION: [0.9, 1.2],
      CHAOS: [1.2, 3.0],
      RESET: [0.8, 1.3],
    };

    const st = this.getState();
    const [minM, maxM] = ranges[st];

    // Derive a uniform number u in [0,1) from a slice of the hex entropy
    const slice = hexEntropy.slice(13, 21) || hexEntropy.slice(0,8);
    const u = parseInt(slice, 16) / Math.pow(2, slice.length * 4);

    let modifier = minM + (maxM - minM) * u;

    // Apply biases based on player composition (global shaping only)
    const cons = this.playerMix.conservative ?? 0;
    const greedy = this.playerMix.greedy ?? 0;
    const tilted = this.playerMix.tilted ?? 0;
    const params = this.playerMixParams;

    // If a tilt sequence was requested previously, force a sharp low crash now
    if (this.tiltNextLow) {
      this.tiltNextLow = false;
      const lowSlice = hexEntropy.slice(21, 25) || '0';
      const lowU = (parseInt(lowSlice, 16) % 1000) / 1000;
      const low = 1.01 + lowU * 0.2;
      return Math.max(1.01, Math.floor(low * 100) / 100);
    }

    // Conservative players: bias mass toward modest multipliers (1.2-1.5)
    if (cons > 0.4) {
      // push modifier toward lower-mid range
      modifier = modifier * (1 - params.conservativePushFactor * cons) + 1.25 * (params.conservativePushFactor * cons);
      // occasional nicer win (3x) with small chance proportional to cons
      const chanceSlice = hexEntropy.slice(21, 25) || '0';
      const chance = (parseInt(chanceSlice, 16) % 1000) / 1000;
      if (chance < params.conservative3xChanceFactor * cons) {
        return Math.max(1.01, Math.floor(baseCrash * 3 * 100) / 100);
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
        return Math.max(1.01, Math.floor(baseCrash * (15 + Math.floor(35 * greedy)) * 100) / 100);
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
        this.tiltNextLow = true;
        return Math.max(1.01, Math.floor(near * 100) / 100);
      }
    }

    // Apply elasticity computed from wins/losses
    const elasticity = this.getElasticity();
    modifier = modifier * elasticity;

    // clamp modifier to a safe range to avoid runaway multipliers
    modifier = Math.max(0.5, Math.min(modifier, 4.0));

    const adjusted = Math.max(1.01, Math.floor(baseCrash * modifier * 100) / 100);
    return adjusted;
  }
}

export default VolatilityEngine;
