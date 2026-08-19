# Velocity Player UI — Rocket + Racecar

Dark, responsive frontend connected **live to the production engine** over
WebSocket. One engine, two completely different experiences:

- **Rocket** — round = mission, betting = pre-launch, running = ascent,
  crash = anomaly, settlement = mission debrief.
- **Racecar** — round = race, betting = starting grid, running = green flag,
  crash = wreck, settlement = podium.

Both experiences consume the exact same `GameStore` + `GameClient`; switching
swaps only the presentation layer (no reconnect, no second state manager).

Zero runtime dependencies: plain TypeScript compiled to browser ES modules
with `tsc` and served statically.

```bash
npx tsx src/vertical-slice.ts   # engine + ws gateway on :3001 (MAX_ROUNDS=0 for unbounded)
npm run web:build               # typecheck + compile web/src -> web/dist
npm run web:dev                 # build, then serve http://localhost:8080
```

URL config: `?experience=rocket|racecar` (persisted), `?user=<id>` (persisted
random guest id by default), `?ws=<url>` (default `ws://<host>:3001`),
`?mock=1` (explicit opt-in to the offline demo simulator — shows a
`SIMULATED DATA` badge; never the default).

## Architecture (SSA: STATE → SYSTEM → SURFACE)

```
web/src/core/         pure state models + formatting (GameView, no DOM, no transport)
web/src/domains/      game domain: ClientGameEvent definitions + reduceGameView reducer
web/src/actions/      PlaceBet / Cashout preflights + client-side AutoCashout
web/src/runtime/      GameStore (pub/sub), GameClient boundary, WebSocket + mock clients
web/src/shared/       experience-agnostic panels (bet, wallet, players, rounds, fairness)
web/src/experiences/  rocket/ and racecar/ presentation layers (render only)
web/src/ui/           presentational primitives (el) + styles.css tokens
```

- **State owns rendering**: panels and experience scenes are pure
  `update(GameView)` renderers subscribed to the store.
- **Business logic never lives in experiences**: bet/cashout validation lives
  in `/actions` preflights; the store/reducer own all audit state. No metaphor
  vocabulary (mission/race) appears anywhere in `core`, `domains`, `actions`,
  `runtime`, or `shared`.
- **Animations visualize engine state**: rocket altitude / car position are
  functions of the real multiplier; scenes only animate while the backend
  reports `RUNNING`. No fake timers generate progress.

## GameClient boundary

`runtime/game-client.ts` is the single integration seam. The production
client (`runtime/ws-game-client.ts`, the default) maps the gateway protocol
(`src/runtime/websocket-gateway.ts`) into normalized `ClientGameEvent`s:

- outbound `{ action: 'WALLET_SYNC' | 'PLACE_BET' | 'CASHOUT', payload: { userId, requestId, clientTs, ... } }`
- inbound `STATE_SYNC`/`STATE_SNAPSHOT` (authoritative resync on connect /
  mid-round join), `TICK_UPDATE`, `WALLET_BALANCE`,
  `BET_ACCEPTED/REJECTED`, `CASHOUT_ACCEPTED/REJECTED`, and public
  `EVENT_APPEND` envelopes (`ROUND_STARTED/LOCKED/RUNNING/CRASHED/SETTLED`,
  `BET_PLACED`, `PLAYER_CASHED_OUT`).

It reconnects with exponential backoff and surfaces
`CONNECTION_CHANGED` so experiences can render loss-of-telemetry states.

Auto-cashout is enforced client-side (`actions/auto-cashout.ts`) against real
tick state — the backend `PLACE_BET` contract accepts only `(userId, amount)`;
the server still decides the actual cashout multiplier.

`runtime/mock-game-client.ts` remains only as an explicit `?mock=1` offline
demo; it is not part of the production path.

## Fairness verification

The FairnessPanel displays the real commitment/reveal fields
(`serverHash`, `clientSeed`, `nonce`, `paramsCommit`, `serverSeed`,
`volatilitySnapshot`, `shapingParams`, proof crash point). The **Verify**
button is a marked integration point: the standalone verifier
(`src/core/fairness-engine/verifier.ts` → `verifyRound(commitment, reveal)`)
uses `node:crypto` and is intentionally **not duplicated** in the frontend.
Expected wiring options:

- expose `verifyRound` through a read-only HTTP endpoint, or
- produce a browser build of the verifier backed by WebCrypto,

then replace the stub click handler in
`web/src/shared/panels/fairness-panel.ts`.

## Known limitation

Player identity (`userId`) is still client-asserted, matching the gateway's
current contract; real session auth is tracked as follow-up work in
`docs/DEPLOYMENT.md`.
