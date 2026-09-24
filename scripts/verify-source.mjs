import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import ts from 'typescript';
import {
  assertPublicContent,
  contentFindings,
  assertPackagePath,
  assertSourcePath,
} from './lib/content-audit.mjs';
const ignored = new Set([
  'docs',
  'node_modules',
  'dist',
  'artifacts',
  '.veytrawl',
  '.semweb',
  '.git',
  '.agents',
  '.codex',
  'test-results',
  '__pycache__',
  '%SystemDrive%',
]);
const files = [];
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (
      ignored.has(entry.name) ||
      entry.name === '.env' ||
      (entry.name.startsWith('.env.') && entry.name !== '.env.example')
    )
      continue;
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink())
      throw new Error(`Unexpected source symlink: ${relative('.', path)}`);
    if (entry.isDirectory()) await walk(path);
    else if (!/\.(?:sqlite(?:-wal|-shm)?|tgz|log)$/i.test(entry.name)) files.push(path);
  }
}
assert.ok(contentFindings('api' + 'key_' + 'a'.repeat(70)).includes('credential'));
assert.ok(contentFindings('person' + '@' + 'private-mail.test').includes('unredacted email'));
assert.throws(() => assertPackagePath('.env.production'));
assert.throws(() => assertPackagePath('dist/packages/core/index.js.map'));
for (const path of [
  'docs/guide.md',
  '.codex/config.toml',
  '.agents/notes.md',
  'prompts/task.md',
  'artifacts/report.json',
]) {
  assert.throws(() => assertPackagePath(path));
  assert.throws(() => assertSourcePath(path));
}
if (existsSync('.git')) {
  const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', windowsHide: true });
  for (const path of tracked.split('\0').filter(Boolean)) assertSourcePath(path);
}
await walk('.');
let codeFiles = 0;
for (const path of files) {
  assertSourcePath(relative('.', path).replaceAll('\\', '/'));
  const bytes = await readFile(path);
  if (path.endsWith('.sh')) assert.ok(!bytes.includes(13), 'Shell scripts require LF line endings');
  assertPublicContent(relative('.', path), bytes);
  if (/\.(?:ts|mjs|js)$/.test(path)) {
    const source = ts.createSourceFile(
      path,
      bytes.toString('utf8'),
      ts.ScriptTarget.Latest,
      true,
      /\.ts$/.test(path) ? ts.ScriptKind.TS : ts.ScriptKind.JS,
    );
    const withComments = ts.createPrinter({ removeComments: false }).printFile(source);
    const withoutComments = ts.createPrinter({ removeComments: true }).printFile(source);
    if (withComments !== withoutComments)
      throw new Error(`Code comments found in ${relative('.', path)}`);
    codeFiles++;
  }
}
const example = await readFile('.env.example', 'utf8');
assert.match(example, /^TYPESAFE_API_KEY=\s*$/);
const project = JSON.parse(await readFile('package.json', 'utf8'));
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
assert.equal(lock.version, project.version, 'Lockfile version mismatch');
assert.equal(lock.packages[''].version, project.version, 'Root package version mismatch');
const cli = await readFile('packages/cli/index.ts', 'utf8');
assert.ok(cli.includes("console.log('" + project.version + "')"), 'CLI version mismatch');
for (const hook of [
  'preinstall',
  'install',
  'postinstall',
  'prepare',
  'prepack',
  'prepublish',
  'prepublishOnly',
])
  assert.ok(!project.scripts?.[hook], `Unexpected lifecycle hook: ${hook}`);
for (const section of ['dependencies', 'devDependencies', 'optionalDependencies'])
  for (const version of Object.values(project[section] ?? {}))
    assert.match(
      version,
      /^\d+\.\d+\.\d+(?:-[\w.]+)?$/,
      'Direct dependency must use an exact version',
    );
const npmrc = await readFile('.npmrc', 'utf8');
for (const setting of [
  'registry=https://registry.npmjs.org/',
  'strict-ssl=true',
  'ignore-scripts=true',
  'save-exact=true',
])
  assert.ok(npmrc.split(/\r?\n/).includes(setting), `Missing npm setting: ${setting}`);
console.log(
  JSON.stringify(
    {
      sourceFiles: files.length,
      commentFreeCodeFiles: codeFiles,
      credentialAndPrivacyChecks: 'passed',
      npmProjectConfiguration: 'passed',
    },
    null,
    2,
  ),
);
