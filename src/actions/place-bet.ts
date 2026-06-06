import { BettingEngine } from '../core/betting-engine';
import { Bet } from '../domains/betting';

export class PlaceBetAction {
  constructor(private engine: BettingEngine) {}

  async execute(bet: Bet) {
    // validate / authorize (MVP: skip auth)
    return this.engine.placeBet(bet.userId, bet.amount as number);
  }
}
