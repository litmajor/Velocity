// COMMAND CENTER experience (presentation layer only).
// Emotional target: control, clarity, confidence. The least cinematic of the
// four experiences: a calm operations overview for someone who needs to
// understand the situation at a glance — current status, exposure, outcome
// distribution, and history. Minimal motion; every figure is real engine
// state from the shared GameStore.

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

const PHASE_LABEL: Record<RoundPhase, string> = {
  BETTING: 'ENTRY OPEN',
  LOCKED: 'ENTRY CLOSED',
  RUNNING: 'IN PROGRESS',
  CRASHED: 'TERMINATED',
  SETTLED: 'SETTLED',
};

export function mountCommandCenterExperience(rootEl: HTMLElement, store: GameStore, client: GameClient): () => void {
  const card = (label: string) => {
    const value = el('div', { class: 'cc-value' }, '\u2014');
    const detail = el('div', { class: 'cc-detail' }, '');
    const root = el('div', { class: 'cc-card' }, el('div', { class: 'cc-label' }, label), value, detail);
    return { root, value, detail };
  };

  const cStatus = card('CURRENT ROUND');
  const cMult = card('MULTIPLIER');
  const cLink = card('ENGINE LINK');
  const cPosition = card('YOUR POSITION');
  const cExposure = card('ROUND EXPOSURE');
  const cSession = card('SESSION P/L');

  // outcome distribution over observed history (real crash points only)
  const distBars = el('div', { class: 'cc-dist-bars' });
  const distNote = el('div', { class: 'cc-detail' }, '');
  const distCard = el(
    'div',
    { class: 'cc-card cc-card-wide' },
    el('div', { class: 'cc-label' }, 'OUTCOME DISTRIBUTION (OBSERVED)'),
    distBars,
    distNote,
  );

  const lastResult = el('div', { class: 'cc-card cc-card-wide' });

  const grid = el(
    'section',
    { class: 'panel game-surface exp-command-center', 'data-phase': 'BETTING' },
    el('div', { class: 'cc-grid' },
      cStatus.root, cMult.root, cLink.root,
      cPosition.root, cExposure.root, cSession.root,
      distCard, lastResult,
    ),
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
      el('div', { class: 'col col-game' }, grid, rounds.root, fairness.root),
      el('div', { class: 'col col-side' }, bet.root, wallet.root, players.root),
    ),
  );

  let sessionStartBalance: number | null = null;

  const update = (state: GameView) => {
    const { round, now, results, history, wallet: w, myBet } = state;
    grid.dataset.phase = round.phase;

    if (sessionStartBalance === null && w.balance > 0) sessionStartBalance = w.balance;

    cStatus.value.textContent = round.roundId ? `#${round.roundNumber}` : '\u2014';
    cStatus.detail.textContent = round.roundId
      ? `${PHASE_LABEL[round.phase]}${round.phase === 'BETTING' && round.bettingEndsAt ? ` \u00b7 closes ${fmtCountdown(round.bettingEndsAt - now)}` : ''}`
      : 'Waiting for engine';

    cMult.value.textContent = fmtMult(round.multiplier);
    cMult.value.className = `cc-value ${round.phase === 'CRASHED' ? 'err' : round.phase === 'RUNNING' ? 'ok' : ''}`;
    cMult.detail.textContent = round.crashPoint !== null ? `terminated at ${fmtMult(round.crashPoint)}` : `${round.curve.length} samples`;

    cLink.value.textContent = state.connection;
    cLink.value.className = `cc-value ${state.connection === 'CONNECTED' ? 'ok' : state.connection === 'MOCK' ? '' : 'err'}`;
    cLink.detail.textContent = state.connection === 'CONNECTED' ? 'live engine feed'
      : state.connection === 'MOCK' ? 'simulated data'
      : state.connection === 'CONNECTING' ? 'establishing link\u2026'
      : 'feed lost \u2014 reconnecting';

    // your position
    switch (myBet.status) {
      case 'ACTIVE':
        cPosition.value.textContent = fmtMoney(myBet.stake);
        cPosition.detail.textContent = `active${myBet.autoCashout ? ` \u00b7 auto @ ${fmtMult(myBet.autoCashout)}` : ''} \u00b7 value ${fmtMoney(myBet.stake * round.multiplier)}`;
        break;
      case 'CASHED_OUT':
        cPosition.value.textContent = `+${fmtMoney(myBet.payout ?? 0)}`;
        cPosition.value.className = 'cc-value ok';
        cPosition.detail.textContent = `exited at ${fmtMult(myBet.cashedOutMultiplier ?? 0)}`;
        break;
      case 'LOST':
        cPosition.value.textContent = `\u2212${fmtMoney(myBet.stake)}`;
        cPosition.value.className = 'cc-value err';
        cPosition.detail.textContent = 'position lost at termination';
        break;
      default:
        cPosition.value.textContent = 'NONE';
        cPosition.value.className = 'cc-value';
        cPosition.detail.textContent = round.phase === 'BETTING' ? 'entry window open' : 'no position this round';
    }

    // round exposure from live players (real data)
    const activeStakes = state.players.filter((p) => p.status === 'ACTIVE').reduce((s, p) => s + p.stake, 0);
    const totalStakes = state.players.reduce((s, p) => s + p.stake, 0);
    cExposure.value.textContent = fmtMoney(activeStakes);
    cExposure.detail.textContent = state.players.length
      ? `${state.players.length} participants \u00b7 ${fmtMoney(totalStakes)} total staked`
      : 'no participants yet';

    // session P/L against first observed balance
    if (sessionStartBalance !== null) {
      const pl = w.balance - sessionStartBalance;
      cSession.value.textContent = `${pl >= 0 ? '+' : '\u2212'}${fmtMoney(Math.abs(pl))}`;
      cSession.value.className = `cc-value ${pl > 0 ? 'ok' : pl < 0 ? 'err' : ''}`;
      cSession.detail.textContent = `balance ${fmtMoney(w.balance)}`;
    } else {
      cSession.value.textContent = '\u2014';
      cSession.detail.textContent = 'awaiting wallet sync';
    }

    // observed outcome distribution from real history
    const buckets: Array<{ label: string; test: (c: number) => boolean; cls: string }> = [
      { label: '<1.5\u00d7', test: (c) => c < 1.5, cls: 'sev-critical' },
      { label: '1.5\u20133\u00d7', test: (c) => c >= 1.5 && c < 3, cls: 'sev-high' },
      { label: '3\u201310\u00d7', test: (c) => c >= 3 && c < 10, cls: 'sev-medium' },
      { label: '\u226510\u00d7', test: (c) => c >= 10, cls: 'sev-low' },
    ];
    if (history.length === 0) {
      distBars.replaceChildren(el('div', { class: 'empty' }, 'No settled rounds observed yet'));
      distNote.textContent = '';
    } else {
      distBars.replaceChildren(
        ...buckets.map((b) => {
          const count = history.filter((h) => b.test(h.crashPoint)).length;
          const pct = Math.round((count / history.length) * 100);
          return el(
            'div',
            { class: 'cc-dist-row' },
            el('span', { class: 'cc-dist-label' }, b.label),
            el('div', { class: 'cc-dist-track' },
              el('div', { class: `cc-dist-fill ${b.cls}`, style: `width:${pct}%` })),
            el('span', { class: 'cc-dist-count' }, `${count}`),
          );
        }),
      );
      distNote.textContent = `${history.length} settled rounds observed this session`;
    }

    // last settled result (real settlement data)
    if (results) {
      const hadPlayers = results.winners.length > 0 || results.losers.length > 0;
      lastResult.replaceChildren(
        el('div', { class: 'cc-label' }, 'LAST SETTLEMENT'),
        el('div', { class: 'cc-detail' },
          hadPlayers
            ? `${results.winners.length} paid \u00b7 ${results.losers.length} lost \u00b7 total payout ${fmtMoney(results.totalPayout)} of ${fmtMoney(results.totalBets)} staked`
            : 'No participants in the last settled round'),
        ...results.winners.slice(0, 5).map((o) =>
          el('div', { class: 'cc-result-row' },
            `${o.userId} \u2014 +${fmtMoney(o.payout)}${o.multiplier !== null ? ` @ ${fmtMult(o.multiplier)}` : ''}`)),
      );
    } else {
      lastResult.replaceChildren(
        el('div', { class: 'cc-label' }, 'LAST SETTLEMENT'),
        el('div', { class: 'cc-detail' }, 'No settlement observed yet this session'),
      );
    }

    const panels = [bet, players, rounds, wallet, fairness];
    for (const p of panels) p.update(state);
  };

  const unsubscribe = store.subscribe(update);
  return () => unsubscribe();
}
