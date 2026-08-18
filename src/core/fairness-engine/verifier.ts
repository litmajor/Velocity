import crypto from 'crypto';
import { VolatilityEngine, VolatilitySnapshot } from '../volatility-engine';

/**
 * Standalone, engine-free verifier for a revealed round.
 *
 * Everything here is a pure function of PUBLISHED data:
 *  - before betting: serverHash (commit of the seed) and paramsCommit
 *    (blinded commit of the exact shaping params + volatility snapshot
 *    that will map the seed to the final crash point)
 *  - at crash: serverSeed, shapingParams, volatilitySnapshot, paramsSalt
 *
 * An auditor holding those values can reproduce the final crash point
 * byte-for-byte without trusting the server, and can prove that neither the
 * seed nor the mapping changed after the commitment.
 */

export interface PublishedShapingParams {
  instantCrashDivisor?: number;
  volatility?: number;
  houseEdge?: number;
}

export interface FairnessCommitment {
  serverHash: string;   // sha256(serverSeed)
  paramsCommit: string; // sha256(canonical({shaping, snapshot}) + ':' + paramsSalt)
}

export interface FairnessReveal {
  serverSeed: string;
  clientSeed: string;
  nonce: number;
  shapingParams: PublishedShapingParams;
  volatilitySnapshot: VolatilitySnapshot;
  paramsSalt: string;
  crashPoint: number;
}

export interface VerificationResult {
  ok: boolean;
  seedMatchesCommit: boolean;
  paramsMatchCommit: boolean;
  crashPointMatches: boolean;
  recomputedCrashPoint: number;
}

// Deterministic JSON: keys sorted recursively so the hash is stable across
// producers regardless of insertion order.
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter(k => obj[k] !== undefined).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
}

export function computeParamsCommit(
  shaping: PublishedShapingParams,
  snapshot: VolatilitySnapshot,
  salt: string,
): string {
  const payload = canonicalJson({ shaping, snapshot });
  return crypto.createHash('sha256').update(payload + ':' + salt).digest('hex');
}

/**
 * Recompute the final crash point from published data alone.
 * Mirrors FairnessEngine.computeProof + VolatilityEngine.crashFromRPure,
 * but as a pure function with no engine state. The uniform draw is never
 * warped; all shaping flows through the committed snapshot's EdgeProfile,
 * whose bounds are re-enforced inside crashFromRPure.
 */
export function recomputeCrashPoint(
  serverSeed: string,
  clientSeed: string,
  nonce: number,
  shaping: PublishedShapingParams,
  snapshot: VolatilitySnapshot,
): number {
  const hmac = crypto.createHmac('sha256', serverSeed);
  hmac.update(`${clientSeed}:${nonce}`);
  const hex = hmac.digest('hex');

  const h = parseInt(hex.slice(0, 13), 16);
  const r = h / Math.pow(2, 52);

  const houseEdge = shaping.houseEdge ?? 0.01;
  return VolatilityEngine.crashFromRPure(r, houseEdge, snapshot);
}

export function verifyRound(commitment: FairnessCommitment, reveal: FairnessReveal): VerificationResult {
  const seedMatchesCommit =
    crypto.createHash('sha256').update(reveal.serverSeed).digest('hex') === commitment.serverHash;
  const paramsMatchCommit =
    computeParamsCommit(reveal.shapingParams, reveal.volatilitySnapshot, reveal.paramsSalt) ===
    commitment.paramsCommit;
  const recomputedCrashPoint = recomputeCrashPoint(
    reveal.serverSeed,
    reveal.clientSeed,
    reveal.nonce,
    reveal.shapingParams,
    reveal.volatilitySnapshot,
  );
  const crashPointMatches = recomputedCrashPoint === reveal.crashPoint;
  return {
    ok: seedMatchesCommit && paramsMatchCommit && crashPointMatches,
    seedMatchesCommit,
    paramsMatchCommit,
    crashPointMatches,
    recomputedCrashPoint,
  };
}
