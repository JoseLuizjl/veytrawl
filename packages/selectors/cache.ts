import { openDatabase, type Database } from '../core/database.js';
export interface SelectorCacheOptions {
  path?: string;
  ttlMs?: number;
  maxEntries?: number;
}
export class SelectorCache {
  private db: Database;
  private ttl: number;
  private max: number;
  constructor(options: SelectorCacheOptions = {}) {
    this.ttl = options.ttlMs ?? 7 * 24 * 60 * 60 * 1000;
    this.max = options.maxEntries ?? 1000;
    if (!Number.isFinite(this.ttl) || this.ttl <= 0 || !Number.isInteger(this.max) || this.max < 1)
      throw new Error('Invalid selector cache limits');
    this.db = openDatabase(options.path);
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS selector_cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated INTEGER NOT NULL);',
    );
  }
  get<T>(key: string): T | undefined {
    const row = this.db
      .prepare('SELECT value, updated FROM selector_cache WHERE key=?')
      .get(key) as
      | {
          value: string;
          updated: number;
        }
      | undefined;
    if (!row) return;
    if (Date.now() - row.updated > this.ttl) {
      this.delete(key);
      return;
    }
    try {
      return JSON.parse(row.value) as T;
    } catch {
      this.delete(key);
      return;
    }
  }
  set(key: string, value: unknown) {
    this.db
      .prepare(
        'INSERT INTO selector_cache(key,value,updated) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated=excluded.updated',
      )
      .run(key, JSON.stringify(value), Date.now());
    this.db
      .prepare(
        'DELETE FROM selector_cache WHERE key NOT IN (SELECT key FROM selector_cache ORDER BY updated DESC, rowid DESC LIMIT ?)',
      )
      .run(this.max);
  }
  delete(key: string) {
    this.db.prepare('DELETE FROM selector_cache WHERE key=?').run(key);
  }
  close() {
    this.db.close();
  }
}
