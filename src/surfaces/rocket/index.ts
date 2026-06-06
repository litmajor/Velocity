import type { RoundState } from '../../domains/game';

export class RocketSurface {
  render(state: RoundState) {
    return `RocketSurface: multiplier=${state.multiplier}`;
  }
}
