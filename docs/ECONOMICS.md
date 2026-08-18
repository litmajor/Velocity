# Economic Model Specification

This document defines the economic contract of the crash game after the
economic-hardening phase: the base distribution, the mathematical root cause of
the previous RTP distortion (audit finding E-1), the redesigned volatility
layer, and the statistical methodology used to test it.

## 1. The economic contract (the invariant)

Let `h` be the configured house edge (default `0.01`) and `m` a cashout
multiplier. For a pre-determined crash point, the return of an auto-cashout at
`m` is fully determined by the survival function:

```
RTP(m) = m × P(crash ≥ m)
```

**Contract:** for EVERY committed configuration (regime, player mix,
elasticity, exposure steering, shaping preset) and EVERY multiplier
`m ∈ (1, CRASH_CAP]`:

```
(1 − h) × (1 − BETA_MAX)  ≤  RTP(m)  ≤  (1 − h)
```

With `h = 0.01` and `BETA_MAX = 0.05` this is `RTP(m) ∈ [0.9405, 0.99]`, i.e.
an effective house edge between 1% and ~6% everywhere, never player-positive.

This is a deliberately *weaker* invariant than `RTP(m) = 1 − h` for all `m`:

- RTP **may vary by regime** (CALM/TENSION/CHAOS/RESET) and **by committed
  player classification / exposure steering — but only inside the band**, and
  every input that moves it is part of the pre-bet blinded commitment and the
  post-crash reveal, so the variation is bounded, declared, and auditable.
- Volatility changes **where** the extra edge (up to `BETA_MAX`) accrues along
  the multiplier axis (shape/variance), never whether the game is
  player-positive.

Chosen constants (exported from `src/core/volatility-engine`):

| constant | value | meaning |
|---|---|---|
| `BETA_MAX` | 0.05 | max extra edge any profile may accrue |
| `LAMBDA_MIN/MAX` | 0.05 / 3.0 | bounds on where the edge accrues |
| `HOUSE_EDGE_MIN/MAX` | 0.001 / 0.02 | bounds on the committed base edge |
| `CRASH_CAP` | 10 000 | tail truncation (house-favoring) |

## 2. Base distribution

The seed-derived uniform is `r = int(hmac[0..13]) / 2^52 ∈ [0, 1)`.
With `β = 0` the mapping is the classical provably-fair crash curve:

- `r < h` → instant crash at 1.00 (probability exactly `h`).
- otherwise `crash = (1 − h) / (1 − r)`, floored to cents.

Its survival function is `S(m) = P(crash ≥ m) = (1 − h)/m`, hence
`RTP(m) = m·S(m) = 1 − h` for every `m` — a constant 1% edge. This is the
Pareto(α=1) curve: **infinite mean**, median ≈ `2(1−h)`. Cent-flooring and the
`CRASH_CAP` truncation only remove player value (house-favoring), by less than
0.5% at any tested `m`.

## 3. Root cause of the E-1 distortion (before)

The previous volatility layer did two things to this curve:

1. **Warped the uniform:** `r ← r^volatility`. For `vol > 1` this pushes mass
   toward 0... but the crash mapping uses `1/(1−r)`, so *smaller* `r` means
   *smaller* crash — except the instant-crash test and modifier ranges were
   tuned against the unwarped curve, mis-scaling `P(crash ≥ m)` at every `m`.
2. **Multiplied the crash point:** `crash ← crash × modifier`, with modifier
   ranges per regime (CALM `[0.7,1.0]`, CHAOS `[1.2,3.0]`, ...), then by
   `elasticity`, plus player-mix branches and scheduled tilt-low rounds.

The mathematical failure is (2). If `X` has survival `c/m` (Pareto tail) and
you multiply by a constant `k`, the new survival at `m` is `P(kX ≥ m) =
c·k/m` — the entire RTP curve is scaled by `k`:

```
RTP_new(m) = k × RTP_base(m)
```

So CHAOS with an average modifier ≈ 2.1 produced RTP ≈ 2.07 (house-losing,
E-1a), CALM with average modifier ≈ 0.85 produced RTP ≈ 0.84 (16% edge,
E-1b), elasticity 2.0 scaled RTP to ~1.68, tilt-low clamped crashes below
1.2 (RTP → 0 above it, E-1c), and exposure steering (vol=1.5 warp + divisor
20) produced ~0.56–0.66 (E-1d). Because the modifier was drawn from a range,
the effect was a mixture of scalings, not a single `k` — but the expectation
argument above is exact for each draw, which is why the measured distortion
matched `E[modifier]` so closely. **Multiplying a Pareto-tailed variable moves
expected return one-for-one; it can never be a variance-only knob.**

## 4. The redesigned layer (after): bounded edge profiles

All volatility influence now funnels into a committed `EdgeProfile
{beta, lambda}` and the crash point is drawn directly from the profile's
distribution — nothing multiplies the crash point and nothing warps `r`.

```
φ(m)  = 1 − β·(1 − m^(−λ))          (φ(1)=1, φ(∞)=1−β, monotone ↓)
S(m)  = (1 − h) · φ(m) / m           survival function
RTP(m) = m·S(m) = (1 − h)·φ(m) ∈ [(1−h)(1−β), 1−h]   for every m
```

`crashFromRPure(r, h, snapshot)` inverts `S` deterministically: instant crash
iff `r < h`, otherwise solve `u·m = (1−h)·φ(m)` for `u = 1−r` by a fixed
64-step bisection on `[1, CRASH_CAP]`, floor to cents. `β` and `λ` (and `h`)
are **re-clamped inside the pure function**, so no committed snapshot —
however constructed or tampered — can escape the band.

Semantics of the shape parameters:

- `β` ("extra edge"): how much RTP decays from `1−h` toward `(1−h)(1−β)` as
  `m` grows. `β = 0` is the pure base curve.
- `λ` ("where"): large λ → the extra edge accrues at low multipliers (thin
  tail, CALM-like feel); small λ → it accrues very late (relatively generous
  mid-tail, CHAOS-like feel).

Per-regime profiles (`STATE_PROFILES`): CALM `{0.04, 1.2}`, TENSION
`{0.03, 0.5}`, CHAOS `{0.02, 0.1}`, RESET `{0.015, 0.3}`. Player mix,
elasticity, and the legacy `volatility` steering knob adjust `β`/`λ` within
bounds in `deriveProfile` (pure, clamped):

- tilted mix adds up to `+0.02·tilted` to β (worse odds, bounded, committed);
- conservative/greedy mixes and elasticity move λ (shape only);
- exposure steering (`volatility: 1.5`) adds `+0.01` to β — a bounded edge
  increase for the *next* rounds, still inside the band, still committed
  pre-bet.

Scheduled tilt-low rounds (`tiltNextLow`) were **removed**: a round whose RTP
is ~0 above 1.2× cannot exist inside any honest RTP band; it was economically
incoherent, not constrainable.

## 5. Player classification & exposure steering — declared properties

- **Tilted players** get the worst allowed profile: β up to 0.05 → RTP floor
  ≈ 0.9405 at high multipliers vs ≈ 0.99 baseline. The differential is at
  most ~5 RTP points, is committed before bets, and is visible in the revealed
  snapshot (`playerMix.tilted`). A player can detect the treatment after each
  round and can influence classification only through observable betting
  behavior; doing so cannot push RTP above `1−h` (no gaming upside).
- **Exposure steering** can only add bounded edge (never a player-positive
  regime as the old RESET/low-vol presets did — `β` is clamped ≥ 0 and the
  steering delta is +0.01). The operator can still *choose* who/when gets more
  edge inside the band; that choice is disclosed at reveal. If per-player RTP
  differentiation is not an intended product property, set the tilted term to
  0 in `deriveProfile` — the contract does not depend on it.

## 6. Statistical methodology

- Deterministic seed streams (`sha256("econ:" + tag + ":" + i)`) through the
  exact production/verifier derivation `recomputeCrashPoint` — no mocks.
- Empirical RTP at m is `m·p̂`, `p̂` binomial ⇒ σ = `m·√(p̂(1−p̂)/N)`.
  Assertions use **4σ tolerances** against the closed-form theory above,
  never exact values (N = 30k in tests, 200k in the study; σ ≤ 0.02 at
  m ≤ 3).
- The **whole multiplier range** is checked analytically: `RTP(m) =
  (1−h)·φ(m)` is evaluated on a log-spaced sweep of `(1, CRASH_CAP]` for
  every configuration and hostile/tampered profiles.
- Quantiles (median/p90/p99) are compared against the numerically inverted
  theoretical survival with relative tolerance `4/√(N·p)` (Pareto-tail
  quantile SE).
- Adaptive strategies run against a 150k-round stream with **real regime
  evolution** (the volatility engine's state transitions driven by actual
  crash history), strategies observing the public pre-round state: always-m
  for the six thresholds, wait-for-CHAOS, skip-CALM, bet-after-3-lows,
  regime-switched multipliers, and fresh-CHAOS-transition exploitation. Each
  must have RTP ≤ (1−h) + 4σ. Because RTP(m) ≤ 1−h holds for every committed
  configuration pointwise, no strategy that selects rounds/multipliers using
  public information can exceed 1−h in expectation (each bet is a convex
  combination of ≤(1−h) returns); the simulations are a regression check on
  that argument.

Run: `npm run rtp:study` (study) and `npm test -- economics` (regression
suite, `test/economics.test.ts`).

## 7. Remaining economic risks

- The band `[0.9405, 0.99]` is a design choice; regulators or product may
  require a tighter (or disclosed-per-regime) band. Tightening = lowering
  `BETA_MAX`.
- Long-run RTP is a mixture over regime occupancy; the band bounds the
  mixture, but the *realized* average edge depends on how often each regime
  occurs (measured ≈ 1.5–4% in the study stream).
- Cent-flooring and `CRASH_CAP` remove up to ~0.5% additional player value at
  extreme multipliers (house-favoring; included in the band's lower tolerance).
- Bet-sizing strategies (martingale etc.) change variance/ruin, not EV; they
  are out of scope because EV per unit staked is bounded by the pointwise
  contract.
