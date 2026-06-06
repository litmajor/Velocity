export interface UserProfile {
  userId: string;
  totalBets: number;
  totalCashouts: number;
  avgCashoutMultiplier: number;
  avgBetSize: number;
  lossStreak: number;
  lossStreakSensitivity: number;
  betSizeGrowth: number;
}

export class UserBehaviorEngine {
  private profiles = new Map<string, {
    totalBets: number;
    totalCashouts: number;
    sumCashoutMultiplier: number;
    lastCashMultipliers: number[];
    lastBets: number[];
    lossStreak: number;
    lossSensitivityEwma: number;
  }>();

  recordBet(userId: string, amount: number) {
    const p = this.profiles.get(userId) ?? { totalBets: 0, totalCashouts: 0, sumCashoutMultiplier: 0, lastCashMultipliers: [], lastBets: [], lossStreak: 0, lossSensitivityEwma: 0 };
    p.totalBets += 1;
    p.lastBets.push(amount);
    if (p.lastBets.length > 20) p.lastBets.shift();
    this.profiles.set(userId, p);
  }

  recordCashout(userId: string, multiplier: number, payout: number) {
    const p = this.profiles.get(userId) ?? { totalBets: 0, totalCashouts: 0, sumCashoutMultiplier: 0, lastCashMultipliers: [], lastBets: [], lossStreak: 0, lossSensitivityEwma: 0 };
    p.totalCashouts += 1;
    p.sumCashoutMultiplier += multiplier;
    p.lastCashMultipliers.push(multiplier);
    if (p.lastCashMultipliers.length > 50) p.lastCashMultipliers.shift();
    // reset loss streak on cashout (win)
    p.lossStreak = 0;
    // nudge sensitivity EWMA downward
    p.lossSensitivityEwma = p.lossSensitivityEwma * 0.9;
    this.profiles.set(userId, p);
  }

  recordLoss(userId: string, amount: number) {
    const p = this.profiles.get(userId) ?? { totalBets: 0, totalCashouts: 0, sumCashoutMultiplier: 0, lastCashMultipliers: [], lastBets: [], lossStreak: 0, lossSensitivityEwma: 0 };
    p.lossStreak += 1;
    // increase sensitivity EWMA
    p.lossSensitivityEwma = p.lossSensitivityEwma * 0.9 + p.lossStreak * 0.1;
    this.profiles.set(userId, p);
  }

  getProfile(userId: string): UserProfile {
    const p = this.profiles.get(userId) ?? { totalBets: 0, totalCashouts: 0, sumCashoutMultiplier: 0, lastCashMultipliers: [], lastBets: [], lossStreak: 0, lossSensitivityEwma: 0 };
    const avgCash = p.totalCashouts ? p.sumCashoutMultiplier / p.totalCashouts : 0;
    const avgBet = p.lastBets.length ? p.lastBets.reduce((a,b) => a+b, 0) / p.lastBets.length : 0;

    // compute simple bet size growth: compare last 5 vs previous 5
    let growth = 1;
    if (p.lastBets.length >= 10) {
      const last5 = p.lastBets.slice(-5);
      const prev5 = p.lastBets.slice(-10, -5);
      const avgLast5 = last5.reduce((a,b) => a+b,0)/last5.length;
      const avgPrev5 = prev5.reduce((a,b) => a+b,0)/prev5.length || 1;
      growth = avgPrev5 > 0 ? avgLast5 / avgPrev5 : 1;
    }

    return {
      userId,
      totalBets: p.totalBets,
      totalCashouts: p.totalCashouts,
      avgCashoutMultiplier: Math.round(avgCash * 100) / 100,
      avgBetSize: Math.round(avgBet * 100) / 100,
      lossStreak: p.lossStreak,
      lossStreakSensitivity: Math.round(p.lossSensitivityEwma * 100) / 100,
      betSizeGrowth: Math.round(growth * 100) / 100,
    };
  }

  // Optionally expose all profiles (admin)
  listProfiles(): UserProfile[] {
    return Array.from(this.profiles.keys()).map(k => this.getProfile(k));
  }
}

export default UserBehaviorEngine;
