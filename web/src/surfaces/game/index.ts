// GamePage (SSA /surfaces layer): composition root. Assembles panels, wires
// them to the store, and owns zero business logic.

import type { GameStore } from '../../runtime/store.js';
import type { GameClient } from '../../runtime/game-client.js';
import { el } from '../../ui/dom.js';
import { createGameSurface } from './panels/game-surface.js';
import { createBetPanel } from './panels/bet-panel.js';
import { createPlayerTable } from './panels/player-table.js';
import { createRecentRounds } from './panels/recent-rounds.js';
import { createWalletPanel } from './panels/wallet-panel.js';
import { createFairnessPanel } from './panels/fairness-panel.js';

export function mountGamePage(rootEl: HTMLElement, store: GameStore, client: GameClient): void {
  const surface = createGameSurface();
  const bet = createBetPanel(client, () => store.getState());
  const players = createPlayerTable();
  const rounds = createRecentRounds();
  const wallet = createWalletPanel();
  const fairness = createFairnessPanel();

  const connBadge = el('span', { class: 'conn-badge' }, '');

  rootEl.replaceChildren(
    el(
      'header',
      { class: 'app-header' },
      el('h1', { class: 'app-title' }, 'VELOCITY'),
      connBadge,
    ),
    el(
      'main',
      { class: 'layout' },
      el('div', { class: 'col col-game' }, surface.root, rounds.root),
      el('div', { class: 'col col-side' }, bet.root, wallet.root, players.root, fairness.root),
    ),
  );

  const panels = [surface, bet, players, rounds, wallet, fairness];
  store.subscribe((state) => {
    connBadge.textContent = state.connection === 'MOCK' ? 'SIMULATED DATA' : state.connection;
    connBadge.className = `conn-badge conn-${state.connection.toLowerCase()}`;
    for (const p of panels) p.update(state);
  });
}
