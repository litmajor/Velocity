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
- `tiltNextLow` — whether a forced-low round is scheduled
- `playerMix` — conservative / greedy / tilted fractions
- `playerMixParams` — all shaping constants (push factors, spike/near-miss
  probabilities, multipliers)
- `elasticity` — win/loss-driven modifier scale

The commitment is *blinded* with a random 16-byte `paramsSalt` so publishing it
pre-bet does not leak the shaping state (e.g. a scheduled tilt-low round, or
the current regime) to players via dictionary lookup.

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
   HMAC, instant-crash test, base crash, and the full volatility adjustment via
   the pure `VolatilityEngine.adjustCrashPure`, using **only published data**
   and no engine state.

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
  influence *auditable* (the snapshot is published at reveal, including
  `tiltNextLow` and the exact player-mix values) but does not remove it.
- A player classified as "tilted" is committed to systematically worse odds,
  and a scheduled tilt-low round has RTP ≈ 0 (see study below). This is now
  visible in the revealed snapshot, but it is still a house-favoring design
  property, not a bug.
- The usual provably-fair assumptions: honest client-seed handling,
  single-instance seed chain, and no seed-grinding at chain generation time.

## 5. RTP / house-edge study (audit item U-1)

Reproduce with `npm run rtp:study` (or `npx tsx scripts/rtp-study.ts <N>`).
The study drives the exact production derivation (`recomputeCrashPoint`, the
same pure function the verifier uses) over deterministic seed streams.

200,000 rounds per configuration. `RTP@mx = m × P(crash ≥ m)`;
house edge = 1 − RTP; values > 1 are **player-positive (house loses)**.

| configuration | mean | median | p90 | p99 | P(instant) | RTP@1.2x | RTP@1.5x | RTP@2x | RTP@3x | RTP@5x | RTP@10x |
|---|---|---|---|---|---|---|---|---|---|---|---|
| DEFAULT / CALM state / no mix / e=1.0 | 19.09 | 1.68 | 8.44 | 86.1 | 0.97% | 0.840 | 0.840 | 0.842 | 0.846 | 0.847 | 0.846 |
| DEFAULT / TENSION state / no mix / e=1.0 | 11.41 | 2.06 | 10.41 | 104.7 | 1.03% | 1.035 | 1.034 | 1.033 | 1.033 | 1.039 | 1.039 |
| DEFAULT / CHAOS state / no mix / e=1.0 | 24.22 | 4.15 | 20.85 | 209.0 | 0.99% | 1.188 | 1.460 | 1.801 | 2.074 | 2.075 | 2.091 |
| DEFAULT / RESET state / no mix / e=1.0 | 16.63 | 2.07 | 10.40 | 104.1 | 1.02% | 1.026 | 1.034 | 1.037 | 1.038 | 1.036 | 1.043 |
| DEFAULT / CALM / no mix / e=0.7 (contract) | 7.03 | 1.17 | 5.97 | 59.5 | 1.02% | 0.588 | 0.589 | 0.590 | 0.592 | 0.596 | 0.592 |
| DEFAULT / CALM / no mix / e=2.0 (expand) | 21.51 | 3.35 | 16.73 | 166.6 | 0.97% | 1.188 | 1.477 | 1.676 | 1.679 | 1.679 | 1.679 |
| DEFAULT / CALM / conservative=0.6 | 11.04 | 1.86 | 9.78 | 99.3 | 0.98% | 0.908 | 0.918 | 0.936 | 0.973 | 0.975 | 0.979 |
| DEFAULT / CALM / greedy=0.6 | 13.54 | 1.74 | 8.87 | 90.0 | 1.01% | 0.872 | 0.875 | 0.874 | 0.876 | 0.878 | 0.883 |
| DEFAULT / CALM / tilted=0.9 | 7.42 | 1.42 | 5.72 | 59.8 | 0.97% | 0.847 | 0.656 | 0.570 | 0.571 | 0.572 | 0.573 |
| DEFAULT / CALM / tilt-low SCHEDULED | 1.10 | 1.10 | 1.18 | 1.20 | 0.99% | 0.058 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 |
| CALM preset / CALM state | 14.92 | 1.97 | 10.40 | 107.5 | 0.32% | 0.930 | 0.961 | 0.986 | 1.012 | 1.031 | 1.041 |
| TENSION preset / TENSION state | 19.04 | 1.94 | 9.52 | 93.9 | 1.48% | 1.007 | 0.985 | 0.972 | 0.964 | 0.956 | 0.951 |
| CHAOS preset / CHAOS state | 16.76 | 3.17 | 13.54 | 134.1 | 5.61% | 1.133 | 1.368 | 1.617 | 1.625 | 1.438 | 1.362 |
| RESET preset / RESET state | 25.65 | 3.04 | 17.03 | 170.0 | 0.05% | 1.137 | 1.277 | 1.400 | 1.520 | 1.604 | 1.661 |
| EXPOSURE_STEERED / CALM state | 11.32 | 1.30 | 5.69 | 57.6 | 4.64% | 0.664 | 0.632 | 0.608 | 0.588 | 0.575 | 0.565 |

### Findings (U-1 → measured)

- **U-1a (economic risk, HIGH): several volatility regimes are house-losing.**
  The nominal 1% house edge only holds for the *base* crash; the volatility
  modifier destroys it in both directions. In the CHAOS system state a simple
  auto-cashout-at-3x strategy returns **~207%** of stake (house pays out more
  than double what it takes). Elasticity ≥ 2 and the RESET preset are also
  strongly player-positive (RTP 1.5–1.7). Since the CHAOS state is *entered
  deterministically after 5 consecutive sub-1.5× crashes* — publicly observable
  history — a player can wait for CHAOS regimes and bet only then. This is an
  exploitable +EV strategy against the current model.
- **U-1b: CALM (the most common regime) is strongly house-favoring** at ~84%
  RTP (16% effective edge), far from the advertised 1%.
- **U-1c: tilted players are committed to ~57% RTP** at ≥2× cashouts, and a
  scheduled tilt-low round is near-total loss (RTP ≈ 0 above 1.2×). This is
  now transparent in the revealed snapshot but is a severe per-player
  discrimination property.
- **U-1d: exposure steering cuts RTP to ~56–66%** whenever round liability
  crosses the ExposureEngine threshold.

### Limitations

- The strategy model is a fixed auto-cashout; real players cash out reactively,
  but for a pre-determined crash point RTP@m depends only on P(crash ≥ m), so
  fixed thresholds bound the strategy space per round.
- The study fixes one snapshot per configuration; live play transitions between
  regimes, so long-run RTP is a mixture weighted by regime occupancy (which
  itself depends on outcomes). The per-regime numbers above bound the mixture.
- 200k rounds per cell → binomial standard error on RTP ≲ 0.01 for m ≤ 3.
  Mean crash values are dominated by rare extreme outliers (the base
  distribution has infinite mean by construction); use median/quantiles.

## 6. Explicit non-claims

Passing tests and a verifiable commitment scheme do **not** make this model
production-ready for real money. The measured RTP dispersion (U-1a–d) is an
open economic defect: the model as tuned can be exploited (+EV regimes) and
misrepresents its nominal house edge. Multi-instance seed-chain safety (U-2)
and admin/debug authentication (U-3) also remain open.
