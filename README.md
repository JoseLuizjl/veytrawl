# Veytrawl

Veytrawl is a command-line tool and TypeScript library for extracting web content, crawling relevant pages, finding interactive elements, and monitoring changes. Use it to search documentation, export page content, or turn changes into RSS and Atom feeds. Core features work without an API key or model.

**Version 1.0.0** | **Node.js 24+** | **TypeScript SDK + CLI** | [**MIT license**](LICENSE)

[Quick start](#quick-start) | [Features](#what-you-can-do) | [Usage](#usage) | [SDK](#typescript-sdk) | [Optional AI](#optional-ai) | [Troubleshooting](#troubleshooting) | [Development](#development)

---

## Quick start

Node.js 24 or later is required.

### 1. Install the CLI

```bash
npm install --global --ignore-scripts veytrawl
veytrawl --version
```

Package page: [veytrawl on npm](https://www.npmjs.com/package/veytrawl).

### 2. Extract your first page

```bash
veytrawl extract https://example.com
```

This prints the page's readable content as Markdown. Save it to a file with:

```bash
veytrawl extract https://example.com --output exports/example.md
```

Explore the commands and check your setup:

```bash
veytrawl --help
veytrawl doctor --format text
```

### 3. Enable browser features when needed

For interactive element lookup or JavaScript-rendered pages, install the Chromium version used by this release:

```bash
npx --yes playwright@1.63.0 install chromium
veytrawl doctor --browser --format text
```

HTTP extraction, crawling, and watching work without Chromium. The CLI installation command disables automatic dependency scripts. Browser installation is an explicit step.

<details>
<summary><strong>Build from source or install a verified local archive</strong></summary>

In the source checkout:

```bash
git clone https://github.com/JoseLuizjl/veytrawl.git
cd veytrawl
npm ci --ignore-scripts
npm run build
node dist/packages/cli/index.js --help
```

To build and verify a distributable archive:

```bash
npm run verify:package
```

The command reports the path to the verified `.tgz` file. Copy that file into your application's folder, then install it:

```bash
npm install --ignore-scripts ./veytrawl-1.0.0.tgz
```

Use `npm install --global --ignore-scripts ./veytrawl-1.0.0.tgz` for a global CLI installation from that archive.

When running directly from source, replace `veytrawl` in the examples below with `node dist/packages/cli/index.js`.

</details>

## What you can do

| Feature          | Use it to                                                           | Get back                                             |
| ---------------- | ------------------------------------------------------------------- | ---------------------------------------------------- |
| **Extract**      | Turn pages into readable content; filter by query, role, or context | Markdown, plain text, or JSON                        |
| **Discover**     | Explore documentation and related pages toward a goal               | Ranked pages, skipped URLs, and errors               |
| **Locate**       | Find buttons and links by meaning, even after selectors change      | A match in the CLI; an executable locator in the SDK |
| **Watch**        | Monitor meaningful content and price changes                        | Change events, diagnostics, and RSS or Atom feeds    |
| **Semantic DOM** | Inspect accessible names, roles, links, and page structure          | A structured JSON snapshot                           |
| **Doctor**       | Check the runtime and optional browser/model setup                  | A readable or JSON diagnostic report                 |

## Usage

### Extract readable content

Export links as JSON, search a page, or capture content rendered by JavaScript:

```bash
veytrawl extract https://example.com --role link --format json
veytrawl extract https://example.com --query documentation --limit 20
veytrawl extract https://example.com --browser --format text
```

Extraction selects content already present on the page. Use `--scope` to filter by entity or context, and `--limit` to control how many blocks are returned. JSON output includes the match count, truncation status, and warnings.

### Discover pages around a goal

```bash
veytrawl crawl https://nodejs.org/api/ --goal "HTTP server" --max-pages 5
```

Veytrawl prioritizes links using their names, URLs, and context. Crawls respect `robots.txt`, origin boundaries, page budgets, and depth limits. The starting page counts toward `--max-pages`.

Use `--depth` to set the maximum link depth and `--delay-ms` to adjust pacing. A site's robots crawl delay still takes precedence.

Limit discovery to useful paths and overlap requests when appropriate:

```bash
veytrawl crawl https://nodejs.org/api/ --goal "HTTP server" --max-pages 10 --concurrency 3 --include-path /api/ --exclude-path /api/deprecations --progress
```

Concurrency defaults to one and supports up to eight workers. All workers share the same request pacing. Include/exclude paths are literal pathname prefixes and may be repeated. The seed page is allowed by include filters; exclude filters still apply. Redirects obey the same policy. `--max-queue` bounds queued links, and `--min-score 0` broadens discovery. Progress is JSON on stderr, leaving the final result on stdout.

### Find interactive elements

```bash
veytrawl locate https://www.wikipedia.org/ --query "English link"
```

Locate reports the matching element, its ranking score, and how it was resolved. **The CLI does not click.** The SDK returns a Playwright locator for explicitly requested actions such as `click()` or `fill()`.

Cached selectors are revalidated before reuse. If an element's identity changes, Veytrawl searches again. For ambiguous results, make the query more specific by naming the action, section, or entity. Confidence is a ranking score, not a calibrated probability.

### Watch for meaningful changes

Run a single check:

```bash
veytrawl watch https://example.com --for all
```

Poll three times, ten seconds apart:

```bash
veytrawl watch https://example.com --for all --interval 10 --count 3
```

Keep watching and export an RSS feed:

```bash
veytrawl watch https://example.com --for all --interval 60 --changes-only --feed exports/changes.xml
```

**The first check creates a baseline.** Later checks compare against it. An unchanged page produces an empty event list; `--changes-only` suppresses those empty results. Press **Ctrl+C** to stop continuous polling.

Use `--scope` to watch a specific entity, `--ignore-text` to exclude chosen text, and `--keep-timestamps` to retain timestamp changes. `--format atom` exports Atom instead of RSS. Feeds contain up to 100 recent events and are written as files.

### Review or reset saved changes

Read, export, or reset saved changes without contacting the monitored site:

```bash
veytrawl history https://example.com --for all --limit 20
veytrawl history https://example.com --for all --limit 20 --offset 20
veytrawl history https://example.com --for all --format atom --output exports/history.xml
veytrawl reset https://example.com --for all
```

Use the same `--db`, scope, ignore rules, and timestamp setting as the original watch. Reset deletes only that watch's baseline and events; its next poll starts a new baseline. Other watches and selector caches remain intact. These commands do not contact the site.

Watch retains the latest 1,000 events per watch by default. Set `watch --max-events 5000` to keep more, or `--max-events 0` to detect and emit changes without retaining event history. Retention applies on the next successful check. Logical deletion does not securely erase database pages or backups.

### Inspect the semantic snapshot

```bash
veytrawl dom https://example.com --compact
```

The snapshot contains roles, accessible names, text, links, hierarchy, and context. Browser snapshots can also capture rendered visibility and geometry. Node IDs belong to one snapshot; they are not stable global identities.

### Common options

| Option                     | Behavior                                                      |
| -------------------------- | ------------------------------------------------------------- |
| `--output <file>`          | Save UTF-8 output and atomically replace the destination      |
| `--compact`                | Emit JSON on one line                                         |
| `--browser`                | Render the page in Chromium                                   |
| `--wait-for <selector>`    | Wait for a known visible element                              |
| `--settle-ms <number>`     | Allow a bounded delay for page updates                        |
| `--timeout <milliseconds>` | Set the request or navigation timeout                         |
| `--db <file>`              | Choose persistent storage; use `:memory:` for temporary state |
| `--allow-private-network`  | Explicitly allow trusted local or intranet targets            |

With `--output`, stdout stays empty and the file holds the latest emitted result. For Watch, `--count` includes all polls, even suppressed results. Use separate paths for `--output` and `--feed`. Errors go to stderr with a failing exit code.

## TypeScript SDK

Install the SDK in your application:

```bash
npm install --ignore-scripts veytrawl
```

Then import `Veytrawl`:

```ts
import { Veytrawl } from 'veytrawl';

const web = new Veytrawl();

try {
  const content = await web.extract({
    url: 'https://example.com',
    role: 'link',
  });

  console.log(content.items);
} finally {
  web.close();
}
```

The SDK exposes the same core workflows through `extract()`, `discover()`, `locate()`, `watch()`, `feed()`, `history()`, and `resetWatch()`.

<details>
<summary><strong>Discover documentation</strong></summary>

```ts
import { Veytrawl } from 'veytrawl';

const web = new Veytrawl();

try {
  const result = await web.discover({
    start: 'https://nodejs.org/api/',
    goal: 'HTTP server',
    maxPages: 5,
    maxDepth: 3,
  });

  console.log(result.pages, result.errors);
} finally {
  web.close();
}
```

Set `minScore: 0` for broader exploration. Results include pages, skipped URLs, errors, and the number visited.

</details>

<details>
<summary><strong>Locate an element in a managed browser session</strong></summary>

```ts
import { Veytrawl, PlaywrightFetcher, launchBrowser } from 'veytrawl';

const browser = await launchBrowser();
const fetcher = new PlaywrightFetcher(browser);
const web = new Veytrawl({ fetcher });

try {
  const session = await fetcher.open('https://www.wikipedia.org/');

  try {
    const match = await web.locate(session.page, 'English link');
    session.check();
    console.log(match.node.name, match.confidence, match.via);
  } finally {
    await session.close();
  }
} finally {
  web.close();
  await browser.close();
}
```

The returned match exposes `click()`, `fill()`, and its underlying Playwright locator. Always close managed sessions and the browser when finished.

</details>

<details>
<summary><strong>Persist a Watch baseline and generate a feed</strong></summary>

```ts
import { Veytrawl } from 'veytrawl';

const web = new Veytrawl({ storage: '.veytrawl/watch.sqlite' });

try {
  const options = { url: 'https://example.com', watchFor: 'all' };
  const result = await web.watch(options);

  console.log(result.baseline, result.events, result.diagnostics);
  console.log(web.feed({ ...options, format: 'rss' }));
} finally {
  web.close();
}
```

Each call to `watch()` performs one check. Call it again to compare against the saved baseline. Failed or incomplete captures preserve the previous baseline; snapshots and events commit together in SQLite.

SDK options include `scope`, `ignoreText`, and `ignoreTimestamps`. Changing these options creates a separate baseline. Monetary normalization covers USD, EUR, GBP, and BRL.

</details>

### History and progress

```ts
import { Veytrawl } from 'veytrawl';

const web = new Veytrawl({
  storage: '.veytrawl/watch.sqlite',
  watchStore: { maxEvents: 5000 },
});

try {
  const options = { url: 'https://example.com', watchFor: 'all' };
  console.log(web.history({ ...options, limit: 20, offset: 0 }));
  const result = await web.discover({
    start: 'https://nodejs.org/api/',
    goal: 'HTTP server',
    concurrency: 3,
    includePaths: ['/api/'],
    onProgress: (progress) => console.error(progress),
  });
  console.log(result.pages);
} finally {
  web.close();
}
```

Call `await web.resetWatch(options)` only when you intend to discard that watch's baseline and history. Signals cancel outstanding crawl waits, including ranking and provider decisions.

### Storage

The SDK uses in-memory storage unless you supply `storage`. Databases open on first use, so extraction and crawling do not create state files. The CLI persists Watch and selector state in `.veytrawl/watch.sqlite`; choose another location with `--db`.

Call `close()` after pending operations finish; calling it repeatedly is safe. Closed instances cannot be reused.

Configure selector caching with `selectorCache: { ttlMs, maxEntries, path }`. Defaults are seven days and 1,000 entries. Finish pending operations before calling `close()`.

### Compatibility

Import from `veytrawl`, `veytrawl/dom`, or `veytrawl/providers/jev`; other internal file paths are not public APIs. Public method signatures, documented defaults, and persisted data formats follow semantic versioning from 1.0 onward. Additive JSON fields may appear in minor releases; consumers should tolerate them. Security fixes may tighten input validation and are documented in the changelog.

Discovery returns per-page errors alongside successful pages. The seed and failed requests count toward the page budget. Parallel discovery may visit pages in a different order; the same origin, robots, path, and pacing rules apply. Cancel operations with an `AbortSignal`; custom providers may finish their own work afterward, but late results cannot update a baseline or schedule new pages.

## Optional AI

| Mode                     | Enable it with                 | Requirements and data flow                                                         |
| ------------------------ | ------------------------------ | ---------------------------------------------------------------------------------- |
| **Built-in matching**    | Enabled by default             | No API key or model required                                                       |
| **Local CPU embeddings** | `--embeddings`                 | Optional Transformers dependency; first use may download a model from Hugging Face |
| **Cached embeddings**    | `--embeddings --offline-model` | A previously downloaded model; no model network access                             |
| **Jev decisions**        | `--jev`                        | A `TYPESAFE_API_KEY`; sends a bounded goal and candidate text to the provider      |

To verify embeddings from the checkout:

```bash
npm run verify:embeddings
npm run verify:embeddings:offline
```

For Jev, supply the key through your environment or a private `.env` file based on the empty `.env.example`. The CLI does not automatically load `.env`. With the SDK installed locally, load it explicitly when needed:

```bash
node --env-file=.env node_modules/veytrawl/dist/packages/cli/index.js locate https://www.wikipedia.org/ --query "English link" --jev
```

Common secrets and email addresses are redacted before remote decisions, but redaction cannot recognize all sensitive content. Enable a remote provider only for content you may share.

## Troubleshooting

| What you see                   | What to do                                                                                                     |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Chromium is missing            | Run `npx --yes playwright@1.63.0 install chromium`, then `doctor --browser`                                    |
| Expected content is absent     | Try `--browser` for JavaScript-rendered pages                                                                  |
| `--wait-for` times out         | Choose a selector that exists and becomes visible, or omit the option                                          |
| Locate is ambiguous            | Include the element's label, action, section, or entity in `--query`                                           |
| Watch returns no events        | The first poll creates a baseline; check `diagnostics.matchedFacts`, capture time, and warnings on later polls |
| A local URL is blocked         | Use `--allow-private-network` only for a trusted local target                                                  |
| Offline embeddings cannot load | Run the online verification once to populate the model cache                                                   |
| A site returns HTTP 403        | The site denied access; Veytrawl does not bypass access controls or anti-bot protection                        |

Watch uses snapshot polling. Empty events do not prove that a live price is unchanged. Closed shadow roots and canvas without accessible content are outside the semantic representation.

Bun supports the paths covered by `npm run test:bun`. On Windows, browser CLI commands delegate to Node.js; use Node for the browser SDK.

## Privacy and security

Veytrawl has no application analytics or telemetry collector. Requests to websites, their browser resources, DNS infrastructure, optional model downloads, and explicitly enabled providers still involve network communication.

Private and reserved network destinations are blocked by default. For trusted local SDK use, configure `allowPrivateNetwork: true` on `Veytrawl` and any custom built-in fetcher. Keep this restriction enabled for arbitrary URLs submitted by others.

Snapshots, feeds, exports, and SQLite databases can contain sensitive page content. Keep them private. Browser mode executes website scripts; service deployments need operating-system isolation in addition to the managed browser controls.

Read the [security policy](SECURITY.md) for data handling, network boundaries, and vulnerability reporting.

## Development

```bash
npm run format:check
npm run verify:source
npm test
npm run verify:package
npm audit
```

Run `npm run demo` to exercise browser discovery, selector recovery, and change detection against a local fixture.

`npm run benchmark:crawl` compares sequential and parallel HTTP discovery on a deterministic latency fixture. `npm run benchmark:improvements` measures CLI startup and indexed diff performance. Results describe local workloads, not production guarantees.

<details>
<summary><strong>Compatibility with earlier project names</strong></summary>

`SemanticWeb` remains an alias for the `Veytrawl` class. Existing `.semweb/` resources are reused when the corresponding `.veytrawl/` resource is absent. Prefer `Veytrawl` and `data-veytrawl-entity` in new code; the legacy entity attribute remains accepted.

</details>

## Project links

- [Source and issues](https://github.com/JoseLuizjl/veytrawl)
- [npm package](https://www.npmjs.com/package/veytrawl)
- [Contributing](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)
- [Security policy](SECURITY.md)

Released under the [MIT license](LICENSE).
