#!/usr/bin/env node
import { FairnessEngine } from '../core/fairness-engine';

function usage() {
  console.log('Usage: node verify-seed.js <serverSeed> <clientSeed> <nonce>');
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 4) { usage(); process.exit(2); }
  const [serverSeed, serverHash, clientSeed, nonceStr] = args;
  const nonce = Number(nonceStr);
  if (!serverSeed || !serverHash || !clientSeed || !Number.isFinite(nonce)) { usage(); process.exit(2); }

  const f = new FairnessEngine();
  const computed = f.computeCrashPoint(serverSeed, clientSeed, nonce);
  const valid = f.verify(serverSeed, serverHash);

  console.log('Computed crashPoint:', computed);
  console.log('serverHash matches reveal:', valid);
  console.log('Provided serverHash:', serverHash);
}

main().catch(err => { console.error(err); process.exit(1); });
