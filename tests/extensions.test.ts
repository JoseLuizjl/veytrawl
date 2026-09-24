import { statePath } from '../packages/core/paths.js';
import { test } from './test.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  Veytrawl,
  fromPage,
  parseSemanticDOM,
  semanticDiff,
  HttpFetcher,
  PlaywrightFetcher,
  launchBrowser,
} from '../packages/core/index.js';
import { SelectorCache } from '../packages/selectors/cache.js';
import { fixture } from './fixture.js';
if (existsSync(statePath('browsers')))
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve(statePath('browsers'));
const chromium = { launch: launchBrowser };
test('nested open shadow roots, accessible labels and real click', async () => {
  const browser = await chromium.launch(),
    web = new Veytrawl({ allowPrivateNetwork: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<shop-app></shop-app>');
    await page.evaluate(() => {
      const outer = document.querySelector('shop-app')!.attachShadow({ mode: 'open' });
      outer.innerHTML = '<section><h2>Starter</h2><pay-card></pay-card></section>';
      const inner = outer.querySelector('pay-card')!.attachShadow({ mode: 'open' });
      inner.innerHTML =
        '<span id="label" hidden>Complete purchase</span><button aria-labelledby="label"><span style="display:none">Delete account</span>Pay</button>';
      inner.querySelector('button')!.onclick = () => {
        document.body.dataset.clicked = 'yes';
      };
    });
    const result = await web.locate(page, 'Starter checkout button');
    assert.equal(result.node.name, 'Complete purchase');
    assert.equal(result.node.context, 'Starter');
    await result.click();
    assert.equal(await page.getAttribute('body', 'data-clicked'), 'yes');
    assert.equal((await web.locate(page, 'Starter checkout button')).via, 'cache');
  } finally {
    web.close();
    await browser.close();
  }
});
test('cross-origin frame resolution, execution and frame reload', async () => {
  const browser = await chromium.launch(),
    first = await fixture(),
    second = await fixture(),
    web = new Veytrawl({ allowPrivateNetwork: true });
  try {
    const page = await browser.newPage();
    await page.goto(first.url);
    await page.evaluate((url) => {
      const frame = document.createElement('iframe');
      frame.src = url;
      frame.style.cssText = 'width:900px;height:650px';
      document.body.replaceChildren(frame);
    }, `${second.url}/shop`);
    await page.frameLocator('iframe').getByRole('button').waitFor();
    const found = await web.locate(page, 'checkout button');
    assert.equal(found.node.framePath?.length, 1);
    await found.click();
    assert.equal(
      await page.frameLocator('iframe').locator('#status').innerText(),
      'Order completed',
    );
    second.setVersion(1);
    await page.locator('iframe').evaluate((el: HTMLIFrameElement) => {
      el.src = el.src;
    });
    await page.frameLocator('iframe').locator('#purchase-new').waitFor();
    assert.equal((await web.locate(page, 'checkout button')).node.locator.htmlId, 'purchase-new');
    assert.equal(
      (await fromPage(page, { includeFrames: false })).nodes.some((n) => n.role === 'button'),
      false,
    );
  } finally {
    web.close();
    await browser.close();
    await first.close();
    await second.close();
  }
});
test('slotted controls retain composed context; editable fields do not expose their values', async () => {
  const browser = await chromium.launch(),
    web = new Veytrawl({ allowPrivateNetwork: true });
  try {
    const page = await browser.newPage();
    await page.setContent(
      '<order-panel><button>Buy now</button></order-panel><div contenteditable aria-label="Message">PRIVATE_TEXT</div>',
    );
    await page.evaluate(() => {
      document.querySelector('order-panel')!.attachShadow({ mode: 'open' }).innerHTML =
        '<section><h2>Starter</h2><slot></slot></section>';
    });
    const node = (await web.locate(page, 'Starter checkout button')).node;
    assert.equal(node.context, 'Starter');
    const doc = await fromPage(page);
    assert.ok(!JSON.stringify(doc).includes('PRIVATE_TEXT'));
    const field = await web.locate(page, 'Message textbox');
    await field.fill('A new message');
    assert.equal(await field.locator.innerText(), 'A new message');
  } finally {
    web.close();
    await browser.close();
  }
});
test('nested frames resolve executable locators; aria-hidden frames are ignored', async () => {
  const browser = await chromium.launch(),
    web = new Veytrawl({ allowPrivateNetwork: true });
  try {
    const page = await browser.newPage();
    await page.setContent(
      '<iframe id="outer"></iframe><iframe aria-hidden="true" srcdoc="<button>Buy now</button>"></iframe>',
    );
    const frame = page.frames().find((f) => f.parentFrame() === page.mainFrame())!;
    await frame.setContent('<iframe id="inner" srcdoc="<button>Buy now</button>"></iframe>');
    await page.frameLocator('#outer').frameLocator('#inner').getByRole('button').waitFor();
    const found = await web.locate(page, 'checkout button');
    assert.equal(found.node.framePath?.length, 2);
    assert.equal(await found.locator.innerText(), 'Buy now');
  } finally {
    web.close();
    await browser.close();
  }
});
test('selector cache survives engine/browser reopening and rejects changed meaning', async () => {
  const browser = await chromium.launch(),
    dir = await mkdtemp(join(tmpdir(), 'veytrawl-persistent-')),
    site = await fixture();
  const storage = join(dir, 'state.sqlite');
  let web = new Veytrawl({ allowPrivateNetwork: true, storage });
  try {
    let page = await browser.newPage();
    await page.goto(`${site.url}/shop`);
    assert.equal((await web.locate(page, 'checkout button')).via, 'heuristic');
    await page.close();
    web.close();
    web = new Veytrawl({ allowPrivateNetwork: true, storage });
    page = await browser.newPage();
    await page.goto(`${site.url}/shop`);
    assert.equal((await web.locate(page, 'checkout button')).via, 'cache');
    await page.locator('button').evaluate((el) => {
      el.textContent = 'Delete account';
    });
    await assert.rejects(web.locate(page, 'checkout button'), /No element|Ambiguous/);
  } finally {
    web.close();
    await browser.close();
    await site.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test('cache evicts bounded entries, ignores corrupt/expired data', async () => {
  const cache = new SelectorCache({ maxEntries: 1, ttlMs: 10 });
  try {
    cache.set('a', { id: 1 });
    cache.set('b', { id: 2 });
    assert.equal(cache.get('a'), undefined);
    assert.deepEqual(cache.get('b'), { id: 2 });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(cache.get('b'), undefined);
  } finally {
    cache.close();
  }
});
test('provider handles zero lexical overlap and can abstain', async () => {
  const browser = await chromium.launch(),
    web = new Veytrawl({
      allowPrivateNetwork: true,
      provider: { choose: async (_query, candidates) => ({ id: candidates[0]!.id }) },
    });
  const abstaining = new Veytrawl({
    allowPrivateNetwork: true,
    provider: { choose: async () => null },
  });
  try {
    const page = await browser.newPage();
    await page.setContent('<button>Proceed</button>');
    assert.equal((await web.locate(page, 'finalize my basket')).via, 'provider');
    await assert.rejects(
      abstaining.locate(page, 'finalize my basket'),
      /Provider could not resolve/,
    );
  } finally {
    web.close();
    abstaining.close();
    await browser.close();
  }
});
test('locate waits for hydration and accepts abort signals', async () => {
  const browser = await chromium.launch(),
    web = new Veytrawl({ allowPrivateNetwork: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<main>Loading</main>');
    await page.evaluate(() => {
      setTimeout(() => {
        document.body.innerHTML = '<button>Complete purchase</button>';
      }, 150);
    });
    assert.equal(
      (await web.locate(page, 'checkout button', { timeoutMs: 2000 })).node.name,
      'Complete purchase',
    );
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(web.locate(page, 'checkout', { signal: abort.signal }), /abort/i);
  } finally {
    web.close();
    await browser.close();
  }
});
test('Locate aborts while a provider is pending and discards its late result', async () => {
  const browser = await chromium.launch();
  let release!: (result: { id: string }) => void,
    entered!: () => void,
    candidate = '';
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const web = new Veytrawl({
    allowPrivateNetwork: true,
    provider: {
      choose: async (_query, candidates) => {
        candidate = candidates[0]!.id;
        entered();
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    },
  });
  try {
    const page = await browser.newPage();
    await page.setContent('<button>Proceed</button>');
    const controller = new AbortController();
    const operation = web.locate(page, 'finalize my basket', { signal: controller.signal });
    const rejected = assert.rejects(operation, /abort/i);
    await started;
    controller.abort();
    await Promise.race([
      rejected,
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error('Locate did not cancel promptly')), 2000);
        timer.unref();
      }),
    ]);
    web.close();
    release({ id: candidate });
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    await browser.close();
  }
});
test('watch ignores wrapper changes and price formatting but preserves entity changes', () => {
  const dom = (html: string) => parseSemanticDOM(html, 'https://example.com');
  const before = dom(
    '<main><h1>Plans</h1><section><h2>Starter</h2><p>$1,000.00 / month</p></section><section><h2>Pro</h2><p>$20 / month</p></section></main>',
  );
  const after = dom(
    '<main><h1>Plans</h1><div><h2>Pro</h2><p><strong>$20</strong> / month</p></div><div><header><h2>Starter</h2></header><p><span>USD 1000</span> / month</p></div></main>',
  );
  assert.deepEqual(semanticDiff(before, after, 'pricing changes'), []);
  const changed = dom(
    '<main><h1>Plans</h1><div><h2>Starter</h2><p>$1,200 / month</p></div><div><h2>Pro</h2><p>$20 / month</p></div></main>',
  );
  const events = semanticDiff(before, changed, 'pricing changes');
  assert.equal(events.length, 1);
  assert.equal(events[0]!.context, 'Starter');
});
test('watch ignores dynamic timestamps selectively and supports scope/ignore rules', () => {
  const dom = (html: string) => parseSemanticDOM(html, 'https://example.com');
  const a = dom(
    '<p>Updated 2 minutes ago</p><time>2026-01-01</time><section><h2>Pro</h2><p>$10</p></section><section><h2>Basic</h2><p>$5</p></section>',
  );
  const b = dom(
    '<p>Updated 5 minutes ago</p><time>2026-02-01</time><section><h2>Pro</h2><p>$15</p></section><section><h2>Basic</h2><p>$7</p></section>',
  );
  assert.equal(semanticDiff(a, b, 'all').length, 2);
  assert.equal(semanticDiff(a, b, 'pricing', { scope: 'Pro' }).length, 1);
  assert.deepEqual(semanticDiff(a, b, 'all', { ignoreText: ['$'] }), []);
  assert.ok(semanticDiff(a, b, 'all', { ignoreTimestamps: false }).length > 2);
});
test('failed and incomplete watch snapshots do not replace the baseline', async () => {
  let state = 0;
  const web = new Veytrawl({
    allowPrivateNetwork: true,
    fetcher: {
      load: async () => {
        if (state === 1) throw new Error('offline');
        const doc = parseSemanticDOM(`<p>$${state === 3 ? 15 : 10}</p>`, 'https://example.com');
        if (state === 2) doc.warnings = ['truncated'];
        return doc;
      },
    },
  });
  try {
    const options = { url: 'https://example.com', watchFor: 'pricing' };
    await web.watch(options);
    state = 1;
    await assert.rejects(web.watch(options), /offline/);
    state = 2;
    await assert.rejects(web.watch(options), /Incomplete/);
    state = 3;
    const result = await web.watch(options);
    assert.equal(result.events[0]?.before, '$10');
  } finally {
    web.close();
  }
});
test('browser depth limits reject partial snapshots and preserve the watch baseline', async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const web = new Veytrawl({
    allowPrivateNetwork: true,
    fetcher: { load: async () => fromPage(page, { maxDepth: 4 }) },
  });
  try {
    const options = { url: 'https://example.com', watchFor: 'pricing' };
    await page.setContent('<p>$10</p>');
    await web.watch(options);
    await page.setContent('<div><div><div><p>$12</p></div></div></div>');
    await assert.rejects(web.watch(options), /depth limit reached/);
    await page.setContent('<p>$15</p>');
    const result = await web.watch(options);
    assert.equal(result.events[0]?.before, '$10');
    assert.equal(result.events[0]?.after, '$15');
    await assert.rejects(fromPage(page, { maxDepth: -1 }), /maxDepth must/);
    await assert.rejects(fromPage(page, { maxDepth: Number.NaN }), /maxDepth must/);
  } finally {
    web.close();
    await browser.close();
  }
});
test('HTTP retries transient failures, supports cancellation; browser waits for selector', async () => {
  const browser = await chromium.launch();
  let attempts = 0;
  const server = createServer((req, res) => {
    if (req.url === '/retry' && attempts++ < 2) {
      res.writeHead(503, { 'retry-after': '0' });
      res.end();
      return;
    }
    res.setHeader('content-type', 'text/html');
    res.end(
      '<main>Loading</main><script>setTimeout(()=>document.body.innerHTML="<button>Buy now</button>",150)</script>',
    );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await new HttpFetcher({ allowPrivateNetwork: true, retryDelayMs: 1 }).load(`${url}/retry`);
    assert.equal(attempts, 3);
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(
      new HttpFetcher({ allowPrivateNetwork: true }).load(url, { signal: abort.signal }),
      /abort/i,
    );
    const doc = await new PlaywrightFetcher(browser, {
      allowPrivateNetwork: true,
      waitForSelector: 'button',
    }).load(url);
    assert.equal(doc.nodes.find((n) => n.role === 'button')?.name, 'Buy now');
    const web = new Veytrawl({ allowPrivateNetwork: true });
    try {
      await assert.rejects(
        web.discover({ start: url, goal: 'test', signal: abort.signal }),
        /abort/i,
      );
    } finally {
      web.close();
    }
  } finally {
    await browser.close();
    await new Promise<void>((r) => {
      server.close(() => r());
      server.closeAllConnections();
    });
  }
});
test('browser validates every redirect before requesting it and preserves the final URL', async () => {
  const browser = await chromium.launch(),
    site = await fixture();
  try {
    const fetcher = new PlaywrightFetcher(browser, { allowPrivateNetwork: true });
    await assert.rejects(
      fetcher.load(`${site.url}/redirect`, { allowURL: (u) => !u.endsWith('/private') }),
      /blocked by policy/,
    );
    assert.ok(!site.requests.includes('/private'));
    await assert.rejects(
      fetcher.load(`${site.url}/external-redirect`, {
        allowURL: (u) => new URL(u).origin === site.url,
      }),
      /blocked by policy/,
    );
    const loaded = await fetcher.load(`${site.url}/redirect`);
    assert.equal(loaded.url, `${site.url}/private`);
    assert.equal(site.requests.filter((u) => u === '/private').length, 1);
    await assert.rejects(
      fetcher.load(site.url, {
        allowURL: () => {
          throw new Error('policy failed');
        },
      }),
      /policy failed/,
    );
    for (const timeoutMs of [-1, Number.NaN, 0.5])
      assert.throws(
        () => new PlaywrightFetcher(browser, { allowPrivateNetwork: true, timeoutMs }),
        /Invalid browser option/,
      );
    assert.equal(browser.contexts().length, 0);
  } finally {
    await browser.close();
    await site.close();
  }
});
test('missing browser wait selector explains the loaded page and does not silently succeed', async () => {
  const browser = await chromium.launch(),
    site = await fixture();
  try {
    await assert.rejects(
      new PlaywrightFetcher(browser, {
        allowPrivateNetwork: true,
        waitForSelector: 'main',
        timeoutMs: 1000,
      }).load(`${site.url}/shop`),
      /no matching element exists.*omit --wait-for/,
    );
    const document = await new PlaywrightFetcher(browser, {
      allowPrivateNetwork: true,
      waitForSelector: 'button',
    }).load(`${site.url}/shop`);
    assert.equal(document.title, 'Checkout');
  } finally {
    await browser.close();
    await site.close();
  }
});
