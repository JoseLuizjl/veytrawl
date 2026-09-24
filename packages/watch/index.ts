import { abortable } from '../core/async.js';
import { openDatabase, type Database } from '../core/database.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { SemanticDocument } from '../dom/index.js';
import { diffDocuments, watchDiagnostics, type WatchDiagnostics } from './diff.js';
export type { DiffOptions, WatchDiagnostics } from './diff.js';
import { canonicalURL, type PageFetcher } from '../core/fetch.js';
export interface WatchEvent {
  id: string;
  url: string;
  at: string;
  type: 'pricing-change' | 'content-added' | 'content-removed' | 'content-changed' | 'state-change';
  important: true;
  context: string;
  before?: string;
  after?: string;
}
export const semanticDiff = diffDocuments;
const watchSchema = z.object({
  url: z.url(),
  watchFor: z.string().trim().min(1),
  ignoreTimestamps: z.boolean().optional(),
  ignoreText: z.array(z.string().min(1)).max(100).optional(),
  scope: z.string().trim().min(1).optional(),
});
export type WatchOptions = z.input<typeof watchSchema> & {
  signal?: AbortSignal;
};
export interface WatchStoreOptions {
  maxEvents?: number;
}
export type WatchHistoryOptions = WatchOptions & {
  limit?: number;
  offset?: number;
};
export class WatchStore {
  private db: Database;
  private pending: Promise<unknown> = Promise.resolve();
  private closed = false;
  private maxEvents: number;
  constructor(path = ':memory:', options: WatchStoreOptions = {}) {
    this.maxEvents = options.maxEvents ?? 1000;
    if (!Number.isInteger(this.maxEvents) || this.maxEvents < 0 || this.maxEvents > 100000)
      throw new Error('maxEvents must be an integer from 0 to 100000');
    this.db = openDatabase(path);
    this.db.exec(
      'PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS snapshots (key TEXT PRIMARY KEY, document TEXT NOT NULL); CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, watch_key TEXT NOT NULL, event TEXT NOT NULL); CREATE INDEX IF NOT EXISTS events_watch ON events(watch_key);',
    );
  }
  check(
    input: WatchOptions,
    fetcher: PageFetcher,
  ): Promise<{
    baseline: boolean;
    events: WatchEvent[];
    document: SemanticDocument;
    diagnostics: WatchDiagnostics;
  }> {
    this.assertOpen();
    const options = watchSchema.parse(input),
      url = canonicalURL(options.url);
    const run = this.pending.then(async () => {
      this.assertOpen();
      input.signal?.throwIfAborted();
      const document = await abortable(
        () => fetcher.load(url, { signal: input.signal }),
        input.signal,
      );
      input.signal?.throwIfAborted();
      if (document.warnings?.length)
        throw new Error(`Incomplete snapshot: ${document.warnings.join('; ')}`);
      if (document.nodes.length === 0)
        throw new Error('Empty snapshot rejected; prior baseline retained');
      const diagnostics = watchDiagnostics(document, options.watchFor, options);
      const key = this.key(options);
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const row = this.db.prepare('SELECT document FROM snapshots WHERE key = ?').get(key) as
          | {
              document: string;
            }
          | undefined;
        const events = row
          ? semanticDiff(
              JSON.parse(row.document) as SemanticDocument,
              document,
              options.watchFor,
              options,
            )
          : [];
        this.db
          .prepare(
            'INSERT INTO snapshots(key,document) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET document=excluded.document',
          )
          .run(key, JSON.stringify(document));
        const insert = this.db.prepare('INSERT INTO events(id,watch_key,event) VALUES(?,?,?)');
        events.forEach((event) => insert.run(event.id, key, JSON.stringify(event)));
        this.db
          .prepare(
            'DELETE FROM events WHERE watch_key=? AND rowid NOT IN (SELECT rowid FROM events WHERE watch_key=? ORDER BY rowid DESC LIMIT ?)',
          )
          .run(key, key, this.maxEvents);
        this.db.exec('COMMIT');
        return { baseline: !row, events, document, diagnostics };
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    });
    this.pending = run.catch(() => {});
    return run;
  }
  events(input: WatchHistoryOptions): WatchEvent[] {
    this.assertOpen();
    const { limit, offset } = z
      .object({
        limit: z.number().int().min(1).max(10000).default(100),
        offset: z.number().int().min(0).max(1000000).default(0),
      })
      .parse(input);
    return (
      this.db
        .prepare('SELECT event FROM events WHERE watch_key=? ORDER BY rowid DESC LIMIT ? OFFSET ?')
        .all(this.key(watchSchema.parse(input)), limit, offset) as {
        event: string;
      }[]
    ).map((row) => JSON.parse(row.event) as WatchEvent);
  }
  reset(input: WatchOptions): Promise<{ baselineRemoved: boolean; eventsRemoved: number }> {
    this.assertOpen();
    const key = this.key(watchSchema.parse(input));
    const run = this.pending.then(() => {
      this.assertOpen();
      input.signal?.throwIfAborted();
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const baselineRemoved = Boolean(
          this.db.prepare('SELECT key FROM snapshots WHERE key=?').get(key),
        );
        const eventsRemoved = (
          this.db.prepare('SELECT COUNT(*) AS count FROM events WHERE watch_key=?').get(key) as {
            count: number;
          }
        ).count;
        this.db.prepare('DELETE FROM snapshots WHERE key=?').run(key);
        this.db.prepare('DELETE FROM events WHERE watch_key=?').run(key);
        this.db.exec('COMMIT');
        return { baselineRemoved, eventsRemoved };
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    });
    this.pending = run.catch(() => {});
    return run;
  }
  private assertOpen() {
    if (this.closed) throw new Error('WatchStore is closed');
  }
  close() {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }
  private key(input: WatchOptions) {
    const identity: unknown[] = [canonicalURL(input.url), input.watchFor.trim().toLowerCase()];
    if (input.ignoreTimestamps === false || input.ignoreText?.length || input.scope)
      identity.push(input.ignoreTimestamps ?? true, input.ignoreText ?? [], input.scope ?? '');
    return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  }
}
const xml = (text: string) =>
  text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(
      /[<>&"']/g,
      (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!,
    );
export function feed(
  events: WatchEvent[],
  options: {
    title: string;
    url: string;
    format?: 'rss' | 'atom';
  },
): string {
  const title = xml(options.title),
    url = xml(options.url);
  const description = (e: WatchEvent) =>
    xml(`${e.context}: ${e.before ?? '(added)'} → ${e.after ?? '(removed)'}`);
  if (options.format === 'atom')
    return `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"><id>${url}</id><title>${title}</title><updated>${xml(events[0]?.at ?? new Date(0).toISOString())}</updated><link href="${url}"/>${events.map((e) => `<entry><id>urn:uuid:${e.id}</id><title>${xml(e.type)}</title><updated>${xml(e.at)}</updated><link href="${xml(e.url)}"/><content type="text">${description(e)}</content><author><name>Veytrawl</name></author></entry>`).join('')}</feed>`;
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${title}</title><link>${url}</link><description>Significant semantic changes</description>${events.map((e) => `<item><guid isPermaLink="false">${e.id}</guid><title>${xml(e.type)}</title><link>${xml(e.url)}</link><pubDate>${new Date(e.at).toUTCString()}</pubDate><description>${description(e)}</description></item>`).join('')}</channel></rss>`;
}
