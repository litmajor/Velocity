// RecentRounds: history strip + table. Render-only.

import type { GameView } from '../../../core/types.js';
import { fmtMult, fmtTime } from '../../../core/format.js';
import { el, badge, panel } from '../../../ui/dom.js';
import type { PanelView } from './game-surface.js';

const bucket = (crash: number): string => (crash < 1.2 ? 'danger' : crash < 2 ? 'neutral' : 'success');

export function createRecentRounds(): PanelView {
  const strip = el('div', { class: 'history-strip' });
  const tbody = el('tbody');
  const { root, body } = panel('Recent Rounds', 'recent-rounds');
  body.append(
    strip,
    el(
      'table',
      { class: 'table' },
      el(
        'thead',
        {},
        el(
          'tr',
          {},
          el('th', {}, 'Round'),
          el('th', {}, 'Crash'),
          el('th', {}, 'Time'),
          el('th', {}, 'Status'),
          el('th', {}, 'Fairness'),
        ),
      ),
      tbody,
    ),
  );

  return {
    root,
    update(state: GameView): void {
      strip.replaceChildren(
        ...state.history.slice(0, 12).map((h) => badge(fmtMult(h.crashPoint), bucket(h.crashPoint))),
      );
      tbody.replaceChildren(
        ...state.history.slice(0, 8).map((h) =>
          el(
            'tr',
            {},
            el('td', {}, `#${h.roundNumber}`),
            el('td', { class: `crash-${bucket(h.crashPoint)}` }, fmtMult(h.crashPoint)),
            el('td', {}, fmtTime(h.endedAt)),
            el('td', {}, badge(h.status, 'neutral')),
            el('td', {}, h.fairnessAvailable ? badge('verifiable', 'success') : badge('pending', 'neutral')),
          ),
        ),
      );
      if (state.history.length === 0) {
        tbody.append(el('tr', {}, el('td', { class: 'empty', colspan: '5' }, 'No completed rounds yet')));
      }
    },
  };
}
