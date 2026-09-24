import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { performance } from 'node:perf_hooks';
import { mkdir, writeFile } from 'node:fs/promises';
import { Veytrawl } from '../dist/packages/core/index.js';
let active = 0,
  peak = 0;
const server = createServer((request, response) => {
  if (request.url === '/robots.txt') {
    response.end('User-agent: *\nAllow: /\n');
    return;
  }
  peak = Math.max(peak, ++active);
  setTimeout(() => {
    active--;
    response.setHeader('content-type', 'text/html');
    response.end(
      request.url === '/'
        ? Array.from({ length: 8 }, (_, i) => `<a href="/guide/${i}">Guide ${i}</a>`).join('')
        : '<p>Guide content</p>',
    );
  }, 100);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const samples = { 1: [], 4: [] },
  peaks = {};
try {
  for (let repeat = 0; repeat < 3; repeat++) {
    for (const concurrency of repeat % 2 ? [4, 1] : [1, 4]) {
      const web = new Veytrawl({ allowPrivateNetwork: true });
      peak = 0;
      try {
        const started = performance.now();
        const result = await web.discover({
          start: url,
          goal: 'Guide',
          maxPages: 9,
          concurrency,
          delayMs: 0,
        });
        samples[concurrency].push(performance.now() - started);
        peaks[concurrency] = peak;
        assert.equal(result.pages.length, 9);
        assert.deepEqual(result.errors, []);
        assert.ok(peak <= concurrency);
      } finally {
        web.close();
      }
    }
  }
  const median = (values) => [...values].sort((a, b) => a - b)[1];
  const report = {
    at: new Date().toISOString(),
    workload:
      '9 local HTTP pages; 100 ms server delay per page; three alternating runs per configuration; robots enabled; explicit zero crawl delay',
    serialMedianMs: median(samples[1]),
    parallelMedianMs: median(samples[4]),
    speedup: median(samples[1]) / median(samples[4]),
    peakRequests: peaks,
    samples,
    limits:
      'Synthetic network latency workload. Site crawl delays, CPU load, and browser rendering change results. Sequential crawling remains the default.',
  };
  await mkdir('artifacts/performance', { recursive: true });
  await writeFile('artifacts/performance/crawl.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  });
}
