import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import fsSync from 'fs';
import { writeFileAtomic, writeFileAtomicSync } from '../src/core/repositories/atomic-json';
import { FairnessEngine } from '../src/core/fairness-engine';
import { SettlementClaimStore } from '../src/core/repositories/settlement-claim';

describe('persistence durability primitives', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'velocity-durability-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('writeFileAtomic replaces the target atomically and leaves no temp files', async () => {
    const p = path.join(dir, 'state.json');
    await writeFileAtomic(p, '{"v":1}');
    await writeFileAtomic(p, '{"v":2}');
    expect(JSON.parse(await fs.readFile(p, 'utf8'))).toEqual({ v: 2 });
    const leftovers = (await fs.readdir(dir)).filter(f => f.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('writeFileAtomicSync is durable at return and survives concurrent-writer temp names', async () => {
    const p = path.join(dir, 'state.json');
    writeFileAtomicSync(p, '{"v":1}');
    expect(JSON.parse(fsSync.readFileSync(p, 'utf8'))).toEqual({ v: 1 });
    // many rapid writers to the same target: last rename wins, file always parses
    for (let i = 2; i <= 20; i++) writeFileAtomicSync(p, JSON.stringify({ v: i }));
    expect(JSON.parse(fsSync.readFileSync(p, 'utf8'))).toEqual({ v: 20 });
  });

  it('settlement claims are durable and single-winner even within one process', () => {
    const a = new SettlementClaimStore(path.join(dir, 'settlements'));
    const b = new SettlementClaimStore(path.join(dir, 'settlements'));
    expect(a.claim('r1')).toBe(true);
    expect(b.claim('r1')).toBe(false); // independent store, same directory
    expect(a.claim('r1')).toBe(false); // never re-claimable
    expect(b.isClaimed('r1')).toBe(true);
    expect(b.claim('r2')).toBe(true);
  });
});

describe('seed-chain durability (restart semantics)', () => {
  let dir: string;
  let savedDataDir: string | undefined;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'velocity-fairness-'));
    savedDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = dir;
  });
  afterEach(async () => {
    if (savedDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = savedDataDir;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('a used commit is durably on disk BEFORE allocateNextSeed returns', () => {
    const engine = new FairnessEngine();
    const alloc = engine.allocateNextSeed('round-a');
    // no flush, no shutdown hook: the durable record must already exist
    const persisted = JSON.parse(fsSync.readFileSync(path.join(dir, 'fairness.json'), 'utf8'));
    expect(persisted.usedCommits).toContain(alloc.serverHash);
  });

  it('after a restart, previously used commits are loaded before any allocation can run', () => {
    const engine1 = new FairnessEngine();
    const alloc = engine1.allocateNextSeed('round-a');
    // "restart": brand-new engine, all memory lost
    const engine2 = new FairnessEngine();
    const used: Set<string> = (engine2 as any).usedCommits;
    expect(used.has(alloc.serverHash)).toBe(true); // loaded synchronously in constructor
    // a fresh allocation can never re-issue the old commitment
    const alloc2 = engine2.allocateNextSeed('round-b');
    expect(alloc2.serverHash).not.toBe(alloc.serverHash);
  });

  it('restart after allocation but before reveal: the round cannot be revealed (voided by recovery), not double-committed', () => {
    const engine1 = new FairnessEngine();
    const alloc = engine1.allocateNextSeed('round-a');
    const engine2 = new FairnessEngine();
    // the allocation map is process memory: the new process cannot reveal it...
    expect(() => engine2.revealSeed('round-a')).toThrow(/no allocated seed/);
    // ...and it can never publish the same commitment for any other round
    for (let i = 0; i < 16; i++) {
      expect(engine2.allocateNextSeed(`round-${i}`).serverHash).not.toBe(alloc.serverHash);
    }
  });

  it('two engines over one directory publish disjoint commitments (per-process chains never collide)', () => {
    const engine1 = new FairnessEngine();
    const engine2 = new FairnessEngine();
    const commits1 = Array.from({ length: 8 }, (_, i) => engine1.allocateNextSeed(`a-${i}`).serverHash);
    const commits2 = Array.from({ length: 8 }, (_, i) => engine2.allocateNextSeed(`b-${i}`).serverHash);
    const all = [...commits1, ...commits2];
    expect(new Set(all).size).toBe(all.length);
  });
});
