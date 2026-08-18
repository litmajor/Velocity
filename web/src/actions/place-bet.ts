// PlaceBetAction (SSA /actions layer): preflight validation lives here, not
// in the BetPanel surface. The surface renders the preflight verdict and
// delegates execution.

import type { GameView } from '../core/types.js';
import type { GameClient } from '../runtime/game-client.js';

export type BetPreflight =
  | { ok: true; stake: number; autoCashout: number | null }
  | { ok: false; code: 'INVALID_AMOUNT' | 'INSUFFICIENT_BALANCE' | 'BETTING_CLOSED' | 'ALREADY_BET' | 'INVALID_AUTO_CASHOUT'; message: string };

export function preflightPlaceBet(
  state: GameView,
  rawStake: string,
  autoEnabled: boolean,
  rawAuto: string,
): BetPreflight {
  const stake = Number(rawStake);
  if (!Number.isFinite(stake) || stake < 0.01) {
    return { ok: false, code: 'INVALID_AMOUNT', message: 'Enter a stake of at least 0.01' };
  }
  if (stake > state.wallet.balance) {
    return { ok: false, code: 'INSUFFICIENT_BALANCE', message: 'Insufficient balance' };
  }
  if (state.round.phase !== 'BETTING') {
    return { ok: false, code: 'BETTING_CLOSED', message: 'Betting is closed' };
  }
  if (state.myBet.status === 'ACTIVE' || state.myBet.status === 'PENDING') {
    return { ok: false, code: 'ALREADY_BET', message: 'You already have a bet this round' };
  }
  let autoCashout: number | null = null;
  if (autoEnabled) {
    autoCashout = Number(rawAuto);
    if (!Number.isFinite(autoCashout) || autoCashout < 1.01) {
      return { ok: false, code: 'INVALID_AUTO_CASHOUT', message: 'Auto-cashout must be at least 1.01\u00d7' };
    }
  }
  return { ok: true, stake: Math.floor(stake * 100) / 100, autoCashout };
}

export function executePlaceBet(client: GameClient, pre: BetPreflight): void {
  if (!pre.ok) return;
  client.placeBet(pre.stake, pre.autoCashout);
}
