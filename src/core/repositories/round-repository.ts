import fs from 'fs/promises';
import path from 'path';
import type { RoundState } from '../../domains/game';

export interface RoundRepository {
  save(round: RoundState): Promise<void>;
  get(roundId: string): Promise<RoundState | null>;
  list(): Promise<RoundState[]>;
  remove(roundId: string): Promise<void>;
}

export class InMemoryRoundRepository implements RoundRepository {
  private map = new Map<string, RoundState>();

  async save(round: RoundState): Promise<void> {
    this.map.set(round.roundId, round);
  }

  async get(roundId: string): Promise<RoundState | null> {
    return this.map.get(roundId) ?? null;
  }

  async list(): Promise<RoundState[]> {
    return Array.from(this.map.values());
  }

  async remove(roundId: string): Promise<void> {
    this.map.delete(roundId);
  }
}

export class FileRoundRepository implements RoundRepository {
  constructor(private dir = path.resolve(process.cwd(), 'data', 'rounds')) {}

  private filePath(roundId: string) {
    return path.join(this.dir, `${roundId}.json`);
  }

  private async ensureDir() {
    await fs.mkdir(this.dir, { recursive: true });
  }

  async save(round: RoundState): Promise<void> {
    await this.ensureDir();
    await fs.writeFile(this.filePath(round.roundId), JSON.stringify(round, null, 2), 'utf8');
  }

  async get(roundId: string): Promise<RoundState | null> {
    try {
      const raw = await fs.readFile(this.filePath(roundId), 'utf8');
      return JSON.parse(raw) as RoundState;
    } catch (err) {
      return null;
    }
  }

  async list(): Promise<RoundState[]> {
    try {
      await this.ensureDir();
      const files = await fs.readdir(this.dir);
      const out: RoundState[] = [];
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        const raw = await fs.readFile(path.join(this.dir, f), 'utf8');
        out.push(JSON.parse(raw) as RoundState);
      }
      return out;
    } catch (err) {
      return [];
    }
  }

  async remove(roundId: string): Promise<void> {
    try {
      await fs.unlink(this.filePath(roundId));
    } catch {}
  }
}
