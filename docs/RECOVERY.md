# Persistence and Crash-Recovery Semantics

This document defines the intended behavior of the engine at every crash point,
the persistence model that backs it, and the recovery state machine executed at
startup. It was written *before* the implementation and the implementation is
tested against it (`test/recovery.test.ts`, `test/wallet-ledger.test.ts`,
`test/recovery-engine.test.ts`).

## Persistence model

Three durable stores, all file-based (no external database required by the
current single-process architecture):

1. **Wallet ledger** (`data/wallet.ledger`): append-only JSON-lines write-ahead
   log. Every economic mutation (`ENSURE`, `CREDIT`, `DEBIT`, `RESERVE`,
   `COMMIT`, `ROLLBACK`) is a single fsync'd line appended *before* the
   in-memory state mutates. Each record carries a unique `tx` id; replay
   dedupes on it, and callers can supply deterministic tx ids
   (`payout:<betId>`, `refund:<betId>`) to make retries exactly-once.
   On load: a torn *final* line (crash mid-append) is discarded — that
   mutation was never acknowledged; corruption *before* the final line fails
   closed (throws), because silently dropping acknowledged history could
   create or destroy funds.
2. **Bet repository** (`data/bets/<betId>.json`): one file per bet, written
   atomically (temp file → fsync → rename). Bets carry their durable economic
   markers: `reservationId` (`bet:<betId>`), `payoutPaid`, `status`
   (`ACTIVE | CASHED_OUT | LOST | REFUNDED`), `resolved`.
3. **Round repository** (`data/rounds/<roundId>.json`): one file per round,
   written atomically, saved at every phase transition.

Corrupt (unparseable) bet/round files fail closed: reads throw
`CorruptStateError` instead of being treated as "missing". A leftover `.tmp`
file from an interrupted atomic replacement is ignored (the previous complete
version, if any, is still the visible file).

## Transaction boundaries and idempotency identities

There are no cross-file transactions. Instead, every multi-step economic
operation is ordered so that each intermediate state is recoverable, and each
money movement has exactly one durable identity:

| Operation | Durable identity | Order |
|---|---|---|
| Stake reservation | ledger `RESERVE` with id `bet:<betId>` | reserve → save bet → commit |
| Stake capture | ledger `COMMIT bet:<betId>` | after bet file exists |
| Cashout | bet file `status=CASHED_OUT, payout, resolved` | single atomic file replace |
| Winner payout | ledger `CREDIT tx=payout:<betId>` + bet `payoutPaid=true` | credit → mark paid |
| Refund | ledger `CREDIT tx=refund:<betId>` (or `ROLLBACK bet:<betId>`) + bet `status=REFUNDED` | refund → mark |
| Round settled | round file `phase=SETTLED` | after all bets processed |

## Crash-point matrix

"Recovery" below = the startup `RecoveryEngine.recover()` pass. It is
idempotent: every action is conditioned on durable state (bet status, payout
markers, reservation existence, ledger tx ids), so running it N times equals
running it once.

| Crash point | What survives | What recovery does | Exactly-once guarantee |
|---|---|---|---|
| Before bet reservation | balance unchanged | nothing to do | no durable record → no effect |
| After `RESERVE`, before bet file save | reservation `bet:<betId>` in ledger, no bet file | rollback the orphan reservation (stake returned) | rollback is idempotent; no bet ever existed |
| After bet save, before `COMMIT` | ACTIVE bet + open reservation | round is dead (BETTING/LOCKED): bet REFUNDED via reservation rollback | reservation removed once; bet marked REFUNDED |
| After `COMMIT`, during BETTING/LOCKED | ACTIVE bet, stake captured | bet REFUNDED via `CREDIT refund:<betId>` | credit tx id dedupes on any retry |
| During RUNNING | round file RUNNING, bets ACTIVE/CASHED_OUT | round is void: ACTIVE bets refunded (`refund:<betId>`); completed cashouts honored and paid (`payout:<betId>`); round → SETTLED (recovered) | all via tx ids / status markers |
| After cashout persisted, before settlement | bet CASHED_OUT, `payoutPaid` unset | pay via `CREDIT payout:<betId>`, set `payoutPaid` | tx id + marker |
| During settlement, before a winner's credit | as above | same as above | same |
| After winner credit, before `payoutPaid` persisted | ledger has `payout:<betId>`; bet says unpaid | retry credit → ledger dedupes (no double pay) → set `payoutPaid` | THE core WAL property |
| After settlement persisted (round SETTLED) | everything | reconcile-only pass (verify no unpaid winners / stray ACTIVE bets) | settle() also refuses SETTLED rounds |
| During any repository write | old file (rename not executed) or new file; possibly a `.tmp` | reads see the last complete version; `.tmp` ignored | atomic rename |
| During a ledger append | complete prefix + torn final line | torn line dropped: the mutation was never acknowledged | write-ahead ordering |

### Round-phase recovery policy

- **BETTING / LOCKED**: round never ran → *void*: refund every non-resolved bet.
- **RUNNING**: outcome cannot be reconstructed (cashouts that "would have
  happened" are unknowable) → *void*: refund ACTIVE bets; pay already-recorded
  cashouts (they occurred at a recorded multiplier before the crash of the
  process, and the money is owed).
- **CRASHED (unsettled)**: outcome is known → complete settlement: pay unpaid
  CASHED_OUT bets, mark ACTIVE bets LOST (stake already captured — no wallet
  action).
- **SETTLED**: reconcile only — pay any unpaid winner, mark any stray ACTIVE
  bet LOST. A recovered/settled round can never be settled again
  (SettlementEngine refuses rounds whose persisted phase is SETTLED).

Recovered rounds are persisted as `phase=SETTLED` with `recovered: true` and a
`recoveryAction` note. Rounds are never silently abandoned.

### Reservation reconciliation (always runs last)

For every open wallet reservation `bet:<betId>`:
- bet file missing → **rollback** (crash was between reserve and bet save);
- bet REFUNDED → **rollback** (refund path chose rollback);
- bet exists otherwise → **commit** (the stake is owed; crash was between bet
  save and commit).

## What is proven vs assumed

Proven by tests: ledger replay correctness, torn-tail handling, fail-closed
corruption handling, refund/payout exactly-once across restarts and repeated
recovery runs, atomic repo writes, settlement idempotency across restart.

Assumed (not proven): the OS honors `fsync` (no lying disk layers); a single
process owns `data/` (no multi-instance coordination); `rename(2)` is atomic
on the target filesystem (true for POSIX local filesystems, not for some
network mounts).
