# Velocity Crashgame — Adversarial Audit Report

Date: 2026-08-18 · Branch: `devin/1787051617-adversarial-audit`
Method: code inspection + 70 deterministic automated tests (`npm test`, Vitest). Every defect below was first reproduced by a failing test, then fixed with the smallest correct change, and the full suite re-run (70/70 passing, stable across 5 consecutive runs; `tsc` clean).

---

## 1. Architecture / Execution Map

Shared infrastructure: a singleton synchronous `TypedEventBus` (`src/runtime/event-bus.ts`) and file-based JSON persistence under `data/` (`src/runtime/persistence.ts`, per-entity repositories). All engines are in-process; there is no database or transaction boundary.

| Engine | Inputs | State changes | Outputs/events | Persistence | Failure behavior |
|---|---|---|---|---|---|
| **GameEngine** (`src/core/game-engine`) | scheduler calls (`startBetting`/`lockBets`/`startRound`/`reset`), 50 ms tick timer | `RoundState` (phase, multiplier, seeds, crashPoint) | `ROUND_STARTED`, `ROUND_LOCKED`, `ROUND_RUNNING`, `TICK_UPDATE`/`MULTIPLIER_UPDATED`, `ROUND_CRASHED` (+proof), `STATE_SNAPSHOT` | fire-and-forget `roundRepo.save()` at each transition; errors swallowed | phase asserts throw; CRASHED w/o reset requires `recover()`; **no reload of persisted round on startup** |
| **FairnessEngine** (`src/core/fairness-engine`) | round IDs, client seeds, shaping-param setters | seed chain, `allocated` map, `usedCommits`, shaping params, owns VolatilityEngine | allocation `{hash, clientSeed, nonce, crashPoint, (now) proof}`; reveal | `data/fairness.json` (usedCommits, mix history) — not seeds/allocations | reveal of unknown round throws; load/save errors swallowed |
| **BettingEngine** (`src/core/betting-engine`) | `placeBet`, `cashout`, tick events | in-memory bet indexes, tick ledger, per-bet locks, in-flight cashouts | `BET_PLACED/REJECTED`, `PLAYER_CASHED_OUT`, `CASHOUT_REJECTED`, exposure alerts | bets via `BetRepository`; tick ledger flushed every 5 s | wallet reservation rolled back if repo save fails; duplicate/phase violations throw |
| **SettlementEngine** (`src/core/settlement-engine`) | `settle()` in CRASHED/SETTLED | credits winners, marks ACTIVE bets LOST under per-bet lock; (now) settled-round guard | `ROUND_SETTLED` | saves a SETTLED round copy | credit failure logged and skipped (bet stays CASHED_OUT & unpaid — manual review) |
| **WalletEngine** (`src/core/wallet-engine`) | credit/debit/reserve/commit/rollback | in-memory balances, reservations, reserved totals | none | **none — memory only** | throws on invalid/insufficient; rollback idempotent |
| **ExposureEngine** (`src/core/exposure-engine`) | bet lists | none (pure) | liability snapshots (assumes 100× for open bets w/o auto-cashout) | none | n/a |
| **UserBehaviorEngine** (`src/core/user-behavior`) | bet/cashout/loss records | per-user profiles (EWMA, loss streaks) | profiles → player-mix aggregation | none | errors swallowed |
| **VolatilityEngine** (`src/core/volatility-engine`) | round history, win/loss sums, player mix, hex entropy | system state (CALM/TENSION/CHAOS/RESET), elasticity, `tiltNextLow` flag | `adjustCrash(base, hex)` → final crash point | none | n/a |
| **RoundScheduler** (`src/runtime/round-scheduler`) | timers | drives BETTING→LOCKED→RUNNING→(crash)→settle→reset | — | — | logs, best-effort settle/reset, recovers CRASHED engine |
| **WebSocketGateway** (`src/runtime/websocket-gateway`) | client JSON messages | per-client request-id replay window, in-flight cashout set | mirrors selected events; ACTION_RESULT | — | validation rejects malformed input; `PLACE_BET` request-id is transport-level only (economic idempotency lives in BettingEngine) |

Key shared-mutable-state hazards found: singleton event bus (sync handlers), FairnessEngine⇄VolatilityEngine hidden state, BettingEngine in-memory indexes vs repository, wallet not persisted.

## 2. Prior-audit claims: verified vs overstated

Verified: engines compile and interoperate; vertical slice runs multi-round with bets/cashouts/settlement; commit–reveal hash chain is real (`sha256(serverSeed) == published hash`, seeds single-use); duplicate *sequential* cashout and double-commit are rejected.

Overstated: "functional" did not imply *safe*. The engine had 9 confirmed defects, including double settlement payouts, a sub-cent money-minting path, and a proof that could desync from the actual crash point. "Provably fair" is only partially justified (see §5).

## 3. Findings

Severity: **C**ritical / **H**igh / **M**edium / **L**ow. Each confirmed finding cites the test that reproduced it (all in `test/`).

### Confirmed vulnerabilities (fixed in this PR)

| ID | Sev | Component | Preconditions | Failure/attack path | Impact | Evidence (test) | Fix |
|---|---|---|---|---|---|---|---|
| V-1 | C | SettlementEngine | phase stays CRASHED after `settle()` | call `settle()` again (scheduler retry path exists) → winners credited again | unbounded fund creation | `settlement.test.ts` INV-S1/S3, `recovery.test.ts` restart replay | idempotency guard: in-memory settled-round set + durable check of persisted `SETTLED` phase |
| V-2 | C | Wallet + BettingEngine | none | bet `0.004999` with balance 0: reservation rounds to 0.00 and succeeds; bet records raw amount; payout floors to ≥ 0.01 at high multiplier | mint money from zero balance | `wallet.test.ts` INV-W8, `monetary-edges.test.ts` INV-M1 | wallet rejects amounts rounding below 0.01; bet stakes quantized to cents before reservation |
| V-3 | H | WalletEngine | outstanding reservation | `debit()` ignored reserved totals → debit + commit drives balance negative | negative balances / overdraft | `wallet.test.ts` INV-W7 + property test | debit checks `balance − reserved` |
| V-4 | H | BettingEngine | concurrent submissions | duplicate check was async (repo read) — 3 parallel `placeBet` all passed, 3 ACTIVE bets, 3 debits | multi-bet per round, exposure accounting broken | `betting-races.test.ts` V-R1 | synchronous `(user, round)` claim before any await |
| V-5 | H | BettingEngine | cashout queued behind a per-bet lock across the crash tick | phase checked only before the lock → cashout completed after CRASHED at last tick multiplier | pay a bet that lost | `betting-races.test.ts` V-R2 | phase re-checked inside the locked critical section |
| V-6 | H | GameEngine/FairnessEngine | shaping params or volatility state change between commitment and reveal (exposure steering does this automatically) | proof recomputed at crash with *current* state → published `proof.adjusted ≠ crashPoint` | unverifiable/false proofs; also double-consumed `tiltNextLow` | `fairness.test.ts` "proof matches actual crash point" | proof computed once at allocation, stored, and published verbatim at reveal |
| V-7 | M | VolatilityEngine | tilted player mix triggers near-miss | `tiltNextLow` path used `Math.random()` → nondeterministic, unverifiable outcome | outcome not reproducible from seed even with full state | `fairness.test.ts` determinism test | entropy derived from the round's HMAC hex |
| V-8 | M | BettingEngine | always | auto-cashout handler and tick-ledger handler shared one dedupe set → tick ledger never populated; cashouts silently used mutable `state.multiplier` | "server-authoritative tick" mechanism inert | `event-ordering.test.ts` tick tests | namespaced dedupe keys (`auto:`/`tick:`) |
| V-9 | L | BettingEngine | rejected cashout | `promise.finally()` chain produced unhandled rejections | process-level noise/crash risk (`unhandledRejection`) | vitest unhandled-error report | swallow the `.finally()` chain rejection |

### Confirmed design properties (documented, NOT changed — see fairness assessment)

- D-1: Exposure above `LIABILITY_THRESHOLD` (10 000) rewrites shaping params (volatility 1.5, divisor 20) for *subsequent* commitments (`fairness.test.ts` exposure-coupling test). The current round is unaffected (crash point fixed at allocation). UPDATE (fairness-transparency phase): no longer silent — the params in force are bound into each round's pre-bet `paramsCommit` and revealed at crash, so steering is auditable per round. Operator control over *which* params are committed remains a trust assumption (see docs/FAIRNESS.md §4).
- D-2: Player-behavior mix (conservative/greedy/tilted) and win/loss elasticity change crash outcomes for identical seeds (`fairness.test.ts` DOCUMENTED tests). UPDATE: the exact mix/elasticity used for a round is now committed pre-bet and revealed at crash — the influence is visible and provable, but still house-chosen at commitment time. The measured per-mix RTP impact is quantified in docs/FAIRNESS.md §5 (tilted players: ~57% RTP; scheduled tilt-low: ~0%).
- D-3: ~~The final `adjusted` crash point depends on hidden VolatilityEngine state and is not reconstructible from committed data alone~~ — CLOSED (fairness-transparency phase): a blinded commitment to the full crash mapping (shaping params + complete volatility snapshot) is published before betting and opened at crash; the standalone verifier (`src/core/fairness-engine/verifier.ts`) reconstructs the FINAL crash point from published data alone (INV-F6 now enforced; `fairness.test.ts` transparency suite).
- D-4: `startBetting()` while CRASHED auto-recovers (unsettled rounds are abandoned, not settled).

### Bounded risks

> **Update (persistence hardening phase):** B-1, B-2, B-3 and B-7 are now FIXED.
> - B-1: wallet state is durable via an append-only fsync'd write-ahead ledger (`src/core/wallet-engine/ledger.ts`); balances, reservations and per-mutation tx ids are replayed on construction (`test/wallet-ledger.test.ts`).
> - B-2: an explicit, idempotent startup recovery pass (`src/core/recovery-engine`) refunds/settles interrupted rounds per the documented policy in `docs/RECOVERY.md` and reconciles wallet reservations (`test/recovery.test.ts`).
> - B-3: bet/round writes are atomic (unique temp file + fsync + rename); corrupt files fail closed with `CorruptStateError` instead of reading as missing.
> - B-7: winner payouts carry the deterministic tx id `payout:<betId>` plus a durable `payoutPaid` marker; failed credits stay durably identifiable and are retried exactly-once by recovery.

- ~~B-1 (High for production): **Wallet is memory-only**~~ — FIXED, see above.
- ~~B-2 (High for production): **No startup recovery**~~ — FIXED, see above.
- ~~B-3: non-atomic `writeFile` in `FileBetRepository`/`FileRoundRepository`~~ — FIXED, see above.
- B-4: Synchronous event bus — one throwing subscriber breaks delivery to later subscribers with no isolation/retry (`event-ordering.test.ts`). Economic effects flow through direct calls, so replayed events move no funds, but UI/audit consumers can silently miss events.
- B-5: Tick ledger appends by arrival order; a late out-of-order tick becomes "latest" and would price the next cashout (`event-ordering.test.ts` DOCUMENTED). Single-process today (bus is in-proc, ordered), becomes real if ticks ever cross a network.
- B-6: `GameEngine.reset()` has no phase guard — a mid-RUNNING reset orphans active bets (`lifecycle.test.ts` BOUNDED RISK). Only the scheduler calls it today.
- ~~B-7: Settlement credit failure leaves a CASHED_OUT-but-unpaid bet with only a console log~~ — FIXED, see above.
- B-8: ExposureEngine assumes 100× liability for open bets without auto-cashout — conservative but crude; steering can trigger on a single 200-unit bet.

### False positives / verified-correct properties

- Concurrent duplicate **cashouts** were already single-flighted correctly (in-flight map + per-bet lock).
- Reservation IDs are single-use; rollback is idempotent; commit debits exactly once.
- Multiplier never exceeds `crashPoint` on any tick; it lands exactly on it.
- Lifecycle transitions cannot skip or go backwards; consecutive rounds don't contaminate each other.
- Seed commits are single-use (`usedCommits`, persisted); reveal matches commitment.
- WebSocket `PLACE_BET` lacking a request-id pass-through is *not* an economic hole: BettingEngine's own duplicate check (V-4 fix) is the idempotency layer.

### Unresolved / needs more evidence

- U-1: ~~House-edge distribution under volatility shaping unknown~~ — MEASURED (fairness-transparency phase, `npm run rtp:study`, 200k rounds/config, docs/FAIRNESS.md §5). Result: the nominal 1% edge does NOT hold. CALM ≈ 84% RTP (16% edge); CHAOS is house-LOSING (RTP up to ~209% at 3x+ cashouts) and is entered deterministically after 5 sub-1.5× crashes — an observable, exploitable +EV regime. Elasticity ≥ 2 and the RESET preset are also player-positive (RTP 1.5–1.7). This is now a confirmed economic defect (re-classified as finding E-1 below) rather than an unknown.
- U-2: `data/fairness.json` and `tick_ledger.json` are shared global paths (cwd-relative) — multi-instance deployments would collide.
- U-3: Admin/debug surface authentication was not exercised end-to-end (WS gateway has token checks; the debug HTTP surface was out of scope).

## 4. Test suite

- Runner: **Vitest 4** (`npm test` → `vitest run`; deterministic: fake timers, fixed-crash fairness stub, seeded LCG for property tests, forked single-file pool because engines share the singleton bus and `data/`).
- 8 files, **70 tests, 70 passing, 0 failing, 0 skipped** (stable across 5 runs). Legacy harness kept as `npm run test:legacy`.
- After the persistence hardening phase: 9 files, **94 tests, 94 passing** — added `wallet-ledger.test.ts` (durable ledger properties) and rewrote `recovery.test.ts` (the former DEFECT/DOCUMENTED-gap tests now assert the fixed behavior: restart survival, crash-point recovery, exactly-once payouts/refunds, atomicity, fail-closed corruption, recovery idempotency).
- After the fairness-transparency phase: **102 tests, 102 passing** — added a transparency suite in `fairness.test.ts` (commit/open of the crash mapping, full-crash reconstruction by the standalone verifier, tamper detection, multi-round evolution under changing hidden state, verification side-effect freedom).
- Coverage is invariant-driven, not line-driven: races (`betting-races`), wallet properties (`wallet`), monetary edges (`monetary-edges`), settlement (`settlement`), lifecycle (`lifecycle`), fairness+verifier (`fairness`), restart/persistence (`recovery`), event ordering (`event-ordering`).
- Intentionally not automated: real process-kill during a syscall (torn write simulated instead); WS transport delay tests (gateway logic covered at engine level, where the economic guarantees live).

## 5. Fairness assessment

**Question: can an observer who knows the current bets, exposure, and player behavior influence the final crash outcome after the fairness commitment has been made?**

**For the round in progress: NO.** Evidence chain: the crash point is computed inside `allocateNextSeed()` at `startBetting()` — the same call that produces the published hash — and stored in `RoundState`; nothing recomputes it (`tick()` only compares the multiplier against it). Tests: shaping params changed mid-round leave `crashPoint` unchanged (`fairness.test.ts` exposure-coupling test), and the published proof now provably describes the actual outcome (V-6 fix).

**For future rounds: YES — by design.** Exposure breaching the liability threshold rewrites shaping params; player-behavior aggregation sets the volatility player mix; wins/losses move elasticity; the operator can call `setShapingParams`/`setPlayerMixParams` at any time. All of these change the seed→crash mapping used at the *next* commitment. Because a round's commitment is published only at its own `startBetting()`, this is operator/state discretion over *uncommitted* rounds — a trust-model question, not a commitment violation.

**Is "provably fair" justified?** ~~Only partially~~ — UPDATED (fairness-transparency phase). A player can now verify after reveal: the seed matches the pre-bet hash, the full crash mapping (shaping params + complete volatility snapshot, including the tilt flag and player mix) matches the pre-bet blinded `paramsCommit`, and the FINAL crash point follows deterministically from the committed seed + committed mapping (`verifyRound` in `src/core/fairness-engine/verifier.ts`). What remains trusted: the operator's *choice* of mapping at commitment time — committed odds can still be player-hostile (tilted mix ≈ 57% RTP, scheduled tilt-low ≈ 0%), they are just no longer hidden or mutable after bets. The honest characterization is now: **"provably committed and fully reconstructible, with operator-chosen (but disclosed-at-reveal) per-round odds."** See docs/FAIRNESS.md for the complete trust model and the measured RTP table.

## 6. Invariants

See `docs/INVARIANTS.md` (machine-readable YAML-style list; each invariant maps to enforcing code and its test).

## 7. Recommended next phase (priority order, from findings)

1. ~~**Persistence hardening** (B-1/B-2/B-3/B-7)~~ — DONE: durable wallet write-ahead ledger, idempotent startup recovery, atomic repo writes, durable payout retry (`docs/RECOVERY.md`).
2. ~~**Fairness transparency** (D-1..D-3, U-1)~~ — DONE: blinded commit/reveal of the full crash mapping + standalone verifier (docs/FAIRNESS.md); RTP study run. NEW BLOCKER from the study — **E-1 (economic, HIGH)**: volatility regimes break the house edge in both directions (CHAOS/RESET/elasticity≥2 are player-positive up to ~2× RTP and CHAOS entry is publicly predictable; CALM ≈ 16% effective edge vs the advertised 1%). The shaping model needs an economic redesign or hard RTP bounds before real money.
3. **Monitoring/observability** (B-4/B-7): isolate event-bus subscribers, alert on settlement credit failures and invariant violations.
4. **Player-facing UI / deployment**: last — the engine is now internally consistent under the tested adversarial conditions, but 1–2 are prerequisites for production.

## 8. Source files modified and why

- `src/core/wallet-engine/index.ts` — reject sub-cent amounts (V-2); debit respects outstanding reservations (V-3).
- `src/core/betting-engine/index.ts` — quantize stakes to cents (V-2); synchronous duplicate-bet claim (V-4); phase re-check inside cashout lock (V-5); namespaced tick/auto dedupe keys (V-8); swallow `.finally()` chain rejection (V-9).
- `src/core/settlement-engine/index.ts` — settlement idempotency guard, in-memory + durable (V-1).
- `src/core/fairness-engine/index.ts` — proof computed once at allocation, stored, returned at reveal (V-6).
- `src/core/game-engine/index.ts` — emit the stored allocation proof instead of recomputing at crash (V-6).
- `src/core/volatility-engine/index.ts` — tilt-low path uses HMAC-derived entropy instead of `Math.random()` (V-7).
- `package.json` / `vitest.config.mts` — Vitest wiring (`npm test`), legacy harness kept as `test:legacy`.
- `test/**` — new suite (8 files, 70 tests) + `test/helpers/rig.ts` deterministic fixture.

Fairness-transparency phase:

- `src/core/volatility-engine/index.ts` — `VolatilitySnapshot` capture, pure static `adjustCrashPure` (all shaping constants read from committed params), side-effect-free instance wrapper.
- `src/core/fairness-engine/verifier.ts` — NEW: standalone engine-free verifier (`canonicalJson`, `computeParamsCommit`, `recomputeCrashPoint`, `verifyRound`).
- `src/core/fairness-engine/index.ts` — snapshot captured at allocation; blinded `paramsCommit` created pre-bet and opened at reveal; `computeProof` made side-effect free.
- `src/core/game-engine/index.ts` — publish `paramsCommit` in `ROUND_STARTED`; publish/persist the opening (`fairnessReveal`) at crash.
- `src/domains/game/types.ts` — typed `paramsCommit`/`fairnessReveal` on `RoundState` and the round events.
- `scripts/rtp-study.ts` — NEW: deterministic Monte-Carlo RTP/house-edge study (`npm run rtp:study`).
- `docs/FAIRNESS.md` — NEW: transparency architecture, trust model, RTP study results.
