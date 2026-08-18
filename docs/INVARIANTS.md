# Core Economic and Lifecycle Invariants

Machine-readable list. Each invariant names the enforcing code and the test that verifies it.
Status: `enforced` (code guarantees it, test green) or `documented-gap` (violated by design today; see docs/AUDIT.md bounded risks).

```yaml
wallet:
  - id: INV-W1
    statement: A user balance can never become negative.
    enforced_by: WalletEngine.debit/reserve/commit (balance - reserved checks)
    test: test/wallet.test.ts
    status: enforced
  - id: INV-W2
    statement: Total reserved funds for a user cannot exceed their balance.
    enforced_by: WalletEngine.reserve
    test: test/wallet.test.ts
    status: enforced
  - id: INV-W3
    statement: Reservation ids are single-use; commit applies its debit exactly once; rollback is idempotent.
    enforced_by: WalletEngine.reserve/commit/rollback
    test: test/wallet.test.ts
    status: enforced
  - id: INV-W4
    statement: A failed reserve/debit/credit leaves wallet state unchanged.
    enforced_by: WalletEngine (validate-before-mutate)
    test: test/wallet.test.ts
    status: enforced
  - id: INV-W5
    statement: No wallet operation may move an amount that rounds below 0.01 (no sub-cent value creation).
    enforced_by: WalletEngine rounded < 0.01 guards
    test: test/wallet.test.ts (INV-W8), test/monetary-edges.test.ts (INV-M1)
    status: enforced
  - id: INV-W6
    statement: Funds are conserved - final balances equal initial + credits - debits.
    enforced_by: arithmetic on 2dp-quantized amounts
    test: test/wallet.test.ts (property test), test/monetary-edges.test.ts
    status: enforced
  - id: INV-W7
    statement: Wallet state survives a process restart.
    enforced_by: nothing (memory only)
    test: test/recovery.test.ts (DEFECT test documents the gap)
    status: documented-gap

betting:
  - id: INV-B1
    statement: A user can hold at most one bet per round, under any concurrency.
    enforced_by: BettingEngine.placeBet synchronous pendingBets/userRound claim
    test: test/betting-races.test.ts
    status: enforced
  - id: INV-B2
    statement: Bets are only accepted during BETTING phase.
    enforced_by: BettingEngine.placeBet phase check
    test: test/betting-races.test.ts
    status: enforced
  - id: INV-B3
    statement: The recorded bet amount always equals the amount reserved/debited (cent-quantized).
    enforced_by: BettingEngine.placeBet stake quantization
    test: test/monetary-edges.test.ts
    status: enforced
  - id: INV-B4
    statement: A cashout can only complete while the round is RUNNING, including after waiting on a lock.
    enforced_by: BettingEngine.cashout phase re-check inside the bet-lock critical section
    test: test/betting-races.test.ts
    status: enforced
  - id: INV-B5
    statement: Cashout has exactly-once economic effect per bet under duplicate/concurrent requests.
    enforced_by: inflightCashouts single-flight + per-bet lock + resolved flag
    test: test/betting-races.test.ts, test/event-ordering.test.ts
    status: enforced
  - id: INV-B6
    statement: Cashout payout never exceeds amount x multiplier, and the multiplier never exceeds the crash point.
    enforced_by: floor-to-cents payout; GameEngine.tick caps multiplier at crashPoint
    test: test/monetary-edges.test.ts, test/lifecycle.test.ts
    status: enforced

settlement:
  - id: INV-S1
    statement: A round is settled at most once; repeat settle() calls move no funds and emit no events.
    enforced_by: SettlementEngine settledRounds set + persisted SETTLED-phase check
    test: test/settlement.test.ts, test/recovery.test.ts
    status: enforced
  - id: INV-S2
    statement: Every settled bet is terminal (CASHED_OUT or LOST), never both paid and refunded; LOST bets have payout 0.
    enforced_by: per-bet lock in settle(); resolved flag
    test: test/settlement.test.ts
    status: enforced
  - id: INV-S3
    statement: Settlement cannot create funds - total payouts equal the sum of individual cashout payouts.
    enforced_by: credits only bet.payout recorded at cashout
    test: test/settlement.test.ts, test/monetary-edges.test.ts
    status: enforced
  - id: INV-S4
    statement: Every accepted bet reaches a terminal state within its round's normal lifecycle.
    enforced_by: settle() marks all non-cashed bets LOST
    test: test/settlement.test.ts, test/lifecycle.test.ts
    status: enforced (gap on mid-round process kill - see INV-R1)

lifecycle:
  - id: INV-L1
    statement: Phases advance only BETTING -> LOCKED -> RUNNING -> CRASHED -> SETTLED; no skips, no backward transitions.
    enforced_by: GameEngine.assertPhase on every transition
    test: test/lifecycle.test.ts
    status: enforced
  - id: INV-L2
    statement: Consecutive rounds do not contaminate each other (unique round ids, per-round bet indexes).
    enforced_by: fresh RoundState per startBetting; round-scoped indexes
    test: test/lifecycle.test.ts
    status: enforced
  - id: INV-L3
    statement: Exactly one ROUND_CRASHED and one ROUND_SETTLED event per round.
    enforced_by: timer cleared at crash; settlement idempotency guard
    test: test/lifecycle.test.ts, test/settlement.test.ts
    status: enforced

fairness:
  - id: INV-F1
    statement: The revealed server seed always hashes to the pre-bet published commitment.
    enforced_by: FairnessEngine seed chain (commit = sha256(secret))
    test: test/fairness.test.ts
    status: enforced
  - id: INV-F2
    statement: Seed commitments are single-use (no seed reuse across rounds).
    enforced_by: usedCommits set (persisted)
    test: test/fairness.test.ts
    status: enforced
  - id: INV-F3
    statement: The crash point is fixed at commitment time; no post-commitment input (bets, exposure, params) changes the committed round's outcome.
    enforced_by: crashPoint computed inside allocateNextSeed, stored in RoundState
    test: test/fairness.test.ts (exposure-coupling test)
    status: enforced
  - id: INV-F4
    statement: The published proof describes the actual crash point used, byte-for-byte.
    enforced_by: proof computed once at allocation, stored, emitted verbatim at reveal
    test: test/fairness.test.ts
    status: enforced
  - id: INV-F5
    statement: Crash derivation is fully deterministic (no Math.random anywhere in the outcome path).
    enforced_by: VolatilityEngine hex-derived entropy
    test: test/fairness.test.ts (determinism test)
    status: enforced
  - id: INV-F6
    statement: The full seed-to-final-crash mapping is reconstructible by an outside verifier from committed/published data.
    enforced_by: only baseCrash is (independent verifier); the adjustCrash layer depends on hidden volatility state
    test: test/fairness.test.ts (hidden-state test)
    status: documented-gap

recovery:
  - id: INV-R1
    statement: A process restart leaves the system economically consistent (no lost balances, no orphaned ACTIVE bets, no double settlement).
    enforced_by: partial - bets/rounds persisted, settlement replay blocked via persisted SETTLED phase; wallet and in-flight round state are not recovered
    test: test/recovery.test.ts
    status: documented-gap (see AUDIT.md B-1/B-2)
  - id: INV-R2
    statement: Event replay/duplication has no economic effect (funds move only through direct engine calls).
    enforced_by: economic paths are call-based; tick dedupe by (roundId, tickIndex)
    test: test/event-ordering.test.ts
    status: enforced
```
