// PlayerTable: live players for the current round. Render-only.

import type { GameView } from '../../core/types.js';
import { fmtMoney, fmtMult } from '../../core/format.js';
import { el, badge, panel } from '../../ui/dom.js';
import type { PanelView } from '../panel-view.js';

const STATUS_VARIANT: Record<string, string> = {
  ACTIVE: 'running',
  CASHED_OUT: 'success',
  LOST: 'danger',
};

export function createPlayerTable(): PanelView {
  const tbody = el('tbody');
  const { root, body } = panel('Live Players', 'player-table');
  body.append(
    el(
      'table',
      { class: 'table' },
      el(
        'thead',
        {},
        el(
          'tr',
          {},
          el('th', {}, 'Player'),
          el('th', {}, 'Stake'),
          el('th', {}, 'Mult'),
          el('th', {}, 'Auto'),
          el('th', {}, 'Payout'),
          el('th', {}, 'Status'),
        ),
      ),
      tbody,
    ),
  );

  return {
    root,
    update(state: GameView): void {
      tbody.replaceChildren(
        ...state.players.map((p) =>
          el(
            'tr',
            { class: p.userId === state.userId ? 'row-you' : '' },
            el('td', {}, p.userId),
            el('td', {}, fmtMoney(p.stake)),
            el(
              'td',
              {},
              p.status === 'CASHED_OUT' && p.cashedOutMultiplier !== null
                ? fmtMult(p.cashedOutMultiplier)
                : p.status === 'ACTIVE' && state.round.phase === 'RUNNING'
                  ? fmtMult(state.round.multiplier)
                  : '\u2014',
            ),
            el('td', {}, p.autoCashout !== null ? fmtMult(p.autoCashout) : '\u2014'),
            el('td', {}, p.payout !== null ? fmtMoney(p.payout) : '\u2014'),
            el('td', {}, badge(p.status.replace('_', ' '), STATUS_VARIANT[p.status] ?? 'neutral')),
          ),
        ),
      );
      if (state.players.length === 0) {
        tbody.append(el('tr', {}, el('td', { class: 'empty', colspan: '6' }, 'No players yet')));
      }
    },
  };
}
