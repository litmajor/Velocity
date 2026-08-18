# Velocity Player UI (skeleton)

Dark, responsive crash-game frontend skeleton. **Runs entirely on simulated
data** (a deterministic mock state source) — it is NOT connected to the
production engine. The header shows a `SIMULATED DATA` badge whenever the
mock client is active.

Zero runtime dependencies: plain TypeScript compiled to browser ES modules
with `tsc` and served statically.

```bash
npm run web:build   # typecheck + compile web/src -> web/dist
npm run web:dev     # build, then serve http://localhost:8080
```

## Architecture (SSA: STATE → SYSTEM → SURFACE)

Mirrors the repo's Surface-State Architecture (see `SSA.md`):

```
web/src/core/      pure state models + formatting (GameView, no DOM, no transport)
web/src/domains/   game domain: ClientGameEvent definitions + reduceGameView reducer
web/src/actions/   PlaceBet / Cashout actions with preflight validation
web/src/runtime/   GameStore (pub/sub), GameClient boundary, Mock + WebSocket clients
web/src/surfaces/  GamePage composition + panels (render/react/compose only)
web/src/ui/        presentational primitives (el/button/badge/panel) + styles.css tokens
```

- **State owns rendering**: every panel is a pure `update(GameView)` renderer
  subscribed to the store; no panel keeps business state.
- **Business logic never lives in surfaces**: bet/cashout validation
  (invalid amount, insufficient balance, betting closed, already bet, round
  crashed, cashout unavailable) lives in `/actions` preflights; `BetPanel`
  only renders the verdicts.
- **Events, not coupling**: components consume the normalized `GameView`
  produced by `reduceGameView`, never raw WebSocket messages.

## GameClient boundary

`runtime/game-client.ts` is the single integration seam:

```ts
interface GameClient {
  connect(): void;
  disconnect(): void;
  placeBet(stake: number, autoCashout: number | null): void;
  cashout(): void;
  onEvent(handler: (ev: ClientGameEvent) => void): void;
}
```

Normalized events cover: `ROUND_STARTED/LOCKED/RUNNING/CRASHED/SETTLED`,
`MULTIPLIER_UPDATED`, `PLAYERS_UPDATED`, `WALLET_BALANCE_UPDATED`,
`WALLET_TRANSACTION_APPENDED`, `BET_ACCEPTED/REJECTED`,
`CASHOUT_ACCEPTED/REJECTED`, `CONNECTION_CHANGED`, `CLOCK_TICKED`.

### Mock (default)

`runtime/mock-game-client.ts` — deterministic (seeded mulberry32) simulator of
the full lifecycle with mock players, cashouts, losing bets, wallet changes,
recent rounds, and fairness placeholder fields. It reuses **no** production
engine logic and its crash points are **not** drawn from the production
distribution.

### WebSocket (integration point, not wired by default)

`runtime/ws-game-client.ts` maps the existing gateway protocol
(`src/runtime/websocket-gateway.ts`) into `ClientGameEvent`s:

- outbound `{ action: 'PLACE_BET' | 'CASHOUT', payload: { requestId, clientTs, ... } }`
- inbound `TICK_UPDATE`, `BET_ACCEPTED/REJECTED`, `CASHOUT_ACCEPTED/REJECTED`,
  and round lifecycle events inside `EVENT_APPEND` envelopes.

Remaining production integration work:

1. Confirm which lifecycle events the gateway publishes to non-admin clients
   (today it forwards `STATE_SNAPSHOT`, `TICK_UPDATE`, `EVENT_APPEND`) and
   extend `DEFAULT_EVENTS`/rooms if round lifecycle envelopes are missing.
2. Live-players and wallet views need read-only backend feeds (`PLAYERS_UPDATED`,
   balance snapshots); none were added in this task to keep the backend in its
   audited state.
3. Swap `MockGameClient` for `WebSocketGameClient` in `web/src/main.ts` and
   remove the `SIMULATED DATA` badge path only after the above is verified.

## Fairness verification

The FairnessPanel displays the real commitment/reveal field names
(`serverHash`, `clientSeed`, `nonce`, `paramsCommit`, `serverSeed`,
`volatilitySnapshot`, `shapingParams`, proof crash point). The **Verify**
button is a marked integration point: the standalone verifier
(`src/core/fairness-engine/verifier.ts` → `verifyRound(commitment, reveal)`)
uses `node:crypto` and is intentionally **not duplicated** in the frontend.
Expected wiring options:

- expose `verifyRound` through a read-only HTTP endpoint, or
- produce a browser build of the verifier backed by WebCrypto,

then replace the stub click handler in
`web/src/surfaces/game/panels/fairness-panel.ts`.
