export interface Bet {
  userId: string;
  amount: number;
  autoCashout?: number;
}

export interface Cashout {
  userId: string;
  atMultiplier: number;
}
