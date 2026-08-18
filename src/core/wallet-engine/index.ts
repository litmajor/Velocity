import crypto from 'crypto';
import { WalletLedger, LedgerRecord } from './ledger';

export { WalletLedger, CorruptLedgerError } from './ledger';
export type { LedgerRecord } from './ledger';

export interface Reservation {
  id: string;
  userId: string;
  amount: number;
}

/**
 * Wallet with an optional durable write-ahead ledger. When constructed with a
 * ledger path, every economic mutation is appended (and fsync'd) to the
 * ledger BEFORE the in-memory state changes, and the full state (balances,
 * reservations, applied tx ids) is rebuilt by replay on construction.
 *
 * Every mutation has a durable tx id; callers may supply deterministic ids
 * (e.g. `payout:<betId>`) to make retries exactly-once: a mutation whose tx
 * id was already applied is a no-op (methods return false).
 */
export class WalletEngine {
  private balances = new Map<string, number>();
  private reservations = new Map<string, { userId: string; amount: number }>();
  private reservedTotals = new Map<string, number>();
  private appliedTx = new Set<string>();
  private ledger: WalletLedger | null = null;

  constructor(opts?: { ledgerPath?: string }) {
    if (opts?.ledgerPath) {
      this.ledger = new WalletLedger(opts.ledgerPath);
      for (const rec of this.ledger.load()) this.apply(rec);
    }
  }

  /** Rebuild in-memory state from one durable record (replay path). */
  private apply(rec: LedgerRecord): void {
    if (this.appliedTx.has(rec.tx)) return;
    this.appliedTx.add(rec.tx);
    switch (rec.t) {
      case 'ENSURE':
        if (!this.balances.has(rec.u)) this.balances.set(rec.u, rec.a);
        break;
      case 'CREDIT':
        this.balances.set(rec.u, round2((this.balances.get(rec.u) ?? 0) + rec.a));
        break;
      case 'DEBIT':
        this.balances.set(rec.u, round2((this.balances.get(rec.u) ?? 0) - rec.a));
        break;
      case 'RESERVE': {
        this.reservations.set(rec.id, { userId: rec.u, amount: rec.a });
        this.reservedTotals.set(rec.u, round2((this.reservedTotals.get(rec.u) ?? 0) + rec.a));
        break;
      }
      case 'COMMIT': {
        const r = this.reservations.get(rec.id);
        if (!r) break;
        this.balances.set(r.userId, round2((this.balances.get(r.userId) ?? 0) - r.amount));
        this.reservations.delete(rec.id);
        this.reservedTotals.set(r.userId, round2(Math.max(0, (this.reservedTotals.get(r.userId) ?? 0) - r.amount)));
        break;
      }
      case 'ROLLBACK': {
        const r = this.reservations.get(rec.id);
        if (!r) break;
        this.reservations.delete(rec.id);
        this.reservedTotals.set(r.userId, round2(Math.max(0, (this.reservedTotals.get(r.userId) ?? 0) - r.amount)));
        break;
      }
    }
  }

  /** Durably record, then apply. Throws (mutating nothing) if the append fails. */
  private record(rec: LedgerRecord): void {
    if (this.ledger) this.ledger.append(rec);
    this.apply(rec);
  }

  ensureAccount(userId: string, initial = 0): void {
    if (this.balances.has(userId)) return;
    this.record({ t: 'ENSURE', u: userId, a: round2(initial), tx: `ensure:${userId}:${crypto.randomUUID()}`, ts: Date.now() });
  }

  getBalance(userId: string): number {
    return this.balances.get(userId) ?? 0;
  }

  getReservedTotal(userId: string): number {
    return this.reservedTotals.get(userId) ?? 0;
  }

  hasReservation(id: string): boolean {
    return this.reservations.has(id);
  }

  /** Durable reservation outcome queries (backed by applied tx ids). */
  wasReserved(id: string): boolean {
    return this.appliedTx.has(`reserve:${id}`);
  }

  wasCommitted(id: string): boolean {
    return this.appliedTx.has(`commit:${id}`);
  }

  wasRolledBack(id: string): boolean {
    return this.appliedTx.has(`rollback:${id}`);
  }

  listReservations(): Reservation[] {
    return Array.from(this.reservations.entries()).map(([id, r]) => ({ id, userId: r.userId, amount: r.amount }));
  }

  /** Returns false (no-op) if this tx id was already applied. */
  debit(userId: string, amount: number, txId?: string): boolean {
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('invalid debit amount');
    const rounded = round2(amount);
    if (rounded < 0.01) throw new Error('invalid debit amount (below 0.01)');
    const tx = txId ?? `debit:${crypto.randomUUID()}`;
    if (this.appliedTx.has(tx)) return false;
    const current = this.getBalance(userId);
    const reserved = this.reservedTotals.get(userId) ?? 0;
    if (current - reserved < rounded) throw new Error('insufficient funds');
    this.record({ t: 'DEBIT', u: userId, a: rounded, tx, ts: Date.now() });
    return true;
  }

  // Reservation API: reserve funds for a pending operation identified by `id`.
  reserve(userId: string, amount: number, id: string): void {
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('invalid reserve amount');
    this.ensureAccount(userId);
    if (this.reservations.has(id)) throw new Error('reservation id in use');
    if (this.appliedTx.has(`reserve:${id}`)) throw new Error('reservation id in use');
    const rounded = round2(amount);
    if (rounded < 0.01) throw new Error('invalid reserve amount (below 0.01)');
    const current = this.getBalance(userId);
    const reserved = this.reservedTotals.get(userId) ?? 0;
    if (current - reserved < rounded) throw new Error('insufficient funds (after reservations)');
    this.record({ t: 'RESERVE', u: userId, a: rounded, id, tx: `reserve:${id}`, ts: Date.now() });
  }

  commit(id: string): void {
    const r = this.reservations.get(id);
    if (!r) throw new Error('no reservation');
    this.record({ t: 'COMMIT', id, tx: `commit:${id}`, ts: Date.now() });
  }

  rollback(id: string): void {
    const r = this.reservations.get(id);
    if (!r) return; // idempotent
    this.record({ t: 'ROLLBACK', id, tx: `rollback:${id}`, ts: Date.now() });
  }

  /** Returns false (no-op) if this tx id was already applied. */
  credit(userId: string, amount: number, txId?: string): boolean {
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('invalid credit amount');
    const rounded = round2(amount);
    if (rounded < 0.01) throw new Error('invalid credit amount (below 0.01)');
    const tx = txId ?? `credit:${crypto.randomUUID()}`;
    if (this.appliedTx.has(tx)) return false;
    this.record({ t: 'CREDIT', u: userId, a: rounded, tx, ts: Date.now() });
    return true;
  }

  close(): void {
    this.ledger?.close();
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
