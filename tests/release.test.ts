import { test } from './test.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm, access, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  Veytrawl,
  parseSemanticDOM,
  type PageFetcher,
  type DiscoverProgress,
} from '../packages/core/index.js';
import { fixture } from './fixture.js';
import { discover } from '../packages/crawler/index.js';
import { validateOptions } from '../packages/cli/options.js';

const exec = promisify(execFile);
const start = 'https://example.com/';
const links = Array.from({ length: 8 }, (_, i) => `<a href="/docs/${i}">Guide ${i}</a>`).join('');

test('parallel discovery bounds concurrency and page budget, deduplicates links, and reports progress', async () => {
  let active = 0,
    peak = 0;
  const calls: string[] = [],
    progress: DiscoverProgress[] = [];
  const web = new Veytrawl({
    fetcher: {
      load: async (url, policy) => {
        calls.push(url);
        peak = Math.max(peak, ++active);
        try {
          await delay(30, undefined, { signal: policy?.signal });
          return parseSemanticDOM(url === start ? links + links : '<p>Guide</p>', url);
        } finally {
          active--;
        }
      },
    },
  });
  try {
    const result = await web.discover({
      start,
      goal: 'Guide',
      concurrency: 3,
      delayMs: 0,
      maxPages: 5,
      respectRobots: false,
      onProgress: (event) => {
        progress.push(event);
      },
    });
    assert.equal(result.visited, 5);
    assert.equal(result.pages.length, 5);
    assert.equal(calls.length, 5);
    assert.equal(new Set(calls).size, 5);
    assert.equal(peak, 3);
    assert.equal(progress.length, 5);
    assert.deepEqual(result.errors, []);
    assert.ok(progress.every((event) => event.visited <= 5 && event.queued <= 1000));
  } finally {
    web.close();
  }
});

test('parallel discovery respects shared pacing and path filters before requesting redirects', async () => {
  const server = createServer((req, res) => {
    if (req.url === '/robots.txt') {
      res.end('User-agent: *\nDisallow: /docs/private\nCrawl-delay: 1\n');
      return;
    }
    res.setHeader('content-type', 'text/html');
    if (req.url === '/')
      res.end(
        '<a href="/docs/a">Guide</a><a href="/docs/b">Guide</a><a href="/docs/private">Guide</a><a href="/other">Guide</a>',
      );
    else if (req.url === '/docs/a') {
      res.writeHead(302, { location: '/outside' });
      res.end();
    } else res.end('<p>Guide</p>');
  });
  const requested: { path: string; at: number }[] = [];
  server.on('request', (req) => {
    requested.push({ path: req.url!, at: performance.now() });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const result = await discover({
      start: url,
      goal: 'Guide',
      concurrency: 3,
      delayMs: 0,
      includePaths: ['/docs/'],
      allowPrivateNetwork: true,
    });
    assert.ok(!requested.some((row) => ['/outside', '/other', '/docs/private'].includes(row.path)));
    assert.match(result.errors[0]!.message, /path policy/);
    assert.ok(result.skipped.some((row) => row.reason === 'robots.txt'));
    const pages = requested.filter((row) => row.path !== '/robots.txt');
    for (let i = 1; i < pages.length; i++) assert.ok(pages[i]!.at - pages[i - 1]!.at >= 850);
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
});

test('crawl cancellation interrupts pending rankers, decisions, and custom fetchers', async () => {
  for (const stage of ['ranker', 'provider', 'fetcher'] as const) {
    const abort = new AbortController();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetcher: PageFetcher = {
      load: async (url) => {
        if (stage === 'fetcher') {
          entered();
          await pending;
        }
        return parseSemanticDOM('<a href="/a">Guide</a><a href="/b">Guide</a>', url);
      },
    };
    const web = new Veytrawl({
      fetcher,
      ranker:
        stage === 'ranker'
          ? {
              rank: async () => {
                entered();
                await pending;
                return [];
              },
            }
          : undefined,
      provider:
        stage === 'provider'
          ? {
              choose: async () => {
                entered();
                await pending;
                return null;
              },
            }
          : undefined,
    });
    try {
      const operation = web.discover({
        start,
        goal: 'Guide',
        signal: abort.signal,
        respectRobots: false,
        delayMs: 0,
      });
      const rejection = assert.rejects(operation, /abort/i);
      await started;
      abort.abort();
      await Promise.race([
        rejection,
        delay(1500).then(() => {
          throw new Error('Crawl cancellation stalled');
        }),
      ]);
    } finally {
      release();
      web.close();
    }
  }
});

test('crawl progress callback failure propagates and path exclusions override the seed exception', async () => {
  const fetcher = { load: async (url: string) => parseSemanticDOM('<p>Guide</p>', url) };
  await assert.rejects(
    discover(
      {
        start,
        goal: 'Guide',
        respectRobots: false,
        maxDepth: 0,
        onProgress: () => {
          throw new Error('consumer stopped');
        },
      },
      fetcher,
    ),
    /consumer stopped/,
  );
  const result = await discover(
    { start, goal: 'Guide', respectRobots: false, excludePaths: ['/'] },
    {
      load: async () => {
        throw new Error('must not fetch');
      },
    },
  );
  assert.equal(result.visited, 0);
  assert.equal(result.skipped[0]!.reason, 'path policy');
});

test('Watch retention, pagination and reset survive reopening without affecting other watches', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'veytrawl-history-'));
  const storage = join(directory, 'watch.sqlite');
  let price = 10;
  const fetcher = { load: async (url: string) => parseSemanticDOM(`<p>$${price}</p>`, url) };
  const options = { url: start, watchFor: 'pricing' };
  let web = new Veytrawl({ fetcher, storage, watchStore: { maxEvents: 2 } });
  try {
    await web.watch(options);
    await web.watch({ ...options, url: start + 'other' });
    for (price = 11; price <= 13; price++) await web.watch(options);
    assert.deepEqual(
      web.history(options).map((e) => e.after),
      ['$13', '$12'],
    );
    assert.equal(web.history({ ...options, limit: 1, offset: 1 })[0]!.after, '$12');
    assert.throws(() => web.history({ ...options, offset: -1 }));
    web.close();
    web = new Veytrawl({ fetcher, storage });
    assert.equal(web.history(options).length, 2);
    assert.deepEqual(await web.resetWatch(options), { baselineRemoved: true, eventsRemoved: 2 });
    assert.deepEqual(web.history(options), []);
    assert.equal((await web.watch(options)).baseline, true);
    assert.equal((await web.watch({ ...options, url: start + 'other' })).baseline, false);
  } finally {
    web.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('zero retention returns live events without storing them and canceled checks preserve the baseline', async () => {
  let price = 10;
  const web = new Veytrawl({
    watchStore: { maxEvents: 0 },
    fetcher: { load: async (url) => parseSemanticDOM(`<p>$${price}</p>`, url) },
  });
  const options = { url: start, watchFor: 'pricing' };
  try {
    await web.watch(options);
    price = 15;
    assert.equal((await web.watch(options)).events.length, 1);
    assert.equal(web.history(options).length, 0);
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(web.resetWatch({ ...options, signal: abort.signal }), /abort/i);
    price = 20;
    assert.equal((await web.watch(options)).events[0]!.before, '$15');
  } finally {
    web.close();
  }
});

test('SDK opens state lazily and closed clients reject every operation consistently', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'veytrawl-lazy-'));
  const storage = join(directory, 'state.sqlite');
  const web = new Veytrawl({
    storage,
    fetcher: { load: async (url) => parseSemanticDOM('<p>Guide</p>', url) },
  });
  try {
    await web.extract({ url: start });
    await web.discover({ start, goal: 'Guide', respectRobots: false });
    await assert.rejects(access(storage));
    web.close();
    web.close();
    await assert.rejects(web.extract({ url: start }), /closed/);
    await assert.rejects(web.discover({ start, goal: 'Guide' }), /closed/);
    await assert.rejects(web.watch({ url: start, watchFor: 'all' }), /closed/);
    await assert.rejects(web.resetWatch({ url: start, watchFor: 'all' }), /closed/);
    assert.throws(() => web.history({ url: start, watchFor: 'all' }), /closed/);
    assert.throws(() => web.feed({ url: start, watchFor: 'all' }), /closed/);
  } finally {
    web.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('CLI option validation rejects ignored options and incomplete combinations', () => {
  for (const [command, options] of [
    ['dom', { goal: 'Guide' }],
    ['extract', { embeddings: true }],
    ['watch', { 'max-pages': '5' }],
    ['crawl', { 'offline-model': true }],
    ['extract', { 'wait-for': 'main' }],
    ['history', { browser: true }],
    ['watch', { feed: ' ' }],
    ['reset', { limit: '10' }],
  ] as [string, Record<string, unknown>][])
    assert.throws(() => validateOptions(command, options));
  validateOptions('crawl', { concurrency: '3', progress: true });
  validateOptions('history', { limit: '10', offset: '5' });
});

test('CLI crawl progress stays on stderr; history and reset work without contacting the site', async () => {
  const site = await fixture(),
    directory = await mkdtemp(join(tmpdir(), 'veytrawl-cli-history-'));
  const storage = join(directory, 'state.sqlite');
  const cli = (...args: string[]) =>
    exec(process.execPath, ['dist/packages/cli/index.js', ...args], {
      windowsHide: true,
      timeout: 60000,
    });
  try {
    const crawl = await cli(
      'crawl',
      site.url,
      '--goal',
      'OAuth',
      '--max-pages',
      '3',
      '--concurrency',
      '2',
      '--delay-ms',
      '0',
      '--progress',
      '--allow-private-network',
    );
    assert.equal(JSON.parse(crawl.stdout).pages.length, 3);
    assert.ok(
      crawl.stderr
        .trim()
        .split('\n')
        .every((line) => JSON.parse(line).status),
    );
    const options = { url: site.url + '/pricing', watchFor: 'pricing' };
    const web = new Veytrawl({ allowPrivateNetwork: true, storage });
    try {
      await web.watch(options);
      site.setVersion(2);
      await web.watch(options);
    } finally {
      web.close();
    }
    const before = site.requests.length;
    const history = await cli(
      'history',
      options.url,
      '--for',
      'pricing',
      '--db',
      storage,
      '--limit',
      '1',
    );
    assert.equal(JSON.parse(history.stdout)[0].after, '$15 / month');
    const output = join(directory, 'history.xml');
    await cli(
      'history',
      options.url,
      '--for',
      'pricing',
      '--db',
      storage,
      '--format',
      'atom',
      '--output',
      output,
    );
    assert.match(await readFile(output, 'utf8'), /<entry>/);
    const reset = await cli('reset', options.url, '--for', 'pricing', '--db', storage);
    assert.equal(JSON.parse(reset.stdout).eventsRemoved, 1);
    assert.equal(site.requests.length, before);
  } finally {
    await site.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('reset waits for an in-flight check and canceled custom Watch work cannot recreate state', async () => {
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const web = new Veytrawl({
    fetcher: {
      load: async (url) => {
        entered();
        await pending;
        return parseSemanticDOM('<p>$10</p>', url);
      },
    },
  });
  const options = { url: start, watchFor: 'pricing' };
  try {
    const checking = web.watch(options);
    await ready;
    const reset = web.resetWatch(options);
    release();
    assert.equal((await checking).baseline, true);
    assert.deepEqual(await reset, { baselineRemoved: true, eventsRemoved: 0 });
    assert.equal((await web.watch(options)).baseline, true);
  } finally {
    release();
    web.close();
  }
  const controller = new AbortController();
  let finish!: () => void, began!: () => void;
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  const delayed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const canceled = new Veytrawl({
    fetcher: {
      load: async (url) => {
        began();
        await delayed;
        return parseSemanticDOM('<p>$10</p>', url);
      },
    },
  });
  try {
    const checking = canceled.watch({ ...options, signal: controller.signal });
    const rejection = assert.rejects(checking, /abort/i);
    await started;
    controller.abort();
    await rejection;
    assert.deepEqual(await canceled.resetWatch(options), {
      baselineRemoved: false,
      eventsRemoved: 0,
    });
    canceled.close();
    finish();
    await delay(10);
  } finally {
    finish();
    canceled.close();
  }
});

test('parallel crawl errors preserve successful pages and a failed robots policy prevents all page loads', async () => {
  const web = new Veytrawl({
    fetcher: {
      load: async (url) => {
        if (url.endsWith('/bad')) throw new Error('offline');
        return parseSemanticDOM(
          url === start ? '<a href="/good">Guide</a><a href="/bad">Guide</a>' : '<p>Guide</p>',
          url,
        );
      },
    },
  });
  try {
    const result = await web.discover({
      start,
      goal: 'Guide',
      respectRobots: false,
      concurrency: 3,
      delayMs: 0,
    });
    assert.equal(result.visited, 3);
    assert.equal(result.pages.length, 2);
    assert.equal(result.errors.length, 1);
  } finally {
    web.close();
  }
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url!);
    response.writeHead(403);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await assert.rejects(
      discover({
        start: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        goal: 'Guide',
        concurrency: 8,
        allowPrivateNetwork: true,
      }),
      /robots.txt access denied/,
    );
    assert.deepEqual(requests, ['/robots.txt']);
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
});
