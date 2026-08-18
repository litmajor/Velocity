// Game domain reducer (SSA /domains layer): the single place where client
// events mutate the normalized GameView. Surfaces only read the result.

import type { GameView, RoundHistoryEntry } from '../../core/types.js';
import { initialGameView } from '../../core/types.js';
import type { ClientGameEvent } from './events.js';

const HISTORY_LIMIT = 20;
const TX_LIMIT = 12;
const CURVE_LIMIT = 600;

export { initialGameView };

export function reduceGameView(state: GameView, ev: ClientGameEvent): GameView {
  switch (ev.type) {
    case 'CLOCK_TICKED':
      return { ...state, now: ev.now };

    case 'CONNECTION_CHANGED':
      return { ...state, connection: ev.status };

    case 'ROUND_STARTED':
      return {
        ...state,
        round: {
          roundId: ev.roundId,
          roundNumber: ev.roundNumber,
          phase: 'BETTING',
          multiplier: 1,
          crashPoint: null,
          bettingEndsAt: ev.bettingEndsAt,
          curve: [1],
        },
        players: [],
        fairness: {
          serverHash: ev.serverHash,
          clientSeed: ev.clientSeed,
          nonce: ev.nonce,
          paramsCommit: ev.paramsCommit,
          serverSeed: null,
          volatilitySnapshot: null,
          shapingParams: null,
          proofCrashPoint: null,
        },
        myBet: { status: 'NONE', stake: 0, autoCashout: null, cashedOutMultiplier: null, payout: null },
        lastActionError: null,
      };

    case 'ROUND_LOCKED':
      return { ...state, round: { ...state.round, phase: 'LOCKED' } };

    case 'ROUND_RUNNING':
      return { ...state, round: { ...state.round, phase: 'RUNNING' } };

    case 'MULTIPLIER_UPDATED': {
      if (ev.roundId !== state.round.roundId) return state;
      const curve = state.round.curve.length >= CURVE_LIMIT
        ? [...state.round.curve.slice(1), ev.multiplier]
        : [...state.round.curve, ev.multiplier];
      return { ...state, round: { ...state.round, multiplier: ev.multiplier, curve } };
    }

    case 'ROUND_CRASHED': {
      if (ev.roundId !== state.round.roundId) return state;
      const myBet = state.myBet.status === 'ACTIVE'
        ? { ...state.myBet, status: 'LOST' as const, payout: 0 }
        : state.myBet;
      return {
        ...state,
        round: { ...state.round, phase: 'CRASHED', multiplier: ev.crashPoint, crashPoint: ev.crashPoint },
        players: state.players.map((p) => (p.status === 'ACTIVE' ? { ...p, status: 'LOST', payout: 0 } : p)),
        fairness: {
          ...state.fairness,
          serverSeed: ev.serverSeed,
          shapingParams: ev.shapingParams,
          volatilitySnapshot: ev.volatilitySnapshot,
          proofCrashPoint: ev.crashPoint,
        },
        myBet,
      };
    }

    case 'ROUND_SETTLED': {
      if (ev.roundId !== state.round.roundId) return state;
      const entry: RoundHistoryEntry = {
        roundId: state.round.roundId ?? '',
        roundNumber: state.round.roundNumber,
        crashPoint: state.round.crashPoint ?? state.round.multiplier,
        endedAt: state.now,
        status: 'SETTLED',
        fairnessAvailable: state.fairness.serverSeed !== null,
      };
      return {
        ...state,
        round: { ...state.round, phase: 'SETTLED' },
        history: [entry, ...state.history].slice(0, HISTORY_LIMIT),
      };
    }

    case 'PLAYERS_UPDATED':
      return { ...state, players: ev.players };

    case 'WALLET_BALANCE_UPDATED':
      return { ...state, wallet: { ...state.wallet, balance: ev.balance } };

    case 'WALLET_TRANSACTION_APPENDED':
      return {
        ...state,
        wallet: {
          ...state.wallet,
          transactions: [
            { id: ev.id, kind: ev.kind, amount: ev.amount, ts: ev.ts },
            ...state.wallet.transactions,
          ].slice(0, TX_LIMIT),
        },
      };

    case 'BET_ACCEPTED':
      return {
        ...state,
        wallet: { ...state.wallet, activeWager: ev.stake },
        myBet: { status: 'ACTIVE', stake: ev.stake, autoCashout: ev.autoCashout, cashedOutMultiplier: null, payout: null },
        lastActionError: null,
      };

    case 'BET_REJECTED':
      return {
        ...state,
        myBet: state.myBet.status === 'PENDING'
          ? { ...state.myBet, status: 'NONE' }
          : state.myBet,
        lastActionError: ev.reason,
      };

    case 'CASHOUT_ACCEPTED':
      return {
        ...state,
        wallet: { ...state.wallet, activeWager: 0 },
        myBet: { ...state.myBet, status: 'CASHED_OUT', cashedOutMultiplier: ev.multiplier, payout: ev.payout },
        lastActionError: null,
      };

    case 'CASHOUT_REJECTED':
      return { ...state, lastActionError: ev.reason };
  }
}
