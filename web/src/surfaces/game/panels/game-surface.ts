// GameSurface panel: multiplier, curve placeholder, phase + countdown.
// Renders GameView only (SSA: surfaces render, react, compose).

import type { GameView, RoundPhase } from '../../../core/types.js';
import { fmtCountdown, fmtMult } from '../../../core/format.js';
import { el } from '../../../ui/dom.js';

const PHASES: RoundPhase[] = ['BETTING', 'LOCKED', 'RUNNING', 'CRASHED', 'SETTLED'];

export interface PanelView {
  root: HTMLElement;
  update(state: GameView): void;
}

export function createGameSurface(): PanelView {
  const multiplierEl = el('div', { class: 'multiplier' }, '1.00\u00d7');
  const statusEl = el('div', { class: 'surface-status' }, '');
  const canvas = el('canvas', { class: 'curve-canvas', width: '800', height: '260' });
  const ctx = canvas.getContext('2d');

  const phaseEls = new Map<RoundPhase, HTMLElement>();
  const phaseRail = el(
    'div',
    { class: 'phase-rail' },
    ...PHASES.map((p) => {
      const node = el('span', { class: 'phase-chip' }, p);
      phaseEls.set(p, node);
      return node;
    }),
  );

  const roundLabel = el('div', { class: 'round-label' }, '');
  const root = el(
    'section',
    { class: 'panel game-surface', 'data-phase': 'BETTING' },
    el('div', { class: 'surface-top' }, roundLabel, phaseRail),
    el('div', { class: 'surface-center' }, multiplierEl, statusEl),
    canvas,
  );

  const drawCurve = (state: GameView) => {
    if (!ctx) return;
    const { width, height } = canvas;
    ctx.clearRect(0, 0, width, height);
    const curve = state.round.curve;
    if (curve.length < 2) return;
    const maxM = Math.max(2, ...curve);
    ctx.beginPath();
    for (let i = 0; i < curve.length; i++) {
      const x = (i / (curve.length - 1)) * width;
      const y = height - ((curve[i] - 1) / (maxM - 1)) * (height - 12) - 6;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = state.round.phase === 'CRASHED' ? '#ff4d5e' : '#42e8a4';
    ctx.lineWidth = 3;
    ctx.stroke();
  };

  return {
    root,
    update(state: GameView): void {
      const { round, now } = state;
      root.dataset.phase = round.phase;
      roundLabel.textContent = round.roundId ? `Round #${round.roundNumber}` : 'Waiting for round\u2026';

      for (const [phase, node] of phaseEls) {
        node.classList.toggle('active', phase === round.phase);
      }

      multiplierEl.textContent = fmtMult(round.multiplier);
      multiplierEl.className = `multiplier ${round.phase === 'CRASHED' ? 'crashed' : round.phase === 'RUNNING' ? 'running' : ''}`;

      switch (round.phase) {
        case 'BETTING':
          statusEl.textContent = round.bettingEndsAt
            ? `Betting closes in ${fmtCountdown(round.bettingEndsAt - now)}`
            : 'Betting open';
          break;
        case 'LOCKED':
          statusEl.textContent = 'Bets locked \u2014 launching\u2026';
          break;
        case 'RUNNING':
          statusEl.textContent = 'In flight';
          break;
        case 'CRASHED':
          statusEl.textContent = `Crashed at ${fmtMult(round.crashPoint ?? round.multiplier)}`;
          break;
        case 'SETTLED':
          statusEl.textContent = 'Round settled';
          break;
      }

      drawCurve(state);
    },
  };
}
