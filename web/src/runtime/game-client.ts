// GameClient boundary (SSA /runtime layer).
// The single client-side abstraction over the backend. Implementations
// translate transport messages into normalized ClientGameEvents; the rest of
// the UI is transport-agnostic.

import type { ClientGameEvent } from '../domains/game/events.js';

export interface GameClient {
  /** Begin producing events (open the socket / start the simulator). */
  connect(): void;
  disconnect(): void;
  /** Fire-and-forget commands; results arrive as BET_/CASHOUT_ events. */
  placeBet(stake: number, autoCashout: number | null): void;
  cashout(): void;
  onEvent(handler: (ev: ClientGameEvent) => void): void;
}
