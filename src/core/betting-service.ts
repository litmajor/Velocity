export interface UserBehaviorFacade {
  recordLoss?(userId: string, amount: number): void;
  recordCashout?(userId: string, multiplier: number, payout: number): void;
  recordBet?(userId: string, amount: number): void;
  getProfile?(userId: string): any;
  listProfiles?(): any[];
}

export interface BettingService {
  placeBet(userId: string, amount: number): Promise<any>;
  cashout(userId: string): Promise<any>;
  getBetsForRound(roundId: string): Promise<any[]>;
  getBet(betId: string): Promise<any | null>;
  updateBet(bet: any): Promise<void>;
  withBetLock<T>(betId: string, fn: () => Promise<T>): Promise<T>;
  // optional behavior facade for telemetry
  userBehavior?: UserBehaviorFacade | null;
}

export default BettingService;
