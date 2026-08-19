// ROCKET experience (presentation layer only).
// Metaphor: round = mission, betting = pre-launch, running = ascent,
// crash = anomaly, settlement = mission debrief. All state comes from the
// shared GameStore; this module renders it and never produces game state.

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
  BETTING: 'PRE-LAUNCH',
  LOCKED: 'IGNITION',
  RUNNING: 'ASCENT',
  CRASHED: 'ANOMALY',
  SETTLED: 'DEBRIEF',
};
const STAGES: RoundPhase[] = ['BETTING', 'LOCKED', 'RUNNING', 'CRASHED', 'SETTLED'];

const LOG_LIMIT = 8;

interface Star {
  x: number;
  y: number;
  size: number;
  speed: number;
}

export function mountRocketExperience(rootEl: HTMLElement, store: GameStore, client: GameClient): () => void {
  // -- scene -----------------------------------------------------------------
  const canvas = el('canvas', { class: 'scene-canvas', width: '860', height: '340' });
  const ctx = canvas.getContext('2d');
  const altitudeEl = el('div', { class: 'multiplier scene-readout' }, '1.00\u00d7');
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

  const logList = el('ul', { class: 'event-log' });
  const debrief = el('div', { class: 'scene-overlay hidden' });

  const scene = el(
    'section',
    { class: 'panel game-surface exp-rocket', 'data-phase': 'BETTING' },
    el('div', { class: 'surface-top' }, roundLabel, stageRail),
    el('div', { class: 'surface-center' }, altitudeEl, statusEl),
    el('div', { class: 'scene-wrap' }, canvas, debrief),
    el('div', { class: 'panel-subtitle' }, 'Mission log'),
    logList,
  );

  // -- shared panels (identical audit truth as Racecar) -----------------------
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

  // -- mission log derived from real state transitions ------------------------
  const logLines: string[] = [];
  const pushLog = (line: string) => {
    logLines.unshift(line);
    if (logLines.length > LOG_LIMIT) logLines.pop();
    logList.replaceChildren(...logLines.map((l) => el('li', { class: 'event-log-row' }, l)));
  };

  let prev: GameView | null = null;
  const trackTransitions = (state: GameView) => {
    if (prev) {
      if (state.round.roundId !== prev.round.roundId && state.round.roundId) {
        pushLog(`Mission #${state.round.roundNumber} on the pad \u2014 boarding open`);
      } else if (state.round.phase !== prev.round.phase) {
        switch (state.round.phase) {
          case 'LOCKED': pushLog('Hatch sealed \u2014 ignition sequence'); break;
          case 'RUNNING': pushLog('Liftoff'); break;
          case 'CRASHED': pushLog(`ANOMALY at ${fmtMult(state.round.crashPoint ?? state.round.multiplier)}`); break;
          case 'SETTLED': pushLog('Mission debrief complete'); break;
        }
      }
      for (const p of state.players) {
        const before = prev.players.find((q) => q.userId === p.userId);
        if (p.status === 'CASHED_OUT' && before?.status === 'ACTIVE') {
          pushLog(`${p.userId} ejected at ${fmtMult(p.cashedOutMultiplier ?? 0)} (+${fmtMoney(p.payout ?? 0)})`);
        }
      }
    }
    prev = state;
  };

  // -- render ------------------------------------------------------------------
  let latest: GameView = store.getState();
  const stars: Star[] = Array.from({ length: 70 }, (_, i) => ({
    x: ((i * 137) % 860),
    y: ((i * 71) % 340),
    size: 0.5 + ((i * 13) % 10) / 6,
    speed: 0.2 + ((i * 7) % 10) / 8,
  }));
  let starDrift = 0;
  let raf = 0;
  let disposed = false;

  const drawScene = () => {
    if (!ctx || disposed) return;
    const { width: w, height: h } = canvas;
    const { round } = latest;
    ctx.clearRect(0, 0, w, h);

    // sky gradient: darker as multiplier ("altitude") climbs
    const alt = Math.min(1, Math.log(Math.max(1, round.multiplier)) / Math.log(30));
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#05060d');
    g.addColorStop(1, `rgba(20, 34, 66, ${1 - alt * 0.7})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    // stars: drift speed is a visualization of the real multiplier only
    if (round.phase === 'RUNNING') starDrift += 0.4 + alt * 5;
    ctx.fillStyle = '#9fb4dd';
    for (const s of stars) {
      const y = (s.y + starDrift * s.speed) % h;
      ctx.globalAlpha = 0.3 + s.size / 3;
      ctx.fillRect(s.x, y, s.size, s.size);
    }
    ctx.globalAlpha = 1;

    // launch pad (visible until running)
    if (round.phase === 'BETTING' || round.phase === 'LOCKED') {
      ctx.fillStyle = '#232b3d';
      ctx.fillRect(w / 2 - 60, h - 18, 120, 8);
    }

    // rocket position: grounded pre-launch, climbs with real multiplier
    const baseY = h - 40;
    const rocketY = round.phase === 'RUNNING' || round.phase === 'CRASHED' || round.phase === 'SETTLED'
      ? baseY - alt * (h - 90)
      : baseY;
    const rx = w / 2;

    if (round.phase === 'CRASHED') {
      // anomaly: expanding blast at last altitude
      ctx.fillStyle = 'rgba(255, 77, 94, 0.75)';
      ctx.beginPath();
      ctx.arc(rx, rocketY, 26, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#f4b942';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(rx, rocketY, 40, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      // hull
      ctx.fillStyle = '#dfe6f3';
      ctx.beginPath();
      ctx.moveTo(rx, rocketY - 34);
      ctx.quadraticCurveTo(rx + 12, rocketY - 8, rx + 10, rocketY + 12);
      ctx.lineTo(rx - 10, rocketY + 12);
      ctx.quadraticCurveTo(rx - 12, rocketY - 8, rx, rocketY - 34);
      ctx.fill();
      // fins
      ctx.fillStyle = '#42e8a4';
      ctx.beginPath();
      ctx.moveTo(rx - 10, rocketY + 12);
      ctx.lineTo(rx - 20, rocketY + 22);
      ctx.lineTo(rx - 8, rocketY + 6);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(rx + 10, rocketY + 12);
      ctx.lineTo(rx + 20, rocketY + 22);
      ctx.lineTo(rx + 8, rocketY + 6);
      ctx.fill();
      // window
      ctx.fillStyle = '#0b0e14';
      ctx.beginPath();
      ctx.arc(rx, rocketY - 12, 4, 0, Math.PI * 2);
      ctx.fill();
      // exhaust flame only while the round is actually running
      if (round.phase === 'RUNNING' || round.phase === 'LOCKED') {
        const flicker = 6 + Math.random() * 8;
        ctx.fillStyle = '#f4b942';
        ctx.beginPath();
        ctx.moveTo(rx - 6, rocketY + 12);
        ctx.lineTo(rx, rocketY + 12 + flicker + alt * 16);
        ctx.lineTo(rx + 6, rocketY + 12);
        ctx.fill();
      }
    }

    raf = requestAnimationFrame(drawScene);
  };

  const update = (state: GameView) => {
    latest = state;
    trackTransitions(state);
    const { round, now, results } = state;
    scene.dataset.phase = round.phase;
    roundLabel.textContent = round.roundId ? `Mission #${round.roundNumber}` : 'Awaiting mission\u2026';
    for (const [phase, node] of stageEls) node.classList.toggle('active', phase === round.phase);

    altitudeEl.textContent = fmtMult(round.multiplier);
    altitudeEl.className = `multiplier scene-readout ${round.phase === 'CRASHED' ? 'crashed' : round.phase === 'RUNNING' ? 'running' : ''}`;

    switch (round.phase) {
      case 'BETTING':
        statusEl.textContent = round.bettingEndsAt
          ? `T-minus ${fmtCountdown(round.bettingEndsAt - now)} \u2014 boarding open`
          : 'Boarding open';
        break;
      case 'LOCKED': statusEl.textContent = 'Ignition sequence \u2014 hatch sealed'; break;
      case 'RUNNING': statusEl.textContent = 'Ascending \u2014 eject any time'; break;
      case 'CRASHED': statusEl.textContent = `Anomaly at ${fmtMult(round.crashPoint ?? round.multiplier)}`; break;
      case 'SETTLED': statusEl.textContent = 'Mission complete'; break;
    }
    if (state.connection === 'DISCONNECTED') statusEl.textContent = 'Telemetry lost \u2014 reconnecting\u2026';
    if (state.connection === 'CONNECTING') statusEl.textContent = 'Acquiring telemetry\u2026';

    // debrief overlay from real settlement results
    if (round.phase === 'SETTLED' && results) {
      debrief.classList.remove('hidden');
      const hadCrew = results.winners.length > 0 || results.losers.length > 0;
      debrief.replaceChildren(
        el('div', { class: 'overlay-title' }, 'MISSION DEBRIEF'),
        el('div', { class: 'overlay-line' }, `Anomaly at ${fmtMult(round.crashPoint ?? round.multiplier)}`),
        hadCrew
          ? el('div', { class: 'overlay-line' },
              `${results.winners.length} crew ejected safely \u00b7 ${results.losers.length} lost \u00b7 payouts ${fmtMoney(results.totalPayout)}`)
          : el('div', { class: 'overlay-line' }, 'Uncrewed mission \u2014 no participants this round'),
        ...results.winners.slice(0, 4).map((o) =>
          el('div', { class: 'overlay-row' }, `${o.userId} \u2014 ${fmtMoney(o.payout)}`)),
      );
    } else {
      debrief.classList.add('hidden');
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
