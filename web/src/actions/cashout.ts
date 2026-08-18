// CashoutAction (SSA /actions layer).

import type { GameView } from '../core/types.js';
import type { GameClient } from '../runtime/game-client.js';

export type CashoutPreflight =
  | { ok: true }
  | { ok: false; code: 'NO_ACTIVE_BET' | 'NOT_RUNNING' | 'ROUND_CRASHED'; message: string };

export function preflightCashout(state: GameView): CashoutPreflight {
  if (state.myBet.status !== 'ACTIVE') {
    return { ok: false, code: 'NO_ACTIVE_BET', message: 'No active bet to cash out' };
  }
  if (state.round.phase === 'CRASHED' || state.round.phase === 'SETTLED') {
    return { ok: false, code: 'ROUND_CRASHED', message: 'Round already crashed' };
  }
  if (state.round.phase !== 'RUNNING') {
    return { ok: false, code: 'NOT_RUNNING', message: 'Cashout available once the round is running' };
  }
  return { ok: true };
}

export function executeCashout(client: GameClient, pre: CashoutPreflight): void {
  if (!pre.ok) return;
  client.cashout();
}
