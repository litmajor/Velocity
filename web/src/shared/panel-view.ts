// Shared panel contract: every panel and experience scene is a pure
// `update(GameView)` renderer over the normalized audit/game state.

import type { GameView } from '../core/types.js';

export interface PanelView {
  root: HTMLElement;
  update(state: GameView): void;
}
