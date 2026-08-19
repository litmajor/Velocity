// RACECAR experience (presentation layer only).
// Metaphor: round = race, betting = starting grid, running = green flag,
// crash = wreck, settlement = podium. It consumes the exact same GameStore
// and GameClient as the Rocket experience \u2014 zero duplicated audit logic.

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
  BETTING: 'GRID',
  LOCKED: 'LIGHTS OUT',
  RUNNING: 'GREEN FLAG',
  CRASHED: 'WRECK',
  SETTLED: 'PODIUM',
};
const STAGES: RoundPhase[] = ['BETTING', 'LOCKED', 'RUNNING', 'CRASHED', 'SETTLED'];

const FEED_LIMIT = 8;

export function mountRacecarExperience(rootEl: HTMLElement, store: GameStore, client: GameClient): () => void {
  // -- scene -----------------------------------------------------------------
  const canvas = el('canvas', { class: 'scene-canvas', width: '860', height: '340' });
  const ctx = canvas.getContext('2d');
  const speedEl = el('div', { class: 'multiplier scene-readout' }, '1.00\u00d7');
  const statusEl = el('div', { class: 'surface-status' }, '');
  const roundLabel = el('div', { class: 'round-label' }, '');

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

  const feedList = el('ul', { class: 'event-log' });
  const podium = el('div', { class: 'scene-overlay hidden' });

  const scene = el(
    'section',
    { class: 'panel game-surface exp-racecar', 'data-phase': 'BETTING' },
    el('div', { class: 'surface-top' }, roundLabel, stageRail),
    el('div', { class: 'surface-center' }, speedEl, statusEl),
    el('div', { class: 'scene-wrap' }, canvas, podium),
    el('div', { class: 'panel-subtitle' }, 'Race control'),
    feedList,
  );

  // -- shared panels (identical audit truth as Rocket) -------------------------
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

  // -- race-control feed derived from real state transitions -------------------
  const feedLines: string[] = [];
  const pushFeed = (line: string) => {
    feedLines.unshift(line);
    if (feedLines.length > FEED_LIMIT) feedLines.pop();
    feedList.replaceChildren(...feedLines.map((l) => el('li', { class: 'event-log-row' }, l)));
  };

  let prev: GameView | null = null;
  const trackTransitions = (state: GameView) => {
    if (prev) {
      if (state.round.roundId !== prev.round.roundId && state.round.roundId) {
        pushFeed(`Race #${state.round.roundNumber} \u2014 cars forming on the grid`);
      } else if (state.round.phase !== prev.round.phase) {
        switch (state.round.phase) {
          case 'LOCKED': pushFeed('Lights out in moments \u2014 grid closed'); break;
          case 'RUNNING': pushFeed('GREEN FLAG \u2014 race underway'); break;
          case 'CRASHED': pushFeed(`WRECK at ${fmtMult(state.round.crashPoint ?? state.round.multiplier)}`); break;
          case 'SETTLED': pushFeed('Results confirmed \u2014 podium'); break;
        }
      }
      for (const p of state.players) {
        const before = prev.players.find((q) => q.userId === p.userId);
        if (p.status === 'CASHED_OUT' && before?.status === 'ACTIVE') {
          pushFeed(`${p.userId} pitted at ${fmtMult(p.cashedOutMultiplier ?? 0)} (+${fmtMoney(p.payout ?? 0)})`);
        }
      }
    }
    prev = state;
  };

  // -- render -------------------------------------------------------------------
  let latest: GameView = store.getState();
  let roadScroll = 0;
  let raf = 0;
  let disposed = false;

  const drawScene = () => {
    if (!ctx || disposed) return;
    const { width: w, height: h } = canvas;
    const { round } = latest;
    ctx.clearRect(0, 0, w, h);

    const progress = Math.min(1, Math.log(Math.max(1, round.multiplier)) / Math.log(30));

    // asphalt
    ctx.fillStyle = '#10141f';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#1a2130';
    ctx.fillRect(0, h * 0.35, w, h * 0.45);

    // lane markings scroll with the real multiplier only while RUNNING
    if (round.phase === 'RUNNING') roadScroll += 4 + progress * 22;
    ctx.fillStyle = '#7d8aa5';
    const dashW = 42;
    for (let x = -((roadScroll) % (dashW * 2)); x < w; x += dashW * 2) {
      ctx.fillRect(x, h * 0.57, dashW, 4);
    }

    // start line on the grid
    if (round.phase === 'BETTING' || round.phase === 'LOCKED') {
      for (let y = Math.floor(h * 0.35); y < h * 0.8; y += 12) {
        ctx.fillStyle = (Math.floor(y / 12) % 2 === 0) ? '#dfe6f3' : '#0b0e14';
        ctx.fillRect(90, y, 10, 12);
      }
    }

    // checkpoint flags at fixed multiplier milestones (2x, 5x, 10x, 20x)
    ctx.font = '10px monospace';
    for (const cp of [2, 5, 10, 20]) {
      const cpProgress = Math.log(cp) / Math.log(30);
      const x = 120 + (w - 220) * cpProgress;
      ctx.fillStyle = progress >= cpProgress && round.phase !== 'BETTING' && round.phase !== 'LOCKED'
        ? '#42e8a4' : '#3a4457';
      ctx.fillRect(x, h * 0.30, 3, h * 0.5);
      ctx.fillText(`${cp}\u00d7`, x - 6, h * 0.27);
    }

    // car x position: on the grid pre-race, advances with the real multiplier
    const carX = round.phase === 'BETTING' || round.phase === 'LOCKED'
      ? 60
      : 120 + (w - 220) * progress;
    const carY = h * 0.6;

    if (round.phase === 'CRASHED') {
      // wreck: smoke + debris at final position
      ctx.fillStyle = 'rgba(255, 77, 94, 0.8)';
      ctx.beginPath();
      ctx.arc(carX + 20, carY, 20, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(125, 138, 165, 0.5)';
      ctx.beginPath();
      ctx.arc(carX + 6, carY - 16, 12, 0, Math.PI * 2);
      ctx.arc(carX + 34, carY - 12, 9, 0, Math.PI * 2);
      ctx.fill();
    } else {
      // body
      ctx.fillStyle = '#f4b942';
      ctx.beginPath();
      ctx.moveTo(carX, carY);
      ctx.lineTo(carX + 14, carY - 12);
      ctx.lineTo(carX + 34, carY - 12);
      ctx.lineTo(carX + 46, carY);
      ctx.closePath();
      ctx.fill();
      ctx.fillRect(carX - 4, carY, 54, 8);
      // cockpit
      ctx.fillStyle = '#0b0e14';
      ctx.fillRect(carX + 18, carY - 10, 12, 8);
      // wheels
      ctx.fillStyle = '#05060d';
      ctx.beginPath();
      ctx.arc(carX + 8, carY + 10, 6, 0, Math.PI * 2);
      ctx.arc(carX + 38, carY + 10, 6, 0, Math.PI * 2);
      ctx.fill();
      // speed lines while racing (length reflects real multiplier)
      if (round.phase === 'RUNNING') {
        ctx.strokeStyle = 'rgba(66, 232, 164, 0.5)';
        ctx.lineWidth = 2;
        for (const dy of [-6, 2, 10]) {
          ctx.beginPath();
          ctx.moveTo(carX - 10, carY + dy);
          ctx.lineTo(carX - 10 - 14 - progress * 40, carY + dy);
          ctx.stroke();
        }
      }
    }

    raf = requestAnimationFrame(drawScene);
  };

  const update = (state: GameView) => {
    latest = state;
    trackTransitions(state);
    const { round, now, results } = state;
    scene.dataset.phase = round.phase;
    roundLabel.textContent = round.roundId ? `Race #${round.roundNumber}` : 'Awaiting race\u2026';
    for (const [phase, node] of stageEls) node.classList.toggle('active', phase === round.phase);

    speedEl.textContent = fmtMult(round.multiplier);
    speedEl.className = `multiplier scene-readout ${round.phase === 'CRASHED' ? 'crashed' : round.phase === 'RUNNING' ? 'running' : ''}`;

    switch (round.phase) {
      case 'BETTING':
        statusEl.textContent = round.bettingEndsAt
          ? `Grid closes in ${fmtCountdown(round.bettingEndsAt - now)} \u2014 place your stake`
          : 'Grid open';
        break;
      case 'LOCKED': statusEl.textContent = 'Lights out\u2026'; break;
      case 'RUNNING': statusEl.textContent = 'Racing \u2014 pit any time to bank your payout'; break;
      case 'CRASHED': statusEl.textContent = `Wreck at ${fmtMult(round.crashPoint ?? round.multiplier)}`; break;
      case 'SETTLED': statusEl.textContent = 'Race complete'; break;
    }
    if (state.connection === 'DISCONNECTED') statusEl.textContent = 'Telemetry lost \u2014 reconnecting\u2026';
    if (state.connection === 'CONNECTING') statusEl.textContent = 'Acquiring telemetry\u2026';

    // podium overlay from real settlement results
    if (round.phase === 'SETTLED' && results) {
      podium.classList.remove('hidden');
      const ranked = [...results.winners].sort((a, b) => b.payout - a.payout);
      const hadEntrants = results.winners.length > 0 || results.losers.length > 0;
      podium.replaceChildren(
        el('div', { class: 'overlay-title' }, 'PODIUM'),
        el('div', { class: 'overlay-line' }, `Wreck at ${fmtMult(round.crashPoint ?? round.multiplier)}`),
        hadEntrants
          ? el('div', { class: 'overlay-line' },
              `${results.winners.length} finished \u00b7 ${results.losers.length} DNF \u00b7 purse ${fmtMoney(results.totalPayout)}`)
          : el('div', { class: 'overlay-line' }, 'No entrants this race'),
        ...ranked.slice(0, 3).map((o, i) =>
          el('div', { class: 'overlay-row' }, `P${i + 1} ${o.userId} \u2014 ${fmtMoney(o.payout)}`)),
      );
    } else {
      podium.classList.add('hidden');
    }

    const panels = [bet, players, rounds, wallet, fairness];
    for (const p of panels) p.update(state);
  };

  const unsubscribe = store.subscribe(update);
  raf = requestAnimationFrame(drawScene);

  return () => {
    disposed = true;
    cancelAnimationFrame(raf);
    unsubscribe();
  };
}
