import { createRequire } from 'node:module';
import { mkdirSync, openSync, closeSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
export interface Statement {
  run(...params: (string | number | null)[]): unknown;
  get(...params: (string | number | null)[]): unknown;
  all(...params: (string | number | null)[]): unknown[];
}
export interface Database {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
}
export function openDatabase(path = ':memory:'): Database {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try {
      closeSync(openSync(path, 'wx', 0o600));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if (process.platform !== 'win32') chmodSync(path, 0o600);
  }
  const require = createRequire(import.meta.url);
  let db: Database;
  if (process.versions.bun) {
    const native = new (
      require('bun:sqlite') as {
        Database: new (path: string) => Database;
      }
    ).Database(path);
    db = {
      exec: (sql) => native.exec(sql),
      close: () => native.close(),
      prepare: (sql) => {
        const invoke = (method: 'run' | 'get' | 'all', params: (string | number | null)[]) => {
          const statement = native.prepare(sql) as Statement & {
            finalize(): void;
          };
          try {
            return statement[method](...params);
          } finally {
            statement.finalize();
          }
        };
        return {
          run: (...params) => invoke('run', params),
          get: (...params) => invoke('get', params),
          all: (...params) => invoke('all', params) as unknown[],
        };
      },
    };
  } else
    db = new (
      require('node:sqlite') as {
        DatabaseSync: new (path: string) => Database;
      }
    ).DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  return db;
}
