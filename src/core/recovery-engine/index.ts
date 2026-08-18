import type { WalletEngine } from '../wallet-engine';
import type { BetRepository } from '../repositories/bet-repository';
import type { RoundRepository } from '../repositories/round-repository';
import type { Bet, RoundState } from '../../domains/game';

export interface RecoveryReport {
  roundsRecovered: string[];
  betsRefunded: string[];
  betsMarkedLost: string[];
  payoutsPaid: string[];
  reservationsCommitted: string[];
  reservationsRolledBack: string[];
  failures: { id: string; error: string }[];
}

/**
 * Startup recovery: reconciles durable wallet, bet and round state after a
 * process failure, per the policy in docs/RECOVERY.md.
 *
 * Idempotent by construction: every action is conditioned on durable state
 * (bet status, payoutPaid markers, reservation existence) and every money
 * movement uses a deterministic wallet tx id (`payout:<betId>`,
 * `refund:<betId>`), so running recovery N times equals running it once.
 *
 * Corrupt persistence files fail closed: the underlying repositories throw
 * CorruptStateError, which propagates out of recover() rather than being
 * treated as missing state.
 */
export class RecoveryEngine {
  constructor(
    private wallet: WalletEngine,
    private betRepo: BetRepository,
    private roundRepo: RoundRepository,
  ) {}

  async recover(): Promise<RecoveryReport> {
    const report: RecoveryReport = {
      roundsRecovered: [],
      betsRefunded: [],
      betsMarkedLost: [],
      payoutsPaid: [],
      reservationsCommitted: [],
      reservationsRolledBack: [],
      failures: [],
    };

    const rounds = await this.roundRepo.list();
    rounds.sort((a, b) => a.roundNumber - b.roundNumber);

    for (const round of rounds) {
      try {
        await this.recoverRound(round, report);
      } catch (err) {
        report.failures.push({ id: round.roundId, error: (err as Error).message });
      }
    }

    // Reservation reconciliation runs last: any still-open reservation
    // `bet:<betId>` is either an orphan (no bet file: crash between reserve
    // and bet save -> rollback), belongs to a refunded bet (-> rollback), or
    // belongs to an existing bet whose commit was interrupted (-> commit).
    for (const res of this.wallet.listReservations()) {
      if (!res.id.startsWith('bet:')) continue;
      const betId = res.id.slice('bet:'.length);
      try {
        const bet = await this.betRepo.get(betId);
        if (!bet || bet.status === 'REFUNDED') {
          this.wallet.rollback(res.id);
          report.reservationsRolledBack.push(res.id);
        } else {
          this.wallet.commit(res.id);
          report.reservationsCommitted.push(res.id);
        }
      } catch (err) {
        report.failures.push({ id: res.id, error: (err as Error).message });
      }
    }

    return report;
  }

  private async recoverRound(round: RoundState, report: RecoveryReport): Promise<void> {
    const bets = await this.betRepo.listByRound(round.roundId);

    if (round.phase === 'SETTLED') {
      // Reconcile only: retry unpaid winners; a stray ACTIVE bet in a settled
      // round lost (stake was captured, round completed without a cashout).
      for (const bet of bets) {
        if (bet.status === 'CASHED_OUT') await this.payIfUnpaid(bet, report);
        else if (bet.status === 'ACTIVE') await this.markLost(bet, report);
      }
      return;
    }

    if (round.phase === 'CRASHED') {
      // Outcome is known: complete the settlement deterministically.
      for (const bet of bets) {
        if (bet.status === 'CASHED_OUT') await this.payIfUnpaid(bet, report);
        else if (bet.status === 'ACTIVE') await this.markLost(bet, report);
      }
      await this.markRoundRecovered(round, 'completed settlement of CRASHED round', report);
      return;
    }

    // BETTING / LOCKED / RUNNING: the round is void. Cashouts recorded before
    // the failure are honored (money is owed); remaining ACTIVE stakes are
    // refunded because the outcome cannot be reconstructed.
    for (const bet of bets) {
      if (bet.status === 'CASHED_OUT') await this.payIfUnpaid(bet, report);
      else if (bet.status === 'ACTIVE') await this.refund(bet, report);
    }
    await this.markRoundRecovered(round, `voided interrupted ${round.phase} round`, report);
  }

  /** Exactly-once payout: wallet dedupes on `payout:<betId>`, bet marks payoutPaid. */
  private async payIfUnpaid(bet: Bet, report: RecoveryReport): Promise<void> {
    if (bet.payoutPaid || !bet.payout) return;
    try {
      this.wallet.ensureAccount(bet.userId);
      const applied = this.wallet.credit(bet.userId, bet.payout, `payout:${bet.betId}`);
      bet.payoutPaid = true;
      await this.betRepo.update(bet);
      if (applied) report.payoutsPaid.push(bet.betId);
    } catch (err) {
      report.failures.push({ id: bet.betId, error: (err as Error).message });
    }
  }

  /** Exactly-once refund: rollback if the stake was never captured, else credit `refund:<betId>`. */
  private async refund(bet: Bet, report: RecoveryReport): Promise<void> {
    try {
      const resId = bet.reservationId ?? `bet:${bet.betId}`;
      if (this.wallet.hasReservation(resId)) {
        // stake never captured: releasing the hold IS the refund
        this.wallet.rollback(resId);
        report.reservationsRolledBack.push(resId);
      } else if (this.wallet.wasRolledBack(resId)) {
        // hold already released (e.g. earlier interrupted recovery run):
        // no money ever moved, so crediting here would mint funds
      } else {
        // stake was captured (committed), or predates the durable ledger:
        // return it via an exactly-once credit
        this.wallet.ensureAccount(bet.userId);
        this.wallet.credit(bet.userId, bet.amount, `refund:${bet.betId}`);
      }
      bet.status = 'REFUNDED';
      bet.payout = 0;
      bet.resolved = true;
      await this.betRepo.update(bet);
      report.betsRefunded.push(bet.betId);
    } catch (err) {
      report.failures.push({ id: bet.betId, error: (err as Error).message });
    }
  }

  private async markLost(bet: Bet, report: RecoveryReport): Promise<void> {
    try {
      bet.status = 'LOST';
      bet.payout = 0;
      bet.resolved = true;
      await this.betRepo.update(bet);
      report.betsMarkedLost.push(bet.betId);
    } catch (err) {
      report.failures.push({ id: bet.betId, error: (err as Error).message });
    }
  }

  private async markRoundRecovered(round: RoundState, action: string, report: RecoveryReport): Promise<void> {
    const settled: RoundState = { ...round, phase: 'SETTLED', recovered: true, recoveryAction: action };
    await this.roundRepo.save(settled);
    report.roundsRecovered.push(round.roundId);
  }
}
