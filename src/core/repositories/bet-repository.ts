import fs from 'fs/promises';
import path from 'path';
import type { Bet } from '../../domains/game';

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
    await fs.writeFile(this.filePath(bet.betId), JSON.stringify(bet, null, 2), 'utf8');
  }

  async get(betId: string): Promise<Bet | null> {
    try {
      const raw = await fs.readFile(this.filePath(betId), 'utf8');
      return JSON.parse(raw) as Bet;
    } catch {
      return null;
    }
  }

  async listByRound(roundId: string): Promise<Bet[]> {
    try {
      await this.ensureDir();
      const files = await fs.readdir(this.dir);
      const out: Bet[] = [];
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        const raw = await fs.readFile(path.join(this.dir, f), 'utf8');
        const b = JSON.parse(raw) as Bet;
        if (b.roundId === roundId) out.push(b);
      }
      return out;
    } catch {
      return [];
    }
  }

  async listByUser(userId: string): Promise<Bet[]> {
    try {
      await this.ensureDir();
      const files = await fs.readdir(this.dir);
      const out: Bet[] = [];
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        const raw = await fs.readFile(path.join(this.dir, f), 'utf8');
        const b = JSON.parse(raw) as Bet;
        if (b.userId === userId) out.push(b);
      }
      return out;
    } catch {
      return [];
    }
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
