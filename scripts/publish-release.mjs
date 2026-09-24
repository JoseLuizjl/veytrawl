import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const project = JSON.parse(await readFile('package.json', 'utf8'));
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Use the manually dispatched publish workflow.');
assert.equal(
  process.env.GITHUB_REF,
  `refs/tags/v${project.version}`,
  'Release tag must match package.json.',
);
assert.equal(
  project.repository?.url,
  `git+https://github.com/${process.env.GITHUB_REPOSITORY}.git`,
  'Configure the public source repository in package.json.',
);
assert.ok(process.env.npm_execpath, 'Run through npm run release:publish.');
const report = JSON.parse(await readFile('artifacts/package-checks/report.json', 'utf8'));
assert.equal(report.passed, true);
assert.equal(report.version, project.version);
const artifact = resolve(report.artifact),
  location = relative(resolve('artifacts/package-checks'), artifact);
assert.ok(
  !isAbsolute(location) && !location.startsWith('..'),
  'Verified archive must be inside package-checks.',
);
const tag = project.version.includes('-alpha.')
  ? 'alpha'
  : project.version.includes('-')
    ? 'next'
    : 'latest';
const npmVersion = spawnSync(process.execPath, [process.env.npm_execpath, '--version'], {
  encoding: 'utf8',
});
assert.equal(npmVersion.status, 0);
const [major, minor, patch] = npmVersion.stdout.trim().split('.').map(Number);
assert.ok(
  major > 11 || (major === 11 && (minor > 5 || (minor === 5 && patch >= 1))),
  'npm 11.5.1 or later is required for OIDC.',
);
const published = spawnSync(
  process.execPath,
  [
    process.env.npm_execpath,
    'publish',
    artifact,
    '--ignore-scripts',
    '--access=public',
    `--tag=${tag}`,
    '--provenance',
    '--registry=https://registry.npmjs.org/',
  ],
  { stdio: 'inherit' },
);
assert.equal(published.status, 0, 'npm publication failed.');
const response = await fetch(`https://registry.npmjs.org/${project.name}/${project.version}`, {
  signal: AbortSignal.timeout(30000),
});
assert.equal(response.status, 200);
const metadata = await response.json();
assert.equal(
  metadata.dist.integrity,
  'sha512-' +
    createHash('sha512')
      .update(await readFile(artifact))
      .digest('base64'),
);
console.log(`Verified ${project.name}@${project.version} with tag ${tag}.`);
