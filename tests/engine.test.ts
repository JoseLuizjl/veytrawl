import { test } from './test.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Veytrawl,
  parseSemanticDOM,
  semanticDiff,
  feed,
  HttpFetcher,
  canonicalURL,
} from '../packages/core/index.js';
import { fixture } from './fixture.js';
test('Semantic DOM keeps accessible names, hierarchy, links and states; excludes hidden noise', () => {
  const doc = parseSemanticDOM(
    '<title>Shop</title><main><section><h2>Starter</h2><button aria-labelledby="label">X</button><span id="label">Buy now</span><label for="search">Search docs</label><input id="search"><input type="password" value="SECRET"><input type="checkbox" checked><a href="/docs">Docs</a><div hidden>Hidden</div><script>SECRET</script></section></main>',
    'https://example.com',
  );
  const button = doc.nodes.find((n) => n.role === 'button')!;
  assert.equal(button.name, 'Buy now');
  assert.equal(button.semanticRole, 'checkout');
  assert.equal(button.context, 'Starter');
  assert.ok(doc.nodes.find((n) => n.id === button.parentId)?.children.includes(button.id));
  assert.equal(doc.nodes.find((n) => n.locator.htmlId === 'search')?.name, 'Search docs');
  assert.equal(doc.nodes.find((n) => n.role === 'checkbox')?.checked, true);
  assert.equal(doc.nodes.find((n) => n.role === 'link')?.href, 'https://example.com/docs');
  assert.ok(!JSON.stringify(doc).includes('SECRET'));
  assert.ok(!JSON.stringify(doc).includes('Hidden'));
});
test('discover visits relevant documentation first, obeys robots, deduplicates and respects budget', async () => {
  const site = await fixture(),
    web = new Veytrawl({ allowPrivateNetwork: true });
  try {
    const result = await web.discover({
      start: site.url,
      goal: 'OAuth authentication',
      maxPages: 3,
      delayMs: 0,
    });
    assert.equal(result.visited, 3);
    assert.equal(result.errors.length, 0);
    assert.equal(new URL(result.pages[1]!.url).pathname, '/oauth');
    assert.ok(!site.requests.includes('/careers'));
    assert.ok(!site.requests.includes('/private'));
    assert.equal(site.requests.filter((p) => p === '/oauth').length, 1);
    assert.ok(!site.requests.includes('/oauth-authentication.png'));
    assert.ok(result.skipped.some((s) => s.reason === 'non-HTML asset extension'));
    assert.ok(result.skipped.some((s) => s.url.endsWith('/private')));
  } finally {
    web.close();
    await site.close();
  }
});
test('fetch validates redirect targets before requesting them and bounds response size', async () => {
  const site = await fixture();
  try {
    const fetcher = new HttpFetcher({ allowPrivateNetwork: true });
    await assert.rejects(
      fetcher.load(`${site.url}/redirect`, { allowURL: (u) => !u.endsWith('/private') }),
      /blocked/,
    );
    assert.ok(!site.requests.includes('/private'));
    await assert.rejects(
      fetcher.load(`${site.url}/external-redirect`, {
        allowURL: (u) => new URL(u).origin === site.url,
      }),
      /blocked/,
    );
    await assert.rejects(
      new HttpFetcher({ allowPrivateNetwork: true, maxBytes: 50 }).load(site.url),
      /exceeds/,
    );
    await assert.rejects(fetcher.load(`${site.url}/broken`), /HTTP 500/);
  } finally {
    await site.close();
  }
});
test('URL normalization preserves meaningful queries but removes fragments and tracking', () => {
  assert.equal(
    canonicalURL('https://example.com/docs?b=2&utm_source=test&a=1#title'),
    'https://example.com/docs?a=1&b=2',
  );
  assert.throws(() => canonicalURL('file:///etc/passwd'));
  assert.throws(() => canonicalURL('https://user:password@example.com'));
});
test('watch persists baseline, ignores cosmetic changes, emits price event once and survives restart', async () => {
  const site = await fixture(),
    dir = await mkdtemp(join(tmpdir(), 'veytrawl-')),
    path = join(dir, 'watch.sqlite');
  let web = new Veytrawl({ allowPrivateNetwork: true, storage: path });
  const options = { url: `${site.url}/pricing`, watchFor: 'pricing changes' };
  try {
    assert.equal((await web.watch(options)).baseline, true);
    site.setVersion(1);
    assert.deepEqual((await web.watch(options)).events, []);
    web.close();
    web = new Veytrawl({ allowPrivateNetwork: true, storage: path });
    site.setVersion(2);
    const result = await web.watch(options);
    assert.equal(result.baseline, false);
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0]?.type, 'pricing-change');
    assert.equal(result.events[0]?.before, '$10 / month');
    assert.equal(result.events[0]?.after, '$15 / month');
    assert.deepEqual((await web.watch(options)).events, []);
    assert.equal((web.feed(options).match(/<item>/g) ?? []).length, 1);
    assert.match(web.feed({ ...options, format: 'atom' }), /<entry>/);
  } finally {
    web.close();
    await site.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test('diff separates plans and ignores reordered facts while detecting real additions and state changes', () => {
  const dom = (html: string) => parseSemanticDOM(html, 'https://example.com');
  const before = dom(
    '<section><h2>Pro</h2><p>$20</p></section><section><h2>Basic</h2><p>$10</p></section>',
  );
  const reordered = dom(
    '<section class="new"><h2>Basic</h2><p>$10</p></section><section><h2>Pro</h2><p>$20</p></section>',
  );
  assert.deepEqual(semanticDiff(before, reordered, 'pricing changes'), []);
  const changed = dom(
    '<section><h2>Basic</h2><p>$15</p></section><section><h2>Pro</h2><p>$20</p></section>',
  );
  const events = semanticDiff(before, changed, 'pricing changes');
  assert.equal(events.length, 1);
  assert.equal(events[0]!.context, 'Basic');
  assert.equal(
    semanticDiff(
      dom('<p>GET /api/users</p>'),
      dom('<p>GET /api/users</p><p>POST /api/tokens</p>'),
      'API',
    )[0]?.type,
    'content-added',
  );
  assert.equal(
    semanticDiff(
      dom('<button>Buy now</button>'),
      dom('<button disabled>Buy now</button>'),
      'checkout',
    )[0]?.type,
    'state-change',
  );
});
test('feeds escape untrusted text and expose significant events only', () => {
  const xml = feed(
    [
      {
        id: '123',
        at: '2026-09-22T12:00:00Z',
        url: 'https://example.com/?a=1&b=2',
        type: 'content-added',
        important: true,
        context: '<script>',
        after: 'A & B',
      },
    ],
    { title: '<test>', url: 'https://example.com' },
  );
  assert.match(xml, /&lt;script&gt;/);
  assert.match(xml, /A &amp; B/);
  assert.ok(!xml.includes('<script>'));
});
test('watch captures named controls with nested markup and checkbox state', () => {
  const dom = (html: string) => parseSemanticDOM(html, 'https://example.com');
  const before = dom(
    '<button><span>Buy now</span></button><input type="checkbox" aria-label="Notifications">',
  );
  const after = dom(
    '<button disabled><span>Buy now</span></button><input type="checkbox" checked aria-label="Notifications">',
  );
  const events = semanticDiff(before, after, 'all');
  assert.equal(events.length, 2);
  assert.ok(events.every((e) => e.type === 'state-change'));
});
