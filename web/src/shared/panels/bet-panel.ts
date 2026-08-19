// BetPanel: stake/auto-cashout inputs and Place Bet / Cash Out.
// All validation verdicts come from /actions preflights; this surface only
// renders them and forwards execution.

import type { GameView } from '../../core/types.js';
import { fmtMoney, fmtMult } from '../../core/format.js';
import { el, button, panel } from '../../ui/dom.js';
import type { GameClient } from '../../runtime/game-client.js';
import { preflightPlaceBet, executePlaceBet } from '../../actions/place-bet.js';
import { preflightCashout, executeCashout } from '../../actions/cashout.js';
import type { PanelView } from '../panel-view.js';

export function createBetPanel(client: GameClient, getState: () => GameView): PanelView {
  const stakeInput = el('input', { class: 'input', type: 'number', min: '0.01', step: '0.01', value: '10.00' });
  const autoToggle = el('input', { type: 'checkbox', class: 'toggle' });
  const autoInput = el('input', { class: 'input input-auto', type: 'number', min: '1.01', step: '0.01', value: '2.00', disabled: true });
  autoToggle.addEventListener('change', () => {
    autoInput.disabled = !autoToggle.checked;
  });

  const betBtn = button('Place Bet', { class: 'btn btn-primary' });
  const cashoutBtn = button('Cash Out', { class: 'btn btn-cashout' });
  const hintEl = el('div', { class: 'bet-hint' }, '');
  const balanceEl = el('span', { class: 'stat-value' }, '');
  const stakeEl = el('span', { class: 'stat-value' }, '');
  const potentialEl = el('span', { class: 'stat-value' }, '');

  betBtn.addEventListener('click', () => {
    const state = getState();
    const pre = preflightPlaceBet(state, stakeInput.value, autoToggle.checked, autoInput.value);
    if (!pre.ok) {
      hintEl.textContent = pre.message;
      hintEl.className = 'bet-hint error';
      return;
    }
    executePlaceBet(client, pre);
  });

  cashoutBtn.addEventListener('click', () => {
    const state = getState();
    const pre = preflightCashout(state);
    if (!pre.ok) {
      hintEl.textContent = pre.message;
      hintEl.className = 'bet-hint error';
      return;
    }
    executeCashout(client, pre);
  });

  const { root, body } = panel('Bet', 'bet-panel');
  body.append(
    el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Stake'), stakeInput),
    el(
      'label',
      { class: 'field field-inline' },
      autoToggle,
      el('span', { class: 'field-label' }, 'Auto-cashout at'),
      autoInput,
    ),
    el('div', { class: 'bet-buttons' }, betBtn, cashoutBtn),
    hintEl,
    el(
      'div',
      { class: 'bet-stats' },
      el('div', { class: 'stat' }, el('span', { class: 'stat-label' }, 'Balance'), balanceEl),
      el('div', { class: 'stat' }, el('span', { class: 'stat-label' }, 'Current stake'), stakeEl),
      el('div', { class: 'stat' }, el('span', { class: 'stat-label' }, 'Potential payout'), potentialEl),
    ),
  );

  return {
    root,
    update(state: GameView): void {
      const { myBet, round, wallet } = state;
      balanceEl.textContent = fmtMoney(wallet.balance);
      stakeEl.textContent = myBet.stake > 0 ? fmtMoney(myBet.stake) : '\u2014';

      const stakeForPotential = myBet.status === 'ACTIVE' ? myBet.stake : Number(stakeInput.value) || 0;
      const multForPotential = myBet.status === 'ACTIVE' && round.phase === 'RUNNING'
        ? round.multiplier
        : (autoToggle.checked ? Number(autoInput.value) || 0 : round.multiplier);
      potentialEl.textContent = stakeForPotential > 0 && multForPotential >= 1
        ? fmtMoney(Math.floor(stakeForPotential * multForPotential * 100) / 100)
        : '\u2014';

      const betPre = preflightPlaceBet(state, stakeInput.value, autoToggle.checked, autoInput.value);
      betBtn.disabled = !betPre.ok;
      const cashPre = preflightCashout(state);
      cashoutBtn.disabled = !cashPre.ok;
      cashoutBtn.textContent = cashPre.ok ? `Cash Out ${fmtMult(round.multiplier)}` : 'Cash Out';

      if (myBet.status === 'CASHED_OUT' && myBet.payout !== null) {
        hintEl.textContent = `Cashed out at ${fmtMult(myBet.cashedOutMultiplier ?? 0)} for ${fmtMoney(myBet.payout)}`;
        hintEl.className = 'bet-hint success';
      } else if (myBet.status === 'LOST') {
        hintEl.textContent = 'Round crashed \u2014 bet lost';
        hintEl.className = 'bet-hint error';
      } else if (state.lastActionError) {
        hintEl.textContent = state.lastActionError;
        hintEl.className = 'bet-hint error';
      } else if (!betPre.ok && myBet.status === 'NONE' && betPre.code !== 'INVALID_AMOUNT') {
        hintEl.textContent = betPre.message;
        hintEl.className = 'bet-hint muted';
      } else if (myBet.status === 'ACTIVE') {
        hintEl.textContent = 'Bet placed \u2014 good luck';
        hintEl.className = 'bet-hint muted';
      } else {
        hintEl.textContent = '';
        hintEl.className = 'bet-hint';
      }
    },
  };
}
