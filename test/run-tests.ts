import assert from 'assert';
import crypto from 'crypto';
import { FairnessEngine } from '../src/core/fairness-engine';

async function testComputeProofConsistency() {
  const f = new FairnessEngine();
  // deterministic inputs
  const serverSeed = crypto.randomBytes(32).toString('hex');
  const clientSeed = crypto.randomBytes(8).toString('hex');
  const nonce = 1;

  const proof = (f as any).computeProof(serverSeed, clientSeed, nonce);
  const cp = f.computeCrashPoint(serverSeed, clientSeed, nonce);

  assert.strictEqual(proof.adjusted, cp, 'computeProof.adjusted must equal computeCrashPoint result');
  console.log('✓ computeProof consistency');
}

async function testAllocateRevealConsistency() {
  const f = new FairnessEngine();
  // ensure chain available and allocate
  f.ensureChain(2);
  const roundId = 'test-round-' + Date.now();
  const alloc = f.allocateNextSeed(roundId);

  // reveal
  const reveal = f.revealSeed(roundId);
  // commit/hash should match
  assert.ok(f.verify(reveal.serverSeed, alloc.serverHash), 'verify(serverSeed, serverHash) should be true');

  const proof = (f as any).computeProof(reveal.serverSeed, alloc.clientSeed, alloc.nonce);
  assert.strictEqual(proof.adjusted, alloc.crashPoint, 'recomputed proof must match allocated crashPoint');

  console.log('✓ allocate/reveal consistency');
}

async function run() {
  try {
    await testComputeProofConsistency();
    await testAllocateRevealConsistency();
    console.log('\nAll tests passed');
    process.exit(0);
  } catch (err: any) {
    console.error('\nTest failed:', err && err.message ? err.message : err);
    process.exit(2);
  }
}

run();
