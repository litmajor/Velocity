/**
 * Monte-Carlo RTP / house-edge study (audit item U-1).
 *
 * Uses the exact production derivation (recomputeCrashPoint — the same pure
 * function the outside verifier uses) over deterministic pseudo-random seeds,
 * for every combination of shaping preset, volatility system state, player
 * mix, and elasticity bound.
 *
 * RTP for an auto-cashout-at-m strategy = m × P(crash ≥ m).
 * House edge = 1 − RTP.
 *
 * Run: npx tsx scripts/rtp-study.ts [roundsPerConfig]
 */
import crypto from 'crypto';
import { recomputeCrashPoint, PublishedShapingParams } from '../src/core/fairness-engine/verifier';
import { VolatilitySnapshot, PlayerMixParams, SystemState } from '../src/core/volatility-engine';

const N = Number(process.argv[2] ?? 100_000);

const DEFAULT_PARAMS: PlayerMixParams = {
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

const SHAPING_PRESETS: Record<string, PublishedShapingParams> = {
  DEFAULT: { instantCrashDivisor: 33, volatility: 1, houseEdge: 0.01 },
  CALM:    { instantCrashDivisor: 50, volatility: 0.8, houseEdge: 0.01 },
  TENSION: { instantCrashDivisor: 33, volatility: 1.1, houseEdge: 0.01 },
  CHAOS:   { instantCrashDivisor: 16, volatility: 1.6, houseEdge: 0.01 },
  RESET:   { instantCrashDivisor: 80, volatility: 0.6, houseEdge: 0.01 },
  EXPOSURE_STEERED: { instantCrashDivisor: 20, volatility: 1.5, houseEdge: 0.01 }, // ExposureEngine threshold rewrite
};

interface Config {
  name: string;
  shaping: PublishedShapingParams;
  snapshot: VolatilitySnapshot;
}

function snap(state: SystemState, mix: VolatilitySnapshot['playerMix'], elasticity: number, tiltNextLow = false): VolatilitySnapshot {
  return { state, tiltNextLow, playerMix: mix, playerMixParams: { ...DEFAULT_PARAMS }, elasticity };
}

const CONFIGS: Config[] = [
  { name: 'DEFAULT / CALM state / no mix / e=1.0',      shaping: SHAPING_PRESETS.DEFAULT, snapshot: snap('CALM', {}, 1.0) },
  { name: 'DEFAULT / TENSION state / no mix / e=1.0',   shaping: SHAPING_PRESETS.DEFAULT, snapshot: snap('TENSION', {}, 1.0) },
  { name: 'DEFAULT / CHAOS state / no mix / e=1.0',     shaping: SHAPING_PRESETS.DEFAULT, snapshot: snap('CHAOS', {}, 1.0) },
  { name: 'DEFAULT / RESET state / no mix / e=1.0',     shaping: SHAPING_PRESETS.DEFAULT, snapshot: snap('RESET', {}, 1.0) },
  { name: 'DEFAULT / CALM / no mix / e=0.7 (contract)', shaping: SHAPING_PRESETS.DEFAULT, snapshot: snap('CALM', {}, 0.7) },
  { name: 'DEFAULT / CALM / no mix / e=2.0 (expand)',   shaping: SHAPING_PRESETS.DEFAULT, snapshot: snap('CALM', {}, 2.0) },
  { name: 'DEFAULT / CALM / conservative=0.6 / e=1.0',  shaping: SHAPING_PRESETS.DEFAULT, snapshot: snap('CALM', { conservative: 0.6 }, 1.0) },
  { name: 'DEFAULT / CALM / greedy=0.6 / e=1.0',        shaping: SHAPING_PRESETS.DEFAULT, snapshot: snap('CALM', { greedy: 0.6 }, 1.0) },
  { name: 'DEFAULT / CALM / tilted=0.9 / e=1.0',        shaping: SHAPING_PRESETS.DEFAULT, snapshot: snap('CALM', { tilted: 0.9 }, 1.0) },
  { name: 'DEFAULT / CALM / tilt-low SCHEDULED',        shaping: SHAPING_PRESETS.DEFAULT, snapshot: snap('CALM', { tilted: 0.9 }, 1.0, true) },
  { name: 'CALM preset / CALM state / no mix',          shaping: SHAPING_PRESETS.CALM,    snapshot: snap('CALM', {}, 1.0) },
  { name: 'TENSION preset / TENSION state / no mix',    shaping: SHAPING_PRESETS.TENSION, snapshot: snap('TENSION', {}, 1.0) },
  { name: 'CHAOS preset / CHAOS state / no mix',        shaping: SHAPING_PRESETS.CHAOS,   snapshot: snap('CHAOS', {}, 1.0) },
  { name: 'RESET preset / RESET state / no mix',        shaping: SHAPING_PRESETS.RESET,   snapshot: snap('RESET', {}, 1.0) },
  { name: 'EXPOSURE_STEERED / CALM state / no mix',     shaping: SHAPING_PRESETS.EXPOSURE_STEERED, snapshot: snap('CALM', {}, 1.0) },
];

const CASHOUTS = [1.2, 1.5, 2, 3, 5, 10];

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

function studyConfig(cfg: Config) {
  const crashes = new Array<number>(N);
  for (let i = 0; i < N; i++) {
    // deterministic seed stream (reproducible study)
    const serverSeed = crypto.createHash('sha256').update(`study:${cfg.name}:${i}`).digest('hex');
    crashes[i] = recomputeCrashPoint(serverSeed, 'rtp-study-client', i + 1, cfg.shaping, cfg.snapshot);
  }
  crashes.sort((a, b) => a - b);
  const mean = crashes.reduce((a, b) => a + b, 0) / N;
  const pInstant = crashes.filter(c => c <= 1.0).length / N;
  const rtp = CASHOUTS.map(m => {
    const wins = crashes.length - lowerBound(crashes, m);
    return (m * wins) / N;
  });
  return {
    name: cfg.name,
    mean,
    median: percentile(crashes, 0.5),
    p90: percentile(crashes, 0.9),
    p99: percentile(crashes, 0.99),
    max: crashes[crashes.length - 1],
    pInstant,
    rtp,
  };
}

// first index with value >= target
function lowerBound(sorted: number[], target: number): number {
  let lo = 0, hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const rows = CONFIGS.map(studyConfig);

const fmt = (n: number) => n.toFixed(3);
console.log(`# RTP study — ${N.toLocaleString()} rounds per configuration\n`);
console.log('| configuration | mean | median | p90 | p99 | max | P(instant) | ' + CASHOUTS.map(m => `RTP@${m}x`).join(' | ') + ' |');
console.log('|---|---|---|---|---|---|---|' + CASHOUTS.map(() => '---').join('|') + '|');
for (const r of rows) {
  console.log(
    `| ${r.name} | ${fmt(r.mean)} | ${fmt(r.median)} | ${fmt(r.p90)} | ${fmt(r.p99)} | ${fmt(r.max)} | ${(r.pInstant * 100).toFixed(2)}% | ` +
    r.rtp.map(fmt).join(' | ') + ' |',
  );
}
console.log('\nRTP@mx = m x P(crash >= m); house edge = 1 - RTP. Values > 1 mean the strategy is player-positive (house loses).');
