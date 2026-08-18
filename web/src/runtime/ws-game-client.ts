// PRODUCTION INTEGRATION POINT (not wired up by default — the UI runs on
// MockGameClient until this is verified against a live gateway).
//
// Maps the existing WebSocketGateway protocol (src/runtime/websocket-gateway.ts)
// into normalized ClientGameEvents:
//   outbound: { action: 'PLACE_BET' | 'CASHOUT', payload: { requestId, clientTs, ... } }
//   inbound:  STATE_SYNC / STATE_SNAPSHOT / TICK_UPDATE / EVENT_APPEND
//             BET_ACCEPTED / BET_REJECTED / CASHOUT_ACCEPTED / CASHOUT_REJECTED
// Round lifecycle transitions arrive inside EVENT_APPEND envelopes
// (ROUND_STARTED, ROUND_LOCKED, ROUND_RUNNING, ROUND_CRASHED, ROUND_SETTLED).

import type { GameClient } from './game-client.js';
import type { ClientGameEvent } from '../domains/game/events.js';

interface GatewayMessage {
  type: string;
  data: Record<string, unknown>;
}

export class WebSocketGameClient implements GameClient {
  private ws: WebSocket | null = null;
  private handlers: Array<(ev: ClientGameEvent) => void> = [];
  private seq = 0;

  constructor(
    private url: string,
    private userId: string,
  ) {}

  connect(): void {
    this.emit({ type: 'CONNECTION_CHANGED', status: 'CONNECTING' });
    this.ws = new WebSocket(this.url);
    this.ws.onopen = () => this.emit({ type: 'CONNECTION_CHANGED', status: 'CONNECTED' });
    this.ws.onclose = () => this.emit({ type: 'CONNECTION_CHANGED', status: 'DISCONNECTED' });
    this.ws.onerror = () => this.emit({ type: 'CONNECTION_CHANGED', status: 'DISCONNECTED' });
    this.ws.onmessage = (raw) => {
      try {
        this.route(JSON.parse(String(raw.data)) as GatewayMessage);
      } catch {
        // ignore malformed frames
      }
    };
  }

  disconnect(): void {
    this.ws?.close();
    this.ws = null;
  }

  placeBet(stake: number, autoCashout: number | null): void {
    this.send('PLACE_BET', { userId: this.userId, amount: stake, autoCashout });
  }

  cashout(): void {
    this.send('CASHOUT', { userId: this.userId });
  }

  onEvent(handler: (ev: ClientGameEvent) => void): void {
    this.handlers.push(handler);
  }

  private send(action: string, payload: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.seq += 1;
    this.ws.send(JSON.stringify({
      action,
      payload: { ...payload, requestId: `${this.userId}:${action}:${this.seq}`, clientTs: Date.now() },
    }));
  }

  private emit(ev: ClientGameEvent): void {
    for (const h of this.handlers) h(ev);
  }

  private route(msg: GatewayMessage): void {
    const d = msg.data ?? {};
    switch (msg.type) {
      case 'TICK_UPDATE':
      case 'MULTIPLIER_UPDATED':
        this.emit({
          type: 'MULTIPLIER_UPDATED',
          roundId: String(d.roundId ?? ''),
          multiplier: Number(d.multiplier ?? 1),
        });
        return;
      case 'BET_ACCEPTED':
        this.emit({
          type: 'BET_ACCEPTED',
          stake: Number(d.amount ?? 0),
          autoCashout: d.autoCashout == null ? null : Number(d.autoCashout),
        });
        return;
      case 'BET_REJECTED':
        this.emit({ type: 'BET_REJECTED', reason: String(d.reason ?? 'rejected') });
        return;
      case 'CASHOUT_ACCEPTED':
        this.emit({
          type: 'CASHOUT_ACCEPTED',
          multiplier: Number(d.cashedOutMultiplier ?? 0),
          payout: Number(d.payout ?? 0),
        });
        return;
      case 'CASHOUT_REJECTED':
        this.emit({ type: 'CASHOUT_REJECTED', reason: String(d.reason ?? 'rejected') });
        return;
      case 'EVENT_APPEND': {
        const envelope = d.envelope as { event?: string; data?: Record<string, unknown> } | undefined;
        if (envelope?.event && envelope.data) this.routeEnvelope(envelope.event, envelope.data);
        return;
      }
      default:
        return; // STATE_SYNC/STATE_SNAPSHOT handled once envelope coverage is confirmed
    }
  }

  private routeEnvelope(event: string, d: Record<string, unknown>): void {
    switch (event) {
      case 'ROUND_STARTED':
        this.emit({
          type: 'ROUND_STARTED',
          roundId: String(d.roundId ?? ''),
          roundNumber: Number(d.roundNumber ?? 0),
          serverHash: String(d.serverHash ?? ''),
          paramsCommit: d.paramsCommit == null ? null : String(d.paramsCommit),
          clientSeed: String(d.clientSeed ?? ''),
          nonce: Number(d.nonce ?? 0),
          bettingEndsAt: Number(d.bettingEndsAt ?? 0),
        });
        return;
      case 'ROUND_LOCKED':
        this.emit({ type: 'ROUND_LOCKED', roundId: String(d.roundId ?? '') });
        return;
      case 'ROUND_RUNNING':
        this.emit({ type: 'ROUND_RUNNING', roundId: String(d.roundId ?? '') });
        return;
      case 'ROUND_CRASHED':
        this.emit({
          type: 'ROUND_CRASHED',
          roundId: String(d.roundId ?? ''),
          crashPoint: Number(d.crashPoint ?? 1),
          serverSeed: String(d.serverSeed ?? ''),
          shapingParams: d.shapingParams ?? null,
          volatilitySnapshot: d.volatilitySnapshot ?? null,
        });
        return;
      case 'ROUND_SETTLED':
        this.emit({ type: 'ROUND_SETTLED', roundId: String(d.roundId ?? '') });
        return;
      default:
        return;
    }
  }
}
