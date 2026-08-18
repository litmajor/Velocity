/**
 * Child-process worker for two-instance tests. Spawned (via tsx) by
 * multi-instance/crash-injection tests as a REAL separate OS process sharing
 * a persistence directory with a sibling worker, so races and kills are
 * genuine, not simulated.
 *
 * Usage: tsx test/helpers/instance-worker.ts '<json args>'
 * Args: { dir, action, ...action-specific fields }
 * Every action prints exactly one JSON line to stdout (unless killed).
 */
import fs from 'fs';
import path from 'path';

const args = JSON.parse(process.argv[2] ?? '{}') as {
  dir: string;
  action: string;
  roundId?: string;
  userId?: string;
  count?: number;
  holdMs?: number;
  barrier?: string;   // path of a file to wait for before acting (start-line sync)
  readyFile?: string; // path of a file to create once ready and waiting
  killAt?: 'after-claim' | 'after-credit';
};

process.env.DATA_DIR = args.dir;

function out(obj: unknown) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

async function waitForBarrier() {
  if (args.readyFile) fs.writeFileSync(args.readyFile, '1');
  if (!args.barrier) return;
  while (!fs.existsSync(args.barrier)) {
    await new Promise(res => setTimeout(res, 2));
  }
}

async function main() {
  switch (args.action) {
    case 'lock-hold': {
      const { InstanceLock, InstanceLockError } = await import('../../src/runtime/instance-lock');
      await waitForBarrier();
      try {
        const lock = InstanceLock.acquire(args.dir);
        out({ ok: true, pid: process.pid });
        await new Promise(res => setTimeout(res, args.holdMs ?? 500));
        lock.release();
      } catch (err) {
        if (err instanceof InstanceLockError) out({ ok: false, error: 'locked' });
        else throw err;
      }
      return;
    }

    case 'lock-die': {
      const { InstanceLock } = await import('../../src/runtime/instance-lock');
      InstanceLock.acquire(args.dir);
      out({ ok: true, pid: process.pid });
      // die without releasing: leaves a stale lock behind
      process.kill(process.pid, 'SIGKILL');
      return;
    }

    case 'claim': {
      const { SettlementClaimStore } = await import('../../src/core/repositories/settlement-claim');
      const store = new SettlementClaimStore(path.join(args.dir, 'settlements'));
      await waitForBarrier();
      out({ ok: true, claimed: store.claim(args.roundId!) });
      return;
    }

    case 'settle': {
      const { WalletEngine } = await import('../../src/core/wallet-engine');
      const { BettingEngine } = await import('../../src/core/betting-engine');
      const { SettlementEngine } = await import('../../src/core/settlement-engine');
      const { FileBetRepository } = await import('../../src/core/repositories/bet-repository');
      const { FileRoundRepository } = await import('../../src/core/repositories/round-repository');
      const { SettlementClaimStore } = await import('../../src/core/repositories/settlement-claim');

      const roundRepo = new FileRoundRepository(path.join(args.dir, 'rounds'));
      const betRepo = new FileBetRepository(path.join(args.dir, 'bets'));
      const wallet = new WalletEngine({ ledgerPath: path.join(args.dir, 'wallet.ledger') });
      const round = await roundRepo.get(args.roundId!);
      if (!round) { out({ ok: false, error: 'round not found' }); return; }
      // minimal GameEngine stand-in: settlement only reads state / records losses
      const gameStub = { getState: () => round, recordLoss: (_: number) => {} };
      const betting = new BettingEngine(gameStub as any, wallet, betRepo);
      const claims = new SettlementClaimStore(path.join(args.dir, 'settlements'));
      const settlement = new SettlementEngine(gameStub as any, betting, wallet, roundRepo, claims);

      if (args.killAt === 'after-claim') {
        const orig = claims.claim.bind(claims);
        claims.claim = (roundId: string) => {
          const r = orig(roundId);
          if (r) process.kill(process.pid, 'SIGKILL'); // die right after claiming
          return r;
        };
      }
      if (args.killAt === 'after-credit') {
        const orig = wallet.credit.bind(wallet);
        let credited = false;
        wallet.credit = (userId: string, amount: number, txId?: string) => {
          const r = orig(userId, amount, txId);
          if (!credited) { credited = true; process.kill(process.pid, 'SIGKILL'); }
          return r;
        };
      }

      await waitForBarrier();
      try {
        const result = await settlement.settle();
        out({ ok: true, winners: result.winners.length, losers: result.losers.length });
      } catch (err) {
        out({ ok: false, error: (err as Error).message });
      }
      wallet.close();
      process.exit(0);
    }

    case 'recover': {
      // mirrors production bootstrap: recovery only runs under the instance lock
      const { InstanceLock, InstanceLockError } = await import('../../src/runtime/instance-lock');
      const { WalletEngine } = await import('../../src/core/wallet-engine');
      const { RecoveryEngine } = await import('../../src/core/recovery-engine');
      const { FileBetRepository } = await import('../../src/core/repositories/bet-repository');
      const { FileRoundRepository } = await import('../../src/core/repositories/round-repository');
      await waitForBarrier();
      let lock;
      try {
        lock = InstanceLock.acquire(args.dir);
      } catch (err) {
        if (err instanceof InstanceLockError) { out({ ok: false, error: 'locked' }); return; }
        throw err;
      }
      const roundRepo = new FileRoundRepository(path.join(args.dir, 'rounds'));
      const betRepo = new FileBetRepository(path.join(args.dir, 'bets'));
      const wallet = new WalletEngine({ ledgerPath: path.join(args.dir, 'wallet.ledger') });
      const recovery = new RecoveryEngine(wallet, betRepo, roundRepo);
      try {
        const report = await recovery.recover();
        out({
          ok: true,
          payoutsPaid: report.payoutsPaid,
          betsRefunded: report.betsRefunded,
          balances: { [args.userId ?? 'alice']: wallet.getBalance(args.userId ?? 'alice') },
        });
      } catch (err) {
        out({ ok: false, error: (err as Error).message });
      }
      if (args.holdMs) await new Promise(res => setTimeout(res, args.holdMs));
      wallet.close();
      lock.release();
      process.exit(0);
    }

    case 'allocate': {
      const { FairnessEngine } = await import('../../src/core/fairness-engine');
      const engine = new FairnessEngine();
      await waitForBarrier();
      const commits: string[] = [];
      for (let i = 0; i < (args.count ?? 4); i++) {
        const alloc = engine.allocateNextSeed(`${process.pid}-round-${i}`);
        commits.push(alloc.serverHash);
      }
      out({ ok: true, commits });
      return;
    }

    default:
      out({ ok: false, error: `unknown action ${args.action}` });
      process.exitCode = 1;
  }
}

main().catch(err => {
  out({ ok: false, error: (err as Error).message });
  process.exit(1);
});
