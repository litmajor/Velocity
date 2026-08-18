// Normalized client-side game events (SSA /domains layer).
// A GameClient (WebSocket or mock) translates transport messages into these;
// surfaces never see raw socket payloads. Names follow the backend's
// GameEvents (src/domains/game/types.ts) DOMAIN_NOUN_VERB convention.

import type { PlayerRow, RoundPhase } from '../../core/types.js';

export type ClientGameEvent =
  | {
      type: 'ROUND_STARTED';
      roundId: string;
      roundNumber: number;
      serverHash: string;
      paramsCommit: string | null;
      clientSeed: string;
      nonce: number;
      bettingEndsAt: number;
    }
  | { type: 'ROUND_LOCKED'; roundId: string }
  | { type: 'ROUND_RUNNING'; roundId: string }
  | { type: 'MULTIPLIER_UPDATED'; roundId: string; multiplier: number }
  | {
      type: 'ROUND_CRASHED';
      roundId: string;
      crashPoint: number;
      serverSeed: string;
      shapingParams: unknown;
      volatilitySnapshot: unknown;
    }
  | { type: 'ROUND_SETTLED'; roundId: string }
  | { type: 'PLAYERS_UPDATED'; players: PlayerRow[] }
  | { type: 'WALLET_BALANCE_UPDATED'; balance: number }
  | {
      type: 'WALLET_TRANSACTION_APPENDED';
      id: string;
      kind: 'BET' | 'PAYOUT' | 'REFUND' | 'DEPOSIT';
      amount: number;
      ts: number;
    }
  | { type: 'BET_ACCEPTED'; stake: number; autoCashout: number | null }
  | { type: 'BET_REJECTED'; reason: string }
  | { type: 'CASHOUT_ACCEPTED'; multiplier: number; payout: number }
  | { type: 'CASHOUT_REJECTED'; reason: string }
  | { type: 'CONNECTION_CHANGED'; status: 'MOCK' | 'CONNECTING' | 'CONNECTED' | 'DISCONNECTED' }
  | { type: 'CLOCK_TICKED'; now: number };

export type PhaseEvent = Extract<ClientGameEvent, { type: `ROUND_${string}` }>;

export const PHASE_BY_EVENT: Partial<Record<ClientGameEvent['type'], RoundPhase>> = {
  ROUND_STARTED: 'BETTING',
  ROUND_LOCKED: 'LOCKED',
  ROUND_RUNNING: 'RUNNING',
  ROUND_CRASHED: 'CRASHED',
  ROUND_SETTLED: 'SETTLED',
};
