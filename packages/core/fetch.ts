import { networkFetch, boundedBody } from './network.js';
import type { Response } from 'undici';
import { parseSemanticDOM, type SemanticDocument } from '../dom/index.js';
import type { Page } from 'playwright';
import { setTimeout as delay } from 'node:timers/promises';
export const USER_AGENT = 'VeytrawlBot/0.1';
export interface FetchPolicy {
  allowURL?: (url: string) => boolean | Promise<boolean>;
  signal?: AbortSignal;
}
export interface PageFetcher {
  load(url: string, policy?: FetchPolicy): Promise<SemanticDocument>;
}
export async function waitForContent(
  page: Page,
  selector: string,
  timeoutMs: number,
): Promise<void> {
  try {
    await page.locator(selector).first().waitFor({ state: 'visible', timeout: timeoutMs });
  } catch (error) {
    if (!(error instanceof Error) || error.name !== 'TimeoutError') throw error;
    const count = await page
      .locator(selector)
      .count()
      .catch(() => 0);
    throw new Error(
      `Timed out waiting for selector ${JSON.stringify(selector)} at ${page.url()}: ${count === 0 ? 'no matching element exists' : 'no visible match was found'}. Choose a selector present on this page or omit --wait-for.`,
      { cause: error },
    );
  }
}
export function canonicalURL(input: string, base?: string): string {
  const url = new URL(input, base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('Only HTTP(S) URLs without embedded credentials are supported');
  url.hash = '';
  for (const key of [...url.searchParams.keys()])
    if (/^(utm_|fbclid$|gclid$)/i.test(key)) url.searchParams.delete(key);
  url.searchParams.sort();
  return url.href;
}
export class HttpFetcher implements PageFetcher {
  constructor(
    private options: {
      timeoutMs?: number;
      maxBytes?: number;
      retries?: number;
      retryDelayMs?: number;
      allowPrivateNetwork?: boolean;
    } = {},
  ) {
    for (const [name, value] of Object.entries(options))
      if (
        value !== undefined &&
        name !== 'allowPrivateNetwork' &&
        (!Number.isFinite(value) ||
          Number(value) < 0 ||
          (name === 'retries' && (!Number.isInteger(value) || Number(value) > 5)))
      )
        throw new Error(`Invalid HTTP option: ${name}`);
  }
  async request(
    input: string,
    policy: FetchPolicy = {},
  ): Promise<{
    url: string;
    status: number;
    type: string;
    text: string;
  }> {
    let url = canonicalURL(input);
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 15000);
    const signal = policy.signal ? AbortSignal.any([timeout, policy.signal]) : timeout;
    for (let redirects = 0; redirects <= 5; redirects++) {
      if (policy.allowURL && !(await policy.allowURL(url)))
        throw new Error(`URL blocked by policy: ${url}`);
      signal.throwIfAborted();
      let response!: Response;
      for (let attempt = 0; attempt <= (this.options.retries ?? 2); attempt++) {
        response = await networkFetch(
          url,
          { signal, headers: { 'user-agent': USER_AGENT, accept: 'text/html,text/plain;q=0.9' } },
          this.options.allowPrivateNetwork,
        );
        if (
          ![429, 502, 503, 504].includes(response.status) ||
          attempt === (this.options.retries ?? 2)
        )
          break;
        const retryAfter = response.headers.get('retry-after');
        const requested = retryAfter
          ? /^\d+$/.test(retryAfter)
            ? Number(retryAfter) * 1000
            : Math.max(0, Date.parse(retryAfter) - Date.now())
          : 0;
        await response.body?.cancel();
        if (requested > 10000)
          throw new Error('Server requested a longer retry delay; retry later');
        await delay(
          Math.max(
            Number.isFinite(requested) ? requested : 0,
            (this.options.retryDelayMs ?? 250) * 2 ** attempt,
          ),
          undefined,
          { signal },
        );
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get('location');
        if (!location) throw new Error('Redirect without Location');
        url = canonicalURL(location, url);
        continue;
      }
      const limit = this.options.maxBytes ?? 2000000;
      return {
        url,
        status: response.status,
        type: response.headers.get('content-type') ?? '',
        text: (await boundedBody(response, limit)).toString('utf8'),
      };
    }
    throw new Error('Too many redirects');
  }
  async load(url: string, policy?: FetchPolicy): Promise<SemanticDocument> {
    const result = await this.request(url, policy);
    if (result.status < 200 || result.status >= 300)
      throw new Error(`HTTP ${result.status}: ${result.url}`);
    if (!/text\/html|application\/xhtml\+xml/i.test(result.type))
      throw new Error(`Unsupported content type: ${result.type}`);
    return parseSemanticDOM(result.text, result.url);
  }
}
export { PlaywrightFetcher } from './browser-fetcher.js';
