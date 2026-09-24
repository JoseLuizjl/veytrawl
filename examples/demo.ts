import { statePath } from '../packages/core/paths.js';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Veytrawl } from '../packages/core/index.js';
import { fixture } from '../tests/fixture.js';
if (existsSync(statePath('browsers')))
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve(statePath('browsers'));
const { chromium } = await import('playwright');
const browser = await chromium.launch(),
  site = await fixture(),
  web = new Veytrawl({ allowPrivateNetwork: true });
const log: Record<string, unknown> = {};
const escape = (s: string) =>
  s.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]!);
try {
  await mkdir('artifacts/demo', { recursive: true });
  const page = await browser.newPage({ viewport: { width: 900, height: 650 } });
  const slide = await browser.newPage({
    viewport: { width: 1100, height: 650 },
    deviceScaleFactor: 1,
  });
  async function frame(name: string, index: number, subtitle: string, output: unknown) {
    const shot = (await page.screenshot()).toString('base64');
    await slide.setContent(
      `<html><head><style>*{box-sizing:border-box}body{margin:0;background:#101824;color:#e9eff7;font:16px system-ui;padding:34px}header{display:flex;justify-content:space-between;align-items:center}h1{font-size:30px;margin:0}small{color:#77dfbe;letter-spacing:3px;font-size:12px}h2{font-size:20px;font-weight:400;color:#aebfd4;margin:14px 0 24px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:22px}img{width:100%;border-radius:12px;border:1px solid #35435b}pre{margin:0;padding:22px;background:#1a2637;border:1px solid #35435b;border-radius:12px;white-space:pre-wrap;overflow-wrap:anywhere;font:15px/1.6 Consolas,monospace;min-height:370px}footer{margin-top:24px;color:#aebfd4;font-size:13px}</style></head><body><header><h1>veytrawl / ${escape(name)}</h1><small>0.2.0 ALPHA</small></header><h2>${escape(subtitle)}</h2><div class="grid"><img src="data:image/png;base64,${shot}"><pre>${escape(typeof output === 'string' ? output : JSON.stringify(output, null, 2))}</pre></div><footer>Local fixture | real Chromium execution | deterministic matching | no AI calls</footer></body></html>`,
    );
    await slide.screenshot({ path: `artifacts/demo/${name}-${index}.png` });
  }
  await page.goto(site.url);
  await frame(
    'discover',
    0,
    'Start with an objective and a strict visit budget',
    'web.discover({\n  start: docsURL,\n  goal: "OAuth authentication",\n  maxPages: 3\n})',
  );
  const crawl = await web.discover({
    start: site.url,
    goal: 'OAuth authentication',
    maxPages: 3,
    delayMs: 0,
  });
  assert.equal(crawl.errors.length, 0);
  for (let i = 1; i < crawl.pages.length; i++) {
    await page.goto(crawl.pages[i]!.url);
    await frame('discover', i, 'Visit relevant links before unrelated pages', {
      visited: crawl.pages.slice(0, i + 1).map((p) => new URL(p.url).pathname),
      budget: 3,
      errors: crawl.errors.length,
    });
  }
  await frame('discover', 3, 'Three pages visited. Careers and About were not crawled.', {
    visited: crawl.visited,
    order: crawl.pages.map((p) => new URL(p.url).pathname).join(' -> '),
    skipped: crawl.skipped.map((s) => new URL(s.url).pathname).join(', '),
  });
  log.discover = {
    pages: crawl.pages.map(({ document, ...p }) => p),
    requests: [...site.requests],
  };
  await page.goto(`${site.url}/shop`);
  const first = await web.locate(page, 'checkout button');
  await frame('locate', 0, 'Resolve the action from its meaning', {
    query: 'checkout button',
    via: first.via,
    id: first.node.locator.htmlId,
    name: first.node.name,
  });
  const cached = await web.locate(page, 'checkout button');
  assert.equal(cached.via, 'cache');
  await frame('locate', 1, 'Reuse the selector after validating its meaning', {
    query: 'checkout button',
    via: cached.via,
    name: cached.node.name,
  });
  site.setVersion(1);
  await page.reload();
  const healed = await web.locate(page, 'checkout button');
  assert.equal(healed.node.locator.htmlId, 'purchase-new');
  await frame('locate', 2, 'ID, class and test ID changed. Resolve the same action again.', {
    query: 'checkout button',
    via: healed.via,
    id: healed.node.locator.htmlId,
    name: healed.node.name,
  });
  await healed.click();
  const status = await page.locator('#status').innerText();
  assert.equal(status, 'Order completed');
  await frame('locate', 3, 'Execute the resolved Playwright locator', {
    call: 'await checkout.click()',
    result: status,
  });
  log.locate = { first: first.via, second: cached.via, healed: healed.node.locator.htmlId, status };
  const options = { url: `${site.url}/pricing`, watchFor: 'pricing changes' };
  site.setVersion(0);
  await page.goto(options.url);
  const baseline = await web.watch(options);
  await frame('watch', 0, 'Save a semantic baseline: Starter costs $10', {
    baseline: baseline.baseline,
    events: baseline.events,
  });
  site.setVersion(1);
  await page.reload();
  const cosmetic = await web.watch(options);
  assert.equal(cosmetic.events.length, 0);
  await frame('watch', 1, 'CSS class, analytics and timestamp changed', {
    baseline: cosmetic.baseline,
    events: cosmetic.events,
  });
  site.setVersion(2);
  await page.reload();
  const changed = await web.watch(options);
  assert.equal(changed.events.length, 1);
  await frame(
    'watch',
    2,
    'The price changed. Emit one meaningful event.',
    changed.events.map(({ type, context, before, after, important }) => ({
      type,
      context,
      before,
      after,
      important,
    })),
  );
  const repeated = await web.watch(options);
  assert.equal(repeated.events.length, 0);
  await frame('watch', 3, 'Poll again without duplicate events; export RSS or Atom', {
    newEvents: repeated.events,
    feedItems: (web.feed(options).match(/<item>/g) ?? []).length,
  });
  log.watch = {
    baseline: baseline.baseline,
    cosmetic: cosmetic.events,
    changed: changed.events,
    repeated: repeated.events,
  };
  await writeFile('artifacts/demo/results.json', JSON.stringify(log, null, 2));
  await writeFile('artifacts/demo/pricing.xml', web.feed(options));
  console.log(JSON.stringify(log, null, 2));
} finally {
  web.close();
  await browser.close();
  await site.close();
}
