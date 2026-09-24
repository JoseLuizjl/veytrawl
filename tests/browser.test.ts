import { statePath } from '../packages/core/paths.js';
import { test } from './test.js';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Veytrawl, fromPage, PlaywrightFetcher, launchBrowser } from '../packages/core/index.js';
import { fixture } from './fixture.js';
if (existsSync(statePath('browsers')))
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve(statePath('browsers'));
const chromium = { launch: launchBrowser };
test('real browser: semantic resolution, cache, selector change and click', async () => {
  const browser = await chromium.launch(),
    site = await fixture(),
    web = new Veytrawl({ allowPrivateNetwork: true });
  try {
    const page = await browser.newPage();
    await page.goto(`${site.url}/shop`);
    const first = await web.locate(page, 'checkout button');
    assert.equal(first.via, 'heuristic');
    assert.equal((await web.locate(page, 'checkout button')).via, 'cache');
    site.setVersion(1);
    await page.reload();
    const healed = await web.locate(page, 'checkout button');
    assert.equal(healed.via, 'heuristic');
    assert.equal(healed.node.locator.htmlId, 'purchase-new');
    await healed.click();
    assert.equal(await page.locator('#status').innerText(), 'Order completed');
    const doc = await fromPage(page, { includeAccessibility: true });
    assert.ok(doc.accessibility?.includes('Complete purchase'));
    assert.ok(doc.nodes.find((n) => n.role === 'button')!.geometry!.width > 0);
    const loaded = await new PlaywrightFetcher(browser, { allowPrivateNetwork: true }).load(
      `${site.url}/pricing`,
    );
    assert.equal(loaded.source, 'browser');
  } finally {
    web.close();
    await browser.close();
    await site.close();
  }
});
test('cache rejects a still-existing selector whose meaning changed; hidden and disabled candidates excluded', async () => {
  const browser = await chromium.launch(),
    web = new Veytrawl({ allowPrivateNetwork: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<button id="target">Complete purchase</button>');
    await web.locate(page, 'checkout button');
    await page.setContent(
      '<button id="target">Delete account</button><button style="display:none">Complete purchase</button><button disabled>Buy now</button><button id="real">Complete purchase</button>',
    );
    const result = await web.locate(page, 'checkout button');
    assert.equal(result.node.locator.htmlId, 'real');
  } finally {
    web.close();
    await browser.close();
  }
});
test('ambiguity fails closed; provider sees bounded candidates and cannot invent an element', async () => {
  const browser = await chromium.launch();
  const plain = new Veytrawl({ allowPrivateNetwork: true }),
    invalid = new Veytrawl({
      allowPrivateNetwork: true,
      provider: { choose: async () => ({ id: 'bogus' }) },
    });
  let calls = 0;
  const assisted = new Veytrawl({
    allowPrivateNetwork: true,
    provider: {
      choose: async (_goal, candidates) => {
        calls++;
        assert.equal(candidates.length, 2);
        return { id: candidates[1]!.id };
      },
    },
  });
  try {
    const page = await browser.newPage();
    await page.setContent('<button id="a">Buy now</button><button id="b">Buy now</button>');
    await assert.rejects(plain.locate(page, 'checkout button'), /Ambiguous/);
    await assert.rejects(invalid.locate(page, 'checkout button'), /unknown candidate/);
    const result = await assisted.locate(page, 'checkout button');
    assert.equal(result.via, 'provider');
    assert.equal(result.node.locator.htmlId, 'b');
    await assisted.locate(page, 'checkout button');
    assert.equal(calls, 1);
    await assert.rejects(plain.locate(page, 'download invoice'), /No element/);
  } finally {
    plain.close();
    invalid.close();
    assisted.close();
    await browser.close();
  }
});
test('cache revalidates product context and default snapshots omit raw form values', async () => {
  const browser = await chromium.launch(),
    web = new Veytrawl({ allowPrivateNetwork: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<section><h2>Starter</h2><button id="buy">Buy now</button></section>');
    await web.locate(page, 'Starter checkout button');
    await page.setContent(
      '<section><h2>Enterprise</h2><button id="buy">Buy now</button></section><section><h2>Starter</h2><button id="starter">Buy now</button></section><input aria-label="Account" value="PRIVATE_VALUE">',
    );
    const result = await web.locate(page, 'Starter checkout button');
    assert.equal(result.node.locator.htmlId, 'starter');
    assert.equal(result.via, 'heuristic');
    const doc = await fromPage(page);
    assert.equal(doc.accessibility, undefined);
    assert.ok(!JSON.stringify(doc).includes('PRIVATE_VALUE'));
  } finally {
    web.close();
    await browser.close();
  }
});
