import { test } from './test.js';
import assert from 'node:assert/strict';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, stat, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { TypeSafeClient } from '@typesafe-ai/sdk';
import { HttpFetcher, PlaywrightFetcher, launchBrowser, Veytrawl } from '../packages/core/index.js';
import { assertNetworkTarget, isPublicAddress, publicLookup } from '../packages/core/network.js';
import { redactSensitiveText, safeError } from '../packages/core/privacy.js';
import { statePath } from '../packages/core/paths.js';
import { JevProvider } from '../packages/providers/jev/index.js';
import { fixture } from './fixture.js';
if (existsSync(statePath('browsers')))
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve(statePath('browsers'));
const exec = promisify(execFile);
test('network policy rejects private, reserved, encoded, and mapped addresses', () => {
  for (const address of [
    '127.0.0.1',
    '0.0.0.0',
    '10.2.3.4',
    '172.16.1.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '224.0.0.1',
    '192.0.2.1',
    '::1',
    '::',
    'fc00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '2001:db8::1',
  ])
    assert.equal(isPublicAddress(address), false, address);
  for (const address of ['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111'])
    assert.equal(isPublicAddress(address), true, address);
  for (const host of [
    '127.1',
    '2130706433',
    '0x7f000001',
    'localhost.',
    'service.local',
    '[::ffff:127.0.0.1]',
  ])
    assert.throws(() => assertNetworkTarget(`http://${host}/`), /blocked/);
  for (const url of ['file:///private', 'ftp://example.com', 'https://name:password@example.com'])
    assert.throws(() => assertNetworkTarget(url, true), /Only HTTP/);
  assert.equal(assertNetworkTarget('https://example.com').hostname, 'example.com');
});
test('DNS lookup refuses localhost results before connecting', async () => {
  await assert.rejects(
    new Promise((resolve, reject) =>
      publicLookup('localhost', { all: true }, (error, addresses) =>
        error ? reject(error) : resolve(addresses),
      ),
    ),
    /private or reserved/,
  );
});
test('HTTP and default SDK deny local requests unless explicitly trusted', async () => {
  const site = await fixture(),
    web = new Veytrawl();
  try {
    await assert.rejects(new HttpFetcher().load(site.url), /blocked/);
    await assert.rejects(web.extract({ url: site.url }), /blocked/);
    assert.equal(site.requests.length, 0);
    assert.ok((await new HttpFetcher({ allowPrivateNetwork: true }).load(site.url)).nodes.length);
    await assert.rejects(
      new HttpFetcher({ allowPrivateNetwork: true, maxBytes: 32 }).load(site.url),
      /exceeds/,
    );
  } finally {
    web.close();
    await site.close();
  }
});
test('managed browser restricts local targets, permits explicit trust, and bounds responses', async () => {
  const browser = await launchBrowser(),
    site = await fixture();
  try {
    await assert.rejects(new PlaywrightFetcher(browser).load(site.url), /blocked/);
    assert.equal(site.requests.length, 0);
    const session = await new PlaywrightFetcher(browser, { allowPrivateNetwork: true }).open(
      `${site.url}/shop`,
    );
    try {
      await session.page.getByRole('button', { name: 'Complete purchase' }).click();
      session.check();
      assert.equal(await session.page.locator('#status').innerText(), 'Order completed');
    } finally {
      await session.close();
    }
    await assert.rejects(
      new PlaywrightFetcher(browser, { allowPrivateNetwork: true, maxBytes: 32 }).load(site.url),
      /exceeds/,
    );
    await assert.rejects(
      new PlaywrightFetcher(browser, { allowPrivateNetwork: true, maxTotalBytes: 32 }).load(
        site.url,
      ),
      /budget exceeded/,
    );
    assert.equal(browser.contexts().length, 0);
  } finally {
    await browser.close();
    await site.close();
  }
});
test('redaction suppresses secrets, home paths, URL credentials, and email addresses', () => {
  const token = 'api' + 'key_' + 'a'.repeat(70),
    email = 'person' + '@' + 'private-mail.test';
  const message = safeError(
    new Error(
      `${homedir()} ${token} ${email} https://example.com/?token=private-value#private-fragment`,
    ),
  );
  for (const secret of [homedir(), token, email, 'private-value', 'private-fragment'])
    assert.ok(!message.includes(secret));
  assert.match(message, /\[HOME\]/);
  assert.equal(redactSensitiveText('Bearer example-value'), 'Bearer [REDACTED]');
  assert.match(
    redactSensitiveText('https://example.com/?topic=documentation'),
    /topic=documentation/,
  );
});
test('Jev transport receives bounded redacted content and preserves candidate IDs', async () => {
  const token = 'api' + 'key_' + 'b'.repeat(70),
    email = 'person' + '@' + 'private-mail.test';
  let payload = '';
  const client = new TypeSafeClient({
    apiKey: 'test-not-a-real-key',
    fetch: async (_url, init) => {
      payload = String(init?.body);
      return new Response(
        JSON.stringify({
          model: 'jev-latest',
          answers: {
            candidate: {
              type: 'choice',
              choice: 'n1',
              confidence: 1,
              probabilities: { n1: 1, none: 0 },
            },
          },
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    },
  });
  const answer = await new JevProvider(client).choose(
    `Find ${token} ${email} ${'x'.repeat(3000)}`,
    [{ id: 'n1', text: `${token} ${email} ${'y'.repeat(2000)}`, score: 1 }],
  );
  assert.equal(answer?.id, 'n1');
  assert.ok(!payload.includes(token));
  assert.ok(!payload.includes(email));
  const state = JSON.parse(payload).state;
  assert.ok(state.goal.length <= 2000);
  assert.ok(state.candidates[0].text.length <= 1500);
});
test('CLI rejects private targets without printing URL secrets', async () => {
  const site = await fixture();
  try {
    const failure = await exec(
      process.execPath,
      ['dist/packages/cli/index.js', 'dom', `${site.url}/?token=private-value`],
      { timeout: 30000, windowsHide: true },
    ).then(
      () => undefined,
      (error) => error,
    );
    assert.ok(failure);
    assert.match(failure.stderr, /blocked/);
    assert.ok(!failure.stderr.includes('private-value'));
    assert.equal(site.requests.length, 0);
  } finally {
    await site.close();
  }
});
test('new databases and CLI exports have owner-only POSIX permissions', async () => {
  if (process.platform === 'win32') return;
  const directory = await mkdtemp(join(tmpdir(), 'veytrawl-permissions-')),
    site = await fixture();
  try {
    const storage = join(directory, 'private', 'watch.sqlite'),
      web = new Veytrawl({ storage, allowPrivateNetwork: true });
    try {
      await assert.rejects(stat(storage), { code: 'ENOENT' });
      await web.watch({ url: site.url, watchFor: 'all' });
      for (const path of [storage, storage + '-wal', storage + '-shm'])
        assert.equal((await stat(path)).mode & 0o777, 0o600);
      assert.equal((await stat(join(directory, 'private'))).mode & 0o777, 0o700);
    } finally {
      web.close();
    }
    const output = join(directory, 'exports', 'page.json');
    await exec(
      process.execPath,
      [
        'dist/packages/cli/index.js',
        'dom',
        site.url,
        '--allow-private-network',
        '--output',
        output,
      ],
      { timeout: 30000 },
    );
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    assert.equal((await stat(join(directory, 'exports'))).mode & 0o777, 0o700);
  } finally {
    await site.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('SDK transport preserves native fetch redirect handling for other libraries', async () => {
  const site = await fixture();
  try {
    const response = await fetch(`${site.url}/redirect`);
    assert.equal(response.status, 200);
    assert.equal(new URL(response.url).pathname, '/private');
    await response.body?.cancel();
  } finally {
    await site.close();
  }
});
