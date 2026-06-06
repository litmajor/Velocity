import type { GameEventName } from '../domains/game';

export type Tier = 'UI' | 'SYSTEM' | 'DEBUG';

// Map events to tiers. Gateway will use this to decide which clients should receive which events.
// Use a loose index type to avoid tight coupling to the GameEvents shape during rapid iteration.
export const EVENT_TIERS: Record<string, Tier> = {
  // WebSocket gateway will prefer the new minimal event set for clients
  STATE_SNAPSHOT: 'UI',
  TICK_UPDATE: 'UI',
  EVENT_APPEND: 'SYSTEM',
};
