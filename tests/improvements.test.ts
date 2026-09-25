import { statePath } from '../packages/core/paths.js';
import { SemanticWeb } from '../packages/core/index.js';
import { test } from './test.js';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  extractDocument,
  renderExtract,
  parseSemanticDOM,
  semanticDiff,
  Veytrawl,
} from '../packages/core/index.js';
import { fixture } from './fixture.js';
const exec = promisify(execFile);
const cli = (...args: string[]) =>
  exec(process.execPath, ['dist/packages/cli/index.js', '--allow-private-network', ...args], {
    timeout: 30000,
    windowsHide: true,
  });
test('extract preserves paragraph text, avoids nested duplication, filters roles and exposes truncation', () => {
  const doc = parseSemanticDOM(
    '<title>Docs</title><main><h1>Guides</h1><p>Read the <a href="/oauth">OAuth guide</a> today.</p><section><h2>Starter</h2><p>$10 / month</p><button>Buy now</button></section><section><h2>Pro</h2><p>$20 / month</p></section><input value="PRIVATE" aria-label="Account"><script>PRIVATE</script></main>',
    'https://example.com',
  );
  const all = extractDocument(doc);
  assert.equal(all.items.filter((i) => i.text.includes('OAuth guide')).length, 1);
  assert.ok(all.items.some((i) => i.text === 'Read the OAuth guide today.'));
  assert.ok(!JSON.stringify(all).includes('PRIVATE'));
  const links = extractDocument(doc, { role: 'link' });
  assert.equal(links.items.length, 1);
  assert.equal(links.items[0]!.href, 'https://example.com/oauth');
  const price = extractDocument(doc, { role: 'price', scope: 'Starter' });
  assert.equal(price.items.length, 1);
  assert.equal(price.items[0]!.text, '$10 / month');
  const filtered = extractDocument(doc, { query: 'OAuth guide', role: 'link' });
  assert.equal(filtered.items[0]!.score, 1);
  const limited = extractDocument(doc, { limit: 1 });
  assert.equal(limited.items.length, 1);
  assert.ok(limited.totalMatches > 1);
  assert.equal(limited.truncated, true);
  assert.match(limited.warnings[0]!, /Showing 1/);
  assert.match(extractDocument(doc, { query: 'zzzz' }).warnings[0]!, /No readable/);
  assert.throws(() => extractDocument(doc, { limit: 0 }), /limit/);
  const linked = extractDocument(
    parseSemanticDOM(
      '<title>Example</title><h1>Example</h1><p><a href="/more">Learn more</a></p>',
      'https://example.com',
    ),
  );
  assert.equal(
    linked.items.find((item) => item.text === 'Learn more')!.href,
    'https://example.com/more',
  );
  const markdown = renderExtract(linked);
  assert.equal(markdown.split('# Example').length - 1, 1);
  assert.ok(markdown.includes('[Learn more](<https://example.com/more>)'));
});
test('readable exports escape page markup and refuse active Markdown link protocols', () => {
  const doc = parseSemanticDOM(
    '<title>&lt;img src=x&gt;</title><h1>Title</h1><p>[fake](javascript:bad)</p><a href="javascript:alert(1)">Bad link</a><a href="https://example.com/a(b)">Good link</a>',
    'https://example.com',
  );
  const result = extractDocument(doc);
  const md = renderExtract(result);
  assert.ok(!md.includes('<img'));
  assert.ok(!md.includes('](<javascript:'));
  assert.match(md, /\[Good link\]\(<https:\/\/example.com\/a%28b%29>\)/);
  assert.ok(md.includes('\\[fake\\]'));
  const text = renderExtract(result, 'text');
  assert.ok(text.includes('[fake](javascript:bad)'));
  assert.ok(!text.includes('\\[fake'));
});
test('SDK extracts real HTTP content and honors cancellation after a fetch', async () => {
  const site = await fixture(),
    web = new Veytrawl({ allowPrivateNetwork: true });
  try {
    const result = await web.extract({ url: site.url, role: 'link', query: 'OAuth' });
    assert.equal(result.source, 'http');
    assert.ok(result.items.some((i) => i.href === `${site.url}/oauth`));
  } finally {
    web.close();
    await site.close();
  }
  const abort = new AbortController();
  const canceled = new Veytrawl({
    allowPrivateNetwork: true,
    fetcher: {
      load: async (url) => {
        abort.abort();
        return parseSemanticDOM('<p>data</p>', url);
      },
    },
  });
  try {
    await assert.rejects(
      canceled.extract({ url: 'https://example.com', signal: abort.signal }),
      /abort/i,
    );
  } finally {
    canceled.close();
  }
});
test('indexed diff preserves duplicate multiplicity, ambiguity and state changes in large shared entities', () => {
  const dom = (body: string) =>
    parseSemanticDOM(`<main><h1>Catalog</h1>${body}</main>`, 'https://example.com');
  const body = Array.from({ length: 4000 }, (_, i) => `<p>Item ${i}</p>`).join('');
  assert.deepEqual(semanticDiff(dom(body), dom(body), 'all'), []);
  const duplicate = semanticDiff(
    dom('<p>Shared fact</p><p>Shared fact</p>'),
    dom('<p>Shared fact</p>'),
    'all',
  );
  assert.equal(duplicate.length, 1);
  assert.equal(duplicate[0]!.type, 'content-removed');
  const ambiguous = semanticDiff(dom('<p>$10</p><p>$10</p>'), dom('<p>$15</p><p>$15</p>'), 'all');
  assert.equal(ambiguous.length, 4);
  assert.ok(ambiguous.every((e) => !e.before || !e.after));
  const changed = semanticDiff(
    dom(body + '<button>Save</button>'),
    dom(body + '<button disabled>Save</button>'),
    'all',
  );
  assert.equal(changed.length, 1);
  assert.equal(changed[0]!.type, 'state-change');
});
test('CLI help/version work without installed dependencies', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'veytrawl-startup-'));
  try {
    const path = join(dir, 'cli.mjs');
    await writeFile(path, await readFile('dist/packages/cli/index.js', 'utf8'));
    assert.equal(
      (await exec(process.execPath, [path, '--version'], { windowsHide: true })).stdout.trim(),
      '1.0.1',
    );
    assert.match(
      (await exec(process.execPath, [path, '--help'], { windowsHide: true })).stdout,
      /veytrawl extract/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('CLI extraction saves readable files, compact JSON and useful validation errors', async () => {
  const site = await fixture(),
    dir = await mkdtemp(join(tmpdir(), 'veytrawl-extract-'));
  try {
    const output = join(dir, 'nested', 'links.json');
    assert.equal(
      (
        await cli(
          'extract',
          site.url,
          '--role',
          'link',
          '--query',
          'OAuth',
          '--format',
          'json',
          '--compact',
          '--output',
          output,
        )
      ).stdout,
      '',
    );
    const saved = await readFile(output, 'utf8');
    assert.equal(saved.trim().split('\n').length, 1);
    assert.ok(
      JSON.parse(saved).items.some((i: { href: string }) => i.href === `${site.url}/oauth`),
    );
    await cli('extract', `${site.url}/pricing`, '--format', 'text', '--output', output);
    assert.match(await readFile(output, 'utf8'), /\$10 \/ month/);
    assert.match((await cli('extract', site.url)).stdout, /# Developer documentation/);
    await assert.rejects(cli('extract', site.url, '--limit', '1.5'), /integer/);
    await assert.rejects(
      cli('watch', site.url, '--for', 'all', '--count', '2'),
      /requires --interval/,
    );
    await assert.rejects(cli('crawl', site.url), /requires --goal/);
    await assert.rejects(cli('extract', site.url, '--format', 'rss'), /markdown, text, json/);
    const crawl = JSON.parse(
      (
        await cli(
          'crawl',
          site.url,
          '--goal',
          'OAuth',
          '--max-pages',
          '2',
          '--delay-ms',
          '0',
          '--compact',
        )
      ).stdout,
    );
    assert.equal(crawl.pages.length, 2);
    assert.deepEqual(crawl.errors, []);
  } finally {
    await site.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test('bounded CLI Watch emits only changes, saves one event and refreshes its feed', async () => {
  const site = await fixture(),
    dir = await mkdtemp(join(tmpdir(), 'veytrawl-bounded-'));
  const timer = setInterval(() => {
    if (site.requests.includes('/pricing')) site.setVersion(2);
  }, 10);
  try {
    const output = join(dir, 'event.json'),
      feed = join(dir, 'feeds', 'changes.xml');
    const result = await cli(
      'watch',
      `${site.url}/pricing`,
      '--for',
      'all',
      '--interval',
      '1',
      '--count',
      '3',
      '--changes-only',
      '--compact',
      '--output',
      output,
      '--feed',
      feed,
      '--db',
      join(dir, 'watch.sqlite'),
    );
    assert.equal(result.stdout, '');
    assert.equal(site.requests.filter((p) => p === '/pricing').length, 3);
    const event = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(event.events.length, 1);
    assert.equal(event.events[0].before, '$10 / month');
    assert.equal(event.events[0].after, '$15 / month');
    assert.equal(((await readFile(feed, 'utf8')).match(/<item>/g) ?? []).length, 1);
    const lines = (
      await cli(
        'watch',
        site.url,
        '--for',
        'all',
        '--interval',
        '1',
        '--count',
        '2',
        '--compact',
        '--db',
        ':memory:',
      )
    ).stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(lines.length, 2);
    assert.equal(lines[0].baseline, true);
    assert.equal(lines[1].baseline, false);
  } finally {
    clearInterval(timer);
    await site.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test('doctor checks core setup without exposing credentials or claiming inference was tested', async () => {
  const { stdout } = await exec(process.execPath, ['dist/packages/cli/index.js', 'doctor'], {
    env: { ...process.env, TYPESAFE_API_KEY: 'SECRET_DIAGNOSTIC_VALUE' },
    windowsHide: true,
    timeout: 30000,
  });
  const report = JSON.parse(stdout);
  assert.equal(report.ready, true);
  assert.equal(report.checks.find((c: { name: string }) => c.name === 'sqlite').status, 'pass');
  assert.ok(!stdout.includes('SECRET_DIAGNOSTIC_VALUE'));
  assert.match(stdout, /Inference not tested/);
});
test('CLI doctor launches Chromium and browser extraction returns rendered price content', async () => {
  const report = JSON.parse((await cli('doctor', '--browser')).stdout);
  assert.equal(report.ready, true);
  assert.match(
    report.checks.find((c: { name: string }) => c.name === 'browser').detail,
    /launched and read a local page/,
  );
  const site = await fixture();
  try {
    const extracted = JSON.parse(
      (
        await cli(
          'extract',
          `${site.url}/pricing`,
          '--browser',
          '--role',
          'price',
          '--format',
          'json',
        )
      ).stdout,
    );
    assert.equal(extracted.source, 'browser');
    assert.equal(extracted.items.length, 1);
    assert.equal(extracted.items[0].text, '$10 / month');
  } finally {
    await site.close();
  }
});
test('Veytrawl rename preserves SDK identity, legacy Watch baselines and entity markers', async () => {
  assert.equal(Veytrawl, SemanticWeb);
  const dir = await mkdtemp(join(tmpdir(), 'veytrawl-migration-')),
    site = await fixture();
  const legacy = join(dir, '.semweb', 'watch.sqlite'),
    current = join(dir, '.veytrawl', 'watch.sqlite');
  const web = new Veytrawl({ allowPrivateNetwork: true, storage: legacy });
  try {
    assert.equal(statePath('models', dir), join(dir, '.veytrawl', 'models'));
    await mkdir(join(dir, '.semweb', 'models'), { recursive: true });
    assert.equal(statePath('models', dir), join(dir, '.semweb', 'models'));
    assert.equal((await web.watch({ url: `${site.url}/pricing`, watchFor: 'all' })).baseline, true);
    web.close();
    site.setVersion(2);
    const result = JSON.parse(
      (
        await exec(
          process.execPath,
          [
            resolve('dist/packages/cli/index.js'),
            'watch',
            `${site.url}/pricing`,
            '--for',
            'all',
            '--allow-private-network',
          ],
          { cwd: dir, windowsHide: true, timeout: 30000 },
        )
      ).stdout,
    );
    assert.equal(result.baseline, false);
    assert.equal(result.events[0].after, '$15 / month');
    await assert.rejects(stat(current), { code: 'ENOENT' });
    await mkdir(join(dir, '.veytrawl'), { recursive: true });
    await writeFile(current, 'new-resource');
    assert.equal(statePath('watch.sqlite', dir), current);
    const doc = parseSemanticDOM(
      '<section data-semweb-entity="Legacy"><p>$10</p></section><section data-semweb-entity="Old" data-veytrawl-entity="New"><p>$20</p></section>',
      'https://example.com',
    );
    assert.equal(doc.nodes.find((n) => n.text === '$10')!.entity, 'Legacy');
    assert.equal(doc.nodes.find((n) => n.text === '$20')!.entity, 'New');
  } finally {
    try {
      web.close();
    } catch {}
    await site.close();
    await rm(dir, { recursive: true, force: true });
  }
});
