import { eventBus } from '../../runtime/event-bus';
import { ExposureEngine } from '../exposure-engine';
import type { SettledBet } from '../../domains/game';
import type { GameEngine }    from '../game-engine';
import type { BettingService } from '../betting-service';
import type { WalletEngine } from '../wallet-engine';
import type { RoundRepository } from '../repositories/round-repository';
import type { SettlementClaimStore } from '../repositories/settlement-claim';

// ─── SettlementEngine ─────────────────────────────────────────────────────────

export class SettlementEngine {
  // rounds already settled by this instance (durable check via roundRepo below)
  private settledRounds = new Set<string>();

  constructor(
    private gameEngine:    GameEngine,
    private bettingEngine: BettingService,
    private wallet?:       WalletEngine,
    private roundRepo?:    RoundRepository,
    private claims?:       SettlementClaimStore,
  ) {}

  async settle(): Promise<{ winners: SettledBet[]; losers: SettledBet[] }> {
    const state = this.gameEngine.getState();

    if (!state || (state.phase !== 'CRASHED' && state.phase !== 'SETTLED')) {
      throw new Error(`settle: expected CRASHED/SETTLED phase, got ${state?.phase ?? 'null'}`);
    }

    // Idempotency guard: a round must never be settled (and paid out) twice.
    if (this.settledRounds.has(state.roundId)) {
      throw new Error(`settle: round ${state.roundId} already settled`);
    }
    if (this.roundRepo) {
      const persisted = await this.roundRepo.get(state.roundId);
      if (persisted?.phase === 'SETTLED') {
        this.settledRounds.add(state.roundId);
        throw new Error(`settle: round ${state.roundId} already settled`);
      }
    }
    // Durable cross-process claim: at most one process may ever execute the
    // economic effects of settling this round, even if the in-memory guard
    // and the persisted-phase check above both raced.
    if (this.claims && !this.claims.claim(state.roundId)) {
      this.settledRounds.add(state.roundId);
      throw new Error(`settle: round ${state.roundId} already claimed for settlement`);
    }
    this.settledRounds.add(state.roundId);

    const bets    = await this.bettingEngine.getBetsForRound(state.roundId);
    const winners: SettledBet[] = [];
    const losers:  SettledBet[] = [];

    for (const bet of bets) {
      if (bet.status === 'CASHED_OUT') {
        // Credit winners now (payouts were recorded on cashout but not yet paid).
        // The credit carries the deterministic tx id `payout:<betId>` and the bet
        // is durably marked payoutPaid, so any retry (in-process or after a
        // restart) applies the money exactly once. A failed credit leaves the
        // bet durably identifiable as an unpaid winner (payoutPaid unset) and
        // is retried by startup recovery.
        if (this.wallet && bet.payout && !bet.payoutPaid) {
          try {
            this.wallet.ensureAccount(bet.userId);
            this.wallet.credit(bet.userId, bet.payout, `payout:${bet.betId}`);
            bet.payoutPaid = true;
            await this.bettingEngine.updateBet(bet);
          } catch (err) {
            console.error('[Settlement] failed to credit', bet.userId, err);
            eventBus.emit('EVENT_APPEND', {
              envelope: {
                event: 'PAYOUT_FAILED',
                data: { betId: bet.betId, userId: bet.userId, payout: bet.payout, error: (err as Error).message },
                timestamp: Date.now(),
              },
            });
          }
        }

        winners.push({
          betId:      bet.betId,
          userId:     bet.userId,
          amount:     bet.amount,
          payout:     bet.payout ?? 0,
          multiplier: bet.cashedOutMultiplier,
          won:        true,
        });
      } else if (bet.status === 'REFUNDED') {
        // stake already returned by recovery — not a winner, not a loser
        continue;
      } else {
        // ACTIVE bets that didn't cash out before crash → LOST
        // perform atomic update per-bet to avoid races with cashout
        try {
          await this.bettingEngine.withBetLock(bet.betId, async () => {
            const fresh = await this.bettingEngine.getBet(bet.betId);
            if (!fresh) return;
            if (fresh.status === 'CASHED_OUT' || fresh.resolved) return;
            fresh.status = 'LOST';
            fresh.payout = 0;
            fresh.resolved = true;
            await this.bettingEngine.updateBet(fresh as any);
          });
        } catch (err) {
          console.error('[Settlement] failed to persist bet status', bet.betId, err);
        }
        // report loss to volatility engine
        try { this.gameEngine.recordLoss(bet.amount); } catch (e) {}
        // update per-user behavior metrics (loss)
        try { (this.bettingEngine as any).userBehavior?.recordLoss(bet.userId, bet.amount); } catch (e) {}
        losers.push({
          betId:  bet.betId,
          userId: bet.userId,
          amount: bet.amount,
          payout: 0,
          won:    false,
        });
      }
    }

    const totalBets   = bets.reduce((sum, b) => sum + b.amount, 0);
    const totalPayout = winners.reduce((sum, w) => sum + w.payout, 0);
    const netResult   = totalBets - totalPayout; // can be negative if house loses

    // Compute final exposure snapshot for auditing and downstream steering
    const exposureEngine = new ExposureEngine();
    const exposure = exposureEngine.computeSnapshot(bets);

      // Do not mutate the frozen snapshot returned by gameEngine.getState();
      // create a shallow mutable copy for persistence and emission.
      const persistedState: any = { ...(state as any) };
      persistedState.exposure = exposure;
      persistedState.phase = 'SETTLED';

    // persist settled state
    if (this.roundRepo) await this.roundRepo.save(persistedState as any);

    eventBus.emit('ROUND_SETTLED', {
      roundId:     persistedState.roundId,
      roundNumber: persistedState.roundNumber,
      winners,
      losers,
      totalBets,
      totalPayout,
      netResult,
      exposure,
    });

    return { winners, losers };
  }
}
