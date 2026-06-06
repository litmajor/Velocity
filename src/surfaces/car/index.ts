import type { RoundState } from '../../domains/game';

export class CarSurface {
  render(state: RoundState) {
    return `CarSurface: multiplier=${state.multiplier}`;
  }
}
