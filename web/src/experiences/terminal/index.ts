// TERMINAL experience (presentation layer only).
// Emotional target: tension, curiosity, technical immersion — a security
// investigation console looking inside the engine while it runs. Everything
// rendered here is a timestamped view of real engine state from the shared
// GameStore; nothing is invented and no timers fabricate activity.

import type { GameStore } from '../../runtime/store.js';
import type { GameClient } from '../../runtime/game-client.js';
import type { GameView, RoundPhase } from '../../core/types.js';
import { fmtCountdown, fmtMoney, fmtMult } from '../../core/format.js';
import { el } from '../../ui/dom.js';
import { createBetPanel } from '../../shared/panels/bet-panel.js';
import { createWalletPanel } from '../../shared/panels/wallet-panel.js';
import { createPlayerTable } from '../../shared/panels/player-table.js';
import { createRecentRounds } from '../../shared/panels/recent-rounds.js';
import { createFairnessPanel } from '../../shared/panels/fairness-panel.js';

const STAGE_LABEL: Record<RoundPhase, string> = {
  BETTING: 'TARGET',
  LOCKED: 'SURFACE LOCK',
  RUNNING: 'TRACE',
  CRASHED: 'ANOMALY',
  SETTLED: 'REPORT',
};
const STAGES: RoundPhase[] = ['BETTING', 'LOCKED', 'RUNNING', 'CRASHED', 'SETTLED'];

const STREAM_LIMIT = 40;

function ts(now: number): string {
  const d = new Date(now || Date.now());
  return d.toISOString().slice(11, 23);
}

export function mountTerminalExperience(rootEl: HTMLElement, store: GameStore, client: GameClient): () => void {
  // -- console chrome ----------------------------------------------------------
  const promptEl = el('span', { class: 'term-prompt' }, 'velocity@engine:~$');
  const sessionEl = el('span', { class: 'term-session' }, '');
  const stageEls = new Map<RoundPhase, HTMLElement>();
  const stageRail = el(
    'div',
    { class: 'phase-rail' },
    ...STAGES.map((p) => {
      const node = el('span', { class: 'phase-chip' }, STAGE_LABEL[p]);
      stageEls.set(p, node);
      return node;
    }),
  );

  const streamEl = el('div', { class: 'term-stream' });

  // telemetry grid: live technical readouts of real engine values
  const telValue = (label: string) => {
    const value = el('div', { class: 'term-tel-value' }, '\u2014');
    const cell = el('div', { class: 'term-tel-cell' }, el('div', { class: 'term-tel-label' }, label), value);
    return { cell, value };
  };
  const telMult = telValue('MULTIPLIER');
  const telPhase = telValue('STAGE');
  const telRound = telValue('TRACE ID');
  const telTicks = telValue('SAMPLES');
  const telWindow = telValue('WINDOW');
  const telLink = telValue('LINK');
  const telemetry = el(
    'div',
    { class: 'term-telemetry' },
    telMult.cell, telPhase.cell, telRound.cell, telTicks.cell, telWindow.cell, telLink.cell,
  );

  const scene = el(
    'section',
    { class: 'panel game-surface exp-terminal', 'data-phase': 'BETTING' },
    el('div', { class: 'surface-top' }, el('div', { class: 'term-head' }, promptEl, sessionEl), stageRail),
    telemetry,
    el('div', { class: 'panel-subtitle' }, 'Live trace'),
    streamEl,
  );

  // -- shared panels (identical audit truth as every other experience) ---------
  const bet = createBetPanel(client, () => store.getState());
  const players = createPlayerTable();
  const rounds = createRecentRounds();
  const wallet = createWalletPanel();
  const fairness = createFairnessPanel();

  rootEl.replaceChildren(
    el(
      'main',
      { class: 'layout' },
      el('div', { class: 'col col-game' }, scene, rounds.root),
      el('div', { class: 'col col-side' }, bet.root, wallet.root, players.root, fairness.root),
    ),
  );

  // -- live trace derived from real state transitions ---------------------------
  const lines: Array<{ t: string; cls: string; text: string }> = [];
  const push = (now: number, cls: string, text: string) => {
    lines.unshift({ t: ts(now), cls, text });
    if (lines.length > STREAM_LIMIT) lines.pop();
    streamEl.replaceChildren(
      ...lines.map((l) =>
        el('div', { class: `term-line ${l.cls}` },
          el('span', { class: 'term-ts' }, l.t), ` ${l.text}`)),
    );
  };

  let prev: GameView | null = null;
  const trackTransitions = (state: GameView) => {
    if (prev) {
      if (state.connection !== prev.connection) {
        push(state.now, state.connection === 'CONNECTED' ? 'ok' : 'warn', `link ${state.connection.toLowerCase()}`);
      }
      if (state.round.roundId !== prev.round.roundId && state.round.roundId) {
        push(state.now, 'info', `target acquired trace=${state.round.roundId.slice(0, 8)} seq=${state.round.roundNumber}`);
        if (state.fairness.serverHash) push(state.now, 'dim', `commitment sha256=${state.fairness.serverHash.slice(0, 16)}\u2026`);
        if (state.fairness.paramsCommit) push(state.now, 'dim', `params-commit ${state.fairness.paramsCommit.slice(0, 16)}\u2026`);
      } else if (state.round.phase !== prev.round.phase) {
        switch (state.round.phase) {
          case 'LOCKED': push(state.now, 'info', 'surface locked \u2014 no further entries'); break;
          case 'RUNNING': push(state.now, 'info', 'trace running \u2014 sampling multiplier stream'); break;
          case 'CRASHED':
            push(state.now, 'err', `ANOMALY terminal state at ${fmtMult(state.round.crashPoint ?? state.round.multiplier)}`);
            if (state.fairness.serverSeed) push(state.now, 'dim', `reveal seed=${state.fairness.serverSeed.slice(0, 16)}\u2026 (verifiable)`);
            break;
          case 'SETTLED': {
            const r = state.results;
            push(state.now, 'ok', r
              ? `report settled winners=${r.winners.length} losers=${r.losers.length} payout=${fmtMoney(r.totalPayout)}`
              : 'report settled');
            break;
          }
        }
      }
      for (const p of state.players) {
        const before = prev.players.find((q) => q.userId === p.userId);
        if (!before && p.status === 'ACTIVE') {
          push(state.now, 'info', `entry user=${p.userId} stake=${fmtMoney(p.stake)}`);
        } else if (p.status === 'CASHED_OUT' && before?.status === 'ACTIVE') {
          push(state.now, 'ok', `exit user=${p.userId} at=${fmtMult(p.cashedOutMultiplier ?? 0)} payout=${fmtMoney(p.payout ?? 0)}`);
        }
      }
      if (state.lastActionError && state.lastActionError !== prev.lastActionError) {
        push(state.now, 'err', `rejected: ${state.lastActionError}`);
      }
    }
    prev = state;
  };

  const update = (state: GameView) => {
    trackTransitions(state);
    const { round, now } = state;
    scene.dataset.phase = round.phase;
    sessionEl.textContent = round.roundId
      ? `investigating trace ${round.roundId.slice(0, 8)}`
      : 'awaiting target\u2026';
    for (const [phase, node] of stageEls) node.classList.toggle('active', phase === round.phase);

    telMult.value.textContent = fmtMult(round.multiplier);
    telMult.value.className = `term-tel-value ${round.phase === 'CRASHED' ? 'err' : round.phase === 'RUNNING' ? 'ok' : ''}`;
    telPhase.value.textContent = STAGE_LABEL[round.phase];
    telRound.value.textContent = round.roundId ? round.roundId.slice(0, 8) : '\u2014';
    telTicks.value.textContent = String(round.curve.length);
    telWindow.value.textContent = round.phase === 'BETTING' && round.bettingEndsAt
      ? fmtCountdown(round.bettingEndsAt - now)
      : round.phase === 'BETTING' ? 'open' : 'closed';
    telLink.value.textContent = state.connection;
    telLink.value.className = `term-tel-value ${state.connection === 'CONNECTED' ? 'ok' : state.connection === 'MOCK' ? '' : 'err'}`;

    const panels = [bet, players, rounds, wallet, fairness];
    for (const p of panels) p.update(state);
  };

  const unsubscribe = store.subscribe(update);
  return () => unsubscribe();
}
