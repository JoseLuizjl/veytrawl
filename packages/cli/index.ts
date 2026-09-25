#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { writeFile, rename, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Veytrawl } from '../core/index.js';
import type { Browser } from 'playwright';
const help = `Veytrawl 0.3.0-alpha - discover, extract, locate, watch

veytrawl doctor [--browser] [--format text|json]
veytrawl extract <url> [--query <text>] [--role link|heading|price] [--limit 200]
veytrawl crawl <url> --goal <text> [--max-pages 10] [--depth 3] [--delay-ms 250]
veytrawl locate <url> --query <text> [--timeout 15000]
veytrawl watch <url> --for <text> [--interval 60] [--count 5] [--changes-only]
veytrawl history <url> --for <text> [--limit 100] [--offset 0]
veytrawl reset <url> --for <text>
veytrawl dom <url>

Crawl: --concurrency 1 --max-queue 1000 --min-score 0.05 --include-path /docs/ --exclude-path /private/ --progress
History: --format json|rss|atom; reset deletes only the selected watch baseline and events
Retention: watch --max-events 1000 (per watch; 0 disables event history)
Output: --output <file> --compact (one-line JSON)
Extract: --format markdown|text|json (default markdown), --scope <entity>
Common: --db .veytrawl/watch.sqlite --jev --embeddings --offline-model
Local targets: --allow-private-network (trusted local/intranet URLs only)
Browser: --browser --wait-for <selector> --settle-ms 250 --timeout 15000
Watch: --feed <file> --format rss|atom --scope <entity> --ignore-text <text> --keep-timestamps

Examples:
  veytrawl extract https://example.com --output page.md
  veytrawl extract https://example.com --role link --format json
  veytrawl watch https://example.com --for all --interval 10 --count 3 --compact
  veytrawl doctor --browser --format text

Watch runs once by default; --interval repeats until Ctrl+C or --count.
--changes-only suppresses baseline/empty results. --output replaces the file
atomically with the latest emitted result; stdout stays empty when saving.
Locate reports a match without clicking. Extraction search uses lexical synonyms.
Embeddings and Jev are optional. No model/service is loaded unless requested.
Install Chromium: npx --yes playwright@1.63.0 install chromium`;
async function save(path: string, value: string) {
  const destination = resolve(path),
    temporary = `${destination}.${randomUUID()}.tmp`;
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporary, value, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}
async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean' },
      goal: { type: 'string' },
      query: { type: 'string' },
      for: { type: 'string' },
      'max-pages': { type: 'string' },
      concurrency: { type: 'string' },
      'max-queue': { type: 'string' },
      'min-score': { type: 'string' },
      'include-path': { type: 'string', multiple: true },
      'exclude-path': { type: 'string', multiple: true },
      progress: { type: 'boolean' },
      'max-events': { type: 'string' },
      offset: { type: 'string' },
      depth: { type: 'string' },
      'delay-ms': { type: 'string' },
      db: { type: 'string' },
      interval: { type: 'string' },
      count: { type: 'string' },
      'changes-only': { type: 'boolean' },
      feed: { type: 'string' },
      format: { type: 'string' },
      jev: { type: 'boolean' },
      output: { type: 'string', short: 'o' },
      compact: { type: 'boolean' },
      role: { type: 'string' },
      limit: { type: 'string' },
      'allow-private-network': { type: 'boolean' },
      browser: { type: 'boolean' },
      embeddings: { type: 'boolean' },
      'offline-model': { type: 'boolean' },
      'wait-for': { type: 'string' },
      'settle-ms': { type: 'string' },
      timeout: { type: 'string' },
      scope: { type: 'string' },
      'ignore-text': { type: 'string', multiple: true },
      'keep-timestamps': { type: 'boolean' },
    },
  });
  if (values.version) {
    console.log('1.0.1');
    return;
  }
  if (values.help || !positionals.length || positionals[0] === 'help') {
    console.log(help);
    return;
  }
  const { statePath } = await import('../core/paths.js');
  const [command, inputURL] = positionals;
  if (
    !['crawl', 'locate', 'watch', 'dom', 'extract', 'doctor', 'history', 'reset'].includes(command!)
  )
    throw new Error(`Unknown command: ${command}`);
  if (command === 'doctor' ? positionals.length !== 1 : !inputURL || positionals.length !== 2)
    throw new Error(
      command === 'doctor'
        ? 'doctor does not take a URL'
        : 'Specify a command and URL. Use --help.',
    );
  const { validateOptions } = await import('./options.js');
  validateOptions(command!, values);
  if (process.versions.bun && (values.browser || command === 'locate')) {
    const child = spawnSync('node', [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
      stdio: 'inherit',
      windowsHide: true,
    });
    if (child.error)
      throw new Error(`Browser commands require Node.js on PATH: ${child.error.message}`);
    process.exitCode = child.status ?? 1;
    return;
  }
  const format =
    values.format ?? (command === 'extract' ? 'markdown' : command === 'watch' ? 'rss' : 'json');
  const allowedFormats =
    command === 'extract'
      ? ['markdown', 'text', 'json']
      : command === 'watch'
        ? ['rss', 'atom']
        : command === 'history'
          ? ['json', 'rss', 'atom']
          : command === 'doctor'
            ? ['text', 'json']
            : ['json'];
  if (!allowedFormats.includes(format))
    throw new Error(`--format for ${command} must be ${allowedFormats.join(', ')}`);
  const number = (
    raw: string | undefined,
    name: string,
    minimum: number,
    maximum: number,
    integer = false,
  ) => {
    if (raw === undefined) return undefined;
    const value = Number(raw);
    if (
      !raw.trim() ||
      !Number.isFinite(value) ||
      value < minimum ||
      value > maximum ||
      (integer && !Number.isInteger(value))
    )
      throw new Error(`${name} must be ${integer ? 'an integer ' : ''}${minimum}-${maximum}`);
    return value;
  };
  const interval = number(values.interval, '--interval', 1, 86400);
  const count = number(values.count, '--count', 1, 1000000, true);
  const limit = number(values.limit, '--limit', 1, 10000, true);
  const delayMs = number(values['delay-ms'], '--delay-ms', 0, 60000);
  const maxPages = number(values['max-pages'], '--max-pages', 1, 1000, true);
  const maxDepth = number(values.depth, '--depth', 0, 20, true);
  const timeoutMs = number(values.timeout ?? '15000', '--timeout', 1, 120000)!;
  const concurrency = number(values.concurrency, '--concurrency', 1, 8, true);
  const maxQueue = number(values['max-queue'], '--max-queue', 1, 100000, true);
  const minScore = number(values['min-score'], '--min-score', 0, 1);
  const maxEvents = number(values['max-events'], '--max-events', 0, 100000, true);
  const offset = number(values.offset, '--offset', 0, 1000000, true);
  const settleMs = number(values['settle-ms'], '--settle-ms', 0, 30000);
  if (
    command !== 'watch' &&
    (count !== undefined || interval !== undefined || values['changes-only'])
  )
    throw new Error('--count, --interval and --changes-only apply to watch');
  if (count !== undefined && count > 1 && interval === undefined)
    throw new Error('--count greater than 1 requires --interval');
  if (
    !['extract', 'history'].includes(command!) &&
    (values.role !== undefined || limit !== undefined)
  )
    throw new Error('--role and --limit apply to extract');
  if (command !== 'crawl' && delayMs !== undefined) throw new Error('--delay-ms applies to crawl');
  if (values.output !== undefined && !values.output.trim())
    throw new Error('--output requires a non-empty path');
  if (values.output && values.feed && resolve(values.output) === resolve(values.feed))
    throw new Error('--output and --feed must use different paths');
  const emit = async (value: unknown, text?: string) => {
    const rendered = text ?? JSON.stringify(value, null, values.compact ? undefined : 2) + '\n';
    if (values.output) await save(values.output, rendered);
    else process.stdout.write(rendered);
  };
  if (command === 'doctor') {
    const { doctor, doctorText } = await import('./doctor.js');
    const result = await doctor(values.browser);
    await emit(result, format === 'text' ? doctorText(result) : undefined);
    if (!result.ready) process.exitCode = 1;
    return;
  }
  if (command === 'crawl' && !values.goal?.trim())
    throw new Error('crawl requires --goal, for example --goal "JavaScript documentation"');
  if (command === 'locate' && !values.query?.trim())
    throw new Error('locate requires --query, for example --query "English link"');
  if (['watch', 'history', 'reset'].includes(command!) && !values.for?.trim())
    throw new Error(`${command} requires --for, for example --for all`);
  const { HttpFetcher, PlaywrightFetcher, canonicalURL } = await import('../core/fetch.js');
  const url = canonicalURL(inputURL!);
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let browser: Browser | undefined, web: Veytrawl | undefined;
  try {
    if (values.browser || command === 'locate') {
      if (existsSync(statePath('browsers')))
        process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve(statePath('browsers'));
      const { launchBrowser } = await import('../core/browser.js');
      browser = await launchBrowser();
    }
    const allowPrivateNetwork = values['allow-private-network'] ?? false;
    const fetcher = browser
      ? new PlaywrightFetcher(browser, {
          allowPrivateNetwork,
          timeoutMs,
          waitForSelector: values['wait-for'],
          settleMs,
        })
      : new HttpFetcher({ timeoutMs, allowPrivateNetwork });
    if (command === 'dom' || command === 'extract') {
      const doc = await fetcher.load(url, { signal: abort.signal });
      abort.signal.throwIfAborted();
      if (command === 'dom') await emit(doc);
      else {
        const { extractDocument, renderExtract } = await import('../core/extract.js');
        const result = extractDocument(doc, {
          query: values.query,
          role: values.role,
          scope: values.scope,
          limit,
        });
        await emit(
          result,
          format === 'json' ? undefined : renderExtract(result, format as 'markdown' | 'text'),
        );
      }
      return;
    }
    const { Veytrawl, EmbeddingRanker } = await import('../core/index.js');
    const provider = values.jev
      ? new (await import('../providers/jev/index.js')).JevProvider()
      : undefined;
    web = new Veytrawl({
      allowPrivateNetwork,
      storage: command === 'crawl' ? ':memory:' : (values.db ?? statePath('watch.sqlite')),
      fetcher,
      provider,
      watchStore: { maxEvents },
      ranker: values.embeddings
        ? new EmbeddingRanker({ localFilesOnly: values['offline-model'] })
        : undefined,
    });
    const watchOptions = {
      url,
      watchFor: values.for!,
      scope: values.scope,
      ignoreText: values['ignore-text'],
      ignoreTimestamps: !values['keep-timestamps'],
      signal: abort.signal,
    };
    if (command === 'history') {
      const events = web.history({ ...watchOptions, limit, offset });
      const { feed } = await import('../watch/index.js');
      await emit(
        events,
        format === 'json'
          ? undefined
          : feed(events, { title: values.for!, url, format: format as 'rss' | 'atom' }) + '\n',
      );
    } else if (command === 'reset') {
      await emit(await web.resetWatch(watchOptions));
    } else if (command === 'crawl') {
      const { redactSensitiveText } = await import('../core/privacy.js');
      const result = await web.discover({
        start: url,
        goal: values.goal!,
        maxPages,
        maxDepth,
        delayMs,
        concurrency,
        maxQueue,
        minScore,
        includePaths: values['include-path'],
        excludePaths: values['exclude-path'],
        onProgress: values.progress
          ? (progress) => {
              process.stderr.write(redactSensitiveText(JSON.stringify(progress)) + '\n');
            }
          : undefined,
        signal: abort.signal,
      });
      await emit({ ...result, pages: result.pages.map(({ document, ...page }) => page) });
      if (result.errors.length) process.exitCode = 1;
    } else if (command === 'locate') {
      const session = await (fetcher as InstanceType<typeof PlaywrightFetcher>).open(url, {
        signal: abort.signal,
      });
      try {
        const page = session.page;
        const result = await web.locate(page, values.query!, { timeoutMs, signal: abort.signal });
        session.check();
        await emit({
          element: result.element,
          confidence: result.confidence,
          confidenceKind: result.confidenceKind,
          via: result.via,
          node: result.node,
        });
      } finally {
        await session.close();
      }
    } else {
      let polls = 0;
      do {
        const options = watchOptions;
        const { baseline, events, diagnostics } = await web.watch(options);
        if (!values['changes-only'] || events.length) await emit({ baseline, events, diagnostics });
        if (values.feed)
          await save(values.feed, web.feed({ ...options, format: format as 'rss' | 'atom' }));
        polls++;
        if (
          interval === undefined ||
          abort.signal.aborted ||
          (count !== undefined && polls >= count)
        )
          break;
        await delay(interval * 1000, undefined, { signal: abort.signal });
      } while (!abort.signal.aborted);
    }
  } catch (error) {
    if (!abort.signal.aborted) throw error;
  } finally {
    web?.close();
    await browser?.close();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
main().catch(async (error) => {
  const { safeError } = await import('../core/privacy.js');
  console.error(`veytrawl: ${safeError(error)}`);
  process.exitCode = 1;
});
