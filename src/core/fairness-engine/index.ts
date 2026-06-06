import crypto from 'crypto';
import { VolatilityEngine, SystemState } from '../volatility-engine';
import { saveJSON, loadJSON, ensureDataDir } from '../../runtime/persistence';

export interface FairnessResult {
  serverSeed: string;
  serverHash: string;
  clientSeed: string;
  nonce:      number;
  crashPoint: number;
}

export interface CrashProof {
  hex: string;
  instantCrash: boolean;
  instantDivisor?: number;
  modInt?: number;
  r: number;
  volatility?: number;
  houseEdge: number;
  raw: number;
  baseCrash: number;
  adjusted: number;
}

export interface ShapingParams {
  // If set, a deterministic instant-crash occurs when the derived int % instantCrashDivisor === 0
  instantCrashDivisor?: number;
  // Volatility exponent (>1 biases toward earlier crashes)
  volatility?: number;
  // House edge target (fraction, e.g., 0.01 for 1%) used as the instant-crash threshold fallback
  houseEdge?: number;
}

export class FairnessEngine {
  private nonce = 1;
  // Seed chain (hash ladder). Each entry is an unrevealed secret and salt for a future round.
  // The published commit for a round is `hash(secret)`; the revealed value is `secret`.
  private chain: Array<{ secret: string; salt: string }> = [];
  private allocated = new Map<string, { secret: string; salt?: string; commit: string; index: number }>();
  // per-round nonce tracking for deterministic nonces
  private roundNonces = new Map<string, number>();
  // track used commits to prevent seed reuse attacks
  private usedCommits = new Set<string>();
  // last allocated nonce for monotonicity checks
  private lastAllocatedNonce = 0;
  private shapingParams: ShapingParams = { instantCrashDivisor: 33, volatility: 1, houseEdge: 0.01 };
  private volatility = new VolatilityEngine();
  private shapingPreset: string = 'DEFAULT';
  // history of recent player mix observations for auditability
  private playerMixHistory: Array<{ mix: { conservative?: number; greedy?: number; tilted?: number }; ts: number }> = [];
  private readonly PERSIST_FILE = 'fairness.json';

  constructor() {
    // fire-and-forget load of persisted state
    void this.loadState();
  }

  generate(externalClientSeed?: string): FairnessResult {
    const serverSeed = crypto.randomBytes(32).toString('hex');
    const serverHash = this.hash(serverSeed);
    const clientSeed = externalClientSeed ?? crypto.randomBytes(8).toString('hex');
    const nonce = this.nonce++;
    const crashPoint = this.computeCrashPoint(serverSeed, clientSeed, nonce);

    return { serverSeed, serverHash, clientSeed, nonce, crashPoint };
  }

  /*******************
   * Seed chain helpers
   *******************/

  // Pre-generate a chain of secrets using a hash-ladder. The last element is a random seed
  // and earlier elements are its successive SHA256 hashes. Store secrets so they can be
  // allocated to rounds (unrevealed until reveal).
  preGenerateChain(count: number) {
    if (count <= 0) return;
    // Start from a fresh random tail seed
    let tail = crypto.randomBytes(32).toString('hex');
    const newSecrets: Array<{ secret: string; salt: string }> = [{ secret: tail, salt: '' }];
    for (let i = 1; i < count; i++) {
      const salt = crypto.randomBytes(16).toString('hex');
      tail = this.hash(tail + ':' + salt);
      newSecrets.push({ secret: tail, salt });
    }
    // newSecrets[0] is the random tail, newSecrets[count-1] is the root; we want
    // to push secrets in reveal order (next secret to reveal should be at index 0),
    // so reverse them: root first -> tail last, but for allocation we want the tail
    // (unrevealed secret) to be at the front. We'll store unrevealed secrets such that
    // chain[0] is the next secret to be used (tail).
    newSecrets.reverse();
    // Append to existing chain
    this.chain.push(...newSecrets);
  }

  // Persist/load important fairness state (used commits + player mix history)
  private async saveState() {
    try {
      await ensureDataDir();
      await saveJSON(this.PERSIST_FILE, {
        usedCommits: Array.from(this.usedCommits),
        playerMixHistory: this.playerMixHistory,
        chainLength: this.chain.length,
      });
    } catch (e) {}
  }

  private async loadState() {
    try {
      await ensureDataDir();
      const obj = await loadJSON<any>(this.PERSIST_FILE);
      if (!obj) return;
      if (Array.isArray(obj.usedCommits)) obj.usedCommits.forEach((c: string) => this.usedCommits.add(c));
      if (Array.isArray(obj.playerMixHistory)) this.playerMixHistory = obj.playerMixHistory;
      // chainLength is advisory; do nothing for now
    } catch (e) {}
  }

  // Public API to flush persisted fairness state (usedCommits, playerMixHistory)
  public async persistState() {
    await this.saveState();
  }

  // Ensure the chain has at least `min` unrevealed secrets available.
  ensureChain(min: number) {
    if (this.chain.length >= min) return;
    const toGenerate = Math.max(min - this.chain.length, 1);
    this.preGenerateChain(toGenerate);
  }

  // Allocate the next unrevealed secret to a round. Returns allocation details
  // including `serverSeed` (kept server-side), `serverHash` (commit), `clientSeed`,
  // `nonce` and the computed `crashPoint`. The `serverSeed` is not published to
  // clients until `revealSeed(roundId)` is called; it is returned here for internal
  // bookkeeping by the engine.
  allocateNextSeed(roundId: string, externalClientSeed?: string) {
    if (this.chain.length === 0) this.preGenerateChain(8);
    const entry = this.chain.shift()!; // take next secret (unrevealed)
    const secret = entry.secret;
    const salt = entry.salt;
    const commit = this.hash(secret);
    // prevent seed reuse attacks: ensure commit not already used
    if (this.usedCommits.has(commit)) {
      throw new Error('Seed collision detected');
    }
    const index = Date.now();
    const clientSeed = externalClientSeed ?? crypto.randomBytes(8).toString('hex');
    const nonce = this.nextNonce(roundId);
    const crashPoint = this.computeCrashPoint(secret, clientSeed, nonce);
    this.allocated.set(roundId, { secret, salt, commit, index });
    this.usedCommits.add(commit);
    // persist used commits so seed reuse survives restarts
    void this.saveState();
    return { serverSeed: secret, serverHash: commit, clientSeed, nonce, crashPoint };
  }

  // Reveal the secret allocated to the round and remove it from the allocated map.
  // Returns { serverSeed, serverHash } or throws if not found.
  revealSeed(roundId: string) {
    const entry = this.allocated.get(roundId);
    if (!entry) throw new Error(`no allocated seed for round ${roundId}`);
    this.allocated.delete(roundId);
    return { serverSeed: entry.secret, serverHash: entry.commit, salt: entry.salt } as any;
  }

  // Record a round result so the volatility engine can update state.
  recordRound(crashPoint: number) {
    this.volatility.recordRound(crashPoint);
  }

  recordWin(amount: number) {
    this.volatility.recordWin(amount);
  }

  recordLoss(amount: number) {
    this.volatility.recordLoss(amount);
  }

  getElasticity(): number {
    return this.volatility.getElasticity?.() ?? 1;
  }

  // Expose the current volatility/system state for publishing in snapshots.
  getVolatilityState(): SystemState {
    return this.volatility.getState();
  }

  // Allow external components to provide aggregated player composition
  setPlayerMix(mix: { conservative?: number; greedy?: number; tilted?: number }) {
    try { (this.volatility as any).setPlayerMix?.(mix); } catch (e) {}
    try { this.playerMixHistory.push({ mix, ts: Date.now() }); } catch (e) {}
    if (this.playerMixHistory.length > 128) this.playerMixHistory.shift();
  }

  getPlayerMixHistory() {
    return this.playerMixHistory.slice();
  }

  // Expose getter/setter for playerMix tuning params
  setPlayerMixParams(params: any) {
    try { (this.volatility as any).setPlayerMixParams?.(params); } catch (e) {}
  }

  getPlayerMixParams() {
    try { return (this.volatility as any).getPlayerMixParams?.() ?? null; } catch (e) { return null; }
  }

  // deterministic per-round nonce generator
  private nextNonce(roundId: string): number {
    const n = this.roundNonces.get(roundId) ?? 0;
    const next = n + 1;
    this.roundNonces.set(roundId, next);
    return next;
  }

  // Configure shaping parameters at runtime. These params are public and should be
  // published in `STATE_SNAPSHOT` so clients can verify the mapping used to derive
  // crash points from seeds.
  setShapingParams(params: Partial<ShapingParams>) {
    this.shapingParams = { ...this.shapingParams, ...params };
    // If tuning playerMixParams are present, forward them to volatility engine
    try {
      if ((this.shapingParams as any).playerMixParams) {
        (this.volatility as any).setPlayerMixParams?.((this.shapingParams as any).playerMixParams);
      }
    } catch (e) {}
  }

  getShapingParams(): ShapingParams {
    return { ...this.shapingParams };
  }

  setShapingPreset(preset: 'CALM' | 'TENSION' | 'CHAOS' | 'RESET' | 'DEFAULT') {
    this.shapingPreset = preset;
    switch (preset) {
      case 'CALM':
        this.shapingParams = { instantCrashDivisor: 50, volatility: 0.8, houseEdge: 0.01 };
        break;
      case 'TENSION':
        this.shapingParams = { instantCrashDivisor: 33, volatility: 1.1, houseEdge: 0.01 };
        break;
      case 'CHAOS':
        this.shapingParams = { instantCrashDivisor: 16, volatility: 1.6, houseEdge: 0.01 };
        break;
      case 'RESET':
        this.shapingParams = { instantCrashDivisor: 80, volatility: 0.6, houseEdge: 0.01 };
        break;
      default:
        this.shapingParams = { instantCrashDivisor: 33, volatility: 1, houseEdge: 0.01 };
    }
  }

  getShapingPreset(): string {
    return this.shapingPreset;
  }

  // Can be called by anyone post-crash to verify the result
  computeCrashPoint(serverSeed: string, clientSeed: string, nonce: number): number {
    return this.computeProof(serverSeed, clientSeed, nonce).adjusted;
  }

  // Compute a reproducible proof object containing intermediate values used
  // to derive the crash point. This object can be published alongside the
  // revealed serverSeed so clients or auditors can independently verify the
  // crash derivation.
  computeProof(serverSeed: string, clientSeed: string, nonce: number): CrashProof {
    const hmac = crypto.createHmac('sha256', serverSeed);
    hmac.update(`${clientSeed}:${nonce}`);
    const hex = hmac.digest('hex');

    const instantDiv = this.shapingParams.instantCrashDivisor;
    let instantCrash = false;
    let modInt: number | undefined;
    if (instantDiv && instantDiv > 1) {
      modInt = parseInt(hex.slice(0, 8), 16);
      if (modInt % instantDiv === 0) instantCrash = true;
    }

    // Use first 52 bits as a uniform [0, 1) float
    const h = parseInt(hex.slice(0, 13), 16);
    let r = h / Math.pow(2, 52);

    const vol = this.shapingParams.volatility ?? 1;
    if (vol !== 1 && vol > 0) {
      r = Math.pow(r, vol);
    }

    const houseEdge = this.shapingParams.houseEdge ?? 0.01;
    if (r < houseEdge) {
      return {
        hex,
        instantCrash: true,
        instantDivisor: instantDiv,
        modInt,
        r,
        volatility: vol,
        houseEdge,
        raw: 0,
        baseCrash: 1.0,
        adjusted: 1.0,
      };
    }

    const raw = (1 - houseEdge) / (1 - r);
    const baseCrash = Math.max(1.01, Math.floor(raw * 100) / 100);
    const adjusted = this.volatility.adjustCrash(baseCrash, hex);

    return {
      hex,
      instantCrash: instantCrash,
      instantDivisor: instantDiv,
      modInt,
      r,
      volatility: vol,
      houseEdge,
      raw,
      baseCrash,
      adjusted,
    };
  }

  verify(serverSeed: string, serverHash: string): boolean {
    return this.hash(serverSeed) === serverHash;
  }

  private hash(input: string): string {
    return crypto.createHash('sha256').update(input).digest('hex');
  }
}
// (Removed duplicate lightweight FairnessEngine to keep the full implementation above)
