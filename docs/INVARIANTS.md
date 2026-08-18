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
    enforced_by: append-only fsync'd write-ahead ledger (WalletLedger); state replayed on construction
    test: test/wallet-ledger.test.ts, test/recovery.test.ts
    status: enforced
  - id: INV-W8b
    statement: Every economic mutation has exactly one durable identity (tx id) and is applied at most once, in-process and across restarts.
    enforced_by: appliedTx dedupe set rebuilt from the ledger; deterministic tx ids (payout:<betId>, refund:<betId>, reserve/commit/rollback:<resId>)
    test: test/wallet-ledger.test.ts, test/recovery.test.ts
    status: enforced
  - id: INV-W9
    statement: A committed reservation cannot commit again and a rolled-back reservation cannot roll back (or be reused) again, including after restart.
    enforced_by: reservation removal is replayed from the ledger; reservation ids are single-use (reserve:<id> tx dedupe)
    test: test/wallet-ledger.test.ts
    status: enforced

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
    statement: Every settled bet is terminal (CASHED_OUT, LOST or REFUNDED), never both paid and refunded; LOST/REFUNDED bets have payout 0.
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
    status: enforced (mid-round process kills are resolved by startup recovery - see INV-R1)
  - id: INV-S5
    statement: A winning payout is credited exactly once; a failed credit leaves the winner durably identifiable (CASHED_OUT with payoutPaid unset) and retryable.
    enforced_by: credit tx id payout:<betId> + durable payoutPaid marker on the bet; RecoveryEngine retries unpaid winners
    test: test/recovery.test.ts (failed-credit injection, credit-then-crash boundary)
    status: enforced

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
    enforced_by: blinded paramsCommit (sha256 over canonical shaping params + volatility snapshot + salt) published pre-bet, opened at crash; standalone verifier (fairness-engine/verifier.ts) recomputes the final crash via pure crashFromRPure
    test: test/fairness.test.ts (transparency suite - INV-F6 reconstruction, tamper detection, multi-round evolution)
    status: enforced
  - id: INV-F7
    statement: The crash mapping (shaping params + volatility snapshot) committed before betting is exactly the mapping revealed and used; any post-hoc substitution is detectable.
    enforced_by: paramsCommit binding + salt opening; snapshot captured at allocation and stored with the proof
    test: test/fairness.test.ts (tampered-reveal / swapped-seed tests)
    status: enforced
  - id: INV-F8
    statement: Verification is side-effect free - computeProof/computeCrashPoint never mutate volatility state, so audits cannot perturb future rounds.
    enforced_by: crashFromRPure/deriveProfile are static/pure; snapshot resolved once inside allocateNextSeed
    test: test/fairness.test.ts
    status: enforced

economic:
  - id: INV-E1
    statement: RTP(m) = m x P(crash >= m) lies in [(1-h)(1-BETA_MAX), 1-h] (= [0.9405, 0.99] at h=0.01) for EVERY multiplier m and EVERY committable configuration (regime, player mix, elasticity, exposure steering, shaping preset). No configuration is player-positive.
    enforced_by: bounded EdgeProfile model - RTP(m) = (1-h)*phi(m) with beta clamped to [0, BETA_MAX] and h to [HOUSE_EDGE_MIN, HOUSE_EDGE_MAX] INSIDE crashFromRPure/theoreticalSurvival (docs/ECONOMICS.md section 1)
    test: test/economics.test.ts (analytic log-spaced sweep of the whole multiplier range + empirical 4-sigma checks + hostile-snapshot clamping)
    status: enforced
  - id: INV-E2
    statement: Volatility (regime, mix, elasticity, steering) changes only WHERE within the bounded band the edge accrues (distribution shape), never whether the game is player-positive; the crash point is never multiplied and the uniform draw is never warped.
    enforced_by: all shaping funnels through deriveProfile into a committed {beta, lambda}; crashFromRPure is the exact inverse CDF of the committed distribution
    test: test/economics.test.ts (monotonicity + empirical-vs-theory), test/fairness.test.ts
    status: enforced
  - id: INV-E3
    statement: No strategy using only publicly observable state (regime, crash history, transitions) has expected return above 1-h per unit staked.
    enforced_by: pointwise RTP ceiling (INV-E1) makes every bet a <=(1-h) expectation regardless of round/multiplier selection
    test: test/economics.test.ts (11 adaptive strategies over a 150k-round stream with real regime evolution)
    status: enforced
  - id: INV-E4
    statement: Instant-crash probability equals the committed house edge h exactly; cent-flooring and the 10000x cap only remove player value (house-favoring), never add it.
    enforced_by: r < h instant-crash region in crashFromRPure; Math.floor to cents; CRASH_CAP truncation
    test: test/economics.test.ts (distribution-properties suite)
    status: enforced

recovery:
  - id: INV-R1
    statement: A process restart leaves the system economically consistent (no lost balances, no orphaned ACTIVE bets, no double settlement, no unpaid winners).
    enforced_by: durable wallet ledger + RecoveryEngine startup pass (docs/RECOVERY.md policy - refund voided rounds, complete CRASHED rounds, retry unpaid payouts, reconcile reservations)
    test: test/recovery.test.ts
    status: enforced
  - id: INV-R3
    statement: Startup recovery is idempotent - running it N times produces the same economic state as running it once.
    enforced_by: every recovery action conditioned on durable state (bet status, payoutPaid, reservation existence) and deterministic tx ids
    test: test/recovery.test.ts (N-runs snapshot equality)
    status: enforced
  - id: INV-R4
    statement: A corrupt persistence file is never treated as missing state - reads and recovery fail closed.
    enforced_by: CorruptStateError from repositories; CorruptLedgerError for non-tail ledger corruption; torn ledger tail (unacknowledged append) is the only discarded data
    test: test/recovery.test.ts, test/wallet-ledger.test.ts
    status: enforced
  - id: INV-R5
    statement: Bet/round repository writes are atomic - a kill mid-write leaves the previous complete file, never a torn one, under the target name.
    enforced_by: unique temp file + fsync + rename in writeFileAtomic; readers ignore *.tmp
    test: test/recovery.test.ts
    status: enforced
  - id: INV-R2
    statement: Event replay/duplication has no economic effect (funds move only through direct engine calls).
    enforced_by: economic paths are call-based; tick dedupe by (roundId, tickIndex)
    test: test/event-ordering.test.ts
    status: enforced
```
