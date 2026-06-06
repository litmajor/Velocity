import { BettingEngine } from '../core/betting-engine';

export class CashoutAction {
  constructor(private engine: BettingEngine) {}

  execute(userId: string) {
    // minimal stub
    return { userId };
  }
}
