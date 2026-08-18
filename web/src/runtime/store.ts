// Minimal reactive store (SSA /runtime layer). Holds GameView, applies
// domain-reduced events, notifies subscribers. No DOM, no transport.

import type { GameView } from '../core/types.js';
import { initialGameView, reduceGameView } from '../domains/game/state.js';
import type { ClientGameEvent } from '../domains/game/events.js';

export type Unsubscribe = () => void;

export class GameStore {
  private state: GameView = initialGameView();
  private listeners = new Set<(s: GameView) => void>();

  getState(): GameView {
    return this.state;
  }

  dispatch(ev: ClientGameEvent): void {
    const next = reduceGameView(this.state, ev);
    if (next === this.state) return;
    this.state = next;
    for (const l of this.listeners) l(next);
  }

  subscribe(listener: (s: GameView) => void): Unsubscribe {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }
}
