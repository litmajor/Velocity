// Production GameClient over the WebSocketGateway (src/runtime/websocket-gateway.ts).
//
// Outbound actions: WALLET_SYNC / PLACE_BET / CASHOUT (payload always carries
// userId, requestId, clientTs).
// Inbound messages:
//   STATE_SYNC / STATE_SNAPSHOT      → STATE_SYNCED (authoritative resync)
//   TICK_UPDATE / MULTIPLIER_UPDATED → MULTIPLIER_UPDATED
//   WALLET_BALANCE                   → WALLET_BALANCE_UPDATED
//   BET_ACCEPTED/REJECTED, CASHOUT_ACCEPTED/REJECTED → direct command results
//   EVENT_APPEND envelopes (public allowlist) → round lifecycle + live players
//     (ROUND_STARTED/LOCKED/RUNNING/CRASHED/SETTLED, BET_PLACED, PLAYER_CASHED_OUT)

import type { GameClient } from './game-client.js';
import type { ClientGameEvent } from '../domains/game/events.js';
import type { RoundPhase, SettledOutcome } from '../core/types.js';

interface GatewayMessage {
  type: string;
  data: Record<string, unknown>;
}

const CLOCK_MS = 200;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 8_000;

const PHASES: RoundPhase[] = ['BETTING', 'LOCKED', 'RUNNING', 'CRASHED', 'SETTLED'];

export class WebSocketGameClient implements GameClient {
  private ws: WebSocket | null = null;
  private handlers: Array<(ev: ClientGameEvent) => void> = [];
  private seq = 0;
  private txSeq = 0;
  private clockTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = RECONNECT_BASE_MS;
  private manualClose = false;
  private pendingAutoCashout: number | null = null;

  constructor(
    private url: string,
    private userId: string,
  ) {}

  connect(): void {
    this.manualClose = false;
    this.emit({ type: 'IDENTITY_SET', userId: this.userId });
    this.emit({ type: 'CONNECTION_CHANGED', status: 'CONNECTING' });
    if (!this.clockTimer) {
      this.clockTimer = setInterval(() => this.emit({ type: 'CLOCK_TICKED', now: Date.now() }), CLOCK_MS);
    }
    this.open();
  }

  disconnect(): void {
    this.manualClose = true;
    if (this.clockTimer) clearInterval(this.clockTimer);
    this.clockTimer = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.ws?.close();
    this.ws = null;
  }

  placeBet(stake: number, autoCashout: number | null): void {
    // The backend accepts (userId, amount); auto-cashout is executed
    // client-side (see actions/auto-cashout.ts) against real tick state.
    this.pendingAutoCashout = autoCashout;
    this.send('PLACE_BET', { userId: this.userId, amount: stake });
  }

  cashout(): void {
    this.send('CASHOUT', { userId: this.userId });
  }

  onEvent(handler: (ev: ClientGameEvent) => void): void {
    this.handlers.push(handler);
  }

  private open(): void {
    this.ws = new WebSocket(this.url);
    this.ws.onopen = () => {
      this.reconnectDelay = RECONNECT_BASE_MS;
      this.emit({ type: 'CONNECTION_CHANGED', status: 'CONNECTED' });
      this.send('WALLET_SYNC', { userId: this.userId });
    };
    this.ws.onclose = () => this.onDown();
    this.ws.onerror = () => this.onDown();
    this.ws.onmessage = (raw) => {
      try {
        this.route(JSON.parse(String(raw.data)) as GatewayMessage);
      } catch {
        // ignore malformed frames
      }
    };
  }

  private onDown(): void {
    this.emit({ type: 'CONNECTION_CHANGED', status: 'DISCONNECTED' });
    if (this.manualClose || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.emit({ type: 'CONNECTION_CHANGED', status: 'CONNECTING' });
      this.open();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(RECONNECT_MAX_MS, this.reconnectDelay * 2);
  }

  private send(action: string, payload: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      if (action === 'PLACE_BET') this.emit({ type: 'BET_REJECTED', reason: 'Not connected' });
      if (action === 'CASHOUT') this.emit({ type: 'CASHOUT_REJECTED', reason: 'Not connected' });
      return;
    }
    this.seq += 1;
    this.ws.send(JSON.stringify({
      action,
      payload: { ...payload, requestId: `${this.userId}:${action}:${Date.now()}:${this.seq}`, clientTs: Date.now() },
    }));
  }

  private emit(ev: ClientGameEvent): void {
    for (const h of this.handlers) h(ev);
  }

  private pushTx(kind: 'BET' | 'PAYOUT', amount: number): void {
    this.txSeq += 1;
    this.emit({ type: 'WALLET_TRANSACTION_APPENDED', id: `local-${this.txSeq}`, kind, amount, ts: Date.now() });
  }

  private route(msg: GatewayMessage): void {
    const d = msg.data ?? {};
    switch (msg.type) {
      case 'STATE_SYNC':
      case 'STATE_SNAPSHOT': {
        const rawPhase = String(d.phase ?? '');
        this.emit({
          type: 'STATE_SYNCED',
          roundId: String(d.roundId ?? ''),
          roundNumber: Number(d.roundNumber ?? 0),
          phase: (PHASES as string[]).includes(rawPhase) ? (rawPhase as RoundPhase) : 'BETTING',
          multiplier: Number(d.multiplier ?? 1),
          serverHash: d.serverHash == null ? null : String(d.serverHash),
          clientSeed: d.clientSeed == null ? null : String(d.clientSeed),
          nonce: d.nonce == null ? null : Number(d.nonce),
          bettingEndsAt: d.bettingEndsAt == null ? null : Number(d.bettingEndsAt),
        });
        return;
      }
      case 'TICK_UPDATE':
      case 'MULTIPLIER_UPDATED':
        this.emit({
          type: 'MULTIPLIER_UPDATED',
          roundId: String(d.roundId ?? ''),
          multiplier: Number(d.multiplier ?? 1),
        });
        return;
      case 'WALLET_BALANCE':
        if (String(d.userId ?? '') !== this.userId) return;
        this.emit({ type: 'WALLET_BALANCE_UPDATED', balance: Number(d.balance ?? 0) });
        return;
      case 'BET_ACCEPTED': {
        const stake = Number(d.amount ?? 0);
        this.emit({ type: 'BET_ACCEPTED', stake, autoCashout: this.pendingAutoCashout });
        this.pushTx('BET', -stake);
        return;
      }
      case 'BET_REJECTED':
        this.pendingAutoCashout = null;
        this.emit({ type: 'BET_REJECTED', reason: String(d.reason ?? 'rejected') });
        return;
      case 'CASHOUT_ACCEPTED': {
        const payout = Number(d.payout ?? 0);
        this.emit({
          type: 'CASHOUT_ACCEPTED',
          multiplier: Number(d.cashedOutMultiplier ?? 0),
          payout,
        });
        this.pushTx('PAYOUT', payout);
        return;
      }
      case 'CASHOUT_REJECTED':
        this.emit({ type: 'CASHOUT_REJECTED', reason: String(d.reason ?? 'rejected') });
        return;
      case 'EVENT_APPEND': {
        // Envelopes arrive as {event, data, timestamp} or wrapped {envelope: {...}}
        const envelope = (d.envelope ?? d) as { event?: string; data?: Record<string, unknown> };
        if (envelope.event && envelope.data) this.routeEnvelope(envelope.event, envelope.data);
        return;
      }
      default:
        return;
    }
  }

  private routeEnvelope(event: string, d: Record<string, unknown>): void {
    switch (event) {
      case 'ROUND_STARTED':
        this.pendingAutoCashout = null;
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
        this.emit({
          type: 'ROUND_SETTLED',
          roundId: String(d.roundId ?? ''),
          winners: this.mapOutcomes(d.winners),
          losers: this.mapOutcomes(d.losers),
          totalBets: Number(d.totalBets ?? 0),
          totalPayout: Number(d.totalPayout ?? 0),
        });
        return;
      case 'BET_PLACED':
        this.emit({
          type: 'PLAYER_BET_PLACED',
          roundId: String(d.roundId ?? ''),
          userId: String(d.userId ?? ''),
          stake: Number(d.amount ?? 0),
        });
        return;
      case 'PLAYER_CASHED_OUT':
        this.emit({
          type: 'PLAYER_CASHED_OUT',
          roundId: String(d.roundId ?? ''),
          userId: String(d.userId ?? ''),
          multiplier: Number(d.multiplier ?? 0),
          payout: Number(d.payout ?? 0),
        });
        return;
      default:
        return;
    }
  }

  private mapOutcomes(raw: unknown): SettledOutcome[] {
    if (!Array.isArray(raw)) return [];
    return raw.map((o) => ({
      userId: String((o as Record<string, unknown>).userId ?? ''),
      amount: Number((o as Record<string, unknown>).amount ?? 0),
      payout: Number((o as Record<string, unknown>).payout ?? 0),
      multiplier:
        (o as Record<string, unknown>).multiplier == null
          ? null
          : Number((o as Record<string, unknown>).multiplier),
    }));
  }
}
