import { WebSocketServer, WebSocket } from 'ws';
import { eventBus } from './event-bus';
import { EVENT_TIERS } from './event-tiers';
import { ActionValidator } from './action-validator';
import type { GameEvents, GameEventName } from '../domains/game';
import type { GameEngine } from '../core/game-engine';
import type { BettingService } from '../core/betting-service';

type ClientMeta = {
  ws: WebSocket;
  rooms: Set<string>;
  isAdmin: boolean;
  latestMultiplier?: GameEvents['MULTIPLIER_UPDATED'];
  seenRequestIds?: Map<string, number>; // requestId -> timestamp
  authToken?: string;
};

const BACKPRESSURE_THRESHOLD = 64 * 1024; // 64KB
const FLUSH_INTERVAL_MS = 100; // flush cached multiplier snapshots

// Only forward these authoritative messages to clients: snapshot, ticks, and event appends
const DEFAULT_EVENTS: GameEventName[] = ['STATE_SNAPSHOT', 'TICK_UPDATE', 'EVENT_APPEND'] as GameEventName[];

export class WebSocketGateway {
  private wss: WebSocketServer;
  private clients = new Set<ClientMeta>();
  private inflightActions = new Set<string>();
  private seenRequestIds = new Set<string>();
  private readonly REQUEST_ID_TTL_MS = 5 * 60 * 1000; // 5 minutes
  private readonly PRUNE_INTERVAL_MS = 60 * 1000; // 1 minute

  constructor(
    private port: number,
    private gameEngine: GameEngine,
    private bettingEngine: BettingService,
  ) {
    this.wss = new WebSocketServer({ port });
    this.mirrorEvents();
    this.handleConnections();
    // periodically prune old requestIds to prevent unbounded memory growth
    setInterval(() => this.pruneSeenRequestIds(), this.PRUNE_INTERVAL_MS);
    setInterval(() => this.flushSnapshots(), FLUSH_INTERVAL_MS);
    console.log(`[WS] Gateway listening on ws://localhost:${port}`);
  }

  // Mirror domain events, apply tiers and room filtering
  private mirrorEvents(): void {
    for (const event of DEFAULT_EVENTS) {
      eventBus.on(event, (data: any) => this.handleEvent(event, data));
    }
  }

  private handleEvent(event: GameEventName, data: GameEvents[typeof event]) {
    const tier = EVENT_TIERS[event] ?? 'UI';

    for (const client of this.clients) {
      // Admins receive everything
      if (client.isAdmin) {
        this.sendSafe(client, { type: event, data });
        continue;
      }

      // Rooms filtering: if client subscribed to rooms, only send events for those roundIds
      const roundId = (data as any).roundId as string | undefined;
      if (client.rooms.size > 0 && roundId && !client.rooms.has(roundId)) continue;

      // Tier filtering: for now UI tier is broadcast to all non-admin clients
      if (tier === 'UI') {
        // Backpressure handling: drop high-frequency multiplier updates when client is overloaded
        if (event === 'MULTIPLIER_UPDATED') {
          if (client.ws.bufferedAmount > BACKPRESSURE_THRESHOLD) {
            // keep latest snapshot for later flush
            client.latestMultiplier = data as GameEvents['MULTIPLIER_UPDATED'];
            continue;
          }
        }
        this.sendSafe(client, { type: event, data });
      }
    }
  }

  private flushSnapshots() {
    for (const client of this.clients) {
      if (client.latestMultiplier && client.ws.bufferedAmount <= BACKPRESSURE_THRESHOLD) {
        this.sendSafe(client, { type: 'MULTIPLIER_UPDATED', data: client.latestMultiplier });
        client.latestMultiplier = undefined;
      }
    }
  }

  private handleConnections(): void {
    this.wss.on('connection', (ws, req) => {
      // lightweight auth: check Authorization header (Bearer TOKEN) or x-client-token
      const headers = (req && (req as any).headers) || {};
      const rawAuth = String(headers.authorization ?? headers['x-client-token'] ?? '').trim();
      const token = rawAuth.replace(/^Bearer\s+/i, '') || '';

      // If a server-side client token is configured, enforce it at connect time
      const requiredToken = process.env.WS_CLIENT_TOKEN;
      if (requiredToken && token !== requiredToken) {
        try { ws.close?.(4001, 'Unauthorized'); } catch {}
        return;
      }

      const meta: ClientMeta = { ws, rooms: new Set(), isAdmin: false, authToken: token };
      meta.seenRequestIds = new Map();
      this.clients.add(meta);

      // Sync current state on join
      const state = this.gameEngine.getState();
      if (state) {
        this.sendSafe(meta, {
          type: 'STATE_SYNC',
          data: {
            roundId:     state.roundId,
            roundNumber: state.roundNumber,
            phase:       state.phase,
            multiplier:  state.multiplier,
            serverHash:  state.serverHash,
          },
        });
      }

      ws.on('message', async (raw) => {
        try {
          const msg = JSON.parse(raw.toString()) as { action: string; payload?: Record<string, unknown> };
          await this.handleMessage(meta, msg);
        } catch {
          this.sendSafe(meta, { type: 'ERROR', data: { message: 'Invalid JSON' } });
        }
      });

      ws.on('close', () => this.clients.delete(meta));
      ws.on('error', () => this.clients.delete(meta));
    });
  }

  private async handleMessage(client: ClientMeta, msg: { action: string; payload?: Record<string, unknown> }) {
    const { action, payload = {} } = msg;

    // Replay protection: if client supplied a requestId, ensure it's not re-used
    const requestId = String(payload.requestId ?? '').trim();
    if (requestId) {
      // per-client tracking with TTL timestamps
      const seenMap = client.seenRequestIds!;
      const seenTs = seenMap.get(requestId);
      if (seenTs) {
        this.sendSafe(client, { type: 'DUPLICATE_REQUEST', data: { requestId } });
        return;
      }
      seenMap.set(requestId, Date.now());
    }

    // Timing integrity: if client provided a timestamp, validate drift
    const clientTs = Number(payload.clientTs ?? 0) || 0;
    if (clientTs > 0) {
      const serverNow = Date.now();
      const drift = Math.abs(serverNow - clientTs);
      if (drift > 250) {
        // Emit structured suspicious activity event for audit/forensics
        try {
          eventBus.emit('EVENT_APPEND' as any, {
            envelope: {
              event: 'SUSPICIOUS_DRIFT',
              data: { drift, requestId: requestId || null },
              timestamp: serverNow,
            },
          } as any);
        } catch (_) {}
      }
    }

    switch (action) {
      case 'SUBSCRIBE': {
        const room = String(payload.room ?? '').trim();
        if (room) client.rooms.add(room);
        this.sendSafe(client, { type: 'SUBSCRIBED', data: { room } });
        break;
      }
      case 'UNSUBSCRIBE': {
        const room = String(payload.room ?? '').trim();
        if (room) client.rooms.delete(room);
        this.sendSafe(client, { type: 'UNSUBSCRIBED', data: { room } });
        break;
      }
      case 'ADMIN': {
        // Simple admin toggle — in prod validate token
        const token = String(payload.token ?? '');
        if (token && token === process.env.WS_ADMIN_TOKEN) {
          client.isAdmin = true;
          this.sendSafe(client, { type: 'ADMIN_OK', data: {} });
        } else {
          this.sendSafe(client, { type: 'ADMIN_DENIED', data: {} });
        }
        break;
      }
      case 'PLACE_BET': {
        try {
          const { userId, amount } = ActionValidator.validatePlaceBet(payload);
          const bet = await this.bettingEngine.placeBet(userId, amount);
          this.sendSafe(client, { type: 'BET_ACCEPTED', data: bet });
        } catch (err) {
          this.sendSafe(client, { type: 'BET_REJECTED', data: { reason: (err as Error).message } });
        }
        break;
      }
      case 'CASHOUT': {
        try {
          const { userId } = ActionValidator.validateCashout(payload);
          const actionKey = `${userId}:CASHOUT`;
          if (this.inflightActions.has(actionKey)) {
            // already processing a cashout for this user — ignore duplicate request
            this.sendSafe(client, { type: 'CASHOUT_INFLIGHT', data: { userId } });
            break;
          }

          this.inflightActions.add(actionKey);
          try {
            // server-only multiplier decision — user does not supply multiplier
            const bet = await this.bettingEngine.cashout(userId);
            this.sendSafe(client, { type: 'CASHOUT_ACCEPTED', data: bet });
          } finally {
            this.inflightActions.delete(actionKey);
          }
        } catch (err) {
          this.sendSafe(client, { type: 'CASHOUT_REJECTED', data: { reason: (err as Error).message } });
        }
        break;
      }
      default:
        this.sendSafe(client, { type: 'ERROR', data: { message: `Unknown action: ${action}` } });
    }
  }

  private pruneSeenRequestIds(): void {
    const cutoff = Date.now() - this.REQUEST_ID_TTL_MS;
    for (const client of this.clients) {
      const map = client.seenRequestIds;
      if (!map) continue;
      for (const [id, ts] of Array.from(map.entries())) {
        if (ts < cutoff) map.delete(id);
      }
    }
  }

  private sendSafe(client: ClientMeta, message: unknown): void {
    try {
      const payload = JSON.stringify(message);
      if (client.ws.readyState === WebSocket.OPEN) client.ws.send(payload);
    } catch {
      // ignore send errors per-client
    }
  }

  get connectedClients(): number {
    return this.clients.size;
  }
}
