// Game domain types

export type RoundPhase = 'BETTING' | 'LOCKED' | 'RUNNING' | 'CRASHED' | 'SETTLED';

export interface RoundState {
  roundId:        string;
  roundNumber:    number;
  phase:          RoundPhase;
  serverSeed:     string;   // hidden until crash, then revealed
  serverHash:     string;   // committed at ROUND_STARTED
  clientSeed:     string;
  nonce:          number;
  crashPoint:     number;   // pre-determined, hidden until crash
  multiplier:     number;   // live value during RUNNING
  roundStartedAt: number | null;
  bettingOpensAt: number;
  bettingEndsAt:  number;
  // Optional exposure snapshot persisted for auditing
  exposure?: {
    roundId: string;
    totalBets: number;
    totalLiability: number;
  };
}

export type SystemState = 'CALM' | 'TENSION' | 'CHAOS' | 'RESET';

export interface ShapingParams {
  instantCrashDivisor?: number;
  volatility?: number;
  houseEdge?: number;
}

export interface Bet {
  betId:               string;
  userId:              string;
  roundId:             string;
  amount:              number;
  placedAt:            number;
  status:              'ACTIVE' | 'CASHED_OUT' | 'LOST';
  cashedOutAt?:        number;
  cashedOutMultiplier?: number;
  payout?:             number;
  autoCashout?:        number;
  // resolved indicates the bet has been finalised (either CASHED_OUT or LOST)
  resolved?:           boolean;
}

export interface SettledBet {
  betId:      string;
  userId:     string;
  amount:     number;
  payout:     number;
  multiplier?: number;
  won:        boolean;
}

export type GameEvents = {
  ROUND_STARTED: {
    roundId:       string;
    roundNumber:   number;
    serverHash:    string;   // hash of serverSeed — players can verify later
    bettingEndsAt: number;
    clientSeed:    string;
    nonce:         number;
  };
  ROUND_LOCKED: {
    roundId:     string;
    roundNumber: number;
  };
  MULTIPLIER_UPDATED: {
    roundId:    string;
    multiplier: number;
    elapsed:    number;
  };
  // New explicit message types for UI/ledger consumption
  STATE_SNAPSHOT: {
    // a limited snapshot of round state safe to publish (no serverSeed, no crashPoint before reveal)
    roundId:        string;
    roundNumber:    number;
    phase:          RoundPhase;
    serverHash:     string;
    clientSeed:     string;
    nonce:          number;
    multiplier:     number;
    roundStartedAt: number | null;
    bettingOpensAt: number;
    bettingEndsAt:  number;
    shapingParams?: ShapingParams;
    systemState?: SystemState;
    shapingPreset?: string;
    elasticity?: number;
  };
  TICK_UPDATE: {
    roundId:    string;
    multiplier: number;
    ts:         number;
  };
  EVENT_APPEND: {
    envelope: WildcardEnvelope;
  };
  ROUND_RUNNING: {
    roundId:     string;
    roundNumber: number;
  };
  ROUND_CRASHED: {
    roundId:     string;
    roundNumber: number;
    crashPoint:  number;
    serverSeed:  string;   // revealed on crash for provable fairness
    clientSeed:  string;
    nonce:       number;
  };
  BET_PLACED: {
    roundId: string;
    userId:  string;
    amount:  number;
    betId:   string;
  };
  BET_REJECTED: {
    roundId: string;
    userId:  string;
    reason:  string;
  };
  PLAYER_CASHED_OUT: {
    roundId:    string;
    userId:     string;
    betId:      string;
    multiplier: number;
    payout:     number;
  };
  CASHOUT_REJECTED: {
    userId: string;
    reason: string;
  };
  ROUND_SETTLED: {
    roundId:      string;
    roundNumber:  number;
    winners:      SettledBet[];
    losers:       SettledBet[];
    totalBets:    number;
    totalPayout:  number;
    netResult:    number; // totalBets - totalPayout (can be negative)
    exposure?: {
      roundId: string;
      totalBets: number;
      totalLiability: number;
    };
  };
};

export type GameEventName = keyof GameEvents;

export interface WildcardEnvelope {
  event:     string;
  data:      unknown;
  timestamp: number;
}
