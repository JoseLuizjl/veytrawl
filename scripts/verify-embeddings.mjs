import { statePath } from '../dist/packages/core/paths.js';
import assert from 'node:assert/strict';
import { EmbeddingRanker, Veytrawl, launchBrowser } from '../dist/packages/core/index.js';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
if (existsSync(statePath('browsers')))
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve(statePath('browsers'));
const offline = process.argv.includes('--offline');
if (offline) {
  globalThis.fetch = async () => {
    throw new Error('Offline verification attempted network access');
  };
  const empty = await mkdtemp(resolve(tmpdir(), 'veytrawl-model-'));
  try {
    await assert.rejects(
      new EmbeddingRanker({ localFilesOnly: true, cacheDir: empty }).rank('refund', [
        { id: 'a', text: 'Refund', score: 0 },
      ]),
      (error) => {
        assert.doesNotMatch(error.message, /attempted network/);
        return true;
      },
    );
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
}
const ranker = new EmbeddingRanker({ localFilesOnly: offline, maxCacheEntries: 1 });
const ranked = await ranker.rank('Where can I get my money back?', [
  { id: 'refund', text: 'Request a refund for your purchase', score: 0 },
  { id: 'search', text: 'Search the documentation', score: 0 },
  { id: 'profile', text: 'Change your profile picture', score: 0 },
]);
assert.equal(ranked[0].id, 'refund');
const concurrent = await Promise.all([
  ranker.rank('Change your profile picture', [
    { id: 'profile', text: 'Change your profile picture', score: 0 },
    { id: 'a', text: 'Search documentation', score: 0 },
  ]),
  ranker.rank('Change your profile picture', [
    { id: 'profile', text: 'Change your profile picture', score: 0 },
    { id: 'b', text: 'Request a refund', score: 0 },
  ]),
]);
assert.ok(
  concurrent.every(
    (result) =>
      result[0].id === 'profile' && result.every((candidate) => Number.isFinite(candidate.score)),
  ),
);
const browser = await launchBrowser(),
  web = new Veytrawl({ ranker });
try {
  const page = await browser.newPage();
  await page.setContent(
    '<button id="refund">Request a refund for your purchase</button><button>Search the documentation</button><button>Change your profile picture</button>',
  );
  const match = await web.locate(page, 'Where can I get my money back?');
  assert.equal(match.node.locator.htmlId, 'refund');
  console.log(
    JSON.stringify(
      {
        mode: 'real local CPU embeddings',
        ranked,
        locate: { id: match.node.locator.htmlId, via: match.via, confidence: match.confidence },
      },
      null,
      2,
    ),
  );
} finally {
  web.close();
  await browser.close();
}
