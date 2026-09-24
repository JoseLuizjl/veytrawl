import { abortable } from '../core/async.js';
import { safeError } from '../core/privacy.js';
import { z } from 'zod';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { HttpFetcher, canonicalURL, USER_AGENT, type PageFetcher } from '../core/fetch.js';
import { score } from '../dom/ranking.js';
import type { SemanticDocument } from '../dom/index.js';
import { decide, type DecisionProvider } from '../providers/index.js';
import { rerank, type SemanticRanker } from '../providers/ranking.js';
const robotsParser = createRequire(import.meta.url)('robots-parser') as (
  url: string,
  text: string,
) => {
  isAllowed(url: string, agent: string): boolean | undefined;
  getCrawlDelay(agent: string): number | undefined;
};
const schema = z.object({
  start: z.url(),
  goal: z.string().trim().min(1),
  maxPages: z.number().int().min(1).max(1000).default(10),
  maxDepth: z.number().int().min(0).max(20).default(3),
  maxQueue: z.number().int().min(1).max(100000).default(1000),
  delayMs: z.number().min(0).max(60000).default(250),
  minScore: z.number().min(0).max(1).default(0.05),
  concurrency: z.number().int().min(1).max(8).default(1),
  includePaths: z.array(z.string().startsWith('/').max(2000)).max(100).default([]),
  excludePaths: z.array(z.string().startsWith('/').max(2000)).max(100).default([]),
  respectRobots: z.boolean().default(true),
  allowPrivateNetwork: z.boolean().default(false),
});
export interface DiscoverProgress {
  url: string;
  status: 'page' | 'error' | 'skipped';
  visited: number;
  pages: number;
  queued: number;
}
export type DiscoverOptions = z.input<typeof schema> & {
  signal?: AbortSignal;
  onProgress?: (progress: DiscoverProgress) => void | Promise<void>;
};
interface Entry {
  url: string;
  priority: number;
  depth: number;
}
class PriorityQueue {
  private heap: Entry[] = [];
  get length() {
    return this.heap.length;
  }
  push(entry: Entry) {
    const h = this.heap;
    h.push(entry);
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (h[p]!.priority >= h[i]!.priority) break;
      [h[p], h[i]] = [h[i]!, h[p]!];
      i = p;
    }
  }
  pop(): Entry {
    const h = this.heap,
      first = h[0]!,
      last = h.pop()!;
    if (h.length) {
      h[0] = last;
      let i = 0;
      while (true) {
        const l = i * 2 + 1,
          r = l + 1;
        let best = i;
        if (l < h.length && h[l]!.priority > h[best]!.priority) best = l;
        if (r < h.length && h[r]!.priority > h[best]!.priority) best = r;
        if (best === i) break;
        [h[i], h[best]] = [h[best]!, h[i]!];
        i = best;
      }
    }
    return first;
  }
}
export interface DiscoverResult {
  pages: {
    url: string;
    title: string;
    relevance: number;
    depth: number;
    document: SemanticDocument;
  }[];
  errors: {
    url: string;
    message: string;
  }[];
  skipped: {
    url: string;
    reason: string;
  }[];
  visited: number;
}
export async function discover(
  input: DiscoverOptions,
  fetcher?: PageFetcher,
  provider?: DecisionProvider,
  ranker?: SemanticRanker,
): Promise<DiscoverResult> {
  input.signal?.throwIfAborted();
  const options = schema.parse(input),
    start = canonicalURL(options.start),
    origin = new URL(start).origin;
  const http = new HttpFetcher({ allowPrivateNetwork: options.allowPrivateNetwork });
  fetcher ??= http;
  let robots = robotsParser(`${origin}/robots.txt`, '');
  if (options.respectRobots) {
    const response = await http.request(`${origin}/robots.txt`, {
      allowURL: (u) => new URL(u).origin === origin,
      signal: input.signal,
    });
    if ([401, 403].includes(response.status))
      throw new Error('robots.txt access denied; crawl stopped');
    if (response.status >= 500 || response.status === 429)
      throw new Error('robots.txt unavailable; retry later');
    if (response.status === 200) robots = robotsParser(`${origin}/robots.txt`, response.text);
  }
  const pathAllowed = (url: string) => {
    const path = new URL(url).pathname;
    return (
      !options.excludePaths.some((prefix) => path.startsWith(prefix)) &&
      (url === start ||
        !options.includePaths.length ||
        options.includePaths.some((prefix) => path.startsWith(prefix)))
    );
  };
  const permitted = (url: string) =>
    pathAllowed(url) &&
    new URL(url).origin === origin &&
    (!options.respectRobots || robots.isAllowed(url, USER_AGENT) !== false);
  const enforcePolicy = (url: string) => {
    if (new URL(url).origin !== origin) throw new Error(`URL blocked by origin policy: ${url}`);
    if (!pathAllowed(url)) throw new Error(`URL blocked by path policy: ${url}`);
    if (options.respectRobots && robots.isAllowed(url, USER_AGENT) === false)
      throw new Error(`URL blocked by robots.txt: ${url}`);
    return true;
  };
  const queue = new PriorityQueue(),
    scheduled = new Set([start]),
    visited = new Set<string>();
  queue.push({ url: start, priority: 1, depth: 0 });
  const result: DiscoverResult = { pages: [], errors: [], skipped: [], visited: 0 };
  const interval = Math.max(
    options.delayMs,
    options.respectRobots ? (robots.getCrawlDelay(USER_AGENT) ?? 0) * 1000 : 0,
  );
  let lastStart = -Infinity;
  let pacing = Promise.resolve();
  const waitForTurn = () => {
    const turn = pacing.then(async () => {
      input.signal?.throwIfAborted();
      const wait = Math.max(0, lastStart + interval - Date.now());
      if (wait) await delay(wait, undefined, { signal: input.signal });
      input.signal?.throwIfAborted();
      lastStart = Date.now();
    });
    pacing = turn.catch(() => {});
    return turn;
  };
  const notify = async (url: string, status: DiscoverProgress['status']) => {
    input.signal?.throwIfAborted();
    if (input.onProgress)
      await abortable(
        async () =>
          input.onProgress!({
            url,
            status,
            visited: result.visited,
            pages: result.pages.length,
            queued: queue.length,
          }),
        input.signal,
      );
  };
  while (queue.length && result.visited < options.maxPages) {
    input.signal?.throwIfAborted();
    const batch: Entry[] = [];
    while (
      queue.length &&
      batch.length < options.concurrency &&
      result.visited < options.maxPages
    ) {
      const entry = queue.pop();
      if (visited.has(entry.url)) continue;
      visited.add(entry.url);
      if (!permitted(entry.url)) {
        result.skipped.push({
          url: entry.url,
          reason: !pathAllowed(entry.url) ? 'path policy' : 'robots.txt',
        });
        await notify(entry.url, 'skipped');
        continue;
      }
      result.visited++;
      batch.push(entry);
    }
    const documents = await Promise.all(
      batch.map(async (entry) => {
        try {
          await waitForTurn();
          const document = await abortable(
            () => fetcher!.load(entry.url, { allowURL: enforcePolicy, signal: input.signal }),
            input.signal,
          );
          enforcePolicy(canonicalURL(document.url));
          return { document };
        } catch (error) {
          input.signal?.throwIfAborted();
          return { error };
        }
      }),
    );
    for (const [index, entry] of batch.entries()) {
      input.signal?.throwIfAborted();
      let status: DiscoverProgress['status'] = 'page';
      try {
        const loaded = documents[index]!;
        if (!loaded.document) throw loaded.error;
        const doc = loaded.document;
        if (doc.warnings?.length) throw new Error(doc.warnings.join('; '));
        const finalURL = canonicalURL(doc.url);
        if (result.pages.some((page) => canonicalURL(page.url) === finalURL)) {
          result.skipped.push({ url: entry.url, reason: 'duplicate redirect' });
          status = 'skipped';
        } else {
          visited.add(finalURL);
          const relevance = score(
            options.goal,
            `${doc.title} ${doc.nodes
              .filter((n) => !n.children.length)
              .map((n) => n.text)
              .join(' ')}`,
          );
          result.pages.push({
            url: doc.url,
            title: doc.title,
            relevance,
            depth: entry.depth,
            document: doc,
          });
          if (entry.depth < options.maxDepth) {
            const candidateURLs = new Set<string>();
            const candidates = doc.nodes
              .filter((n) => n.href)
              .flatMap((n) => {
                try {
                  const url = canonicalURL(n.href!),
                    parsed = new URL(url);
                  if (
                    parsed.origin !== origin ||
                    scheduled.has(url) ||
                    visited.has(url) ||
                    candidateURLs.has(url)
                  )
                    return [];
                  candidateURLs.add(url);
                  if (!pathAllowed(url)) {
                    result.skipped.push({ url, reason: 'path policy' });
                    return [];
                  }
                  if (
                    /\.(?:png|jpe?g|gif|svg|webp|ico|avif|pdf|zip|gz|tar|mp[34]|wav|webm|woff2?|ttf|css|json|xml|csv)$/i.test(
                      parsed.pathname,
                    )
                  ) {
                    scheduled.add(url);
                    result.skipped.push({ url, reason: 'non-HTML asset extension' });
                    return [];
                  }
                  return [
                    {
                      url,
                      text: `${n.name} ${n.context} ${parsed.pathname}`,
                      priority: score(options.goal, `${n.name} ${n.context} ${parsed.pathname}`),
                      depth: entry.depth + 1,
                    },
                  ];
                } catch {
                  return [];
                }
              })
              .sort((a, b) => b.priority - a.priority);
            if (ranker) {
              const ranked = await abortable(
                () =>
                  rerank(
                    ranker,
                    options.goal,
                    candidates
                      .slice(0, 100)
                      .map((c, i) => ({ id: `c${i}`, text: c.text, score: c.priority })),
                  ),
                input.signal,
              );
              for (const result of ranked)
                candidates[Number(result.id.slice(1))]!.priority = result.score;
              candidates.sort((a, b) => b.priority - a.priority);
            }
            if (
              provider &&
              candidates.length > 1 &&
              candidates[0]!.priority - candidates[1]!.priority < 0.15
            ) {
              const top = candidates.slice(0, 10);
              const selected = await abortable(
                () =>
                  decide(
                    provider,
                    options.goal,
                    top.map((c, i) => ({ id: `c${i}`, text: c.text, score: c.priority })),
                  ),
                input.signal,
              );
              const index = top.findIndex((_, i) => `c${i}` === selected);
              if (index >= 0) top[index]!.priority += 0.1;
            }
            candidates.sort((a, b) => b.priority - a.priority);
            for (const candidate of candidates) {
              if (queue.length >= options.maxQueue) break;
              if (scheduled.has(candidate.url) || candidate.priority < options.minScore) continue;
              scheduled.add(candidate.url);
              queue.push(candidate);
            }
          }
        }
      } catch (error) {
        input.signal?.throwIfAborted();
        result.errors.push({ url: entry.url, message: safeError(error) });
        status = 'error';
      }
      await notify(entry.url, status);
    }
  }
  return result;
}
