import { eventBus } from './runtime/event-bus';
import './runtime/audit-log';
import { GameEngine } from './core/game-engine';
import { RoundScheduler } from './runtime/round-scheduler';
import { BettingEngine } from './core/betting-engine';
import { SettlementEngine } from './core/settlement-engine';
import { WebSocketGateway } from './runtime/websocket-gateway';
import { DebugSurface } from './surfaces/debug';
import { WalletEngine } from './core/wallet-engine';
import { FileBetRepository, FileRoundRepository } from './core/repositories';
import { RecoveryEngine } from './core/recovery-engine';
import { InstanceLock, InstanceLockError } from './runtime/instance-lock';
import { SettlementClaimStore } from './core/repositories/settlement-claim';
import type { BettingService } from './core/betting-service';
import path from 'path';

// ─── Bootstrap ────────────────────────────────────────────────────────────────

const bus = eventBus; // injectable bus for easier testing and isolation
const dataDir = path.resolve(process.cwd(), process.env.DATA_DIR ?? 'data');

// Single-writer deployment invariant: exactly one process may own a data
// directory. All in-memory guards (settlement, wallet, seed chain, scheduler)
// are only correct under this invariant, so it is enforced, not assumed.
let instanceLock: InstanceLock;
try {
  instanceLock = InstanceLock.acquire(dataDir);
} catch (err) {
  if (err instanceof InstanceLockError) {
    console.error(`[System] FATAL: ${err.message}`);
    process.exit(1);
  }
  throw err;
}

const roundRepo = new FileRoundRepository(path.join(dataDir, 'rounds'));
const betRepo = new FileBetRepository(path.join(dataDir, 'bets'));
const wallet = new WalletEngine({ ledgerPath: path.join(dataDir, 'wallet.ledger') });

const gameEngine = new GameEngine(bus, undefined, roundRepo);
const bettingEngine = new BettingEngine(gameEngine, wallet, betRepo);
const bettingService: BettingService = bettingEngine;
const settlementEngine = new SettlementEngine(
  gameEngine, bettingService, wallet, roundRepo,
  new SettlementClaimStore(path.join(dataDir, 'settlements')),
);
const scheduler = new RoundScheduler(gameEngine, bettingService, settlementEngine, { maxRounds: 10 });
const wsGateway = new WebSocketGateway(3001, gameEngine, bettingService);
const debugSurface = new DebugSurface(gameEngine, bettingService, { mode: 'auto' });
import { startAdminServer } from './runtime/admin-server';
startAdminServer(Number(process.env.ADMIN_PORT ?? 4001), gameEngine, bettingService);

void wsGateway; // silence unused

// seed wallets for two dev users (auto-seed)
wallet.ensureAccount('alice', 1000);
wallet.ensureAccount('bob', 500);
wallet.ensureAccount('charlie', 2000);
wallet.ensureAccount('dave', 150);
wallet.ensureAccount('eve', 100);

// Simulation driver (dev only) — isolates test logic from bootstrap
class SimulationDriver {
  private roundsSimulated = 0;
  private lastRoundId: string | null = null;
  private processed = new Set<string>();
  private bus: typeof eventBus;
  constructor(private betting: BettingService, busParam?: typeof eventBus, private opts?: {
    users?: string[];
    betAmounts?: Record<string, number>;
    cashoutTargets?: Record<string, number>;
  }) {
    this.bus = busParam ?? eventBus;
  }

  start(maxRounds = 10) {
    const users = this.opts?.users ?? ['alice', 'bob'];
    const betAmounts = this.opts?.betAmounts ?? { alice: 100, bob: 50 };
    const targets = this.opts?.cashoutTargets ?? { alice: 2.0, bob: 1.5 };

    this.bus.on('ROUND_STARTED', () => {
      this.roundsSimulated++;
      if (this.roundsSimulated > maxRounds) return;
      // place sample bets shortly after round start for configured users
      setTimeout(async () => {
        for (const u of users) {
          try { await this.betting.placeBet(u, betAmounts[u] ?? 50); } catch {}
        }
      }, 1_000);
    });

    // idempotent tick handler to trigger simple auto-cashouts
    this.bus.on('TICK_UPDATE' as any, async (event: any) => {
      const { multiplier, roundId } = event || {};
      if (!roundId) return;
      // ignore stale rounds
      if (this.lastRoundId && roundId !== this.lastRoundId) return;
      this.lastRoundId = roundId;

      const key = `${roundId}:${multiplier}`;
      if (this.processed.has(key)) return;
      this.processed.add(key);
      if (this.processed.size > 5000) this.processed.clear();

      try {
        const bets = await this.betting.getBetsForRound(roundId);
        const has = (userId: string) => bets.some((b: any) => b.userId === userId && b.status === 'ACTIVE');
        for (const u of users) {
          const target = targets[u] ?? targets[u.toLowerCase()] ?? null;
          if (target && multiplier >= target && has(u)) {
            try { await this.betting.cashout(u); } catch (e) {}
          }
        }
      } catch (e) {}
    });
  }
}

if (process.env.NODE_ENV !== 'production') {
  // configure simulation: two users and 10 rounds by default
  new SimulationDriver(bettingService, bus, {
    users: ['alice', 'bob'],
    betAmounts: { alice: 100, bob: 50 },
    cashoutTargets: { alice: 2.0, bob: 1.5 },
  }).start(10);
}

let roundsDone = 0;
bus.on('ROUND_SETTLED', () => {
  roundsDone++;
  if (roundsDone >= 10 && process.env.NODE_ENV !== 'production') {
    setTimeout(() => {
      console.log('\n[System] ✅ 10 rounds completed — simulation finished\n');
      void gracefulShutdown();
    }, 1_500);
  }
});

// start services — startup recovery MUST complete before new rounds begin
const recovery = new RecoveryEngine(wallet, betRepo, roundRepo);
recovery.recover()
  .then(report => {
    console.log('[Recovery]', {
      roundsRecovered: report.roundsRecovered.length,
      betsRefunded: report.betsRefunded.length,
      betsMarkedLost: report.betsMarkedLost.length,
      payoutsPaid: report.payoutsPaid.length,
      reservationsCommitted: report.reservationsCommitted.length,
      reservationsRolledBack: report.reservationsRolledBack.length,
      failures: report.failures,
    });
    debugSurface.start();
    return scheduler.start();
  })
  .catch(err => {
    // fail closed: corrupt persisted state must not be played through
    console.error('[System] Startup recovery / scheduler fatal error:', err);
    process.exit(1);
  });

// graceful shutdown
let shuttingDown = false;
async function gracefulShutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\n[System] shutting down...');
  try {
    await Promise.resolve(scheduler.stop?.());
    await Promise.resolve((settlementEngine as any)?.flush?.());
    await Promise.resolve((debugSurface as any)?.stop?.());
    // persist engine state
    try { await Promise.resolve((bettingService as any)?.persistTickLedger?.()); } catch (e) {}
    try { await Promise.resolve(((gameEngine as any).fairness as any)?.persistState?.()); } catch (e) {}
  } catch (err) {
    console.error('[Shutdown error]', err);
  }
  try { instanceLock.release(); } catch (e) {}
  process.exit(0);
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

// simple health guard
setInterval(() => {
  console.log('[HEALTH]', { uptime: process.uptime(), memory: process.memoryUsage(), roundsDone });
  bus.emit('SYSTEM_HEALTH' as any, { uptime: process.uptime(), roundsDone });
}, 5000);
