import { statePath } from '../dist/packages/core/paths.js';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { platform } from 'node:os';
import { resolve, join, relative } from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import {
  Veytrawl,
  parseSemanticDOM,
  semanticDiff,
  launchBrowser,
  fromPage,
  EmbeddingRanker,
} from '../dist/packages/core/index.js';
import { fixture } from '../dist/tests/fixture.js';
if (existsSync(statePath('browsers')))
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve(statePath('browsers'));
const exec = promisify(execFile);
const measurements = [],
  evidence = {};
const report = {
  capturedAt: new Date().toISOString(),
  environment: { node: process.version, platform: platform() },
  methodology:
    'Sequential local fixture measurements; assertions excluded from timed regions. Warmup counts and all raw samples retained. First-use samples are single observations, not percentiles. OS/browser/model files may already be cached by the operating system. Public-site timings include network and CLI startup. No production service-level guarantee.',
  measurements,
  evidence,
};
await mkdir('artifacts/performance', { recursive: true });
const runDir = await mkdtemp(resolve('artifacts/performance/run-'));
async function measure(name, count, warmups, operation, verify = () => {}) {
  for (let i = 0; i < warmups; i++) verify(await operation(i));
  const samplesMs = [];
  for (let i = 0; i < count; i++) {
    const start = performance.now();
    const result = await operation(i);
    samplesMs.push(performance.now() - start);
    verify(result);
  }
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const rounded = (n) => +n.toFixed(3);
  const row = {
    name,
    count,
    warmups,
    minMs: rounded(sorted[0]),
    maxMs: rounded(sorted.at(-1)),
    meanMs: rounded(samplesMs.reduce((a, b) => a + b) / count),
    ...(count > 1
      ? {
          p50Ms: rounded(sorted[Math.ceil(count * 0.5) - 1]),
          p95Ms: rounded(sorted[Math.ceil(count * 0.95) - 1]),
        }
      : {}),
    samplesMs: samplesMs.map(rounded),
  };
  measurements.push(row);
  console.log(JSON.stringify({ ...row, samplesMs: undefined }));
}
try {
  for (const plans of [100, 1000]) {
    const html = `<main>${Array.from({ length: plans }, (_, i) => `<section><h2>Plan ${i}</h2><p>$${10 + i}</p><button>Buy now</button></section>`).join('')}</main>`;
    const before = parseSemanticDOM(html, 'https://example.com');
    const after = parseSemanticDOM(html.replace('<p>$10</p>', '<p>$15</p>'), 'https://example.com');
    const verify = (doc) => {
      assert.equal(doc.nodes.length, plans * 4 + 1);
      assert.equal(doc.nodes.filter((n) => n.role === 'button').length, plans);
    };
    await measure(
      `Parse ${plans} plans (${before.nodes.length} semantic nodes)`,
      40,
      5,
      () => parseSemanticDOM(html, 'https://example.com'),
      verify,
    );
    await measure(
      `Diff ${plans} plans: one price change`,
      30,
      5,
      () => semanticDiff(before, after, 'pricing changes'),
      (events) => {
        assert.equal(events.length, 1);
        assert.equal(events[0].before, '$10');
        assert.equal(events[0].after, '$15');
        assert.equal(events[0].context, 'Plan 0');
      },
    );
    await measure(
      `Diff ${plans} plans: unchanged`,
      30,
      5,
      () => semanticDiff(before, before, 'page changes'),
      (events) => assert.deepEqual(events, []),
    );
  }
  const site = await fixture();
  let web = new Veytrawl({ allowPrivateNetwork: true, storage: join(runDir, 'watch.sqlite') });
  try {
    const verifyCrawl = (result) => {
      assert.equal(result.visited, 3);
      assert.deepEqual(result.errors, []);
      assert.deepEqual(
        result.pages.map((p) => new URL(p.url).pathname),
        ['/', '/oauth', '/api'],
      );
      assert.ok(!site.requests.includes('/private'));
      assert.ok(!site.requests.includes('/oauth-authentication.png'));
      evidence.crawl = result;
    };
    await measure(
      'HTTP crawl: 3 local pages, no politeness delay',
      10,
      2,
      () =>
        web.discover({ start: site.url, goal: 'OAuth authentication', maxPages: 3, delayMs: 0 }),
      verifyCrawl,
    );
    await measure(
      'HTTP crawl: 3 local pages, default politeness delay',
      5,
      1,
      () => web.discover({ start: site.url, goal: 'OAuth authentication', maxPages: 3 }),
      verifyCrawl,
    );
    const watch = { url: `${site.url}/pricing`, watchFor: 'page changes' };
    await measure(
      'Watch: first persistent baseline',
      1,
      0,
      () => web.watch(watch),
      (result) => {
        assert.equal(result.baseline, true);
        assert.deepEqual(result.events, []);
      },
    );
    site.setVersion(1);
    await measure(
      'Watch: cosmetic change ignored',
      1,
      0,
      () => web.watch(watch),
      (result) => assert.deepEqual(result.events, []),
    );
    web.close();
    web = new Veytrawl({ allowPrivateNetwork: true, storage: join(runDir, 'watch.sqlite') });
    site.setVersion(2);
    await measure(
      'Watch: real price change after restart',
      1,
      0,
      () => web.watch(watch),
      (result) => {
        assert.equal(result.baseline, false);
        assert.equal(result.events.length, 1);
        assert.equal(result.events[0].before, '$10 / month');
        assert.equal(result.events[0].after, '$15 / month');
        evidence.watch = result;
      },
    );
    await measure(
      'Watch: unchanged persistent poll',
      20,
      2,
      () => web.watch(watch),
      (result) => assert.deepEqual(result.events, []),
    );
    const rss = web.feed(watch);
    assert.equal((rss.match(/<item>/g) ?? []).length, 1);
    await writeFile(join(runDir, 'changes.xml'), rss);
    await measure(
      'CLI DOM: fresh Node process + local HTTP',
      5,
      1,
      () =>
        exec(
          process.execPath,
          ['dist/packages/cli/index.js', 'dom', site.url, '--db', ':memory:'],
          { windowsHide: true, timeout: 30000 },
        ),
      (result) => {
        const doc = JSON.parse(result.stdout);
        assert.equal(doc.title, 'Developer documentation');
        assert.ok(doc.nodes.some((n) => n.href === `${site.url}/oauth`));
      },
    );
    let browser;
    await measure('Chromium: first launch in this process', 1, 0, async () => {
      browser = await launchBrowser();
    });
    try {
      const page = await browser.newPage();
      site.setVersion(0);
      await measure(
        'Browser: navigate to local shop',
        10,
        1,
        () => page.goto(`${site.url}/shop`),
        (response) => assert.equal(response.status(), 200),
      );
      await measure(
        'Browser: semantic DOM snapshot',
        20,
        2,
        () => fromPage(page),
        (doc) => {
          assert.equal(doc.title, 'Checkout');
          assert.equal(doc.nodes.find((n) => n.role === 'button').name, 'Complete purchase');
        },
      );
      await measure(
        'Locate: first uncached checkout resolution',
        1,
        0,
        () => web.locate(page, 'checkout button'),
        (result) => {
          assert.equal(result.via, 'heuristic');
          assert.equal(result.node.name, 'Complete purchase');
        },
      );
      await measure(
        'Locate: cached checkout with identity revalidation',
        30,
        3,
        () => web.locate(page, 'checkout button'),
        (result) => {
          assert.equal(result.via, 'cache');
          assert.equal(result.node.name, 'Complete purchase');
        },
      );
      site.setVersion(1);
      await page.reload();
      await measure(
        'Locate: recover after selector changes',
        1,
        0,
        () => web.locate(page, 'checkout button'),
        (result) => {
          assert.equal(result.via, 'heuristic');
          assert.equal(result.node.locator.htmlId, 'purchase-new');
        },
      );
      const located = await web.locate(page, 'checkout button');
      await measure('Browser: execute resolved click', 1, 0, () => located.click());
      assert.equal(await page.locator('#status').innerText(), 'Order completed');
      evidence.click = {
        text: await page.locator('#status').innerText(),
        selectorRecovered: located.node.locator.htmlId,
      };
      await page.screenshot({ path: join(runDir, 'checkout.png'), fullPage: true });
    } finally {
      await browser?.close();
    }
  } finally {
    web.close();
    await site.close();
  }
  if (process.argv.includes('--embeddings')) {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error('Offline benchmark attempted network');
    };
    try {
      const ranker = new EmbeddingRanker({ localFilesOnly: true });
      const candidates = [
        { id: 'refund', text: 'Request a refund for your purchase', score: 0 },
        { id: 'search', text: 'Search the documentation', score: 0 },
        { id: 'profile', text: 'Change your profile picture', score: 0 },
      ];
      const verify = (ranked) => {
        assert.equal(ranked[0].id, 'refund');
        assert.ok(ranked.every((c) => Number.isFinite(c.score)));
        evidence.embeddings = ranked;
      };
      await measure(
        'CPU embeddings: first model load + rank 3 candidates',
        1,
        0,
        () => ranker.rank('Where can I get my money back?', candidates),
        verify,
      );
      await measure(
        'CPU embeddings: identical texts from vector cache',
        30,
        3,
        () => ranker.rank('Where can I get my money back?', candidates),
        verify,
      );
      await measure(
        'CPU embeddings: new query, cached candidates',
        10,
        0,
        (i) => ranker.rank(`Request number ${i}: Where can I get my money back?`, candidates),
        verify,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
  if (process.argv.includes('--public')) {
    const cases = [
      [
        'Public Node.js HTTP crawl (2 pages)',
        ['crawl', 'https://nodejs.org/api/', '--goal', 'HTTP server', '--max-pages', '2'],
        (r) => {
          assert.deepEqual(r.errors, []);
          assert.equal(r.pages.length, 2);
          assert.ok(r.pages.some((p) => p.url.endsWith('/api/http.html')));
        },
      ],
      [
        'Public MDN browser crawl (2 pages)',
        [
          'crawl',
          'https://developer.mozilla.org/',
          '--goal',
          'JavaScript documentation',
          '--max-pages',
          '2',
          '--browser',
        ],
        (r) => {
          assert.deepEqual(r.errors, []);
          assert.equal(r.pages.length, 2);
          assert.ok(r.pages.some((p) => /JavaScript/i.test(p.title)));
        },
      ],
      [
        'Public Wikipedia locate English link',
        ['locate', 'https://www.wikipedia.org/', '--query', 'English link'],
        (r) => {
          assert.match(JSON.stringify(r), /English/);
          assert.match(JSON.stringify(r), /js-link-box-en/);
        },
      ],
    ];
    for (const [name, args, verify] of cases) {
      await measure(
        name,
        1,
        0,
        () =>
          exec(process.execPath, ['dist/packages/cli/index.js', ...args, '--db', ':memory:'], {
            windowsHide: true,
            timeout: 60000,
            maxBuffer: 4 * 1024 * 1024,
          }),
        (result) => {
          const output = JSON.parse(result.stdout);
          verify(output);
          evidence[name] = output;
        },
      );
    }
  }
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error.stack;
  process.exitCode = 1;
  console.error(error);
} finally {
  report.memoryAtEndMiB = +(process.memoryUsage().rss / 2 ** 20).toFixed(1);
  await writeFile(join(runDir, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(
    'artifacts/performance/latest.json',
    JSON.stringify({ ...report, runDir: relative('.', runDir) }, null, 2),
  );
  const rows = measurements.map(
    (m) =>
      `| ${m.name} | ${m.count} | ${m.count === 1 ? m.meanMs : m.p50Ms} | ${m.p95Ms ?? 'single sample'} |`,
  );
  await writeFile(
    join(runDir, 'report.md'),
    `# Performance and output verification\n\n${report.capturedAt}\n\n${report.methodology}\n\n${JSON.stringify(report.environment)}\n\n| Operation | Samples | Median / single observation (ms) | p95 (ms) |\n| --- | ---: | ---: | ---: |\n${rows.join('\n')}\n\nAll output assertions passed: ${report.passed}. See report.json for raw samples and captured outputs.\n${report.error ?? ''}`,
  );
  console.log(`Report: ${join(runDir, 'report.md')}`);
}
