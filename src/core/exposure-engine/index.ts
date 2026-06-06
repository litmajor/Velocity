import type { Bet } from '../../domains/game';

export interface ExposureSnapshot {
  roundId: string;
  totalBets: number;
  totalLiability: number;
}

export class ExposureEngine {
  // default assumed max multiplier for open bets without autoCashout
  private assumedMaxMultiplier = 100;

  computeSnapshot(bets: Bet[]): ExposureSnapshot {
    const totalBets = bets.reduce((s, b) => s + b.amount, 0);
    const totalLiability = bets.reduce((s, b) => {
      if (b.status === 'CASHED_OUT') return s + (b.payout ?? 0);
      const multiplier = b.autoCashout ?? this.assumedMaxMultiplier;
      return s + Math.floor(b.amount * multiplier * 100) / 100;
    }, 0);

    return { roundId: bets[0]?.roundId ?? 'unknown', totalBets, totalLiability };
  }

  setAssumedMaxMultiplier(m: number) { this.assumedMaxMultiplier = m; }
}

export default ExposureEngine;
