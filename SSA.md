# Surface-State Architecture (SSA)
> *An application systems framework for large-scale stateful software.*
> *"State determines surface. Systems own behavior. Surfaces only render."*

---

## Preamble

Most frontend systems fail under scale not because of bad components —  
but because **state, logic, and presentation collapse into each other**.

SSA is a doctrine that prevents that collapse.

It is not a component library. It is not a styling system. It is not tied to any framework.

It is an **operating philosophy for how software systems should be structured, evolved, and owned** — across the full lifecycle from prototype to production.

---

## The Core Law

```
STATE → SYSTEM → SURFACE
```

1. **State** is the source of truth. It drives everything.
2. **Systems** (engines, domains, actions) own all logic and behavior.
3. **Surfaces** only reflect what state and systems produce.

Violating this law — in any direction — creates drift, fragility, and coupling that compounds over time.

---

## The Seven Principles

### 1. State Owns Rendering
A surface renders because state says so. Not because a route matched. Not because a prop was passed. State is the single cause.

```ts
// ❌ Anti-pattern
if (wallet.balance > 0) return <TransferPanel />

// ✅ SSA pattern
{showTransferSurface && <TransferSurface />}
// where showTransferSurface derives from OperationalState
```

---

### 2. Business Logic Never Lives in Surfaces
Surfaces do three things only: **render**, **react**, **compose**.  
Any business logic inside a surface is a violation. Move it to a domain, engine, or action system.

---

### 3. Actions Are Orchestrated Centrally
An action is not a button handler. An action is a **system** — with entry conditions, async lifecycle, side effects, and rollback paths.  
Actions live in `/actions`, not scattered across components.

---

### 4. Domains Own Capability
A feature's state, logic, validators, and policies live together in a domain.  
A domain is self-contained. It does not depend on other domains directly — it emits events.

```
/domains/wallet    → owns wallet capability
/domains/treasury  → owns treasury capability
/domains/security  → owns security capability
```

---

### 5. Surfaces Compose Operational Views
A surface is a composition of modules, panels, and actions tied to a specific operational context.  
It does not own logic. It **assembles** what domains and state produce.

```
/surfaces/liquidity   → composes wallet + market data + actions
/surfaces/governance  → composes DAO + proposal + voting
```

---

### 6. Security Is First-Class State
Security is not a middleware. It is a **named state layer** with its own model, lifecycle, and surface visibility rules.

```ts
SecurityState.status → 'locked' | 'unlocked' | 'degraded' | 'escalated'
```

Surfaces respond to `SecurityState` the same way they respond to `FinancialState`.

---

### 7. Features Evolve Independently
A domain should be addable, removable, or modifiable without touching surfaces, other domains, or the core engine.  
This is enforced by the event model — domains communicate through events, not direct imports.

---

## Layer Architecture

```
┌─────────────────────────────────────┐
│             /surfaces               │  ← What users see. Renders only.
├─────────────────────────────────────┤
│             /actions                │  ← Orchestrated system actions
├─────────────────────────────────────┤
│             /domains                │  ← Feature ownership. State + logic.
├─────────────────────────────────────┤
│             /runtime                │  ← Async, caching, event bus, stores
├─────────────────────────────────────┤
│              /core                  │  ← Pure logic. Zero framework deps.
└─────────────────────────────────────┘
│              /ui                    │  ← Pure presentation. Zero business logic.
```

---

### Layer: `/core`
The pure, framework-agnostic engine.

Contains:
- State machines
- Domain models
- Policy engines
- Workflow definitions
- Validation logic

**Rule:** No imports from React, stores, or external services. Zero side effects.

---

### Layer: `/runtime`
The operational backbone.

Contains:
- Async orchestration
- Store management (Zustand, Jotai, etc.)
- Event bus / pub-sub
- Cache coordination
- Sync managers

**Rule:** Runtime knows about core. Core does NOT know about runtime.

---

### Layer: `/domains`
Feature ownership units.

Each domain owns:
- Its slice of state
- Its business rules
- Its API interaction
- Its event emissions

```
/domains/wallet/
  state.ts       → WalletState model
  engine.ts      → WalletEngine (logic)
  api.ts         → WalletAPI (data fetching)
  events.ts      → WALLET_* event definitions
  policies.ts    → transfer limits, guards
```

**Rule:** Domains never import from other domains. They communicate through events only.

---

### Layer: `/actions`
Centralized action orchestration.

An action is a typed, testable system with:
- Entry conditions (pre-flight)
- Async execution
- State transitions during execution
- Side effects
- Rollback / failure handling

```ts
// Action types
AtomicAction       → single operation, immediate
TransactionalAction → multi-step, reversible
FlowAction         → multi-screen, user-guided
BackgroundAction   → silent, async, no UI
```

**Rule:** No business logic in click handlers. Every significant user operation is an Action.

---

### Layer: `/surfaces`
Operational views assembled from domains and state.

```
/surfaces/overview/
/surfaces/liquidity/
/surfaces/governance/
/surfaces/security/
/surfaces/portfolio/
```

A surface contains:
- `index.tsx` → composition root
- `modules/` → sub-units of the surface
- `panels/` → contained views within the surface

**Rule:** A surface imports from `/domains` for state. Imports from `/actions` for behavior. Never defines its own logic.

---

### Layer: `/ui`
Pure presentational system.

Contains:
- Tokens (colors, spacing, typography)
- Primitives (Button, Input, Badge, etc.)
- Layout components
- Animation primitives

**Rule:** Zero business logic. Zero state imports from domains. Zero knowledge of actions.

---

## Taxonomy Reference

### State Taxonomy
```ts
SecurityState      → auth, session, lock status, escalation
FinancialState     → balances, positions, exposure, liquidity
OperationalState   → loading, error, sync, feature availability
InteractionState   → modal open, selected item, form draft
SessionState       → user context, permissions, preferences
NetworkState       → connectivity, latency, degraded mode
```

---

### UI Taxonomy
```ts
Surface    → full operational context (e.g. LiquiditySurface)
Panel      → contained view within a surface (e.g. BalancePanel)
Module     → self-contained unit within a panel (e.g. TokenList)
Action     → user-triggered operation (e.g. SendAction)
Flow       → multi-step guided process (e.g. OnboardingFlow)
Overlay    → contextual layer above surface (e.g. ConfirmOverlay)
```

---

### Event Taxonomy
```ts
// Format: DOMAIN_NOUN_VERB (past tense — events describe what happened)
WALLET_BALANCE_UPDATED
WALLET_TRANSFER_INITIATED
WALLET_TRANSFER_CONFIRMED
SECURITY_SESSION_LOCKED
SECURITY_THREAT_DETECTED
TREASURY_PROPOSAL_CREATED
TREASURY_VOTE_CAST
ESCROW_CREATED
ESCROW_RELEASED
```

---

## Anti-Patterns

| Anti-Pattern | Why It Fails |
|---|---|
| Business logic in components | Surfaces become brittle, untestable, domain-coupled |
| Route-driven rendering | State and URL drift apart under complex conditions |
| Domain imports across domains | Creates hidden coupling, breaks independent evolution |
| Logic in `useEffect` | Side effects scattered, hard to trace, impossible to test |
| God component | Collapses all layers into one, no clean seam to cut |
| Feature flags in `/components` | Feature ownership becomes invisible |

---

## Evolution Path

```
Phase 1: Establish /core and /ui as clean layers
Phase 2: Introduce /domains with explicit state models
Phase 3: Move all async/stores into /runtime
Phase 4: Refactor surfaces to consume domain state only
Phase 5: Introduce /actions as orchestration layer
Phase 6: Add event model — domains emit, surfaces subscribe
```

---

## Applied to MtaaDAO

The three MtaaDAO personas (Okedi, Yuki, Amara) are **surface configurations**, not feature gates.

```
OkediSurface    → governance, DAOs, community
YukiSurface     → trading, DeFi execution, YUKI
AmaraSurface    → portfolio, passive income, DAO investments
```

Morio (AI context engine) operates at the `/runtime` layer — it reads `OperationalState` and `SessionState`, injects context, and routes AI surface responses. It is not a persona. It is an engine.

```
MorioEngine (runtime) → reads all state → produces ContextState → surfaces consume
```

---

## Closing

SSA exists to answer one question:

> **How should large-scale stateful applications evolve safely — without collapsing into themselves?**

The answer: every layer has one job. Every rule enforces a clean seam. Systems own behavior. Surfaces only render.

*Every system has a loop. SSA finds it — and holds it.*

---

*Version 1.0 — James Kagua*  
*Surface-State Architecture (SSA)*

---

## Applied to Velocity (repo mapping)

This repository is already structured close to SSA. Below is a concise mapping of Velocity folders and files to SSA layers, plus quick recommendations for applying SSA patterns here.

- `core/` → `/core` (pure logic engines)
  - Examples: `core/game-engine`, `core/fairness-engine`, `core/settlement-engine`
  - Recommendation: keep these framework-agnostic, export pure functions and engine classes.

- `domains/` → `/domains` (feature ownership)
  - Examples: `domains/betting`, `domains/game`, `domains/wallet`
  - Recommendation: each domain should export its state model, event names, and an engine to mutate state.

- `actions/` → `/actions` (orchestration)
  - Examples: `actions/place-bet.ts`, `actions/cashout.ts`
  - Recommendation: convert button handlers into typed Action objects with preflight, execute, and rollback.

- `surfaces/` → `/surfaces` (operational views)
  - Examples: `surfaces/rocket`, `surfaces/debug`, `surfaces/car`
  - Recommendation: surfaces import domain state and actions only; they contain no business logic.

- `runtime/` → `/runtime` (async backbone)
  - Examples: `runtime/event-bus.ts`, `runtime/round-scheduler.ts`, `runtime/persistence.ts`, `runtime/websocket-gateway.ts`
  - Recommendation: runtime wires engines, persists state, and hosts the event bus. Keep side effects here.

- `ui/` → `/ui` (presentation primitives)
  - Examples: `ui/button.ts`
  - Recommendation: keep these pure presentational components and tokens.

- `src/index.ts` and `vertical-slice.ts`
  - Role: application bootstrap and composition of surfaces, runtime, and core engines. Ensure this file composes modules without embedding business logic.

Quick steps to apply SSA to Velocity:

1. Convert `actions/*` to typed `Action` objects with `preflight`, `execute`, `rollback` signatures.
2. Ensure each `domains/*` folder exports `state.ts`, `engine.ts`, and `events.ts` (explicit surface interface).
3. Move all side-effecting code (file writes, network) into `runtime/*` and keep engines pure.
4. Refactor surfaces to read from domain state slices and call actions; remove any inline business logic from `surfaces/*`.
5. Add a small example `domains/ssa-demo` and `surfaces/ssa-demo` to demonstrate the flow (I can scaffold these for you).

Useful commands

```bash
npm run typecheck
npm run test
```

If you'd like, I can scaffold the example domain, surface, and an action now so you can see the SSA flow end-to-end.
