import { eventBus } from './event-bus';
import type { GameEvents } from '../domains/game';
import type { GameEngine } from '../core/game-engine';
import type { BettingService } from '../core/betting-service';
import type { SettlementEngine } from '../core/settlement-engine';

// ─── Timing ───────────────────────────────────────────────────────────────────

const BETTING_MS  = 5_000;   // 5s for players to place bets
const LOCK_GAP_MS =   500;   // brief pause after lock before multiplier starts
const COOLDOWN_MS = 3_000;   // pause between rounds (show crash result)

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

export class RoundScheduler {
  private running    = false;
  private roundsDone = 0;
  private maxRounds?: number;

  constructor(
    private gameEngine:       GameEngine,
    private bettingEngine:    BettingService,
    private settlementEngine: SettlementEngine,
    opts?: { maxRounds?: number },
  ) {
    this.maxRounds = opts?.maxRounds;
  }

  async start(): Promise<void> {
    if (this.running) throw new Error('Scheduler already running');
    this.running = true;
    await this.loop();
  }

  stop(): void {
    this.running = false;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        // If engine is in a CRASHED state, attempt recover; stop if recover fails
        try {
          const phase = this.gameEngine.getPhase?.() ?? 'IDLE';
          if (phase === 'CRASHED') {
            console.error('[Scheduler] Engine in CRASHED state — attempting recovery');
            try { await Promise.resolve((this.gameEngine as any).recover?.()); } catch (e) { /* ignore */ }
            const newPhase = this.gameEngine.getPhase?.() ?? 'IDLE';
            if (newPhase === 'CRASHED') {
              console.error('[Scheduler] Engine recovery failed — stopping scheduler');
              this.running = false;
              break;
            }
          }
        } catch (e) {}

        await this.executeRound();
        this.roundsDone++;
        if (this.maxRounds && this.roundsDone >= this.maxRounds) {
          this.running = false;
        }
      } catch (err) {
        console.error('[Scheduler] Round error:', err);
        await sleep(1_000);
      }
    }
  }

  private async executeRound(): Promise<void> {
    // ── 1. Open betting ──────────────────────────────────────────────────────
    const round = this.gameEngine.startBetting(BETTING_MS);
    await sleep(BETTING_MS);

    // ── 2. Lock bets ─────────────────────────────────────────────────────────
    this.gameEngine.lockBets();
    await sleep(LOCK_GAP_MS);

    // ── 3. Start multiplier ──────────────────────────────────────────────────
    this.gameEngine.startRound();

    // ── 4. Wait for crash (GameEngine owns timing via setInterval) ───────────
    try {
      await this.waitForCrash(round.roundId);
      // ── 5. Settle (phase is now CRASHED/SETTLED) ────────────────────────────
      await this.settlementEngine.settle();
    } catch (err) {
      console.error('[Scheduler] error during wait/settle:', err);
      // best-effort settle if possible
      try { await this.settlementEngine.settle(); } catch (e) { console.error('[Scheduler] fallback settle failed', e); }
    } finally {
      // ── 6. Reset state, cool down (always attempt to reset so scheduler can continue)
      try { this.gameEngine.reset(); } catch (e) { console.error('[Scheduler] reset failed', e); }
      await sleep(COOLDOWN_MS);
    }
  }

  /** Resolves when ROUND_CRASHED fires for this specific roundId. */
  private waitForCrash(roundId: string): Promise<void> {
    return new Promise(resolve => {
      const handler = (data: GameEvents['ROUND_CRASHED']) => {
        if (data.roundId === roundId) {
          eventBus.off('ROUND_CRASHED', handler as any);
          resolve();
        }
      };
      eventBus.on('ROUND_CRASHED', handler as any);
    });
  }
}
