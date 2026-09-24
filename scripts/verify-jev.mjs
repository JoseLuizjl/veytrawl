import { statePath } from '../dist/packages/core/paths.js';
import assert from 'node:assert/strict';
import { JevProvider } from '../dist/packages/providers/jev/index.js';
import { Veytrawl, launchBrowser } from '../dist/packages/core/index.js';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
if (!process.env.TYPESAFE_API_KEY) {
  console.error(
    'Live Jev verification requires TYPESAFE_API_KEY in the environment. No request sent.',
  );
  process.exitCode = 2;
} else {
  const provider = new JevProvider();
  const result = await provider.choose('checkout button', [
    { id: 'purchase', text: 'button: Complete purchase', score: 0.9 },
    { id: 'search', text: 'button: Search documentation', score: 0.1 },
  ]);
  assert.equal(result?.id, 'purchase');
  console.log('Live Jev verification passed.');
  let browserVerified = false;
  if (process.argv.includes('--browser')) {
    if (existsSync(statePath('browsers')))
      process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve(statePath('browsers'));
    const browser = await launchBrowser(),
      web = new Veytrawl({ provider });
    try {
      const page = await browser.newPage();
      await page.setContent(
        '<button id="refund" onclick="document.body.dataset.clicked=\'refund\'">Request a refund</button><button>Search documentation</button>',
      );
      const match = await web.locate(page, 'Where can I get my money back?');
      assert.equal(match.via, 'provider');
      assert.equal(match.node.locator.htmlId, 'refund');
      await match.click();
      assert.equal(await page.getAttribute('body', 'data-clicked'), 'refund');
      browserVerified = true;
      console.log('Live Jev fallback resolved and clicked the refund button in Chromium.');
    } finally {
      web.close();
      await browser.close();
    }
  }
  await mkdir('artifacts/validation', { recursive: true });
  await writeFile(
    'artifacts/validation/jev.json',
    JSON.stringify(
      { at: new Date().toISOString(), liveInference: true, browserVerified, sampleDataOnly: true },
      null,
      2,
    ),
  );
}
