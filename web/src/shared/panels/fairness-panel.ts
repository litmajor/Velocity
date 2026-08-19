// FairnessPanel: collapsible view of the commit-reveal fields for the
// current round. The Verify button is a marked integration point: the real
// standalone verifier (src/core/fairness-engine/verifier.ts, verifyRound)
// uses node:crypto and is NOT duplicated here. Expected wiring: expose
// verifyRound(commitment, reveal) via a read-only endpoint or a browser
// crypto build, then replace the stub handler below.

import type { GameView } from '../../core/types.js';
import { fmtMult, shortHash } from '../../core/format.js';
import { el, button, panel } from '../../ui/dom.js';
import type { PanelView } from '../panel-view.js';

export function createFairnessPanel(): PanelView {
  const rows: Array<[string, HTMLElement]> = [
    'serverHash',
    'clientSeed',
    'nonce',
    'paramsCommit',
    'serverSeed',
    'volatilitySnapshot',
    'shapingParams',
    'proof',
  ].map((label) => [label, el('code', { class: 'fair-value' }, '\u2014')]);
  const valueByLabel = new Map(rows);

  const verifyNote = el('div', { class: 'bet-hint muted' }, '');
  const verifyBtn = button('Verify round', { class: 'btn btn-ghost' });
  verifyBtn.addEventListener('click', () => {
    verifyNote.textContent =
      'Not wired: verification runs through verifyRound() in src/core/fairness-engine/verifier.ts \u2014 see web/README.md.';
  });

  const details = el(
    'details',
    { class: 'fairness-details' },
    el('summary', {}, 'Provably fair \u2014 commitment & reveal'),
    el(
      'div',
      { class: 'fair-grid' },
      ...rows.flatMap(([label, valueEl]) => [el('span', { class: 'fair-label' }, label), valueEl]),
    ),
    el('div', { class: 'fair-actions' }, verifyBtn, verifyNote),
  );

  const { root, body } = panel('Fairness', 'fairness-panel');
  body.append(details);

  const setRow = (label: string, text: string) => {
    const node = valueByLabel.get(label);
    if (node) node.textContent = text;
  };

  return {
    root,
    update(state: GameView): void {
      const f = state.fairness;
      setRow('serverHash', shortHash(f.serverHash));
      setRow('clientSeed', f.clientSeed ?? '\u2014');
      setRow('nonce', f.nonce !== null ? String(f.nonce) : '\u2014');
      setRow('paramsCommit', shortHash(f.paramsCommit));
      setRow('serverSeed', f.serverSeed ? shortHash(f.serverSeed) : 'hidden until crash');
      setRow('volatilitySnapshot', f.volatilitySnapshot ? JSON.stringify(f.volatilitySnapshot) : 'revealed at crash');
      setRow('shapingParams', f.shapingParams ? JSON.stringify(f.shapingParams) : 'revealed at crash');
      setRow('proof', f.proofCrashPoint !== null ? `crashPoint ${fmtMult(f.proofCrashPoint)}` : 'available after reveal');
      verifyBtn.disabled = f.serverSeed === null;
    },
  };
}
