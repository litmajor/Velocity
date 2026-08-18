import { describe, it, expect } from 'vitest';
import { WalletEngine } from '../src/core/wallet-engine';

describe('WalletEngine monetary invariants', () => {
  it('balance starts at 0 and credit/debit round to 2dp', () => {
    const w = new WalletEngine();
    w.ensureAccount('u', 100);
    expect(w.getBalance('u')).toBe(100);
    w.credit('u', 10.005);
    expect(w.getBalance('u')).toBeCloseTo(110.01, 10);
    w.debit('u', 10.01);
    expect(w.getBalance('u')).toBeCloseTo(100, 10);
  });

  it('rejects invalid amounts (zero, negative, NaN, Infinity)', () => {
    const w = new WalletEngine();
    w.ensureAccount('u', 100);
    for (const bad of [0, -1, NaN, Infinity, -Infinity]) {
      expect(() => w.debit('u', bad)).toThrow();
      expect(() => w.credit('u', bad)).toThrow();
      expect(() => w.reserve('u', bad, 'r' + bad)).toThrow();
    }
  });

  it('INV-W1: debit cannot make a balance negative', () => {
    const w = new WalletEngine();
    w.ensureAccount('u', 50);
    expect(() => w.debit('u', 50.01)).toThrow(/insufficient/);
    expect(w.getBalance('u')).toBe(50);
  });

  it('INV-W2: reserved total cannot exceed available balance', () => {
    const w = new WalletEngine();
    w.ensureAccount('u', 100);
    w.reserve('u', 60, 'r1');
    expect(() => w.reserve('u', 41, 'r2')).toThrow(/insufficient/);
    w.reserve('u', 40, 'r2'); // exactly the remainder is fine
  });

  it('INV-W3: reservation ids are single-use', () => {
    const w = new WalletEngine();
    w.ensureAccount('u', 100);
    w.reserve('u', 10, 'r1');
    expect(() => w.reserve('u', 10, 'r1')).toThrow(/in use/);
  });

  it('INV-W4: failed reserve leaves wallet state unchanged', () => {
    const w = new WalletEngine();
    w.ensureAccount('u', 10);
    expect(() => w.reserve('u', 20, 'r1')).toThrow();
    expect(w.getBalance('u')).toBe(10);
    // a full-balance reservation must still be possible
    w.reserve('u', 10, 'r2');
  });

  it('INV-W5: rollback restores reservable funds; rollback is idempotent', () => {
    const w = new WalletEngine();
    w.ensureAccount('u', 100);
    w.reserve('u', 100, 'r1');
    expect(() => w.reserve('u', 1, 'r2')).toThrow();
    w.rollback('r1');
    w.rollback('r1'); // idempotent no-op
    w.reserve('u', 100, 'r3');
    w.commit('r3');
    expect(w.getBalance('u')).toBe(0);
  });

  it('INV-W6: commit applies the debit exactly once', () => {
    const w = new WalletEngine();
    w.ensureAccount('u', 100);
    w.reserve('u', 30, 'r1');
    w.commit('r1');
    expect(w.getBalance('u')).toBe(70);
    expect(() => w.commit('r1')).toThrow(/no reservation/); // cannot double-commit
    expect(w.getBalance('u')).toBe(70);
  });

  // FINDING V-M2: debit ignores outstanding reservations, so a debit + commit
  // sequence can push the balance negative.
  it('INV-W7: debit while funds are reserved cannot lead to a negative balance', () => {
    const w = new WalletEngine();
    w.ensureAccount('u', 100);
    w.reserve('u', 50, 'r1');
    // Debiting the full 100 would leave only 0 to cover the outstanding 50 reservation.
    expect(() => w.debit('u', 100)).toThrow(/insufficient/);
    w.commit('r1');
    expect(w.getBalance('u')).toBeGreaterThanOrEqual(0);
  });

  // FINDING V-M1: amounts below 0.005 round to a 0.00 reservation/debit while
  // the raw amount is still recorded on the bet, enabling value creation.
  it('INV-W8: sub-cent amounts cannot create a zero-cost reservation', () => {
    const w = new WalletEngine();
    w.ensureAccount('u', 0);
    expect(() => w.reserve('u', 0.004, 'r1')).toThrow();
    expect(() => w.credit('u', 0.004)).toThrow();
    expect(() => w.debit('u', 0.004)).toThrow();
    expect(w.getBalance('u')).toBe(0);
  });

  it('property: random reserve/commit/rollback/credit/debit sequences preserve invariants', () => {
    // deterministic LCG so the test is reproducible
    let seed = 42;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const w = new WalletEngine();
    const users = ['a', 'b', 'c'];
    for (const u of users) w.ensureAccount(u, 1000);
    const open: Array<{ id: string; userId: string; amount: number }> = [];
    let credited = 0;
    let debited = 0;
    let nextId = 0;

    for (let i = 0; i < 5000; i++) {
      const u = users[Math.floor(rnd() * users.length)];
      const op = rnd();
      const amount = Math.round(rnd() * 20000) / 100 + 0.01;
      try {
        if (op < 0.35) {
          const id = 'r' + nextId++;
          w.reserve(u, amount, id);
          open.push({ id, userId: u, amount: Math.round(amount * 100) / 100 });
        } else if (op < 0.55 && open.length) {
          const r = open.splice(Math.floor(rnd() * open.length), 1)[0];
          w.commit(r.id);
          debited += r.amount;
        } else if (op < 0.7 && open.length) {
          const r = open.splice(Math.floor(rnd() * open.length), 1)[0];
          w.rollback(r.id);
        } else if (op < 0.85) {
          w.credit(u, amount);
          credited += Math.round(amount * 100) / 100;
        } else {
          w.debit(u, amount);
          debited += Math.round(amount * 100) / 100;
        }
      } catch {
        // rejected ops must not change state; balance checks below verify
      }
      for (const user of users) {
        expect(w.getBalance(user)).toBeGreaterThanOrEqual(0);
      }
    }
    const total = users.reduce((s, u) => s + w.getBalance(u), 0);
    // conservation: initial + credited - debited == final (within float rounding of 2dp ops)
    expect(total).toBeCloseTo(3000 + credited - debited, 1);
  });
});
