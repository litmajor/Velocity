import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { GameEngine } from '../src/core/game-engine';
import { BettingEngine } from '../src/core/betting-engine';
import { SettlementEngine } from '../src/core/settlement-engine';
import { WalletEngine } from '../src/core/wallet-engine';
import { FileBetRepository } from '../src/core/repositories/bet-repository';
import { FileRoundRepository } from '../src/core/repositories/round-repository';
import { FixedCrashFairness, msToReach } from './helpers/rig';

const CRASH = 2.0;

interface FileRig {
  game: GameEngine;
  betting: BettingEngine;
  settlement: SettlementEngine;
  wallet: WalletEngine;
  betRepo: FileBetRepository;
  roundRepo: FileRoundRepository;
}

function makeFileRig(betDir: string, roundDir: string): FileRig {
  const betRepo = new FileBetRepository(betDir);
  const roundRepo = new FileRoundRepository(roundDir);
  const wallet = new WalletEngine();
  const game = new GameEngine(undefined, new FixedCrashFairness(CRASH), roundRepo);
  const betting = new BettingEngine(game, wallet, betRepo);
  const settlement = new SettlementEngine(game, betting, wallet, roundRepo);
  return { game, betting, settlement, wallet, betRepo, roundRepo };
}

/**
 * "Restart" = construct brand-new engine instances pointing at the same
 * file-backed repositories. Everything held only in memory (game state,
 * wallet balances, reservations, indexes) is lost, exactly as it would be
 * on a process kill.
 */
describe('crash/restart recovery with file persistence', () => {
  let dir: string;
  let rig: FileRig;

  beforeEach(async () => {
    vi.useFakeTimers();
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'velocity-recovery-'));
    rig = makeFileRig(path.join(dir, 'bets'), path.join(dir, 'rounds'));
  });
  afterEach(async () => {
    try {
      rig.game.reset();
    } catch {}
    vi.useRealTimers();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('accepted bets are durably persisted as individual JSON files', async () => {
    rig.wallet.ensureAccount('alice', 100);
    rig.game.startBetting(1_000);
    const bet = await rig.betting.placeBet('alice', 25);
    const restarted = makeFileRig(path.join(dir, 'bets'), path.join(dir, 'rounds'));
    const recovered = await restarted.betRepo.get(bet.betId);
    expect(recovered).toBeTruthy();
    expect(recovered!.amount).toBe(25);
    expect(recovered!.status).toBe('ACTIVE');
  });

  // The fire-and-forget repo.save() completes on real I/O, so poll the file.
  async function waitForPhase(roundId: string, phase: string) {
    for (let i = 0; i < 200; i++) {
      const r = await rig.roundRepo.get(roundId); // each await crosses the event loop
      if (r?.phase === phase) return r;
    }
    return rig.roundRepo.get(roundId);
  }

  it('round state is persisted at each phase transition', async () => {
    rig.game.startBetting(1_000);
    const roundId = rig.game.getState()!.roundId;
    expect((await waitForPhase(roundId, 'BETTING'))?.phase).toBe('BETTING');
    rig.game.lockBets();
    expect((await waitForPhase(roundId, 'LOCKED'))?.phase).toBe('LOCKED');
    rig.game.startRound();
    await vi.advanceTimersByTimeAsync(msToReach(CRASH) + 200);
    expect((await waitForPhase(roundId, 'CRASHED'))?.phase).toBe('CRASHED');
    await rig.settlement.settle();
    expect((await waitForPhase(roundId, 'SETTLED'))?.phase).toBe('SETTLED');
  });

  it('DEFECT: wallet balances and reservations are memory-only and vanish on restart', async () => {
    rig.wallet.ensureAccount('alice', 100);
    rig.game.startBetting(1_000);
    await rig.betting.placeBet('alice', 25);
    expect(rig.wallet.getBalance('alice')).toBe(75);
    const restarted = makeFileRig(path.join(dir, 'bets'), path.join(dir, 'rounds'));
    // no wallet persistence exists at all: the 75 balance is gone
    expect(restarted.wallet.getBalance('alice')).toBe(0);
  });

  it('DEFECT: a kill mid-round orphans ACTIVE bets — no recovery path settles them', async () => {
    rig.wallet.ensureAccount('alice', 100);
    rig.game.startBetting(1_000);
    const bet = await rig.betting.placeBet('alice', 25);
    rig.game.lockBets();
    rig.game.startRound();
    await vi.advanceTimersByTimeAsync(200); // killed while RUNNING
    rig.game.reset(); // simulate process death (timers gone)

    const restarted = makeFileRig(path.join(dir, 'bets'), path.join(dir, 'rounds'));
    await vi.advanceTimersByTimeAsync(10);
    // the restarted GameEngine does not reload the persisted RUNNING round
    expect(restarted.game.getState()).toBeNull();
    // so settlement cannot run for it…
    await expect(restarted.settlement.settle()).rejects.toThrow(/expected CRASHED/);
    // …and the bet stays ACTIVE forever (stake already debited pre-kill)
    const orphan = await restarted.betRepo.get(bet.betId);
    expect(orphan!.status).toBe('ACTIVE');
  });

  it('DEFECT: settlement is not idempotent across a restart replay either', async () => {
    rig.wallet.ensureAccount('alice', 100);
    rig.game.startBetting(1_000);
    await rig.betting.placeBet('alice', 50);
    rig.game.lockBets();
    rig.game.startRound();
    await vi.advanceTimersByTimeAsync(msToReach(1.5));
    const out = await rig.betting.cashout('alice');
    await vi.advanceTimersByTimeAsync(msToReach(CRASH) + 200);
    await rig.settlement.settle();
    const afterFirst = rig.wallet.getBalance('alice');
    expect(afterFirst).toBeCloseTo(50 + out.payout!, 2);
    // a second settle (retry after partial failure / restart replay) must not pay again
    try {
      await rig.settlement.settle();
    } catch {}
    expect(rig.wallet.getBalance('alice')).toBeCloseTo(afterFirst, 2);
  });

  it('DOCUMENTED: bet/round file writes are not atomic (no temp-file + rename)', async () => {
    // Code-level property: FileBetRepository.save/FileRoundRepository.save use a
    // single writeFile; a kill mid-write can leave a truncated JSON file, which
    // get()/list() then silently treat as missing (catch → null/[]).
    const repo = new FileBetRepository(path.join(dir, 'bets'));
    await fs.mkdir(path.join(dir, 'bets'), { recursive: true });
    await fs.writeFile(path.join(dir, 'bets', 'torn.json'), '{"betId":"torn","amou'); // torn write
    expect(await repo.get('torn')).toBeNull(); // silently dropped, not surfaced
    expect(await repo.listByRound('any')).toEqual([]);
  });
});
