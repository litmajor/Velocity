// AutoCashoutAction (SSA /actions layer): client-side auto-cashout. The
// backend accepts plain (userId, amount) bets, so the auto-cashout target is
// enforced here against real tick state: when the authoritative multiplier
// reaches the target, a normal CASHOUT command is issued. The server still
// decides the actual cashout multiplier.

import type { GameStore } from '../runtime/store.js';
import type { GameClient } from '../runtime/game-client.js';

export function installAutoCashout(store: GameStore, client: GameClient): () => void {
  let firedForRound: string | null = null;

  return store.subscribe((state) => {
    const { myBet, round } = state;
    if (
      myBet.status === 'ACTIVE' &&
      myBet.autoCashout !== null &&
      round.phase === 'RUNNING' &&
      round.roundId !== null &&
      round.multiplier >= myBet.autoCashout &&
      firedForRound !== round.roundId
    ) {
      firedForRound = round.roundId;
      client.cashout();
    }
  });
}
