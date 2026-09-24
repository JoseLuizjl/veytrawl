import { performance } from 'node:perf_hooks';
import { parseSemanticDOM, semanticDiff, Veytrawl } from '../packages/core/index.js';
import { fixture } from '../tests/fixture.js';
const html = `<main>${Array.from({ length: 100 }, (_, i) => `<section><h2>Plan ${i}</h2><p>$${10 + i}</p><button>Buy now</button></section>`).join('')}</main>`;
const timings: number[] = [];
for (let i = 0; i < 100; i++) {
  const start = performance.now();
  parseSemanticDOM(html, 'https://example.com');
  timings.push(performance.now() - start);
}
timings.sort((a, b) => a - b);
const before = parseSemanticDOM(html, 'https://example.com'),
  after = parseSemanticDOM(html.replace('$10', '$15'), 'https://example.com');
const start = performance.now(),
  diff = semanticDiff(before, after, 'pricing changes'),
  diffMs = performance.now() - start;
const site = await fixture(),
  web = new Veytrawl({ allowPrivateNetwork: true });
try {
  const crawl = await web.discover({
    start: site.url,
    goal: 'OAuth authentication',
    maxPages: 3,
    delayMs: 0,
  });
  console.log(
    JSON.stringify(
      {
        kind: 'synthetic local benchmark; not an external quality evaluation',
        nodes: before.nodes.length,
        parseMs: { p50: timings[50], p95: timings[95] },
        diffMs,
        priceEvents: diff.length,
        crawlOrder: crawl.pages.map((p) => new URL(p.url).pathname),
        providerCalls: 0,
      },
      null,
      2,
    ),
  );
} finally {
  web.close();
  await site.close();
}
