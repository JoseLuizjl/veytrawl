import { test } from './test.js';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TypeSafeClient } from '@typesafe-ai/sdk';
import { JevProvider } from '../packages/providers/jev/index.js';
import { fixture } from './fixture.js';
const exec = promisify(execFile);
const cli = (...args: string[]) =>
  exec(
    process.execPath,
    [
      'dist/packages/cli/index.js',
      '--allow-private-network',
      ...args,
      ...(!['watch', 'locate', 'history', 'reset'].includes(args[0]!) || args.includes('--db')
        ? []
        : ['--db', ':memory:']),
    ],
    { timeout: 30000 },
  );
test('CLI crawl and persisted watch export real RSS', async () => {
  const site = await fixture(),
    dir = await mkdtemp(join(tmpdir(), 'veytrawl-cli-'));
  try {
    const crawl = JSON.parse(
      (await cli('crawl', site.url, '--goal', 'OAuth authentication', '--max-pages', '2')).stdout,
    );
    assert.equal(crawl.visited, 2);
    assert.ok(crawl.pages[1].url.endsWith('/oauth'));
    const args = [
      'watch',
      `${site.url}/pricing`,
      '--for',
      'pricing changes',
      '--db',
      join(dir, 'watch.sqlite'),
      '--feed',
      join(dir, 'feed.xml'),
    ];
    assert.equal(JSON.parse((await cli(...args)).stdout).baseline, true);
    site.setVersion(2);
    assert.equal(JSON.parse((await cli(...args)).stdout).events.length, 1);
    assert.match(await readFile(join(dir, 'feed.xml'), 'utf8'), /pricing-change/);
    await assert.rejects(
      cli('watch', site.url, '--for', 'pricing', '--interval', 'NaN'),
      /interval/,
    );
    await assert.rejects(cli('crawl', site.url, '--goal', 'OAuth', '--max-pages', '-1'));
    await assert.rejects(cli('unknown', site.url), /Unknown command/);
    await assert.rejects(cli('locate', 'file:///private.html', '--query', 'checkout'), /Only HTTP/);
    await assert.rejects(
      cli('locate', `${site.url}/broken`, '--query', 'checkout'),
      /navigation failed: 500/,
    );
  } finally {
    await site.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test('Jev adapter uses official SDK transport and choice answers (mock HTTP, no live inference)', async () => {
  let request: Record<string, unknown> | undefined;
  const client = new TypeSafeClient({
    apiKey: 'test-not-a-real-key',
    fetch: async (_url, init) => {
      request = JSON.parse(init!.body as string);
      return new Response(
        JSON.stringify({
          model: 'jev-latest',
          answers: {
            candidate: {
              type: 'choice',
              choice: 'n2',
              confidence: 0.9,
              probabilities: { n1: 0.05, n2: 0.9, none: 0.05 },
            },
          },
          usage: { input_tokens: 10, output_tokens: 3 },
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    },
  });
  const result = await new JevProvider(client).choose('checkout', [
    { id: 'n1', text: 'Search', score: 0.1 },
    { id: 'n2', text: 'Buy now', score: 0.9 },
  ]);
  assert.equal(result?.id, 'n2');
  assert.ok(request?.questions);
  assert.equal(request?.model, 'jev-latest');
});
test('CLI browser locate persists selectors across separate processes', async () => {
  const site = await fixture(),
    dir = await mkdtemp(join(tmpdir(), 'veytrawl-cli-browser-'));
  try {
    const args = [
      'locate',
      `${site.url}/shop`,
      '--query',
      'checkout button',
      '--db',
      join(dir, 'selectors.sqlite'),
    ];
    assert.equal(JSON.parse((await cli(...args)).stdout).via, 'heuristic');
    assert.equal(JSON.parse((await cli(...args)).stdout).via, 'cache');
    const dom = JSON.parse(
      (await cli('dom', `${site.url}/shop`, '--browser', '--wait-for', 'button')).stdout,
    );
    assert.equal(dom.source, 'browser');
    assert.ok(dom.nodes.some((n: { role: string }) => n.role === 'button'));
  } finally {
    await site.close();
    await rm(dir, { recursive: true, force: true });
  }
});
