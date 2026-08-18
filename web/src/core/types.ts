// Pure state models for the player UI. Framework-free (SSA /core layer).
// These mirror the backend's published/normalized shapes (src/domains/game/types.ts)
// but contain only data safe to show a player.

export type RoundPhase = 'BETTING' | 'LOCKED' | 'RUNNING' | 'CRASHED' | 'SETTLED';

export type PlayerStatus = 'ACTIVE' | 'CASHED_OUT' | 'LOST';

export interface PlayerRow {
  userId: string;
  stake: number;
  autoCashout: number | null;
  status: PlayerStatus;
  cashedOutMultiplier: number | null;
  payout: number | null;
}

export interface RoundHistoryEntry {
  roundId: string;
  roundNumber: number;
  crashPoint: number;
  endedAt: number;
  status: 'SETTLED' | 'CRASHED';
  fairnessAvailable: boolean;
}

export interface WalletTransaction {
  id: string;
  kind: 'BET' | 'PAYOUT' | 'REFUND' | 'DEPOSIT';
  amount: number; // signed: negative = debit
  ts: number;
}

export interface WalletView {
  balance: number;
  activeWager: number;
  transactions: WalletTransaction[];
}

export interface FairnessView {
  serverHash: string | null;
  clientSeed: string | null;
  nonce: number | null;
  paramsCommit: string | null;
  // revealed only after crash
  serverSeed: string | null;
  volatilitySnapshot: unknown | null;
  shapingParams: unknown | null;
  proofCrashPoint: number | null;
}

export type MyBetStatus = 'NONE' | 'PENDING' | 'ACTIVE' | 'CASHED_OUT' | 'LOST' | 'REFUNDED';

export interface MyBetView {
  status: MyBetStatus;
  stake: number;
  autoCashout: number | null;
  cashedOutMultiplier: number | null;
  payout: number | null;
}

export interface RoundView {
  roundId: string | null;
  roundNumber: number;
  phase: RoundPhase;
  multiplier: number;
  crashPoint: number | null; // revealed at crash
  bettingEndsAt: number | null;
  // sampled multiplier history for the current round (drives the curve)
  curve: number[];
}

export type ConnectionStatus = 'MOCK' | 'CONNECTING' | 'CONNECTED' | 'DISCONNECTED';

export interface GameView {
  now: number;
  connection: ConnectionStatus;
  round: RoundView;
  players: PlayerRow[];
  history: RoundHistoryEntry[];
  wallet: WalletView;
  fairness: FairnessView;
  myBet: MyBetView;
  lastActionError: string | null;
}

export const initialGameView = (): GameView => ({
  now: 0,
  connection: 'MOCK',
  round: {
    roundId: null,
    roundNumber: 0,
    phase: 'BETTING',
    multiplier: 1,
    crashPoint: null,
    bettingEndsAt: null,
    curve: [],
  },
  players: [],
  history: [],
  wallet: { balance: 0, activeWager: 0, transactions: [] },
  fairness: {
    serverHash: null,
    clientSeed: null,
    nonce: null,
    paramsCommit: null,
    serverSeed: null,
    volatilitySnapshot: null,
    shapingParams: null,
    proofCrashPoint: null,
  },
  myBet: { status: 'NONE', stake: 0, autoCashout: null, cashedOutMultiplier: null, payout: null },
  lastActionError: null,
});
