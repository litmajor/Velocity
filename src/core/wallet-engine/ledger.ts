import fs from 'fs';
import path from 'path';

// Append-only JSON-lines write-ahead log for wallet mutations.
// Records are appended (and fsync'd) BEFORE the in-memory state mutates, so
// every acknowledged economic mutation has exactly one durable record.

export type LedgerRecord =
  | { t: 'ENSURE'; u: string; a: number; tx: string; ts: number }
  | { t: 'CREDIT'; u: string; a: number; tx: string; ts: number }
  | { t: 'DEBIT'; u: string; a: number; tx: string; ts: number }
  | { t: 'RESERVE'; u: string; a: number; id: string; tx: string; ts: number }
  | { t: 'COMMIT'; id: string; tx: string; ts: number }
  | { t: 'ROLLBACK'; id: string; tx: string; ts: number };

export class CorruptLedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CorruptLedgerError';
  }
}

export class WalletLedger {
  private fd: number | null = null;

  constructor(private filePath: string) {}

  /**
   * Load all durable records. A torn FINAL line (crash mid-append) is
   * discarded and truncated away — that mutation was never acknowledged.
   * Corruption anywhere before the final line fails closed: acknowledged
   * history cannot be silently dropped without creating/destroying funds.
   */
  load(): LedgerRecord[] {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch (err: any) {
      if (err?.code === 'ENOENT') return [];
      throw err;
    }
    const records: LedgerRecord[] = [];
    let offset = 0; // byte offset of the end of the last good line
    const lines = raw.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === '') {
        continue;
      }
      const isLast = i === lines.length - 1 || (i === lines.length - 2 && lines[lines.length - 1] === '');
      try {
        records.push(JSON.parse(line) as LedgerRecord);
        offset += Buffer.byteLength(line, 'utf8') + 1; // +1 for '\n'
      } catch {
        if (isLast) {
          // torn tail: drop it and truncate so future appends start clean
          fs.truncateSync(this.filePath, offset);
          break;
        }
        throw new CorruptLedgerError(
          `wallet ledger corrupt at line ${i + 1} of ${this.filePath}; refusing to load partial history`,
        );
      }
    }
    return records;
  }

  /** Durably append one record (write + fsync) before the caller mutates memory. */
  append(record: LedgerRecord): void {
    if (this.fd === null) {
      const dir = path.dirname(this.filePath);
      fs.mkdirSync(dir, { recursive: true });
      const created = !fs.existsSync(this.filePath);
      this.fd = fs.openSync(this.filePath, 'a');
      if (created) {
        // make the new file's directory entry durable: without this, power
        // loss can lose the whole ledger file even though appends are fsync'd
        try {
          const dfd = fs.openSync(dir, 'r');
          try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
        } catch {}
      }
    }
    const line = JSON.stringify(record) + '\n';
    fs.writeSync(this.fd, line, null, 'utf8');
    fs.fsyncSync(this.fd);
  }

  close(): void {
    if (this.fd !== null) {
      fs.closeSync(this.fd);
      this.fd = null;
    }
  }
}
