// WalletPanel: balance, active wager, available balance, recent transactions.
// Render-only view over the backend-owned wallet (no second wallet system).

import type { GameView } from '../../core/types.js';
import { fmtMoney, fmtTime } from '../../core/format.js';
import { el, panel } from '../../ui/dom.js';
import type { PanelView } from '../panel-view.js';

export function createWalletPanel(): PanelView {
  const balanceEl = el('span', { class: 'stat-value big' }, '');
  const wagerEl = el('span', { class: 'stat-value' }, '');
  const availableEl = el('span', { class: 'stat-value' }, '');
  const txList = el('ul', { class: 'tx-list' });

  const { root, body } = panel('Wallet', 'wallet-panel');
  body.append(
    el(
      'div',
      { class: 'wallet-stats' },
      el('div', { class: 'stat' }, el('span', { class: 'stat-label' }, 'Balance'), balanceEl),
      el('div', { class: 'stat' }, el('span', { class: 'stat-label' }, 'Active wager'), wagerEl),
      el('div', { class: 'stat' }, el('span', { class: 'stat-label' }, 'Available'), availableEl),
    ),
    el('div', { class: 'panel-subtitle' }, 'Recent transactions'),
    txList,
  );

  return {
    root,
    update(state: GameView): void {
      const { wallet } = state;
      balanceEl.textContent = fmtMoney(wallet.balance);
      wagerEl.textContent = wallet.activeWager > 0 ? fmtMoney(wallet.activeWager) : '\u2014';
      availableEl.textContent = fmtMoney(wallet.balance);
      txList.replaceChildren(
        ...wallet.transactions.map((tx) =>
          el(
            'li',
            { class: 'tx-row' },
            el('span', { class: 'tx-kind' }, tx.kind),
            el('span', { class: `tx-amount ${tx.amount < 0 ? 'debit' : 'credit'}` },
              `${tx.amount < 0 ? '\u2212' : '+'}${fmtMoney(Math.abs(tx.amount))}`),
            el('span', { class: 'tx-time' }, fmtTime(tx.ts)),
          ),
        ),
      );
      if (wallet.transactions.length === 0) {
        txList.append(el('li', { class: 'empty' }, 'No transactions yet'));
      }
    },
  };
}
