# Velocity — Deployment Safety, Admin Security, and Durability Model

Date: 2026-08-18 · Branch: `devin/1787063224-deployment-hardening`
Method: code inspection + deterministic automated tests, including **real two-OS-process race tests** sharing one data directory (`test/multi-instance.test.ts`, worker: `test/helpers/instance-worker.ts`), crash injection via SIGKILL at persistence boundaries, and admin/WebSocket authorization tests (`test/admin-security.test.ts`, `test/durability.test.ts`).

This document is the U-2 (multi-instance), U-3 (admin/debug security), and durability deliverable. The economic and fairness model is unchanged.

---

## 1. Deployment invariant (the headline)

**Velocity is a single-writer system. Exactly one process may own a data directory at a time.**

This is now *enforced*, not assumed: the bootstrap (`src/vertical-slice.ts`) acquires an exclusive on-disk instance lock (`data/instance.lock`, `src/runtime/instance-lock.ts`) via `O_CREAT|O_EXCL` before constructing any engine. A second process pointed at the same `DATA_DIR` exits fatally at startup. A lock left by a dead process on the same host is detected (PID liveness probe) and taken over; a lock recorded by a *different hostname* is never treated as stale.

Consequences:

- **Same-host double-start:** prevented (tested: two real processes race to acquire; exactly one wins).
- **Crash + restart on the same host:** automatic takeover of the stale lock (tested).
- **Two hosts sharing a network filesystem:** the lock *cannot* verify remote PID liveness, so a crashed remote owner requires manual `instance.lock` removal. `O_EXCL` is also not reliable on NFS. **Do not deploy multiple hosts against a shared data directory.** This is a documented deployment constraint, not a solved problem.

Why single-writer (and not a distributed mechanism): every engine keeps authoritative state in process memory — wallet balances/reservations, the fairness seed chain and `allocated` map, bet indexes and per-bet locks, the settlement guard, scheduler timers, and the synchronous singleton event bus. No file locking scheme can make concurrent read-modify-write of `fairness.json`, `tick_ledger.json`, or the wallet ledger safe without moving that state into a transactional store. The minimum mechanism the *actual architecture* supports is exclusive ownership, plus a durable per-round settlement claim as defense in depth for the one operation (settlement) where a second writer could mint money.

## 2. Multi-instance audit (U-2)

Format: resource / current owner / concurrency hazard / reproduction / severity / mitigation.

| Resource | Owner | Hazard under 2 processes | Reproduction | Sev | Mitigation |
|---|---|---|---|---|---|
| `data/fairness.json` (`usedCommits`, mix history) | FairnessEngine (memory) + sync save on allocate | Last-writer-wins overwrite: process B's save can erase commits recorded by A → a voided commit could be re-considered "unused" | two engines saving alternately over one file | **C** | instance lock (single writer). Within one writer: save is synchronous+fsynced *before* an allocation is returned (tested in `durability.test.ts`) |
| Seed chain + `allocated` map | FairnessEngine memory only (never persisted) | independent chains per process; conflicting reveals for one round | two engines allocate for the same roundId | **C** | instance lock. Note: chains are per-process random; even two unlocked processes cannot produce the *same* commitment (tested: disjoint commitments), but they could each publish a *different* commitment for one round — lock prevents round ownership from splitting |
| `data/tick_ledger.json` | BettingEngine memory, flushed every 5 s | last-writer-wins; interleaved flushes lose ticks | two engines flushing | **H** | instance lock |
| `data/rounds/*.json` | GameEngine/scheduler (fire-and-forget saves) | both processes drive the same round through conflicting phases | two schedulers | **C** | instance lock |
| `data/bets/*.json` | BettingEngine per-bet in-memory locks | per-bet locks are process-local → concurrent cashout/settle on one bet | two processes cashing out one bet | **C** | instance lock |
| `data/wallet.ledger` (append-only, fsync per record) | WalletEngine memory replayed from ledger | balance validation happens against a stale in-memory view; two processes both see "refund not applied" and both append it → **double credit** | two recovery runs without the lock | **C** | instance lock; recovery workers acquire it (tested: concurrent recovery admits exactly one; refund applied exactly once) |
| Settlement guard (`settledRounds` Set) | SettlementEngine memory | both processes settle one round → double payout | two `settle()` calls | **C** | durable per-round claim file `data/settlements/<roundId>.claim` created `O_EXCL`+fsync **before** any economic effect; exactly one process can ever win it (tested with two real processes) |
| In-flight cashout map, request-id replay window | BettingEngine / gateway memory | process-local dedup only | — | H | instance lock |
| Scheduler timers | RoundScheduler memory | two schedulers both drive rounds | — | **C** | instance lock |
| Singleton event bus | per-process `EventEmitter` | events never cross processes; consumers in B never see A's events | — | H (silent divergence) | instance lock |
| cwd-relative `data/` path | `process.cwd()` + `DATA_DIR` | two "different" deployments accidentally share state when started from one cwd | — | M | lock converts accidental sharing into a fatal startup error |

**Verdict:** with the lock, all "verify" items hold trivially (single writer) plus are directly tested where a mechanism exists beyond the lock (settlement claims, allocation durability, recovery idempotency). Without the lock, concurrent operation is **unsafe by design** — the lock is the deployment invariant.

## 3. Resource → writer → synchronization → failure/recovery

| Resource | Writer | Synchronization | Failure/recovery behavior |
|---|---|---|---|
| all of `data/` | the single locked process | `instance.lock` (`O_EXCL`, PID+hostname+fsync) | crash leaves stale lock; same-host restart probes PID and takes over; other-host lock requires manual intervention |
| round settlement | SettlementEngine | durable claim file per round (`O_EXCL`) + deterministic wallet tx ids (`payout:<betId>`, `refund:<betId>`) + `payoutPaid` markers | crash after claim: recovery completes payment from durable round/bet state; crash after credit: tx-id dedup prevents double pay (both SIGKILL-tested) |
| wallet | WalletEngine | append-only ledger, fsync per record, replay on start | committed records survive crash; recovery replays and dedups by tx id |
| fairness commitments | FairnessEngine | `usedCommits` saved synchronously (fsync) before allocation returns | restart loses the in-memory allocation → the round is voided/refunded by recovery; the commitment can never be re-issued (tested) |
| rounds/bets | Game/Betting engines | atomic temp+fsync+rename(+dir fsync) per file | torn writes impossible to observe; recovery reads last durable state |

## 4. Admin/debug security audit (U-3)

### Endpoint inventory

| Endpoint | Auth | Authorization | Mutation capability | Sensitive info | Production? | Failure behavior |
|---|---|---|---|---|---|---|
| HTTP `POST /admin/player-mix-params` | `Bearer <ADMIN_TOKEN>` (constant-time) | single admin role | **yes — shaping/player-mix params (economic)** | — | yes, token required | 503 if no token configured (fail closed); 401 on missing/malformed/wrong credentials; params unchanged (tested) |
| HTTP `GET /admin/state` | same | same | no | shaping params, exposure, round state | yes | 503/401 as above; body leaks nothing pre-auth (tested) |
| HTTP any other path | same gate (auth before routing) | same | no | — | — | 401 unauthenticated; 404 only after auth (tested) |
| WS connect | optional `WS_CLIENT_TOKEN` (constant-time) | player | no | public round state | yes | close 4001 on wrong token when configured (tested). **If unset, connections are open** — intended for public players; economic actions are still validated per user |
| WS `ADMIN` | `WS_ADMIN_TOKEN` (constant-time) | admin flag → full event mirror | no direct mutation; privileged visibility | all event tiers | yes | denied when token unset (fail closed — empty/`"undefined"` tokens rejected; tested) |
| WS `PLACE_BET` / `CASHOUT` | connection-level only | per-`userId` economic validation in BettingEngine | yes (economic) | — | yes | rejected outside betting phase / insufficient funds; wallet untouched on rejection (tested). **Note:** `userId` is client-asserted — player identity/session auth is future UI-integration work, documented as a known boundary |
| WS unknown/debug actions | — | — | none | — | — | `Unknown action` error; no debug routes exist (tested) |

There are no other HTTP servers, debug routes, or REPL surfaces in `src/` (verified by enumeration of `http.createServer`/`WebSocketServer` call sites).

### Tested attack surface
No credentials, invalid credentials, malformed headers (missing scheme, wrong scheme, case-mangled, empty token), repeated failures, unknown routes, and — beyond status codes — **that unauthorized calls cause no economic state transition** (player-mix params unchanged, wallet balances unchanged).

## 5. Durability model

For each operation: persistence boundary / crash behavior / recovery behavior.

| Operation | Persistence boundary | Process-crash behavior | Recovery behavior |
|---|---|---|---|
| wallet mutation (credit/debit/reserve/commit/rollback) | ledger append + `fsync` **before** the in-memory apply | record durable at return; crash mid-append leaves a torn final line, skipped on replay (pre-existing tested behavior) | replay ledger; dedup by tx id |
| bet persistence / cashout | atomic JSON write (temp + file fsync + rename + parent-dir fsync) | old or new version visible, never torn | recovery reconciles bet status against round outcome |
| settlement claim | `O_EXCL` create + fsync | claim durable before any credit | claimed-but-incomplete round is completed by recovery from durable state (SIGKILL-tested at after-claim and after-credit) |
| winner credit / refund | deterministic tx id in ledger | exactly-once by tx-id dedup | idempotent on re-run (tested) |
| round persistence | atomic JSON write | old or new phase visible | scheduler/recovery resumes from durable phase |
| seed allocation | `fairness.json` synchronous atomic write + fsync **before** allocation is returned | used commit durable; seed material intentionally memory-only | round with lost allocation is voided/refunded; commit never re-issued |
| fairness reveal | reveal is derived from memory; only used commits persist | restart before reveal → reveal impossible (tested) | round voided; fairness proof integrity preserved (never two commitments for one round) |

### Atomicity vs process-crash durability vs power-loss durability

- **Atomic visibility:** yes, for all JSON state — unique temp file + rename means readers see old-or-new, never torn (tested, including tmp-file leftovers).
- **Process-crash durability:** yes — every economic write point fsyncs file data before it is relied upon (wallet ledger per record; JSON files before rename; claim/lock files at create), and parent directories are fsynced after rename/create so the *directory entry* survives too.
- **Power-loss durability:** **qualified.** On Linux ext4/xfs with default mount options the file-fsync + rename + parent-directory-fsync sequence makes completed writes power-loss durable. However: (a) directory fsync is best-effort — on filesystems/platforms that reject directory `fsync` (e.g. some network filesystems, Windows), the rename itself may be lost on power failure, exposing the *previous* version of the file (never a torn one); (b) the disk's own write cache is outside our control (no `O_DSYNC`/barrier configuration); (c) the wallet ledger fsyncs data but not its directory entry per append — the ledger file's *creation* is directory-fsynced, appends extend an existing inode and are covered by file fsync. We claim: **completed operations survive power loss on a conventional local Linux filesystem with write barriers enabled; on other platforms the guarantee degrades to atomic old-or-new visibility.** We do not claim more.

## 6. Crash-injection matrix

Existing suite (`test/recovery.test.ts`, kept green) covers in-process fault injection around wallet mutation, reservation, bet/cashout persistence, payout, refund, torn files, and recovery idempotency. New real-process SIGKILL injection (`test/multi-instance.test.ts`):

| Kill point | Expected state after restart + recovery | Result |
|---|---|---|
| holding the instance lock | stale lock detected, ownership taken over | pass |
| immediately after settlement claim, before any credit | claim durable, zero economic effect; recovery pays winner exactly once, marks losers, settles round; `settle()` can never re-run | pass |
| immediately after winner credit, before `payoutPaid` marker | one durable ledger credit; recovery dedups by tx id — still exactly one credit, marker completed | pass |
| after seed allocation, before reveal (process restart) | commitment durably used, reveal impossible, round voided, commitment never re-issued | pass |

## 7. Economic invariants under concurrency

The existing invariant suite (130 tests) is unchanged and green. The two-process tests additionally verify, from durable state only: no double settlement, no double payout, no double refund, funds conserved across crash/restart (winner 125.00 exactly, loser stake debited once), exactly one final round state, single-use reservation ids (ledger replay), and no lost bets/wallet records.

## 8. Final assessment

- **Single-instance deployment: safe**, within the durability model above. Startup enforces exclusive ownership; recovery is idempotent; settlement is exactly-once across crash/restart.
- **Multi-instance deployment (shared data directory): not safe and now impossible to do accidentally** on one host. Scaling beyond one process requires moving wallet/fairness/round state into a transactional store with advisory locks or leases — a deliberate architectural change, out of scope here.
- **Admin surface: production-safe** with `ADMIN_TOKEN`/`WS_ADMIN_TOKEN` configured (fail-closed when not). Remaining gap: WebSocket *player* identity is client-asserted (`userId` in the payload) — acceptable for the current phase, must be replaced by real session auth during UI integration.
- **Persistence guarantees:** atomic visibility everywhere; process-crash durability everywhere it matters; power-loss durability qualified as in §5.
- **Blocker-class risks remaining:** none for single-host, single-instance operation. Bounded risks: shared-network-filesystem locking (documented as unsupported), disk write cache behavior, client-asserted WS identity.
