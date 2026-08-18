import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import { FairnessEngine } from '../src/core/fairness-engine';
import { VolatilityEngine } from '../src/core/volatility-engine';
import { makeRig, collect, Rig } from './helpers/rig';

/**
 * Independent verifier: replicates the seed → baseCrash derivation using only
 * crypto primitives and the published shaping params (no engine code).
 * NOTE: the final `adjusted` crash point additionally depends on hidden
 * VolatilityEngine state (history, playerMix, elasticity, tiltNextLow) and is
 * NOT reconstructible from committed data alone — see fairness assessment.
 */
function independentBaseCrash(
  serverSeed: string,
  clientSeed: string,
  nonce: number,
  houseEdge = 0.01,
  volatility = 1,
): { hex: string; baseCrash: number } {
  const hex = crypto.createHmac('sha256', serverSeed).update(`${clientSeed}:${nonce}`).digest('hex');
  let r = parseInt(hex.slice(0, 13), 16) / 2 ** 52;
  if (volatility !== 1 && volatility > 0) r = Math.pow(r, volatility);
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
      crash.proof.volatility,
    );
    expect(hex).toBe(crash.proof.hex);
    expect(baseCrash).toBe(crash.proof.baseCrash);
  });

  // DESIGN FINDING V-F2: the final crash point is NOT reconstructible from
  // committed/published data once VolatilityEngine state has evolved.
  it('DOCUMENTED: adjusted crash point depends on hidden volatility state', () => {
    const stateful = new FairnessEngine();
    // evolve hidden state: five sub-1.5 rounds force the CHAOS regime
    for (let i = 0; i < 5; i++) stateful.recordRound(1.2);
    stateful.ensureChain(16);
    // find a non-instant-crash allocation so the volatility layer applies
    let alloc: ReturnType<FairnessEngine['allocateNextSeed']> | null = null;
    let reveal: any = null;
    let freshProof: any = null;
    for (let i = 0; i < 12; i++) {
      const a = stateful.allocateNextSeed('rX' + i);
      const r = stateful.revealSeed('rX' + i);
      const p = new FairnessEngine().computeProof(r.serverSeed, a.clientSeed, a.nonce);
      if (p.baseCrash >= 1.3) {
        alloc = a;
        reveal = r;
        freshProof = p;
        break;
      }
    }
    expect(alloc).toBeTruthy();
    expect(freshProof.baseCrash).toBe(
      independentBaseCrash(reveal.serverSeed, alloc!.clientSeed, alloc!.nonce).baseCrash,
    );
    // the adjusted value diverges because CHAOS≠CALM modifiers are disjoint
    expect(freshProof.adjusted).not.toBe(alloc!.crashPoint);
  });
});

describe('VolatilityEngine determinism and shaping', () => {
  it('adjustCrash is deterministic for identical state and entropy (incl. tilt path)', () => {
    const mk = () => {
      const v = new VolatilityEngine();
      v.setPlayerMix({ tilted: 1 });
      return v;
    };
    const a = mk();
    const b = mk();
    // hex chosen so slice(9,13) is '0000' → triggers the near-miss + tiltNextLow path
    const hex1 = 'fffffffff0000fffffffffffffffffff';
    const hex2 = 'abcdefabcdefabcdefabcdefabcdefab';
    const seqA = [a.adjustCrash(2.0, hex1), a.adjustCrash(2.0, hex2), a.adjustCrash(3.0, hex2)];
    const seqB = [b.adjustCrash(2.0, hex1), b.adjustCrash(2.0, hex2), b.adjustCrash(3.0, hex2)];
    expect(seqA).toEqual(seqB);
  });

  it('adjusted crash never drops below 1.01 and modifier is clamped', () => {
    const v = new VolatilityEngine();
    for (let i = 0; i < 200; i++) {
      const hex = crypto.randomBytes(16).toString('hex');
      const adj = v.adjustCrash(1.01, hex);
      expect(adj).toBeGreaterThanOrEqual(1.01);
      expect(adj).toBeLessThanOrEqual(1.01 * 4.0 + 0.01);
    }
  });

  it('DOCUMENTED: player mix (behavior) changes crash outcomes for identical seeds', () => {
    const neutral = new VolatilityEngine();
    const tilted = new VolatilityEngine();
    tilted.setPlayerMix({ tilted: 1 });
    const hex = 'fffffffff0000fffffffffffffffffff'; // triggers tilted near-miss branch
    expect(neutral.adjustCrash(5.0, hex)).not.toBe(tilted.adjustCrash(5.0, hex));
  });

  it('DOCUMENTED: elasticity from win/loss totals changes crash outcomes', () => {
    const a = new VolatilityEngine();
    const b = new VolatilityEngine();
    for (let i = 0; i < 20; i++) b.recordLoss(1_000); // heavy losses → elasticity > 1
    const hex = '00000000000000000000000000000000';
    expect(b.getElasticity()).toBeGreaterThan(1);
    expect(a.adjustCrash(2.0, hex)).not.toBe(b.adjustCrash(2.0, hex));
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
