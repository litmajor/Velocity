import { GameEngine } from '../../src/core/game-engine';
import { FairnessEngine } from '../../src/core/fairness-engine';
import { BettingEngine } from '../../src/core/betting-engine';
import { SettlementEngine } from '../../src/core/settlement-engine';
import { WalletEngine } from '../../src/core/wallet-engine';
import { InMemoryBetRepository, InMemoryRoundRepository } from '../../src/core/repositories';
import { eventBus } from '../../src/runtime/event-bus';
import type { GameEvents } from '../../src/domains/game';

/** FairnessEngine stub that forces a fixed crash point (lifecycle/race tests). */
export class FixedCrashFairness extends FairnessEngine {
  constructor(private fixedCrash: number) {
    super();
  }
  allocateNextSeed(roundId: string, externalClientSeed?: string) {
    const a = super.allocateNextSeed(roundId, externalClientSeed);
    return { ...a, crashPoint: this.fixedCrash };
  }
}

export interface Rig {
  game: GameEngine;
  betting: BettingEngine;
  settlement: SettlementEngine;
  wallet: WalletEngine;
  betRepo: InMemoryBetRepository;
  roundRepo: InMemoryRoundRepository;
  fairness: FairnessEngine;
}

export function makeRig(opts?: { crashPoint?: number; fairness?: FairnessEngine }): Rig {
  const roundRepo = new InMemoryRoundRepository();
  const betRepo = new InMemoryBetRepository();
  const wallet = new WalletEngine();
  const fairness =
    opts?.fairness ?? (opts?.crashPoint ? new FixedCrashFairness(opts.crashPoint) : new FairnessEngine());
  const game = new GameEngine(eventBus, fairness, roundRepo);
  const betting = new BettingEngine(game, wallet, betRepo);
  const settlement = new SettlementEngine(game, betting, wallet, roundRepo);
  return { game, betting, settlement, wallet, betRepo, roundRepo, fairness };
}

/** Collect events of a given type emitted during the test. Returns handle to stop. */
export function collect<K extends keyof GameEvents>(event: K): { events: GameEvents[K][]; stop: () => void } {
  const events: GameEvents[K][] = [];
  const handler = (d: GameEvents[K]) => {
    events.push(d);
  };
  eventBus.on(event, handler);
  return { events, stop: () => eventBus.off(event, handler) };
}

/** ms of elapsed round time required for the multiplier to reach `target` (growth 0.000175/ms). */
export function msToReach(target: number): number {
  return Math.ceil(Math.log(target) / 0.000175);
}

/** Acquire and hold a bet lock until release() is called. */
export function holdBetLock(betting: BettingEngine, betId: string): { held: Promise<unknown>; release: () => void } {
  let release: () => void = () => {};
  const gate = new Promise<void>((res) => {
    release = res;
  });
  const held = betting.withBetLock(betId, () => gate);
  return { held, release };
}

export function flushMicrotasks(times = 10): Promise<void> {
  let p = Promise.resolve();
  for (let i = 0; i < times; i++) p = p.then(() => undefined);
  return p;
}
