import { abortable } from './async.js';
import { HttpFetcher, type PageFetcher } from './fetch.js';
import { discover, type DiscoverOptions } from '../crawler/index.js';
import { SemanticLocator } from '../selectors/index.js';
import {
  WatchStore,
  feed,
  type WatchOptions,
  type WatchStoreOptions,
  type WatchHistoryOptions,
} from '../watch/index.js';
import type { DecisionProvider } from '../providers/index.js';
import type { Page } from 'playwright';
import type { LocateOptions } from '../selectors/index.js';
import type { SelectorCacheOptions } from '../selectors/cache.js';
import type { SemanticRanker } from '../providers/ranking.js';
import { extractDocument, type ExtractOptions } from './extract.js';
export * from './extract.js';
export * from './fetch.js';
export { launchBrowser } from './browser.js';
export * from '../dom/index.js';
export * from '../selectors/index.js';
export * from '../watch/index.js';
export type { DecisionProvider, Candidate } from '../providers/index.js';
export { EmbeddingRanker } from '../providers/ranking.js';
export type { SemanticRanker, EmbeddingOptions } from '../providers/ranking.js';
export type { DiscoverOptions, DiscoverResult, DiscoverProgress } from '../crawler/index.js';
export interface VeytrawlOptions {
  fetcher?: PageFetcher;
  provider?: DecisionProvider;
  ranker?: SemanticRanker;
  storage?: string;
  allowPrivateNetwork?: boolean;
  selectorCache?: SelectorCacheOptions;
  watchStore?: WatchStoreOptions;
}
export class Veytrawl {
  private allowPrivateNetwork: boolean;
  private fetcher: PageFetcher;
  private selectors?: SemanticLocator;
  private store?: WatchStore;
  private closed = false;
  private provider?: DecisionProvider;
  private ranker?: SemanticRanker;
  constructor(private options: VeytrawlOptions = {}) {
    this.allowPrivateNetwork = options.allowPrivateNetwork ?? false;
    this.fetcher =
      options.fetcher ?? new HttpFetcher({ allowPrivateNetwork: this.allowPrivateNetwork });
    this.provider = options.provider;
    this.ranker = options.ranker;
  }
  private assertOpen() {
    if (this.closed) throw new Error('Veytrawl is closed');
  }
  private watchStore() {
    this.assertOpen();
    return (this.store ??= new WatchStore(this.options.storage, this.options.watchStore));
  }
  async discover(options: DiscoverOptions) {
    this.assertOpen();
    return discover(
      { allowPrivateNetwork: this.allowPrivateNetwork, ...options },
      this.fetcher,
      this.provider,
      this.ranker,
    );
  }
  async extract(
    options: ExtractOptions & {
      url: string;
      signal?: AbortSignal;
    },
  ) {
    this.assertOpen();
    options.signal?.throwIfAborted();
    const document = await abortable(
      () => this.fetcher.load(options.url, { signal: options.signal }),
      options.signal,
    );
    options.signal?.throwIfAborted();
    return extractDocument(document, options);
  }
  async locate(page: Page, query: string, options?: LocateOptions) {
    this.assertOpen();
    this.selectors ??= new SemanticLocator(this.provider, this.ranker, {
      path: this.options.storage,
      ...this.options.selectorCache,
    });
    return this.selectors.locate(page, query, options);
  }
  async watch(options: WatchOptions) {
    return this.watchStore().check(options, this.fetcher);
  }
  history(options: WatchHistoryOptions) {
    return this.watchStore().events(options);
  }
  async resetWatch(options: WatchOptions) {
    return this.watchStore().reset(options);
  }
  feed(
    options: WatchOptions & {
      format?: 'rss' | 'atom';
    },
  ) {
    return feed(this.watchStore().events(options), {
      title: options.watchFor,
      url: options.url,
      format: options.format,
    });
  }
  close() {
    if (this.closed) return;
    this.store?.close();
    this.selectors?.close();
    this.closed = true;
  }
}
export { Veytrawl as SemanticWeb };
