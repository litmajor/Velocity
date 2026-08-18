# Fairness & Transparency

This document describes the fairness architecture after the transparency
hardening phase, the exact verification procedure available to players and
auditors, the trust model (what is cryptographically proven vs. what remains
trusted), and the measured RTP/house-edge behavior of the volatility layer.

## 1. What is committed, and when

Before any bet is accepted for a round, the server publishes (in
`ROUND_STARTED`):

| field | meaning |
|---|---|
| `serverHash` | `sha256(serverSeed)` — commitment to the seed |
| `clientSeed`, `nonce` | HMAC inputs, fixed pre-bet |
| `paramsCommit` | `sha256(canonicalJson({shaping, snapshot}) + ':' + paramsSalt)` — blinded commitment to the **entire crash mapping** |

The `snapshot` inside `paramsCommit` is a `VolatilitySnapshot` captured at seed
allocation. It freezes every input the volatility layer uses:

- `state` — system regime (CALM / TENSION / CHAOS / RESET)
- `playerMix` — conservative / greedy / tilted fractions
- `elasticity` — win/loss-driven shape modifier
- `profile` — the resolved, clamped `EdgeProfile {beta, lambda}` that fully
  determines the crash distribution (see docs/ECONOMICS.md)

The commitment is *blinded* with a random 16-byte `paramsSalt` so publishing it
pre-bet does not leak the shaping state (e.g. the current regime or the exact
edge profile) to players via dictionary lookup.

## 2. What is revealed, and when

At crash (`ROUND_CRASHED`), the server reveals:

- `serverSeed` (opens `serverHash`)
- `shapingParams`, `volatilitySnapshot`, `paramsSalt` (opens `paramsCommit`)
- the full `proof` (intermediate derivation values)

The opening is also persisted on the round record (`RoundState.fairnessReveal`)
so rounds can be audited offline from the data directory.

## 3. Independent verification

`src/core/fairness-engine/verifier.ts` is a standalone, engine-free verifier.
`verifyRound(commitment, reveal)` checks:

1. `sha256(serverSeed) === serverHash` — the seed did not change after bets.
2. `computeParamsCommit(shaping, snapshot, salt) === paramsCommit` — the
   mapping did not change after bets.
3. `recomputeCrashPoint(...) === crashPoint` — the published outcome is exactly
   what the committed seed + committed mapping produce. This recomputes the
   HMAC, instant-crash test, and the full bounded-edge inverse-CDF derivation
   via the pure `VolatilityEngine.crashFromRPure`, using **only published
   data** and no engine state.

This closes audit finding **INV-F6 / D-3**: the final adjusted crash point is
now reconstructible from committed/published data alone. Verification is also
side-effect free — `FairnessEngine.computeProof` no longer mutates volatility
state, so verification calls cannot perturb future rounds.

## 4. Trust model — proven vs. trusted

**Proven by cryptography + tests (post-commitment integrity):**

- The seed cannot change after bets are known (hash commitment).
- The complete crash mapping (shaping params + volatility snapshot) cannot
  change after bets are known (blinded hash commitment).
- The published crash point is exactly the committed mapping applied to the
  committed seed (pure recomputation by the verifier).
- Therefore: bets, exposure, and player behavior observed **during** a round
  cannot influence that round's outcome, and any tampering with the reveal is
  detectable by any observer.

**Still trusted (commitment-time operator control):**

- The operator chooses the shaping state *before* committing. Player-mix,
  exposure, and loss-streak signals from **previous** rounds legitimately feed
  the snapshot of the **next** round (D-1/D-2). The commitment makes this
  influence *auditable* (the snapshot is published at reveal, including the
  exact player-mix values and resolved edge profile) but does not remove it —
  and the economic contract now *bounds* it (docs/ECONOMICS.md §1).
- A player classified as "tilted" is committed to bounded extra edge (RTP
  floor ≈ 0.9405 vs ≈ 0.99 baseline — never worse than `BETA_MAX`; scheduled
  tilt-low rounds were removed in the economic-hardening phase). This is
  visible in the revealed snapshot; it is a declared, bounded design property.
  See docs/ECONOMICS.md §5.
- The usual provably-fair assumptions: honest client-seed handling,
  single-instance seed chain, and no seed-grinding at chain generation time.

## 5. RTP / house-edge study (audit items U-1 / E-1)

Reproduce with `npm run rtp:study` (or `npx tsx scripts/rtp-study.ts <N>`).
The study drives the exact production derivation (`recomputeCrashPoint`, the
same pure function the verifier uses) over deterministic seed streams.

The **pre-hardening** model measured CALM ≈ 0.84 RTP, CHAOS ≈ 2.07 RTP at 3×
(house-losing, publicly predictable entry), elasticity 2.0 ≈ 1.68, tilted ≈
0.57, scheduled tilt-low ≈ 0, exposure steering ≈ 0.56–0.66 — see finding E-1
and the root-cause derivation in docs/ECONOMICS.md §3.

**After the economic hardening** (bounded EdgeProfile model, ECONOMICS.md §4),
200,000 rounds per configuration; `RTP@mx = m × P(crash ≥ m)`; contract band
`[0.9405, 0.99]`; empirical ± 3σ / closed-form theory:

| configuration | median | p90 | p99 | P(instant) | RTP@1.2x | RTP@2x | RTP@3x | RTP@10x |
|---|---|---|---|---|---|---|---|---|
| DEFAULT / CALM | 1.94 | 9.57 | 97.2 | 0.97% | 0.983 / 0.982 | 0.970 / 0.968 | 0.966 / 0.961 | 0.956 / 0.953 |
| DEFAULT / TENSION | 1.95 | 9.69 | 96.8 | 1.03% | 0.987 / 0.987 | 0.979 / 0.981 | 0.973 / 0.977 | 0.969 / 0.970 |
| DEFAULT / CHAOS | 1.97 | 9.84 | 99.2 | 0.99% | 0.989 / 0.990 | 0.989 / 0.989 | 0.991 / 0.988 | 0.983 / 0.986 |
| DEFAULT / RESET | 1.97 | 9.87 | 97.0 | 1.02% | 0.989 / 0.989 | 0.988 / 0.987 | 0.986 / 0.986 | 0.988 / 0.983 |
| CALM / e=0.7 | 1.92 | 9.65 | 96.8 | 1.02% | 0.979 / 0.979 | 0.962 / 0.962 | 0.961 / 0.956 | 0.966 / 0.951 |
| CALM / e=2.0 | 1.95 | 9.53 | 95.5 | 0.97% | 0.987 / 0.986 | 0.977 / 0.977 | 0.969 / 0.971 | 0.954 / 0.960 |
| CALM / conservative=0.6 | 1.92 | 9.54 | 97.5 | 0.98% | 0.979 / 0.980 | 0.962 / 0.964 | 0.957 / 0.958 | 0.954 / 0.951 |
| CALM / greedy=0.6 | 1.94 | 9.51 | 92.9 | 1.01% | 0.983 / 0.984 | 0.970 / 0.971 | 0.962 / 0.965 | 0.951 / 0.955 |
| CALM / tilted=0.9 | 1.91 | 9.44 | 95.9 | 0.97% | 0.980 / 0.980 | 0.958 / 0.962 | 0.950 / 0.954 | 0.945 / 0.944 |
| EXPOSURE_STEERED | 1.92 | 9.32 | 95.7 | 0.95% | 0.980 / 0.980 | 0.962 / 0.962 | 0.952 / 0.954 | 0.929 / 0.944 |
| WORST CASE (tilted=1/steered/e=0.7) | 1.90 | 9.31 | 94.8 | 1.04% | 0.976 / 0.977 | 0.953 / 0.956 | 0.945 / 0.948 | 0.930 / 0.941 |

Every cell (and the full 1.2/1.5/2/3/5/10× set plus a log-spaced analytic
sweep of the entire multiplier range) lies inside the contract band. Adaptive
strategies over publicly observable state (wait-for-CHAOS, skip-CALM,
bet-after-lows, regime-switching, transition exploitation) are all ≤ 0.99 RTP
within 4σ — see `test/economics.test.ts` and docs/ECONOMICS.md §6.

### Limitations

- The strategy model is a fixed auto-cashout; real players cash out reactively,
  but for a pre-determined crash point RTP@m depends only on P(crash ≥ m), so
  fixed thresholds bound the strategy space per round.
- Live long-run RTP is a regime-occupancy mixture; because every regime lies
  inside the band pointwise, the mixture does too.
- Mean crash values are tail-dominated (the base distribution has infinite
  mean before the 10 000× cap); use median/quantiles.

## 6. Explicit non-claims

Passing tests and a verifiable commitment scheme do **not** make this model
production-ready for real money. The E-1 economic defect is fixed and
regression-tested (RTP bounded in `[0.9405, 0.99]` everywhere), but
multi-instance seed-chain safety (U-2), admin/debug authentication (U-3),
regulatory review of the disclosed RTP band, and operational hardening remain
open. See docs/ECONOMICS.md §7 for remaining economic risks.
