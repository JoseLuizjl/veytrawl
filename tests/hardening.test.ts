import { test } from './test.js';
import assert from 'node:assert/strict';
import {
  Veytrawl,
  parseSemanticDOM,
  EmbeddingRanker,
  semanticDiff,
} from '../packages/core/index.js';
import { fixture } from './fixture.js';
test('HTTP snapshots omit nested editable content and ARIA values but retain accessible labels', () => {
  const doc = parseSemanticDOM(
    '<span id="label" hidden>Complete purchase</span><button aria-labelledby="label">Pay</button><div contenteditable aria-label="Message"><p>PRIVATE_VALUE</p><b>PRIVATE_NESTED</b></div><input aria-label="Amount" aria-valuetext="PRIVATE_ARIA" aria-valuenow="123456"><div contenteditable="false"><p>Public content</p></div>',
    'https://example.com',
  );
  assert.equal(doc.nodes.find((n) => n.role === 'button')?.name, 'Complete purchase');
  assert.equal(doc.nodes.find((n) => n.name === 'Message')?.role, 'textbox');
  assert.ok(!JSON.stringify(doc).includes('PRIVATE_'));
  assert.ok(!JSON.stringify(doc).includes('123456'));
  assert.ok(doc.nodes.some((n) => n.text === 'Public content'));
});
test('deep HTTP snapshots fail explicitly and preserve the Watch baseline', async () => {
  let html = '<p>$10</p>';
  const web = new Veytrawl({
    allowPrivateNetwork: true,
    fetcher: { load: async (url) => parseSemanticDOM(html, url) },
  });
  const options = { url: 'https://example.com', watchFor: 'pricing' };
  try {
    await web.watch(options);
    html = '<div>'.repeat(150) + '<p>$12</p>' + '</div>'.repeat(150);
    await assert.rejects(web.watch(options), /depth limit/);
    html = '<p>$15</p>';
    assert.equal((await web.watch(options)).events[0]?.before, '$10');
  } finally {
    web.close();
  }
});
test('Watch cancellation after fetch does not change persisted snapshots or feeds', async () => {
  let price = 10,
    abortDuringFetch = false;
  const controller = new AbortController();
  const web = new Veytrawl({
    allowPrivateNetwork: true,
    fetcher: {
      load: async (url) => {
        if (abortDuringFetch) controller.abort();
        return parseSemanticDOM(`<section><h2>Starter</h2><p>$${price}</p></section>`, url);
      },
    },
  });
  const options = { url: 'https://example.com', watchFor: 'pricing', scope: ' Starter ' };
  try {
    await web.watch(options);
    price = 12;
    abortDuringFetch = true;
    await assert.rejects(web.watch({ ...options, signal: controller.signal }), /abort/i);
    abortDuringFetch = false;
    price = 15;
    const changed = await web.watch(options);
    assert.equal(changed.events[0]?.before, '$10');
    assert.equal(changed.events[0]?.after, '$15');
    assert.match(web.feed(options), /pricing-change/);
    assert.equal((web.feed(options).match(/<item>/g) ?? []).length, 1);
  } finally {
    web.close();
  }
});
test('embedding ranker rejects invalid cache bounds and does no work for empty candidates', async () => {
  for (const maxCacheEntries of [-1, Number.NaN, Infinity, 1.5])
    assert.throws(() => new EmbeddingRanker({ maxCacheEntries }), /maxCacheEntries/);
  assert.deepEqual(await new EmbeddingRanker({ maxCacheEntries: 0 }).rank('refund', []), []);
});
test('generic page-change goals compare all facts, while specific goals still filter', () => {
  const before = parseSemanticDOM(
    '<p>Service endpoint is currently available</p>',
    'https://example.com',
  );
  const after = parseSemanticDOM(
    '<p>Service endpoint is currently unavailable</p>',
    'https://example.com',
  );
  for (const goal of ['page changes', 'all changes', 'website changes'])
    assert.equal(semanticDiff(before, after, goal).length, 1);
  assert.equal(semanticDiff(before, after, 'pricing').length, 0);
});
test('Watch reports observed coverage and warns when a goal or scope matches no facts', async () => {
  const web = new Veytrawl({
    allowPrivateNetwork: true,
    fetcher: {
      load: async (url) => parseSemanticDOM('<section><h2>Bitcoin</h2><p>$10</p></section>', url),
    },
  });
  try {
    const options = { url: 'https://example.com', watchFor: 'bitcoin price' };
    const result = await web.watch(options);
    assert.equal(result.diagnostics.source, 'http');
    assert.ok(result.diagnostics.matchedFacts > 0);
    assert.equal(result.diagnostics.priceFacts, 1);
    assert.deepEqual(result.diagnostics.warnings, []);
    const unmatched = await web.watch({ ...options, scope: 'Ethereum' });
    assert.equal(unmatched.diagnostics.matchedFacts, 0);
    assert.equal(unmatched.diagnostics.warnings.length, 1);
    assert.equal((await web.watch(options)).events.length, 0);
  } finally {
    web.close();
  }
});
test('crawl explains robots-blocked redirects and never requests the blocked destination', async () => {
  const site = await fixture(),
    web = new Veytrawl({ allowPrivateNetwork: true });
  try {
    const result = await web.discover({ start: `${site.url}/redirect`, goal: 'docs' });
    assert.match(result.errors[0]!.message, /blocked by robots\.txt/);
    assert.ok(!site.requests.includes('/private'));
  } finally {
    web.close();
    await site.close();
  }
});
test('crawl retains HTML documentation pages whose names end in .js', async () => {
  const web = new Veytrawl({
    allowPrivateNetwork: true,
    fetcher: {
      load: async (url) =>
        parseSemanticDOM(
          url.endsWith('/Node.js')
            ? '<h1>Node.js documentation</h1>'
            : '<a href="/docs/Node.js">Node.js documentation</a><a href="/node.png">Node diagram</a>',
          url,
        ),
    },
  });
  try {
    const result = await web.discover({
      start: 'https://example.com',
      goal: 'Node documentation',
      maxPages: 2,
      respectRobots: false,
      delayMs: 0,
    });
    assert.equal(result.pages[1]?.url, 'https://example.com/docs/Node.js');
    assert.deepEqual(result.errors, []);
    assert.equal(result.skipped[0]?.url, 'https://example.com/node.png');
  } finally {
    web.close();
  }
});
