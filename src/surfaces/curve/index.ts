import type { RoundState } from '../../domains/game';

export class CurveSurface {
  render(state: RoundState) {
    return `CurveSurface: multiplier=${state.multiplier}`;
  }
}
