import fs from 'fs/promises';
import path from 'path';
import type { Bet } from '../../domains/game';
import { writeFileAtomic, readJsonFailClosed, CorruptStateError } from './atomic-json';

export { CorruptStateError };

export interface BetRepository {
  save(bet: Bet): Promise<void>;
  get(betId: string): Promise<Bet | null>;
  listByRound(roundId: string): Promise<Bet[]>;
  listByUser(userId: string): Promise<Bet[]>;
  update(bet: Bet): Promise<void>;
  remove(betId: string): Promise<void>;
}

export class InMemoryBetRepository implements BetRepository {
  private bets = new Map<string, Bet>();

  async save(bet: Bet): Promise<void> {
    this.bets.set(bet.betId, bet);
  }

  async get(betId: string): Promise<Bet | null> {
    return this.bets.get(betId) ?? null;
  }

  async listByRound(roundId: string): Promise<Bet[]> {
    return Array.from(this.bets.values()).filter(b => b.roundId === roundId);
  }

  async listByUser(userId: string): Promise<Bet[]> {
    return Array.from(this.bets.values()).filter(b => b.userId === userId);
  }

  async update(bet: Bet): Promise<void> {
    this.bets.set(bet.betId, bet);
  }

  async remove(betId: string): Promise<void> {
    this.bets.delete(betId);
  }
}

export class FileBetRepository implements BetRepository {
  constructor(private dir = path.resolve(process.cwd(), 'data', 'bets')) {}

  private filePath(betId: string) {
    return path.join(this.dir, `${betId}.json`);
  }

  private async ensureDir() {
    await fs.mkdir(this.dir, { recursive: true });
  }

  async save(bet: Bet): Promise<void> {
    await this.ensureDir();
    await writeFileAtomic(this.filePath(bet.betId), JSON.stringify(bet, null, 2));
  }

  async get(betId: string): Promise<Bet | null> {
    return readJsonFailClosed<Bet>(this.filePath(betId));
  }

  async list(): Promise<Bet[]> {
    await this.ensureDir();
    const files = await fs.readdir(this.dir);
    const out: Bet[] = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue; // ignores leftover .tmp from interrupted replaces
      const b = await readJsonFailClosed<Bet>(path.join(this.dir, f));
      if (b) out.push(b);
    }
    return out;
  }

  async listByRound(roundId: string): Promise<Bet[]> {
    return (await this.list()).filter(b => b.roundId === roundId);
  }

  async listByUser(userId: string): Promise<Bet[]> {
    return (await this.list()).filter(b => b.userId === userId);
  }

  async update(bet: Bet): Promise<void> {
    await this.save(bet);
  }

  async remove(betId: string): Promise<void> {
    try {
      await fs.unlink(this.filePath(betId));
    } catch {}
  }
}
