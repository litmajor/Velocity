---
name: testing-velocity-server
description: How to run and black-box test the Velocity crash-game server (WS gateway, admin HTTP, instance lock, settlement claims, fairness proofs)
---

# Testing the Velocity crash-game server

## Run
- `DATA_DIR=/tmp/vel-test ADMIN_TOKEN=... WS_ADMIN_TOKEN=... npx tsx src/vertical-slice.ts` (from repo root).
- Ports are fixed: WS on 3001, admin HTTP on 4001 (override admin with ADMIN_PORT). Only one server at a time.
- In non-production mode it self-terminates gracefully after 10 rounds (removes `instance.lock`); each round is ~9-30s.
- Env: `DATA_DIR`, `ADMIN_TOKEN` (admin HTTP; unset → 503), `WS_ADMIN_TOKEN` (WS ADMIN action; unset → always ADMIN_DENIED), `WS_CLIENT_TOKEN` (connect gate; wrong/missing → close code 4001).

## Gotchas
- `npx tsx` spawns a chain of processes (`sh` → `.bin/tsx` wrapper → real `/usr/bin/node ... vertical-slice.ts`). For kill -9 crash tests you MUST kill the real node pid: `pgrep -f "usr/bin/node.*vertical-slice"`. Killing the wrapper leaves the server alive (and the instance lock legitimately held).
- `pkill -f vertical-slice` will match and kill your own shell if the pattern appears in your command line — use a bracketed pattern like `pkill -f "[v]ertical-slice.ts"`.
- The built-in SimulationDriver (alice/bob) never auto-cashes-out after round 1 (stale `lastRoundId` guard in src/vertical-slice.ts), so alice/bob always lose and run out of funds after ~9 rounds across restarts on the same DATA_DIR. To generate real cashouts/payouts, drive a WS client yourself (PLACE_BET/CASHOUT for seeded user `charlie`, balance 2000).
- WS non-admin clients only receive UI-tier events (STATE_SYNC, TICK_UPDATE, STATE_SNAPSHOT). To observe ROUND_CRASHED with the revealed serverSeed/proof over WS, first send `{action:"ADMIN", payload:{token:<WS_ADMIN_TOKEN>}}` — admins receive all EVENT_APPEND envelopes.
- WS client scripts importing `ws` must live inside the repo (or set NODE_PATH) so ESM resolution finds node_modules.

## Useful checks
- Wallet ledger: `DATA_DIR/wallet.ledger`, one JSON line per tx with `tx` id (`bet:`, `payout:<betId>`, `refund:<betId>`, `ensure:`). Exactly-once = no duplicate payout:/refund: tx ids.
- Settlement claims: `DATA_DIR/settlements/<roundId>.claim` (O_EXCL, never released).
- Instance lock: `DATA_DIR/instance.lock` JSON `{pid,hostname,acquiredAt}`; stale (dead pid, same host) is taken over on restart; second live process exits 1 with `[System] FATAL: data directory ... is owned by another instance`.
- Fairness: verify `sha256(serverSeed)` (revealed in ROUND_CRASHED) equals the `serverHash` committed at ROUND_STARTED / STATE_SYNC.
- Known no-op: POST /admin/player-mix-params passes auth but changes nothing — FairnessEngine has no `setPlayerMixParams`/`getPlayerMixParams` (only `setPlayerMix`/`getPlayerMixHistory`); response always shows `playerMixParams: null` (pre-existing, may be fixed later).
