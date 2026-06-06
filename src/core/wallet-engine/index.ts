export class WalletEngine {
  private balances = new Map<string, number>();
  private reservations = new Map<string, { userId: string; amount: number }>();
  private reservedTotals = new Map<string, number>();

  ensureAccount(userId: string, initial = 0): void {
    if (!this.balances.has(userId)) this.balances.set(userId, Math.round(initial * 100) / 100);
  }

  getBalance(userId: string): number {
    return this.balances.get(userId) ?? 0;
  }

  debit(userId: string, amount: number): void {
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('invalid debit amount');
    const rounded = Math.round(amount * 100) / 100;
    const current = this.getBalance(userId);
    if (current < rounded) throw new Error('insufficient funds');
    this.balances.set(userId, Math.round((current - rounded) * 100) / 100);
  }

  // Reservation API: reserve funds for a pending operation identified by `id`.
  reserve(userId: string, amount: number, id: string): void {
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('invalid reserve amount');
    this.ensureAccount(userId);
    if (this.reservations.has(id)) throw new Error('reservation id in use');
    const rounded = Math.round(amount * 100) / 100;
    const current = this.getBalance(userId);
    const reserved = this.reservedTotals.get(userId) ?? 0;
    if (current - reserved < rounded) throw new Error('insufficient funds (after reservations)');
    this.reservations.set(id, { userId, amount: rounded });
    this.reservedTotals.set(userId, Math.round((reserved + rounded) * 100) / 100);
  }

  commit(id: string): void {
    const r = this.reservations.get(id);
    if (!r) throw new Error('no reservation');
    const { userId, amount } = r;
    // apply debit
    const current = this.getBalance(userId);
    this.balances.set(userId, Math.round((current - amount) * 100) / 100);
    // remove reservation
    this.reservations.delete(id);
    const reserved = this.reservedTotals.get(userId) ?? 0;
    this.reservedTotals.set(userId, Math.round(Math.max(0, reserved - amount) * 100) / 100);
  }

  rollback(id: string): void {
    const r = this.reservations.get(id);
    if (!r) return; // idempotent
    const { userId, amount } = r;
    this.reservations.delete(id);
    const reserved = this.reservedTotals.get(userId) ?? 0;
    this.reservedTotals.set(userId, Math.round(Math.max(0, reserved - amount) * 100) / 100);
  }

  credit(userId: string, amount: number): void {
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('invalid credit amount');
    const rounded = Math.round(amount * 100) / 100;
    const current = this.getBalance(userId);
    this.balances.set(userId, Math.round((current + rounded) * 100) / 100);
  }
}
