import assert from 'node:assert/strict';
import test from 'node:test';
import { waitForPublication } from './lib/publication.mjs';

const url = 'https://registry.npmjs.org/example/1.0.0';
const metadata = { dist: { integrity: 'sha512-fixture' } };

test('publication verification waits through registry processing and transient failures', async () => {
  const statuses = [404, 503, 429, 200];
  const result = await waitForPublication(url, metadata.dist.integrity, {
    pollIntervalMs: 1,
    fetcher: async () => new Response(JSON.stringify(metadata), { status: statuses.shift() }),
  });
  assert.deepEqual(result, metadata);
  assert.equal(statuses.length, 0);
});

test('publication verification rejects a different archive', async () => {
  await assert.rejects(
    waitForPublication(url, 'sha512-other', {
      fetcher: async () => new Response(JSON.stringify(metadata)),
    }),
    /integrity mismatch/,
  );
});

test('publication verification fails immediately on authentication errors', async () => {
  let requests = 0;
  await assert.rejects(
    waitForPublication(url, metadata.dist.integrity, {
      fetcher: async () => {
        requests++;
        return new Response('', { status: 401 });
      },
    }),
    /HTTP 401/,
  );
  assert.equal(requests, 1);
});

test('publication verification bounds the wait without attempting another publication', async () => {
  await assert.rejects(
    waitForPublication(url, metadata.dist.integrity, {
      timeoutMs: 15,
      pollIntervalMs: 5,
      fetcher: async () => new Response('', { status: 404 }),
    }),
    /do not republish/,
  );
});
