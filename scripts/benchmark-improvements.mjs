import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { performance } from 'node:perf_hooks';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { parseSemanticDOM, semanticDiff } from '../dist/packages/core/index.js';
import { fixture } from '../dist/tests/fixture.js';
const exec = promisify(execFile),
  site = await fixture(),
  results = [];
await mkdir('artifacts/improvements', { recursive: true });
try {
  for (const [name, args] of [
    ['version', ['--version']],
    ['dom', ['dom', site.url]],
  ]) {
    const samples = [];
    for (let i = 0; i < 8; i++) {
      const start = performance.now();
      const out = await exec(
        process.execPath,
        ['dist/packages/cli/index.js', '--allow-private-network', ...args],
        { windowsHide: true },
      );
      samples.push(performance.now() - start);
      if (name === 'dom') assert.ok(JSON.parse(out.stdout).nodes.length);
      else assert.equal(out.stdout.trim(), '0.3.0-alpha.0');
    }
    results.push({ name, samples, median: [...samples].sort((a, b) => a - b)[3] });
  }
  const doc = parseSemanticDOM(
    '<main><h1>Catalog</h1>' +
      Array.from({ length: 4000 }, (_, i) => '<p>Item ' + i + '</p>').join('') +
      '</main>',
    'https://example.com',
  );
  const samples = [];
  for (let i = 0; i < 10; i++) {
    const start = performance.now();
    const events = semanticDiff(doc, doc, 'all');
    samples.push(performance.now() - start);
    assert.deepEqual(events, []);
  }
  results.push({
    name: 'diff4000SameEntity',
    samples,
    median: [...samples].sort((a, b) => a - b)[4],
  });
  await writeFile('artifacts/improvements/after.json', JSON.stringify(results, null, 2));
  let before;
  try {
    before = JSON.parse(await readFile('artifacts/improvements/before.json', 'utf8'));
  } catch {}
  const comparisons = results.map((result) => {
    const original = before?.find((row) => row.name === result.name);
    return {
      name: result.name,
      beforeMedianMs: original?.median,
      afterMedianMs: result.median,
      speedup: original ? original.median / result.median : undefined,
    };
  });
  const report = {
    at: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    methodology:
      'Same sequential workloads before/after; 8 fresh-process samples per CLI operation, 10 diff samples. No warmup. Lower median. OS caches and machine load are uncontrolled. Synthetic shared-entity diff, not a universal speed claim.',
    comparisons,
  };
  await writeFile('artifacts/improvements/comparison.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await site.close();
}
