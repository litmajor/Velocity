import { EventEmitter } from 'events';
import type { GameEvents, GameEventName, WildcardEnvelope } from '../domains/game';

// ─── TypedEventBus ────────────────────────────────────────────────────────────
//
//  Every domain emits events here.
//  WebSocket gateway listens here and mirrors to clients.
//  Debug surface listens here via onWildcard().
//  Nothing owns logic except the domain that emits.

class TypedEventBus {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  emit<K extends GameEventName>(event: K, data: GameEvents[K]): void {
    const envelope: WildcardEnvelope = { event, data, timestamp: Date.now() };
    this.emitter.emit('*', envelope);
    // Also emit an explicit append event for UI/ledger consumers
    // (use emitter directly to avoid recursion into this.emit)
    this.emitter.emit('EVENT_APPEND', envelope as any);
    this.emitter.emit(event, data);
  }

  on<K extends GameEventName>(event: K, handler: (data: GameEvents[K]) => void): this {
    this.emitter.on(event, handler as (...args: unknown[]) => void);
    return this;
  }

  off<K extends GameEventName>(event: K, handler: (data: GameEvents[K]) => void): this {
    this.emitter.off(event, handler as (...args: unknown[]) => void);
    return this;
  }

  once<K extends GameEventName>(event: K, handler: (data: GameEvents[K]) => void): this {
    this.emitter.once(event, handler as (...args: unknown[]) => void);
    return this;
  }

  // Wildcard: observe every event — used by DebugSurface and logging
  onWildcard(handler: (envelope: WildcardEnvelope) => void): this {
    this.emitter.on('*', handler as (...args: unknown[]) => void);
    return this;
  }

  offWildcard(handler: (envelope: WildcardEnvelope) => void): this {
    this.emitter.off('*', handler as (...args: unknown[]) => void);
    return this;
  }
}

export const eventBus = new TypedEventBus();