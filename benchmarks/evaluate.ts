import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { HttpFetcher, parseSemanticDOM } from '../packages/core/index.js';
import { score } from '../packages/dom/ranking.js';
const cases = [
  {
    id: 'typescript',
    url: 'https://www.typescriptlang.org/docs/handbook/2/generics.html',
    goal: 'generic constraints',
    target: 'generic-constraints',
  },
  {
    id: 'playwright',
    url: 'https://playwright.dev/docs/locators',
    goal: 'locate in shadow DOM',
    target: 'locate-in-shadow-dom',
  },
  { id: 'node', url: 'https://nodejs.org/api/fs.html', goal: 'readFile', target: 'readfile' },
  {
    id: 'mdn',
    url: 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Authentication',
    goal: 'basic authentication',
    target: 'basic',
  },
];
await mkdir('artifacts/corpus', { recursive: true });
const results = [];
for (const sample of cases) {
  try {
    const path = `artifacts/corpus/${sample.id}.html`;
    let html: string;
    if (process.argv.includes('--offline')) html = await readFile(path, 'utf8');
    else {
      const response = await new HttpFetcher({
        allowPrivateNetwork: true,
        maxBytes: 5000000,
      }).request(sample.url);
      if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
      html = response.text;
      await writeFile(path, html);
    }
    const doc = parseSemanticDOM(html, sample.url);
    const ranked = doc.nodes
      .filter((n) => n.href)
      .map((n) => ({
        text: n.name,
        url: n.href!,
        score: score(sample.goal, `${n.name} ${n.href}`),
      }))
      .sort((a, b) => b.score - a.score);
    const seen = new Set<string>();
    const unique = ranked.filter((n) => {
      if (seen.has(n.url)) return false;
      seen.add(n.url);
      return true;
    });
    const index = unique.findIndex((n) => n.url.toLowerCase().includes(sample.target));
    results.push({
      ...sample,
      sha256: createHash('sha256').update(html).digest('hex'),
      bytes: Buffer.byteLength(html),
      nodes: doc.nodes.length,
      expectedRank: index < 0 ? null : index + 1,
      hitAt5: index >= 0 && index < 5,
      top5: unique.slice(0, 5),
    });
  } catch (error) {
    results.push({ ...sample, error: String(error), hitAt5: false });
  }
}
const report = {
  at: new Date().toISOString(),
  method:
    'Fixed known-section link retrieval on four public documentation pages; not a general semantic-accuracy benchmark.',
  offline: process.argv.includes('--offline'),
  hitAt5: results.filter((r) => r.hitAt5).length / cases.length,
  results,
};
await writeFile('artifacts/corpus/report.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (report.hitAt5 < 1) process.exitCode = 1;
