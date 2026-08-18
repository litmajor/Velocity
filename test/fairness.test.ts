import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import { FairnessEngine } from '../src/core/fairness-engine';
import { verifyRound, recomputeCrashPoint, computeParamsCommit } from '../src/core/fairness-engine/verifier';
import { VolatilityEngine, BETA_MAX, CRASH_CAP } from '../src/core/volatility-engine';
import { makeRig, collect, Rig } from './helpers/rig';

/**
 * Independent verifier: replicates the seed → baseCrash (beta=0 reference
 * curve) derivation using only crypto primitives and the published shaping
 * params (no engine code). The FINAL crash point is reconstructed separately
 * via the committed snapshot's EdgeProfile (see verifyRound tests below).
 */
function independentBaseCrash(
  serverSeed: string,
  clientSeed: string,
  nonce: number,
  houseEdge = 0.01,
): { hex: string; baseCrash: number } {
  const hex = crypto.createHmac('sha256', serverSeed).update(`${clientSeed}:${nonce}`).digest('hex');
  const r = parseInt(hex.slice(0, 13), 16) / 2 ** 52;
  if (r < houseEdge) return { hex, baseCrash: 1.0 };
  const raw = (1 - houseEdge) / (1 - r);
  return { hex, baseCrash: Math.max(1.01, Math.floor(raw * 100) / 100) };
}

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

describe('FairnessEngine unit properties (converted from legacy harness)', () => {
  it('computeProof.adjusted equals computeCrashPoint', () => {
    const f = new FairnessEngine();
    const serverSeed = crypto.randomBytes(32).toString('hex');
    const clientSeed = crypto.randomBytes(8).toString('hex');
    const proof = f.computeProof(serverSeed, clientSeed, 1);
    // fresh engine, identical state ⇒ deterministic
    const cp = new FairnessEngine().computeCrashPoint(serverSeed, clientSeed, 1);
    expect(proof.adjusted).toBe(cp);
  });

  it('allocate/reveal round-trips: commit matches reveal and crashPoint matches stored proof', () => {
    const f = new FairnessEngine();
    f.ensureChain(2);
    const roundId = 'round-' + crypto.randomUUID();
    const alloc = f.allocateNextSeed(roundId);
    const reveal = f.revealSeed(roundId);
    expect(f.verify(reveal.serverSeed, alloc.serverHash)).toBe(true);
    expect(sha256(reveal.serverSeed)).toBe(alloc.serverHash);
    // the independent baseCrash derivation matches the engine for default params
    const { baseCrash } = independentBaseCrash(reveal.serverSeed, alloc.clientSeed, alloc.nonce);
    expect(new FairnessEngine().computeProof(reveal.serverSeed, alloc.clientSeed, alloc.nonce).baseCrash).toBe(
      baseCrash,
    );
  });

  it('seed commits are single-use (reuse attack prevented)', () => {
    const f = new FairnessEngine();
    f.ensureChain(4);
    const a = f.allocateNextSeed('r1');
    const b = f.allocateNextSeed('r2');
    expect(a.serverHash).not.toBe(b.serverHash);
  });

  it('revealSeed throws for unknown rounds and cannot reveal twice', () => {
    const f = new FairnessEngine();
    f.ensureChain(2);
    f.allocateNextSeed('r1');
    f.revealSeed('r1');
    expect(() => f.revealSeed('r1')).toThrow(/no allocated seed/);
    expect(() => f.revealSeed('never')).toThrow(/no allocated seed/);
  });

  it('crash points are always >= 1.0', () => {
    const f = new FairnessEngine();
    for (let i = 0; i < 500; i++) {
      const cp = f.computeCrashPoint(crypto.randomBytes(32).toString('hex'), 'c', i);
      expect(cp).toBeGreaterThanOrEqual(1.0);
    }
  });
});

describe('round-level fairness (commit → reveal → verify)', () => {
  let rig: Rig;
  beforeEach(() => {
    vi.useFakeTimers();
    rig = makeRig(); // real FairnessEngine — real crash points
  });
  afterEach(() => {
    try {
      rig.game.reset();
    } catch {}
    vi.useRealTimers();
  });

  async function runOneRound() {
    const crashes = collect('ROUND_CRASHED');
    const started = collect('ROUND_STARTED');
    rig.game.startBetting(500);
    rig.game.lockBets();
    rig.game.startRound();
    for (let i = 0; i < 400 && rig.game.getPhase() !== 'CRASHED'; i++) {
      await vi.advanceTimersByTimeAsync(1_000);
    }
    crashes.stop();
    started.stop();
    expect(rig.game.getPhase()).toBe('CRASHED');
    return { crash: crashes.events[0] as any, start: started.events[0] };
  }

  it('reveal matches the pre-bet commitment', async () => {
    const { crash, start } = await runOneRound();
    expect(sha256(crash.serverSeed)).toBe(start.serverHash);
    expect(crash.serverHash).toBe(start.serverHash);
    expect(crash.clientSeed).toBe(start.clientSeed);
    expect(crash.nonce).toBe(start.nonce);
  });

  // V-F1: the published proof must describe the crash point that was actually
  // used, even if shaping params were changed after the commitment.
  it('published proof matches the actual crash point when params change mid-round', async () => {
    const crashes = collect('ROUND_CRASHED');
    rig.game.startBetting(500);
    // operator/exposure steering changes the mapping after commitment
    rig.game.setShapingParams({ volatility: 2.5, instantCrashDivisor: 10, houseEdge: 0.05 });
    rig.game.lockBets();
    rig.game.startRound();
    for (let i = 0; i < 400 && rig.game.getPhase() !== 'CRASHED'; i++) {
      await vi.advanceTimersByTimeAsync(1_000);
    }
    crashes.stop();
    const crash = crashes.events[0] as any;
    expect(crash.proof).toBeTruthy();
    expect(crash.proof.adjusted).toBe(crash.crashPoint);
  });

  it('independent verifier reproduces baseCrash from revealed data + published params', async () => {
    const { crash } = await runOneRound();
    expect(crash.proof).toBeTruthy();
    const { hex, baseCrash } = independentBaseCrash(
      crash.serverSeed,
      crash.clientSeed,
      crash.nonce,
      crash.proof.houseEdge,
    );
    expect(hex).toBe(crash.proof.hex);
    expect(baseCrash).toBe(crash.proof.baseCrash);
  });

  // Regime state changes the committed SHAPE (EdgeProfile), so an engine in a
  // different regime produces different crash points for the same seed — but
  // the actual mapping used is committed pre-bet and fully verifiable.
  it('regime state changes the committed profile (and is committed, not hidden)', () => {
    const stateful = new FairnessEngine();
    // evolve state: five sub-1.5 rounds force the CHAOS regime
    for (let i = 0; i < 5; i++) stateful.recordRound(1.2);
    stateful.ensureChain(16);
    const chaosSnap = stateful.getVolatilitySnapshot();
    const calmSnap = new FairnessEngine().getVolatilitySnapshot();
    expect(chaosSnap.state).toBe('CHAOS');
    expect(calmSnap.state).toBe('CALM');
    expect(chaosSnap.profile).not.toEqual(calmSnap.profile);
    // some non-instant crash values differ between the two committed profiles
    let diverged = 0;
    for (let i = 0; i < 32; i++) {
      const a = stateful.allocateNextSeed('rX' + i);
      const r = stateful.revealSeed('rX' + i);
      const fresh = new FairnessEngine().computeProof(r.serverSeed, a.clientSeed, a.nonce);
      expect(fresh.baseCrash).toBe(
        independentBaseCrash(r.serverSeed, a.clientSeed, a.nonce).baseCrash,
      );
      if (fresh.adjusted !== a.crashPoint) diverged++;
    }
    expect(diverged).toBeGreaterThan(0);
  });
});

describe('VolatilityEngine determinism and bounded shaping', () => {
  const draw = (hex: string) => parseInt(hex.slice(0, 13), 16) / 2 ** 52;

  it('crashFromRPure is deterministic for identical snapshots', () => {
    const snapA = new VolatilityEngine().getSnapshot();
    const snapB = new VolatilityEngine().getSnapshot();
    for (let i = 0; i < 50; i++) {
      const r = draw(crypto.randomBytes(16).toString('hex'));
      expect(VolatilityEngine.crashFromRPure(r, 0.01, snapA))
        .toBe(VolatilityEngine.crashFromRPure(r, 0.01, snapB));
    }
  });

  it('crash is always in [1.0, CRASH_CAP] for every regime', () => {
    const states = ['CALM', 'TENSION', 'CHAOS', 'RESET'] as const;
    for (const state of states) {
      const snap = { ...new VolatilityEngine().getSnapshot(), state,
        profile: VolatilityEngine.deriveProfile(state, {}, 1) };
      for (const r of [0, 0.005, 0.01, 0.5, 0.999999, 1 - 2 ** -52]) {
        const c = VolatilityEngine.crashFromRPure(r, 0.01, snap);
        expect(c).toBeGreaterThanOrEqual(1.0);
        expect(c).toBeLessThanOrEqual(CRASH_CAP);
      }
    }
  });

  it('a hostile committed profile cannot escape the economic bounds', () => {
    const base = new VolatilityEngine().getSnapshot();
    const hostile = { ...base, profile: { beta: 0.99, lambda: 100 } };
    // even with beta=0.99 committed, the pure derivation re-clamps to BETA_MAX
    for (const m of [1.2, 1.5, 2, 3, 5, 10]) {
      // survival at m can never drop below the max-edge curve
      const s = VolatilityEngine.theoreticalSurvival(m, 0.01, hostile);
      expect(m * s).toBeGreaterThanOrEqual((1 - 0.01) * (1 - BETA_MAX) - 1e-12);
      expect(m * s).toBeLessThanOrEqual(1 - 0.01 + 1e-12);
    }
  });

  it('DOCUMENTED: player mix changes the committed profile (tilted ⇒ more edge)', () => {
    const neutral = VolatilityEngine.deriveProfile('CALM', {}, 1);
    const tilted = VolatilityEngine.deriveProfile('CALM', { tilted: 1 }, 1);
    expect(tilted.beta).toBeGreaterThan(neutral.beta);
    expect(tilted.beta).toBeLessThanOrEqual(BETA_MAX);
  });

  it('DOCUMENTED: elasticity from win/loss totals changes the committed shape only', () => {
    const a = new VolatilityEngine();
    const b = new VolatilityEngine();
    for (let i = 0; i < 20; i++) b.recordLoss(1_000); // heavy losses → elasticity > 1
    expect(b.getElasticity()).toBeGreaterThan(1);
    const pa = a.getSnapshot().profile;
    const pb = b.getSnapshot().profile;
    expect(pb.lambda).toBeLessThan(pa.lambda); // edge accrues later
    expect(pb.beta).toBe(pa.beta); // total edge budget unchanged
  });
});

describe('exposure → shaping coupling (documented design property)', () => {
  let rig: Rig;
  beforeEach(() => {
    vi.useFakeTimers();
    rig = makeRig({ crashPoint: 2.0 });
  });
  afterEach(() => {
    try {
      rig.game.reset();
    } catch {}
    vi.useRealTimers();
  });

  it('exceeding the liability threshold changes shaping params after the commitment', async () => {
    rig.wallet.ensureAccount('whale', 100_000);
    const state = rig.game.startBetting(1_000);
    const before = rig.fairness.getShapingParams();
    expect(before.volatility).toBe(1);
    // one large bet: liability = amount × assumedMax(100) > threshold(10 000)
    await rig.betting.placeBet('whale', 200);
    const after = rig.fairness.getShapingParams();
    // exposure steering silently rewrites the mapping params post-commitment
    expect(after.volatility).toBe(1.5);
    expect(after.instantCrashDivisor).toBe(20);
    // current round's crashPoint was computed at allocation and is unchanged
    expect(rig.game.getState()!.crashPoint).toBe(state.crashPoint);
  });
});

describe('fairness transparency: committed mapping + full outside verification', () => {
  let rig: Rig;
  beforeEach(() => {
    vi.useFakeTimers();
    rig = makeRig(); // real FairnessEngine — real crash points
  });
  afterEach(() => {
    try {
      rig.game.reset();
    } catch {}
    vi.useRealTimers();
  });

  async function runOneRound() {
    const crashes = collect('ROUND_CRASHED');
    const started = collect('ROUND_STARTED');
    rig.game.startBetting(500);
    rig.game.lockBets();
    rig.game.startRound();
    for (let i = 0; i < 400 && rig.game.getPhase() !== 'CRASHED'; i++) {
      await vi.advanceTimersByTimeAsync(1_000);
    }
    crashes.stop();
    started.stop();
    expect(rig.game.getPhase()).toBe('CRASHED');
    return { crash: crashes.events[0] as any, start: started.events[0] as any };
  }

  it('a blinded params commitment is published pre-bet and opened at crash', async () => {
    const { crash, start } = await runOneRound();
    expect(start.paramsCommit).toMatch(/^[0-9a-f]{64}$/);
    expect(crash.paramsCommit).toBe(start.paramsCommit);
    expect(crash.paramsSalt).toMatch(/^[0-9a-f]{32}$/);
    expect(crash.shapingParams).toBeTruthy();
    expect(crash.volatilitySnapshot).toBeTruthy();
    // the opening hashes back to the pre-bet commitment
    expect(computeParamsCommit(crash.shapingParams, crash.volatilitySnapshot, crash.paramsSalt))
      .toBe(start.paramsCommit);
    // the commitment blinds the snapshot: publishing identical params under a
    // different salt yields a different commitment (no dictionary lookup)
    expect(computeParamsCommit(crash.shapingParams, crash.volatilitySnapshot, 'other-salt'))
      .not.toBe(start.paramsCommit);
  });

  it('INV-F6: the FINAL crash point is reconstructible from published data alone', async () => {
    const { crash, start } = await runOneRound();
    const result = verifyRound(
      { serverHash: start.serverHash, paramsCommit: start.paramsCommit },
      {
        serverSeed: crash.serverSeed,
        clientSeed: crash.clientSeed,
        nonce: crash.nonce,
        shapingParams: crash.shapingParams,
        volatilitySnapshot: crash.volatilitySnapshot,
        paramsSalt: crash.paramsSalt,
        crashPoint: crash.crashPoint,
      },
    );
    expect(result.seedMatchesCommit).toBe(true);
    expect(result.paramsMatchCommit).toBe(true);
    expect(result.crashPointMatches).toBe(true);
    expect(result.recomputedCrashPoint).toBe(crash.crashPoint);
    expect(result.ok).toBe(true);
  });

  it('verification holds across many rounds while hidden state evolves (history, wins/losses, player mix)', async () => {
    for (let round = 0; round < 8; round++) {
      // evolve every input the volatility layer depends on, between rounds
      rig.fairness.recordWin(50 * (round + 1));
      rig.fairness.recordLoss(120 * (round + 1));
      rig.fairness.setPlayerMix({ conservative: 0.6, greedy: 0.5, tilted: 0.9 });
      const { crash, start } = await runOneRound();
      const result = verifyRound(
        { serverHash: start.serverHash, paramsCommit: start.paramsCommit },
        {
          serverSeed: crash.serverSeed,
          clientSeed: crash.clientSeed,
          nonce: crash.nonce,
          shapingParams: crash.shapingParams,
          volatilitySnapshot: crash.volatilitySnapshot,
          paramsSalt: crash.paramsSalt,
          crashPoint: crash.crashPoint,
        },
      );
      expect(result.ok).toBe(true);
      rig.game.reset();
    }
  });

  it('a tampered reveal is detected: modified snapshot fails the params commitment', async () => {
    const { crash, start } = await runOneRound();
    const tamperedSnapshot = { ...crash.volatilitySnapshot, elasticity: crash.volatilitySnapshot.elasticity + 0.1 };
    const result = verifyRound(
      { serverHash: start.serverHash, paramsCommit: start.paramsCommit },
      {
        serverSeed: crash.serverSeed,
        clientSeed: crash.clientSeed,
        nonce: crash.nonce,
        shapingParams: crash.shapingParams,
        volatilitySnapshot: tamperedSnapshot,
        paramsSalt: crash.paramsSalt,
        crashPoint: crash.crashPoint,
      },
    );
    expect(result.paramsMatchCommit).toBe(false);
    expect(result.ok).toBe(false);
  });

  it('a swapped seed is detected by the seed commitment', async () => {
    const { crash, start } = await runOneRound();
    const result = verifyRound(
      { serverHash: start.serverHash, paramsCommit: start.paramsCommit },
      {
        serverSeed: crypto.randomBytes(32).toString('hex'),
        clientSeed: crash.clientSeed,
        nonce: crash.nonce,
        shapingParams: crash.shapingParams,
        volatilitySnapshot: crash.volatilitySnapshot,
        paramsSalt: crash.paramsSalt,
        crashPoint: crash.crashPoint,
      },
    );
    expect(result.seedMatchesCommit).toBe(false);
    expect(result.ok).toBe(false);
  });

  it('the opening is persisted on the round for offline audits', async () => {
    const { start } = await runOneRound();
    const s = rig.game.getState()!;
    expect(s.paramsCommit).toBe(start.paramsCommit);
    expect(s.fairnessReveal).toBeTruthy();
    const recomputed = recomputeCrashPoint(
      s.serverSeed,
      s.clientSeed,
      s.nonce,
      s.fairnessReveal!.shapingParams,
      s.fairnessReveal!.volatilitySnapshot as any,
    );
    expect(recomputed).toBe(s.crashPoint);
  });

  it('verification calls cannot perturb future rounds (no tilt-state mutation)', () => {
    const engine = new FairnessEngine();
    // a fully tilted mix maximises the chance the near-miss path would have
    // scheduled a tilt-low under the old mutating computeProof
    engine.setPlayerMix({ tilted: 1 });
    engine.recordLoss(1000);
    const before = engine.getVolatilitySnapshot();
    for (let i = 0; i < 50; i++) {
      const seed = crypto.randomBytes(32).toString('hex');
      engine.computeCrashPoint(seed, 'client', i + 1);
      engine.computeProof(seed, 'client', i + 1);
    }
    expect(engine.getVolatilitySnapshot()).toEqual(before);
  });

  it('repeated verification of the same reveal is deterministic', async () => {
    const { crash } = await runOneRound();
    const first = recomputeCrashPoint(
      crash.serverSeed, crash.clientSeed, crash.nonce, crash.shapingParams, crash.volatilitySnapshot,
    );
    for (let i = 0; i < 10; i++) {
      expect(recomputeCrashPoint(
        crash.serverSeed, crash.clientSeed, crash.nonce, crash.shapingParams, crash.volatilitySnapshot,
      )).toBe(first);
    }
  });
});
