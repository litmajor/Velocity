import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import fssync from 'fs';
import { WalletEngine, CorruptLedgerError } from '../src/core/wallet-engine';

describe('durable wallet ledger', () => {
  let dir: string;
  let ledgerPath: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'velocity-wallet-'));
    ledgerPath = path.join(dir, 'wallet.ledger');
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const fresh = () => new WalletEngine({ ledgerPath });

  it('balances survive a restart', () => {
    const w1 = fresh();
    w1.ensureAccount('alice', 100);
    w1.credit('alice', 50);
    w1.debit('alice', 20);
    w1.close();

    const w2 = fresh();
    expect(w2.getBalance('alice')).toBe(130);
  });

  it('open reservations survive a restart (balance and hold intact)', () => {
    const w1 = fresh();
    w1.ensureAccount('alice', 100);
    w1.reserve('alice', 40, 'bet:r1');
    w1.close();

    const w2 = fresh();
    expect(w2.getBalance('alice')).toBe(100); // reserve does not move funds
    expect(w2.hasReservation('bet:r1')).toBe(true);
    expect(w2.getReservedTotal('alice')).toBe(40);
    // the hold still constrains spendable funds
    expect(() => w2.debit('alice', 70)).toThrow(/insufficient/);
  });

  it('a committed reservation cannot be committed again after restart', () => {
    const w1 = fresh();
    w1.ensureAccount('alice', 100);
    w1.reserve('alice', 40, 'bet:r1');
    w1.commit('bet:r1');
    expect(w1.getBalance('alice')).toBe(60);
    w1.close();

    const w2 = fresh();
    expect(w2.getBalance('alice')).toBe(60);
    expect(() => w2.commit('bet:r1')).toThrow(/no reservation/);
    expect(w2.getBalance('alice')).toBe(60);
    expect(w2.wasCommitted('bet:r1')).toBe(true);
  });

  it('a rolled-back reservation cannot be rolled back (or reused) again after restart', () => {
    const w1 = fresh();
    w1.ensureAccount('alice', 100);
    w1.reserve('alice', 40, 'bet:r1');
    w1.rollback('bet:r1');
    w1.close();

    const w2 = fresh();
    expect(w2.getBalance('alice')).toBe(100);
    w2.rollback('bet:r1'); // idempotent no-op
    expect(w2.getBalance('alice')).toBe(100);
    expect(w2.getReservedTotal('alice')).toBe(0);
    // reservation ids are single-use across restarts
    expect(() => w2.reserve('alice', 10, 'bet:r1')).toThrow(/in use/);
  });

  it('conservation: initial + credits - debits = final, across restarts', () => {
    const w1 = fresh();
    w1.ensureAccount('alice', 500);
    let credits = 0;
    let debits = 0;
    for (let i = 0; i < 25; i++) {
      w1.credit('alice', 7.13);
      credits += 7.13;
      w1.debit('alice', 3.02);
      debits += 3.02;
    }
    w1.reserve('alice', 50, 'bet:x');
    w1.commit('bet:x');
    debits += 50;
    w1.close();

    const w2 = fresh();
    expect(w2.getBalance('alice')).toBeCloseTo(500 + credits - debits, 2);
  });

  it('a credit with the same tx id is applied at most once, even across restarts', () => {
    const w1 = fresh();
    w1.ensureAccount('alice', 0.5);
    expect(w1.credit('alice', 75, 'payout:bet-1')).toBe(true);
    expect(w1.credit('alice', 75, 'payout:bet-1')).toBe(false); // in-process retry
    expect(w1.getBalance('alice')).toBe(75.5);
    w1.close();

    const w2 = fresh();
    expect(w2.credit('alice', 75, 'payout:bet-1')).toBe(false); // post-restart retry
    expect(w2.getBalance('alice')).toBe(75.5);
  });

  it('a torn final ledger line (crash mid-append) is discarded, earlier history intact', () => {
    const w1 = fresh();
    w1.ensureAccount('alice', 100);
    w1.credit('alice', 25);
    w1.close();
    // simulate a crash mid-append: partial record with no trailing newline
    fssync.appendFileSync(ledgerPath, '{"t":"CREDIT","u":"alice","a":999');

    const w2 = fresh();
    expect(w2.getBalance('alice')).toBe(125); // torn mutation never acknowledged
    // the file was truncated: further appends still replay cleanly
    w2.credit('alice', 10);
    w2.close();
    const w3 = fresh();
    expect(w3.getBalance('alice')).toBe(135);
  });

  it('fails closed on corruption BEFORE the final line (acknowledged history)', () => {
    const w1 = fresh();
    w1.ensureAccount('alice', 100);
    w1.credit('alice', 25);
    w1.close();
    const raw = fssync.readFileSync(ledgerPath, 'utf8');
    const lines = raw.split('\n');
    lines[0] = lines[0].slice(0, 10); // corrupt an interior record
    fssync.writeFileSync(ledgerPath, lines.join('\n'));

    expect(() => fresh()).toThrow(CorruptLedgerError);
  });

  it('missing ledger file is a valid empty wallet (not an error)', () => {
    const w = fresh();
    expect(w.getBalance('anyone')).toBe(0);
  });

  it('no negative balances and no reservation exceeding available funds, after replay', () => {
    const w1 = fresh();
    w1.ensureAccount('alice', 30);
    w1.reserve('alice', 20, 'bet:a');
    expect(() => w1.reserve('alice', 15, 'bet:b')).toThrow(/insufficient/);
    expect(() => w1.debit('alice', 15)).toThrow(/insufficient/);
    w1.close();

    const w2 = fresh();
    expect(w2.getBalance('alice')).toBe(30);
    expect(w2.getReservedTotal('alice')).toBe(20);
    expect(() => w2.reserve('alice', 15, 'bet:c')).toThrow(/insufficient/);
    expect(() => w2.debit('alice', 15)).toThrow(/insufficient/);
  });
});
