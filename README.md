# Velocity — Crash Game Engine

Velocity is a lightweight, event-driven crash game server written in TypeScript. It includes deterministic, verifiable RNG (commit-reveal + HMAC-based crash derivation), per-bet locking, persistence for auditability, and a small development vertical slice for interactive testing.

## Features

- Deterministic RNG with commit-reveal and verifiable proof (`computeProof`) in `src/core/fairness-engine`
- Game lifecycle engine with quantized ticks and crash emission (`src/core/game-engine`)
- Betting engine with per-bet locking and idempotency guards (`src/core/betting-engine`)
- Settlement engine that persists cloned settled state for auditability (`src/core/settlement-engine`)
- File-based persistence helper at `src/runtime/persistence.ts` (data persisted to `data/`)
- Lightweight dev vertical slice and simulation driver (`src/vertical-slice.ts`)
- Minimal test harness validating fairness-proof and allocation/reveal (`test/run-tests.ts`)

## Prerequisites

- Node.js 16+ (recommended)
- npm (included with Node.js)

## Quickstart

1. Install dependencies:

```bash
npm install
```

2. Run the development vertical slice (websocket gateway + admin server + simulation driver):

```bash
npm run dev
```

3. Run the lightweight verification tests:

```bash
npm run test
```

## Verifying a Round (commit-reveal proof)

When a round crashes the server emits a `ROUND_CRASHED` event that includes the revealed `serverSeed`, `serverHash`, `clientSeed`, `nonce`, and a `proof` object. To independently verify the crash point:

1. Confirm the reveal matches the commit:
   - `sha256(serverSeed) === serverHash`
2. Recompute the proof using the same algorithm (`computeProof(serverSeed, clientSeed, nonce)`) and confirm:
   - `proof.adjusted === crashPoint` (the published crash point)

The `proof` object contains intermediate values (`hex`, `modInt`, `r`, `baseCrash`, `adjusted`) so auditors can reproduce each step.

## Important Files

- `src/core/fairness-engine/index.ts` — RNG, commit-reveal, `computeProof`
- `src/core/game-engine/index.ts` — round lifecycle, tick quantization, events
- `src/core/betting-engine/index.ts` — bet placement, cashout, reservations
- `src/core/settlement-engine/index.ts` — settlement and persisted round state
- `src/runtime/persistence.ts` — atomic JSON persistence helper (writes to `data/`)
- `test/run-tests.ts` — lightweight test harness
- `COMMIT_MESSAGE.md` — suggested initial commit message

## Development notes

- The `data/` directory stores persisted fairness state and tick ledgers. It is ignored by Git via `.gitignore`.
- The dev simulation seeds a couple of demo players; use the admin server if you want to modify simulation parameters.

## Next steps / Suggested improvements

- Add an automated test framework (Jest/Vitest) and convert `test/run-tests.ts` to formal unit tests.
- Add admin endpoints to retrieve historical proofs for specific `roundId`s.
- Harden persistence with durable writes and backup rotation for production.

## License
This project is released under the MIT License — see `LICENSE`.

## What this project demonstrates

- A deterministic commit-reveal RNG pattern suitable for provably-fair games.
- How to derive a verifiable game outcome using HMAC with serverSeed, clientSeed and nonce.
- Defensive engineering patterns for real-time systems: quantized ticks, idempotent events, per-item locking, and single-flight guards.
- Lightweight persistence strategies for auditability (append-only JSON) and crash-resilient state publishing.
- An extensible architecture separating fairness, game, betting, settlement, and persistence concerns so engines can be swapped or tuned independently.

## What this project could be

- A production-grade crash game server with hardened persistence, backup, and monitoring (extend `src/runtime/persistence.ts`).
- A reference implementation for auditors and security researchers to validate provable-fair RNG approaches.
- A testbed for advanced volatility and exposure steering algorithms (plug new `VolatilityEngine` implementations).
- A foundation for a full platform with player accounts, KYC, robust wallet integrations, and horizontal scaling.
