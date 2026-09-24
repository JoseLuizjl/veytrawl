import type { Locator, Page, FrameLocator } from 'playwright';
import { fromPage, type SemanticNode } from '../dom/index.js';
import { inspectBrowser } from '../dom/browser.js';
import { elementScore } from '../dom/ranking.js';
import { decide, type DecisionProvider } from '../providers/index.js';
import { rerank, type SemanticRanker } from '../providers/ranking.js';
import { SelectorCache, type SelectorCacheOptions } from './cache.js';
export class LocateError extends Error {}
type Strategy = {
  kind: 'testId' | 'id' | 'css' | 'role';
  value: string;
  role?: string;
  framePath: string[];
};
interface Cached {
  version: 2;
  strategy: Strategy;
  node: SemanticNode;
  confidence: number;
  confidenceKind: Located['confidenceKind'];
}
export interface LocateOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}
export interface Located {
  element: string;
  confidence: number;
  confidenceKind: 'heuristic' | 'embedding';
  via: 'cache' | 'heuristic' | 'provider' | 'embedding';
  node: SemanticNode;
  locator: Locator;
  click: Locator['click'];
  fill: Locator['fill'];
}
function scope(page: Page, frames: string[]): Page | FrameLocator {
  let root: Page | FrameLocator = page;
  for (const frame of frames) root = root.frameLocator(frame);
  return root;
}
function build(page: Page, s: Strategy): Locator {
  const root = scope(page, s.framePath);
  if (s.kind === 'role')
    return root.getByRole(s.role as Parameters<Page['getByRole']>[0], {
      name: s.value,
      exact: true,
    });
  return s.kind === 'testId'
    ? root.getByTestId(s.value)
    : s.kind === 'id'
      ? root.locator(`[id=${JSON.stringify(s.value)}]`)
      : root.locator(s.value);
}
function sameIdentity(a: SemanticNode, b: SemanticNode): boolean {
  return (
    a.name === b.name &&
    a.role === b.role &&
    a.href === b.href &&
    a.context === b.context &&
    a.entity === b.entity &&
    a.documentURL === b.documentURL &&
    !a.disabled
  );
}
export class SemanticLocator {
  private cache: SelectorCache;
  constructor(
    private provider?: DecisionProvider,
    private ranker?: SemanticRanker,
    cacheOptions?: SelectorCacheOptions,
  ) {
    this.cache = new SelectorCache(cacheOptions);
  }
  close() {
    this.cache.close();
  }
  async locate(page: Page, query: string, options: LocateOptions = {}): Promise<Located> {
    if (!query.trim()) throw new LocateError('A non-empty semantic query is required');
    const timeout = options.timeoutMs ?? 0;
    if (!Number.isFinite(timeout) || timeout < 0 || timeout > 120000)
      throw new LocateError('timeoutMs must be 0–120000');
    const deadline = Date.now() + timeout;
    while (true) {
      options.signal?.throwIfAborted();
      try {
        const signal = options.signal;
        const operation = this.resolve(page, query, signal);
        if (!signal) return await operation;
        let cancel!: () => void;
        const aborted = new Promise<never>((_, reject) => {
          cancel = () => reject(signal.reason);
          signal.addEventListener('abort', cancel, { once: true });
          if (signal.aborted) cancel();
        });
        try {
          return await Promise.race([operation, aborted]);
        } finally {
          signal.removeEventListener('abort', cancel);
        }
      } catch (error) {
        options.signal?.throwIfAborted();
        if (
          !(error instanceof LocateError) ||
          /Ambiguous|Provider/.test(error.message) ||
          Date.now() >= deadline
        )
          throw error;
        const { setTimeout } = await import('node:timers/promises');
        await setTimeout(Math.min(100, deadline - Date.now()), undefined, {
          signal: options.signal,
        });
      }
    }
  }
  private async resolve(page: Page, query: string, signal?: AbortSignal): Promise<Located> {
    signal?.throwIfAborted();
    const key = JSON.stringify(['v2', page.url(), query.trim().toLowerCase()]);
    const cached = this.cache.get<Cached>(key);
    if (cached?.version === 2) {
      try {
        const locator = build(page, cached.strategy);
        if (
          (await locator.count()) === 1 &&
          (await locator.isVisible()) &&
          (await locator.isEnabled())
        ) {
          const current = (await locator.evaluate(inspectBrowser))[0];
          if (current && sameIdentity(current, cached.node)) {
            signal?.throwIfAborted();
            current.id = cached.node.id;
            current.framePath = cached.strategy.framePath;
            return this.result(current, locator, cached.confidence, 'cache', cached.confidenceKind);
          }
        }
      } catch {}
      signal?.throwIfAborted();
      this.cache.delete(key);
    }
    const doc = await fromPage(page);
    signal?.throwIfAborted();
    if (doc.warnings?.length) throw new LocateError(doc.warnings.join('; '));
    const candidates = doc.nodes.filter((n) => n.interactive && !n.disabled);
    const byId = new Map(candidates.map((n) => [n.id, n]));
    const cheap = candidates
      .map((n) => ({
        id: n.id,
        text: `${n.name} ${n.role} ${n.semanticRole ?? ''} ${n.context}`,
        score: elementScore(
          query,
          `${n.name} ${n.role} ${n.semanticRole ?? ''} ${n.context}`,
          n.role,
        ),
      }))
      .sort((a, b) => b.score - a.score);
    const ranked = (await rerank(this.ranker, query, cheap.slice(0, this.ranker ? 100 : 10))).slice(
      0,
      10,
    );
    signal?.throwIfAborted();
    let best = ranked[0];
    if (!best) throw new LocateError(`No element matches: ${query}`);
    const weak = best.score < 0.35;
    const ambiguous = Boolean(ranked[1] && best.score - ranked[1].score < 0.15);
    let via: Located['via'] = this.ranker ? 'embedding' : 'heuristic';
    if (weak || ambiguous) {
      if (!this.provider) {
        const suggestions = ranked
          .slice(0, 3)
          .map((c) => {
            const node = byId.get(c.id)!;
            return `${node.role} ${JSON.stringify(node.name.slice(0, 120))}`;
          })
          .join('; ');
        throw new LocateError(
          `${weak ? `No element matches: ${query}` : `Ambiguous query: ${query}`}. Add a specific name, role or context, or configure a decision provider. Candidates: ${suggestions}`,
        );
      }
      const id = await decide(this.provider, query, ranked);
      signal?.throwIfAborted();
      best = ranked.find((c) => c.id === id);
      if (!best) throw new LocateError(`Provider could not resolve: ${query}`);
      via = 'provider';
    }
    const n = byId.get(best.id)!;
    const framePath = n.framePath ?? [];
    const strategies: Strategy[] = [
      ...(n.locator.testId
        ? [{ kind: 'testId' as const, value: n.locator.testId, framePath }]
        : []),
      ...(n.locator.htmlId ? [{ kind: 'id' as const, value: n.locator.htmlId, framePath }] : []),
      { kind: 'role', role: n.role, value: n.name, framePath },
      { kind: 'css', value: n.locator.css, framePath },
    ];
    for (const strategy of strategies) {
      const locator = build(page, strategy);
      if (
        (await locator.count()) !== 1 ||
        !(await locator.isVisible()) ||
        !(await locator.isEnabled())
      )
        continue;
      const current = (await locator.evaluate(inspectBrowser))[0];
      if (!current || !sameIdentity(current, n)) continue;
      const confidenceKind = this.ranker ? 'embedding' : 'heuristic';
      signal?.throwIfAborted();
      this.cache.set(key, {
        version: 2,
        strategy,
        node: n,
        confidence: best.score,
        confidenceKind,
      } satisfies Cached);
      return this.result(n, locator, best.score, via, confidenceKind);
    }
    throw new LocateError('Page changed during resolution; retry locate');
  }
  private result(
    node: SemanticNode,
    locator: Locator,
    confidence: number,
    via: Located['via'],
    confidenceKind: Located['confidenceKind'],
  ): Located {
    return {
      element: node.id,
      confidence,
      confidenceKind,
      via,
      node,
      locator,
      click: locator.click.bind(locator),
      fill: locator.fill.bind(locator),
    };
  }
}
