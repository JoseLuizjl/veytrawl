import { assertPublicContent, assertPackagePath } from './lib/content-audit.mjs';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const exec = promisify(execFile);
const root = resolve('.'),
  npm = process.env.npm_execpath;
if (!npm) throw new Error('Run this check with npm run verify:package');
await mkdir('artifacts/package-checks', { recursive: true });
const directory = await mkdtemp(resolve('artifacts/package-checks/run-'));
const runNpm = (args) =>
  exec(process.execPath, [npm, ...args], { cwd: directory, timeout: 120000, windowsHide: true });
const packed = await exec(
  process.execPath,
  [npm, 'pack', '--ignore-scripts', '--json', '--pack-destination', directory],
  { cwd: root, timeout: 30000, windowsHide: true },
);
const packResult = JSON.parse(packed.stdout);
const manifest = Array.isArray(packResult) ? packResult[0] : packResult.veytrawl;
assert.ok(manifest?.files, 'npm pack did not return the package manifest');
for (const file of manifest.files) {
  assertPackagePath(file.path);
  assertPublicContent(file.path, await readFile(join(root, file.path)));
}
assert.ok(manifest.files.some((f) => f.path === 'dist/packages/core/index.d.ts'));
assert.ok(
  manifest.files.every(
    (f) => !/(^|\/)(?:\.env|\.veytrawl|\.semweb|tests|artifacts|node_modules)(?:\/|$)/.test(f.path),
  ),
);
const project = JSON.parse(await readFile('package.json', 'utf8'));
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
const tarball = `file:./${manifest.filename}`;
const consumer = {
  name: 'veytrawl-package-check',
  version: '0.0.0',
  private: true,
  type: 'module',
  dependencies: { veytrawl: tarball },
};
lock.name = consumer.name;
lock.version = consumer.version;
lock.packages[''] = consumer;
lock.packages['node_modules/veytrawl'] = {
  version: project.version,
  resolved: tarball,
  integrity: manifest.integrity,
  dependencies: project.dependencies,
  optionalDependencies: project.optionalDependencies,
  bin: project.bin,
  engines: project.engines,
};
await writeFile(join(directory, 'package.json'), JSON.stringify(consumer));
await writeFile(join(directory, 'package-lock.json'), JSON.stringify(lock));
await runNpm([
  'ci',
  '--offline',
  '--ignore-scripts',
  '--omit=optional',
  '--omit=dev',
  '--no-audit',
  '--no-fund',
]);
const installed = createRequire(
  pathToFileURL(join(directory, 'node_modules/veytrawl/dist/packages/core/index.js')),
);
for (const dependency of Object.keys(project.dependencies))
  assert.ok(
    installed
      .resolve(dependency)
      .startsWith(join(directory, 'node_modules') + (process.platform === 'win32' ? '\\' : '/')),
    `${dependency} must resolve from the clean install`,
  );
await writeFile(
  join(directory, 'smoke.mjs'),
  `
import assert from 'node:assert/strict';
import { Veytrawl, parseSemanticDOM, extractDocument, renderExtract } from 'veytrawl';
import { parseSemanticDOM as parseDOM } from 'veytrawl/dom';
import { JevProvider } from 'veytrawl/providers/jev';
assert.equal(typeof JevProvider, 'function');
assert.equal(parseDOM, parseSemanticDOM);
const extracted = extractDocument(parseDOM('<a href="/docs">Docs</a>', 'https://example.com'), { role: 'link' });
assert.equal(extracted.items[0].href, 'https://example.com/docs');
assert.match(renderExtract(extracted), /Docs/);
let price = 10;
const web = new Veytrawl({ storage: 'smoke.sqlite', fetcher: { load: async url => parseSemanticDOM('<p>$' + price + '</p>', url) } });
try {
  const options = { url: 'https://example.com', watchFor: 'pricing' };
  assert.equal((await web.extract({url: options.url, role: 'price'})).items[0].text, '$10');
  assert.equal((await web.watch(options)).baseline, true);
  price = 15;
  assert.equal((await web.watch(options)).events[0].after, '$15');
  assert.match(web.feed(options), /pricing-change/);
  assert.equal(web.history(options)[0].after, '$15');
  assert.equal((await web.resetWatch(options)).eventsRemoved, 1);
  assert.equal((await web.watch(options)).baseline, true);
} finally { web.close(); }
console.log('Installed SDK exports and SQLite Watch passed without optional dependencies.');
`,
);
for (const file of manifest.files)
  assertPublicContent(
    file.path,
    await readFile(join(directory, 'node_modules/veytrawl', file.path)),
  );
const smoke = await exec(process.execPath, ['smoke.mjs'], {
  cwd: directory,
  timeout: 30000,
  windowsHide: true,
});
const cli = await exec(
  process.execPath,
  ['node_modules/veytrawl/dist/packages/cli/index.js', '--version'],
  { cwd: directory, timeout: 30000, windowsHide: true },
);
assert.equal(cli.stdout.trim(), JSON.parse(await readFile('package.json', 'utf8')).version);
const help = await exec(
  process.execPath,
  ['node_modules/veytrawl/dist/packages/cli/index.js', '--help'],
  { cwd: directory, timeout: 30000, windowsHide: true },
);
assert.match(help.stdout, /Veytrawl/);
assert.match(help.stdout, /veytrawl extract/);
assert.equal(project.bin.veytrawl, './dist/packages/cli/index.js');
assert.ok(!project.bin.semweb);
await writeFile(
  join(directory, 'consumer.ts'),
  `import { Veytrawl, extractDocument, renderExtract, type ExtractOptions, type DiscoverOptions } from 'veytrawl';\nimport { parseSemanticDOM } from 'veytrawl/dom';\nimport { JevProvider } from 'veytrawl/providers/jev';\nconst options: DiscoverOptions = {start: 'https://example.com', goal: 'docs', concurrency: 2, includePaths: ['/docs/'], onProgress: progress => {void progress.queued;}};\nconst web = new Veytrawl({watchStore: {maxEvents: 100}}); web.history({url: 'https://example.com', watchFor: 'all', limit: 5, offset: 0}); void web.resetWatch({url: 'https://example.com', watchFor: 'all'}); web.close(); void options; void parseSemanticDOM; void JevProvider; const extraction: ExtractOptions = {role: "link"}; void extraction; void extractDocument; void renderExtract;\n`,
);
await exec(
  process.execPath,
  [
    resolve('node_modules/typescript/bin/tsc'),
    '--noEmit',
    '--strict',
    '--skipLibCheck',
    '--target',
    'ES2023',
    '--module',
    'NodeNext',
    '--moduleResolution',
    'NodeNext',
    'consumer.ts',
  ],
  { cwd: directory, timeout: 30000, windowsHide: true },
);
const report = {
  at: new Date().toISOString(),
  version: cli.stdout.trim(),
  artifact: relative(root, join(directory, manifest.filename)),
  files: manifest.files.length,
  checks: [
    'package allowlist and credential/privacy audit',
    'offline clean install without optional dependencies',
    'SDK exports',
    'Extraction SDK and rendering',
    'SQLite Watch, retained history, and reset',
    'CLI version',
    'consumer TypeScript declarations',
  ],
  passed: true,
};
await writeFile('artifacts/package-checks/report.json', JSON.stringify(report, null, 2));
console.log(smoke.stdout.trim());
console.log(JSON.stringify(report, null, 2));
