import type { Browser } from 'playwright';
import { setTimeout as delay } from 'node:timers/promises';
import { fromPage } from '../dom/index.js';
import { canonicalURL, waitForContent, USER_AGENT, type FetchPolicy } from './fetch.js';
import { networkFetch, boundedBody, type NetworkOptions } from './network.js';
export interface BrowserFetchOptions extends NetworkOptions {
  timeoutMs?: number;
  waitForSelector?: string;
  settleMs?: number;
  includeFrames?: boolean;
  maxBytes?: number;
  maxRequests?: number;
  maxTotalBytes?: number;
}
export class PlaywrightFetcher {
  constructor(
    private browser: Browser,
    private options: BrowserFetchOptions = {},
  ) {
    for (const name of ['timeoutMs', 'settleMs'] as const) {
      const value = options[name];
      if (value !== undefined && (!Number.isInteger(value) || value < 0 || value > 120000))
        throw new Error(`Invalid browser option: ${name}`);
    }
    for (const name of ['maxBytes', 'maxRequests', 'maxTotalBytes'] as const)
      if (options[name] !== undefined && (!Number.isInteger(options[name]) || options[name]! < 1))
        throw new Error(`Invalid browser option: ${name}`);
  }
  async open(url: string, policy: FetchPolicy = {}) {
    policy.signal?.throwIfAborted();
    const controller = new AbortController();
    const signal = policy.signal
      ? AbortSignal.any([policy.signal, controller.signal])
      : controller.signal;
    const context = await this.browser.newContext({
      userAgent: USER_AGENT,
      serviceWorkers: 'block',
      acceptDownloads: false,
      permissions: [],
    });
    const close = async () => {
      controller.abort();
      policy.signal?.removeEventListener('abort', abort);
      await context.close();
    };
    const abort = () => {
      void close().catch(() => {});
    };
    policy.signal?.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted();
      let redirect: string | undefined,
        navigationError: unknown,
        navigating = true,
        requests = 0,
        totalBytes = 0;
      await context.routeWebSocket('**/*', (socket) => socket.close());
      await context.route('**/*', async (route) => {
        const request = route.request();
        const main = request.isNavigationRequest() && request.frame().parentFrame() === null;
        try {
          if (++requests > (this.options.maxRequests ?? 500))
            throw new Error('Browser request budget exceeded');
          let target = canonicalURL(request.url());
          let method = request.method(),
            body: Buffer | undefined = request.postDataBuffer() ?? undefined;
          const headers = await request.allHeaders();
          delete headers.host;
          delete headers['content-length'];
          for (let hops = 0; ; hops++) {
            if (hops > 5) throw new Error('Too many resource redirects');
            if (main && policy.allowURL && !(await policy.allowURL(target)))
              throw new Error(`URL blocked by policy: ${target}`);
            const response = await networkFetch(
              target,
              {
                method,
                headers,
                body,
                signal: AbortSignal.any([
                  signal,
                  AbortSignal.timeout(this.options.timeoutMs ?? 15000),
                ]),
              },
              this.options.allowPrivateNetwork,
            );
            if ([301, 302, 303, 307, 308].includes(response.status)) {
              await response.body?.cancel();
              const location = response.headers.get('location');
              if (!location) throw new Error('Redirect without Location');
              const next = canonicalURL(location, target);
              if (main) {
                if (policy.allowURL && !(await policy.allowURL(next)))
                  throw new Error(`URL blocked by policy: ${next}`);
                if (!navigating)
                  throw new Error('Page redirected after initial navigation; retry load');
                redirect = next;
                await route.fulfill({ status: 200, contentType: 'text/html', body: '' });
                return;
              }
              if (new URL(next).origin !== new URL(target).origin) {
                delete headers.authorization;
                delete headers.cookie;
                delete headers['proxy-authorization'];
              }
              if (
                response.status === 303 ||
                ([301, 302].includes(response.status) && method === 'POST')
              ) {
                method = 'GET';
                body = undefined;
              }
              target = next;
              continue;
            }
            const bytes = await boundedBody(response, this.options.maxBytes ?? 10000000);
            totalBytes += bytes.length;
            if (totalBytes > (this.options.maxTotalBytes ?? 50000000)) {
              controller.abort();
              throw new Error('Browser response budget exceeded');
            }
            const responseHeaders = Object.fromEntries(response.headers);
            delete responseHeaders['content-encoding'];
            delete responseHeaders['content-length'];
            delete responseHeaders['transfer-encoding'];
            const cookies = response.headers.getSetCookie();
            if (cookies.length) responseHeaders['set-cookie'] = cookies.join('\n');
            await route.fulfill({ status: response.status, headers: responseHeaders, body: bytes });
            return;
          }
        } catch (error) {
          navigationError ??= error;
          await route.abort().catch(() => {});
        }
      });
      const page = await context.newPage();
      page.on('popup', (popup) => {
        void popup.close().catch(() => {});
      });
      let target = canonicalURL(url);
      for (let hops = 0; ; hops++) {
        if (hops > 5) throw new Error('Too many redirects');
        redirect = undefined;
        try {
          const response = await page.goto(target, {
            waitUntil: 'domcontentloaded',
            timeout: this.options.timeoutMs ?? 15000,
          });
          if (!response?.ok()) throw new Error(`Browser navigation failed: ${response?.status()}`);
        } catch (error) {
          if (navigationError) throw navigationError;
          if (!redirect) throw error;
        }
        if (!redirect) break;
        target = redirect;
      }
      navigating = false;
      if (this.options.waitForSelector)
        await waitForContent(page, this.options.waitForSelector, this.options.timeoutMs ?? 15000);
      if (this.options.settleMs) await delay(this.options.settleMs, undefined, { signal });
      if (navigationError) throw navigationError;
      signal.throwIfAborted();
      return {
        page,
        close,
        check: () => {
          signal.throwIfAborted();
          if (navigationError) throw navigationError;
        },
      };
    } catch (error) {
      await close();
      policy.signal?.throwIfAborted();
      throw error;
    }
  }
  async load(url: string, policy: FetchPolicy = {}) {
    const session = await this.open(url, policy);
    try {
      const document = await fromPage(session.page, { includeFrames: this.options.includeFrames });
      session.check();
      return document;
    } finally {
      await session.close();
    }
  }
}
