import { eventBus } from '../../runtime/event-bus';
import type { GameEngine } from '../../core/game-engine';
import type { BettingService } from '../../core/betting-service';
import type { WildcardEnvelope } from '../../domains/game';

// ─── ANSI helpers ─────────────────────────────────────────────────────────────

const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  red:    '\x1b[31m',
  cyan:   '\x1b[36m',
  white:  '\x1b[37m',
  gray:   '\x1b[90m',
};

function multiColor(m: number): string {
  if (m < 2)   return C.cyan;
  if (m < 5)   return C.green;
  if (m < 10)  return C.yellow;
  return C.red;
}

function phaseColor(phase: string): string {
  switch (phase) {
    case 'BETTING':  return C.cyan;
    case 'LOCKED':   return C.yellow;
    case 'RUNNING':  return C.green;
    case 'CRASHED':  return C.red;
    default:         return C.gray;
  }
}

// ─── DebugSurface ─────────────────────────────────────────────────────────────

export class DebugSurface {
  private eventLog: Array<{ event: string; data: unknown; timestamp: number }> = [];
  private renderTimer: ReturnType<typeof setInterval> | null = null;
  private readonly MAX_LOG = 15;
  private readonly isTerminal: boolean;

  constructor(
    private gameEngine:    GameEngine,
    private bettingEngine: BettingService,
    opts?: { mode?: 'terminal' | 'log' | 'auto' },
  ) {
    const mode = opts?.mode ?? 'auto';
    this.isTerminal = mode === 'terminal'
      || (mode === 'auto' && !!process.stdout.isTTY);
  }

  start(): void {
    // In terminal mode we want a compact, incremental UI: capture wildcard
    // events only for terminal (so log-mode handlers below don't duplicate).
    if (this.isTerminal) {
      // Capture all events into log (excluding MULTIPLIER_UPDATED/TICK_UPDATE — too noisy)
      eventBus.onWildcard((envelope: WildcardEnvelope) => {
        if (envelope.event !== 'MULTIPLIER_UPDATED' && envelope.event !== 'TICK_UPDATE') {
          this.eventLog.unshift(envelope);
          if (this.eventLog.length > this.MAX_LOG) this.eventLog.pop();
        }
      });

      // render a compact view: full snapshot once per round, then tick-only updates
      this.renderTimer = setInterval(() => { void this.renderTerminal(); }, 250);
    } else {
      // log-mode registers its own per-event handlers (no wildcard)
      this.startLogMode();
    }
  }

  stop(): void {
    if (this.renderTimer) clearInterval(this.renderTimer);
  }

  // ── Terminal Mode ─────────────────────────────────────────────────────────

  private async renderTerminal(): Promise<void> {
    const state = this.gameEngine.getState();
    if (!state) return;
    // incremental rendering: print a full snapshot on round/phase change,
    // otherwise append a concise TICK_UPDATE and any new events.
    const m    = state.multiplier;
    const mc   = multiColor(m);
    const pc   = phaseColor(state.phase);

    // track last round rendered to decide between snapshot vs tick
    (this as any)._lastRoundId = (this as any)._lastRoundId ?? null;
    (this as any)._lastEventTs = (this as any)._lastEventTs ?? 0;

    const fullSnapshot = (this as any)._lastRoundId !== state.roundId || (this as any)._lastPhase !== state.phase;

    if (fullSnapshot) {
      (this as any)._lastRoundId = state.roundId;
      (this as any)._lastPhase = state.phase;

      const bets = await this.bettingEngine.getBetsForRound(state.roundId);

      process.stdout.write('\x1B[2J\x1B[H'); // clear screen

      const lines = [
        `${C.bold}╔══════════════════════════════════════════════╗${C.reset}`,
        `${C.bold}║         CRASH ENGINE — DEBUG SURFACE         ║${C.reset}`,
        `${C.bold}╚══════════════════════════════════════════════╝${C.reset}`,
        ``,
        `  ROUND      ${C.bold}#${state.roundNumber}${C.reset}  ${C.dim}${state.roundId.slice(0, 12)}...${C.reset}`,
        `  PHASE      ${pc}${C.bold}${state.phase}${C.reset}`,
        `  MULTIPLIER ${mc}${C.bold}${m.toFixed(2)}x${C.reset}`,
        `  CRASH @    ${state.phase === 'CRASHED' ? C.red + '💥 ' : C.dim}${state.crashPoint.toFixed(2)}x${C.reset}`,
        `  HASH       ${C.dim}${state.serverHash.slice(0, 20)}...${C.reset}`,
        ``,
        `  ${C.bold}BETS (${bets.length})${C.reset}`,
        ...(bets.length === 0 ? [`  ${C.gray}  (none)${C.reset}`] : bets.map(b => {
          const statusStr = b.status === 'CASHED_OUT'
            ? `${C.green}✓ @${b.cashedOutMultiplier?.toFixed(2)}x  → +${b.payout?.toFixed(2)}${C.reset}`
            : b.status === 'LOST'
            ? `${C.red}✗ lost${C.reset}`
            : `${C.cyan}⏳ active${C.reset}`;
          return `    ${C.bold}${b.userId.padEnd(14)}${C.reset}${String(b.amount).padStart(8)}  ${statusStr}`;
        })),
        ``,
        `  ${C.bold}EVENTS${C.reset}`,
      ];

      // print recent events (up to MAX_LOG)
      lines.push(...this.eventLog.slice(0, 8).map(e => {
        const t = new Date(e.timestamp).toISOString().slice(11, 23);
        if (e.timestamp > (this as any)._lastEventTs) (this as any)._lastEventTs = Math.max((this as any)._lastEventTs, e.timestamp);
        return `  ${C.gray}${t}${C.reset}  ${C.cyan}${e.event}${C.reset}`;
      }));

      process.stdout.write(lines.join('\n') + '\n');
    } else {
      // Tick update: append a short multiplier line and any new events
      const t = new Date().toISOString().slice(11, 23);
      process.stdout.write(`${C.gray}${t}${C.reset}  ${C.bold}${mc}${m.toFixed(2)}x${C.reset}\n`);

      // append newly captured events (those with timestamp > lastEventTs)
      for (const e of this.eventLog) {
        if (e.timestamp > (this as any)._lastEventTs) {
          const tt = new Date(e.timestamp).toISOString().slice(11, 23);
          process.stdout.write(`  ${C.gray}${tt}${C.reset}  ${C.cyan}${e.event}${C.reset}\n`);
          (this as any)._lastEventTs = Math.max((this as any)._lastEventTs, e.timestamp);
        }
      }
    }
  }

  // ── Log Mode ──────────────────────────────────────────────────────────────

  private startLogMode(): void {
    const LINE = '─'.repeat(52);

    eventBus.on('ROUND_STARTED', (d) => {
      console.log(`\n${LINE}`);
      console.log(`▶ ROUND #${d.roundNumber} STARTED`);
      console.log(`  hash:     ${d.serverHash.slice(0, 20)}...`);
      console.log(`  bet ends: ${new Date(d.bettingEndsAt).toISOString().slice(11, 23)}`);
    });

    eventBus.on('ROUND_LOCKED', (d) => {
      console.log(`🔒 ROUND #${d.roundNumber} LOCKED — bets closed`);
    });

    // For multiplier: only log on whole 0.5x increments to avoid spam
    let lastLogged = 1.0;
    eventBus.on('MULTIPLIER_UPDATED', (d) => {
      if (d.multiplier >= lastLogged + 0.5) {
        lastLogged = Math.floor(d.multiplier * 2) / 2;
        process.stdout.write(`\r  📈 ${d.multiplier.toFixed(2)}x    `);
      }
    });

    eventBus.on('ROUND_CRASHED', (d) => {
      lastLogged = 1.0; // reset for next round
      console.log(`\n💥 CRASHED @ ${d.crashPoint.toFixed(2)}x`);
      console.log(`  seed: ${d.serverSeed.slice(0, 16)}...`);
    });

    eventBus.on('BET_PLACED', (d) => {
      console.log(`  💰 BET  ${d.userId.padEnd(12)} ${d.amount} (${d.betId.slice(0, 8)})`);
    });

    eventBus.on('BET_REJECTED', (d) => {
      console.log(`  ⚠️  BET REJECTED  ${d.userId}: ${d.reason}`);
    });

    eventBus.on('PLAYER_CASHED_OUT', (d) => {
      const profit = d.payout - (d.payout / d.multiplier);
      console.log(`  ✅ CASHOUT  ${d.userId.padEnd(12)} @ ${d.multiplier.toFixed(2)}x → ${d.payout.toFixed(2)}  (+${profit.toFixed(2)})`);
    });

    eventBus.on('CASHOUT_REJECTED', (d) => {
      console.log(`  ⚠️  CASHOUT REJECTED  ${d.userId}: ${d.reason}`);
    });

    eventBus.on('ROUND_SETTLED', (d: any) => {
      console.log(`\n📊 ROUND #${d.roundNumber} SETTLED`);
      console.log(`   winners: ${d.winners.length}  losers: ${d.losers.length}`);
      console.log(`   total bets:   ${d.totalBets.toFixed(2)}`);
      console.log(`   total payout: ${d.totalPayout.toFixed(2)}`);
      console.log(`   net result:   ${d.netResult.toFixed(2)}`);
      for (const w of d.winners) {
        console.log(`   ✓ ${w.userId.padEnd(12)} bet ${w.amount}  → got ${w.payout.toFixed(2)} @ ${w.multiplier?.toFixed(2)}x`);
      }
      for (const l of d.losers) {
        console.log(`   ✗ ${l.userId.padEnd(12)} bet ${l.amount}  → lost`);
      }
    });
  }
}
