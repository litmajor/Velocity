import crypto from 'crypto';
import { eventBus } from '../../runtime/event-bus';
import { FairnessEngine } from '../fairness-engine';
import type { RoundState } from '../../domains/game';
import type { RoundRepository } from '../repositories/round-repository';

// ─── Constants ────────────────────────────────────────────────────────────────

const MULTIPLIER_TICK_MS = 50;    // emit MULTIPLIER_UPDATED every 50ms
const GROWTH_RATE       = 0.000175; // e^(k * elapsed_ms): 2x at ~4s, 10x at ~13s
const TICK_STEP_MS = MULTIPLIER_TICK_MS;

export class GameEngine {
  private state:           RoundState | null = null;
  private roundNumber      = 0;
  private multiplierTimer: ReturnType<typeof setInterval> | null = null;
  private lastPhaseChange = 0;

  constructor(
    private bus = eventBus,
    private fairness = new FairnessEngine(),
    private repo?: RoundRepository,
  ) {}

  // Allow external components (e.g., exposure engine) to adjust shaping params.
  setShapingParams(params: Partial<import('../fairness-engine').ShapingParams>) {
    this.fairness.setShapingParams(params);
  }

  // Forward aggregated player composition to the fairness/volatility engines
  setPlayerMix(mix: { conservative?: number; greedy?: number; tilted?: number }) {
    try { (this.fairness as any).setPlayerMix?.(mix); } catch (e) {}
  }

  // Record outcome metrics (wins/losses) to influence volatility elasticity
  recordWin(amount: number) {
    try { this.fairness.recordWin(amount); } catch (e) {}
  }

  recordLoss(amount: number) {
    try { this.fairness.recordLoss(amount); } catch (e) {}
  }

  getElasticity(): number {
    return this.fairness.getElasticity();
  }

  // ── Accessors ──────────────────────────────────────────────────────────────

  getState(): RoundState | null {
    // Expose an immutable snapshot to prevent external tampering.
    if (!this.state) return null;
    return Object.freeze({ ...this.state });
  }

  getPhase(): string {
    return this.state?.phase ?? 'IDLE';
  }

  // ── Phase Transitions ──────────────────────────────────────────────────────

  /** Opens the betting window. Call this to start a new round. */
  startBetting(durationMs: number): RoundState {
    if (this.state !== null) {
      // If engine is in CRASHED state, attempt recovery before starting a new round
      if (this.state.phase === 'CRASHED') {
        console.warn('[GameEngine] startBetting called while CRASHED — attempting recover()');
        this.recover();
      } else {
        throw new Error(`startBetting: state must be null, got ${this.state.phase}`);
      }
    }

    // Ensure fairness engine has a buffer of seeds
    this.fairness.ensureChain(8);
    const now = Date.now();
    // monotonic phase change check
    if (now < this.lastPhaseChange) throw new Error('DESYNC DETECTED: clock rollback');
    this.lastPhaseChange = now;
    this.roundNumber++;

    const roundId = crypto.randomUUID();
    // Allocate an unrevealed seed for this round. The returned `serverSeed` is
    // kept server-side (not published) but used to compute the authoritative crashPoint.
    const alloc = this.fairness.allocateNextSeed(roundId);

    this.state = {
      roundId,
      roundNumber: this.roundNumber,
      phase: 'BETTING',
      serverSeed: alloc.serverSeed,
      serverHash: alloc.serverHash,
      clientSeed: alloc.clientSeed,
      nonce: alloc.nonce,
      crashPoint: alloc.crashPoint,
      multiplier: 1.0,
      roundStartedAt: null,
      bettingOpensAt: now,
      bettingEndsAt: now + durationMs,
    };

    this.bus.emit('ROUND_STARTED', {
      roundId: this.state.roundId,
      roundNumber: this.state.roundNumber,
      serverHash: this.state.serverHash, // ← published; seed stays hidden
      bettingEndsAt: this.state.bettingEndsAt,
      clientSeed: this.state.clientSeed,
      nonce: this.state.nonce,
    });

    // Publish an initial STATE_SNAPSHOT (authoritative, no serverSeed/crashPoint)
    this.bus.emit('STATE_SNAPSHOT', {
      roundId:        this.state.roundId,
      roundNumber:    this.state.roundNumber,
      phase:          this.state.phase,
      serverHash:     this.state.serverHash,
      clientSeed:     this.state.clientSeed,
      nonce:          this.state.nonce,
      multiplier:     this.state.multiplier,
      roundStartedAt: this.state.roundStartedAt,
      bettingOpensAt: this.state.bettingOpensAt,
      bettingEndsAt:  this.state.bettingEndsAt,
      shapingParams:  this.fairness.getShapingParams(),
      systemState:    this.fairness.getVolatilityState(),
      shapingPreset:  this.fairness.getShapingPreset(),
      elasticity:     this.getElasticity(),
    });

    // persist round state if repository provided (fire-and-forget)
    if (this.repo) this.repo.save(this.state).catch(() => {});

    return this.state;
  }

  /** Closes the betting window. No more bets accepted after this. */
  lockBets(): void {
    this.assertPhase('BETTING', 'lockBets');
    const now = Date.now();
    if (now < this.lastPhaseChange) throw new Error('DESYNC DETECTED: clock rollback');
    this.lastPhaseChange = now;

    this.state!.phase = 'LOCKED';
    this.bus.emit('ROUND_LOCKED', {
      roundId:     this.state!.roundId,
      roundNumber: this.state!.roundNumber,
    });

    if (this.repo) this.repo.save(this.state!).catch(() => {});
  }

  /** Starts the multiplier clock. Round is now live. */
  startRound(): void {
    this.assertPhase('LOCKED', 'startRound');
    const now = Date.now();
    if (now < this.lastPhaseChange) throw new Error('DESYNC DETECTED: clock rollback');
    this.lastPhaseChange = now;

    this.state!.phase          = 'RUNNING';
    this.state!.roundStartedAt = Date.now();
    this.state!.multiplier     = 1.00;
    this.multiplierTimer = setInterval(() => this.tick(), MULTIPLIER_TICK_MS);

    // notify surfaces that the round is now running
    this.bus.emit('ROUND_RUNNING' as any, {
      roundId:    this.state!.roundId,
      roundNumber: this.state!.roundNumber,
    });

    // snapshot at RUNNING (authoritative)
    this.bus.emit('STATE_SNAPSHOT', {
      roundId:        this.state!.roundId,
      roundNumber:    this.state!.roundNumber,
      phase:          this.state!.phase,
      serverHash:     this.state!.serverHash,
      clientSeed:     this.state!.clientSeed,
      nonce:          this.state!.nonce,
      multiplier:     this.state!.multiplier,
      roundStartedAt: this.state!.roundStartedAt,
      bettingOpensAt: this.state!.bettingOpensAt,
      bettingEndsAt:  this.state!.bettingEndsAt,
      shapingParams:  this.fairness.getShapingParams(),
      systemState:    this.fairness.getVolatilityState(),
      shapingPreset:  this.fairness.getShapingPreset(),
      elasticity:     this.getElasticity(),
    });

    if (this.repo) this.repo.save(this.state!).catch(() => {});
  }

  /** Resets state after settlement — scheduler calls this between rounds. */
  reset(): void {
    if (this.multiplierTimer) {
      clearInterval(this.multiplierTimer);
      this.multiplierTimer = null;
    }
    const now = Date.now();
    if (now < this.lastPhaseChange) throw new Error('DESYNC DETECTED: clock rollback');
    this.lastPhaseChange = now;
    this.state = null;
  }

  // Recover the engine from a CRASHED state by clearing timers and resetting state.
  // This is a controlled, manual recovery and should be used cautiously in production.
  

  // Attempt to recover from a CRASHED state by clearing timers and resetting state.
  // This is a best-effort recovery used by the scheduler/watchdog to resume operations.
  recover(): void {
    try {
      if (this.multiplierTimer) {
        clearInterval(this.multiplierTimer);
        this.multiplierTimer = null;
      }
    } catch (e) {}
    if (this.state && this.state.phase === 'CRASHED') {
      this.state = null;
    }
  }

  // ── Internal Multiplier Loop ───────────────────────────────────────────────

  private tick(): void {
    const s = this.state;
    if (!s || s.phase !== 'RUNNING' || s.roundStartedAt === null) return;
    const elapsed  = Date.now() - s.roundStartedAt;
    // quantize elapsed to deterministic steps to avoid drift across machines
    const elapsedSteps = Math.floor(elapsed / TICK_STEP_MS);
    const effectiveElapsed = elapsedSteps * TICK_STEP_MS;
    const rawMulti = Math.exp(GROWTH_RATE * effectiveElapsed);

    // Crash detection: multiplier has reached the pre-determined crashPoint
    if (rawMulti >= s.crashPoint) {
      s.multiplier = s.crashPoint; // land exactly on crashPoint

      if (this.multiplierTimer) {
        clearInterval(this.multiplierTimer);
        this.multiplierTimer = null;
      }

      s.phase = 'CRASHED';
      // Reveal the seed from the fairness engine (removes allocation)
      try {
        const reveal = this.fairness.revealSeed(s.roundId);
        // sync state serverSeed with revealed value (defence-in-depth)
        s.serverSeed = reveal.serverSeed;
        s.serverHash = reveal.serverHash ?? s.serverHash;

        // Publish the proof recorded at allocation time so clients/auditors can
        // verify how the crash point was derived from the revealed seed and the
        // parameters in force at commitment (clientSeed + nonce). Recomputing it
        // here would use current shaping/volatility state and could desync from
        // the actual crashPoint.
        try {
          const proof = (reveal as any).proof ?? (this.fairness as any).computeProof?.(s.serverSeed, s.clientSeed, s.nonce) ?? null;
          this.bus.emit('ROUND_CRASHED', {
            roundId: s.roundId,
            roundNumber: s.roundNumber,
            crashPoint: s.crashPoint,
            serverSeed: s.serverSeed, // ← revealed now; anyone can verify
            serverHash: s.serverHash,
            clientSeed: s.clientSeed,
            nonce: s.nonce,
            proof,
          } as any);
        } catch (e) {
          // fallback to minimal reveal if proof computation fails
          this.bus.emit('ROUND_CRASHED', {
            roundId: s.roundId,
            roundNumber: s.roundNumber,
            crashPoint: s.crashPoint,
            serverSeed: s.serverSeed,
            serverHash: s.serverHash,
            clientSeed: s.clientSeed,
            nonce: s.nonce,
          } as any);
        }
      } catch (err) {
        // If reveal fails, proceed with whatever serverSeed we have in-state
        this.bus.emit('ROUND_CRASHED', {
          roundId: s.roundId,
          roundNumber: s.roundNumber,
          crashPoint: s.crashPoint,
          serverSeed: s.serverSeed,
          clientSeed: s.clientSeed,
          nonce: s.nonce,
        } as any);
      }
      // Record into fairness/volatility engine history so state can evolve
      try {
        this.fairness.recordRound(s.crashPoint);
      } catch (e) {
        // ignore
      }
      // publish final snapshot including crash/reveal so clients can verify
      this.bus.emit('STATE_SNAPSHOT', {
        roundId:        s.roundId,
        roundNumber:    s.roundNumber,
        phase:          s.phase,
        serverHash:     s.serverHash,
        clientSeed:     s.clientSeed,
        nonce:          s.nonce,
        multiplier:     s.multiplier,
        roundStartedAt: s.roundStartedAt,
        bettingOpensAt: s.bettingOpensAt,
        bettingEndsAt:  s.bettingEndsAt,
        shapingParams:  this.fairness.getShapingParams(),
        systemState:    this.fairness.getVolatilityState(),
        shapingPreset:  this.fairness.getShapingPreset(),
        elasticity:     this.getElasticity(),
      });
      if (this.repo) this.repo.save(s).catch(() => {});

      return;
    }

    // Still running — floor to 2dp to avoid jitter in display
    s.multiplier = Math.floor(rawMulti * 100) / 100;

    // Emit both legacy MULTIPLIER_UPDATED and new TICK_UPDATE for clients
    const tickIndex = elapsedSteps;
    eventBus.emit('MULTIPLIER_UPDATED', {
      roundId:    s.roundId,
      multiplier: s.multiplier,
      elapsed: effectiveElapsed,
      tickIndex,
    } as any);
    eventBus.emit('TICK_UPDATE', {
      roundId:    s.roundId,
      multiplier: s.multiplier,
      ts:         Date.now(),
      tickIndex,
    } as any);
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private assertPhase(expected: string, caller: string): void {
    if (this.state?.phase !== expected) {
      throw new Error(`${caller}: expected phase ${expected}, got ${this.state?.phase ?? 'null'}`);
    }
  }
}
