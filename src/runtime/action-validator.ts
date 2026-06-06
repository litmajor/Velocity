export class ActionValidator {
  static validatePlaceBet(payload: Record<string, unknown>): { userId: string; amount: number } {
    const userId = String(payload.userId ?? '').trim();
    const amount = Number(payload.amount);
    if (!userId) throw new Error('userId required');
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('amount must be a positive number');
    return { userId, amount };
  }

  static validateCashout(payload: Record<string, unknown>): { userId: string } {
    const userId = String(payload.userId ?? '').trim();
    if (!userId) throw new Error('userId required');
    return { userId };
  }
}
