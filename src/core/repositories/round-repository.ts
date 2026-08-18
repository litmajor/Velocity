import fs from 'fs/promises';
import path from 'path';
import type { RoundState } from '../../domains/game';
import { writeFileAtomic, readJsonFailClosed } from './atomic-json';

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
    await writeFileAtomic(this.filePath(round.roundId), JSON.stringify(round, null, 2));
  }

  async get(roundId: string): Promise<RoundState | null> {
    return readJsonFailClosed<RoundState>(this.filePath(roundId));
  }

  async list(): Promise<RoundState[]> {
    await this.ensureDir();
    const files = await fs.readdir(this.dir);
    const out: RoundState[] = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue; // ignores leftover .tmp from interrupted replaces
      const r = await readJsonFailClosed<RoundState>(path.join(this.dir, f));
      if (r) out.push(r);
    }
    return out;
  }

  async remove(roundId: string): Promise<void> {
    try {
      await fs.unlink(this.filePath(roundId));
    } catch {}
  }
}
