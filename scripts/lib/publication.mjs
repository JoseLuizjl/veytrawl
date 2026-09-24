import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

export async function waitForPublication(url, integrity, options = {}) {
  const timeoutMs = options.timeoutMs ?? 600000;
  const pollIntervalMs = options.pollIntervalMs ?? 5000;
  const fetcher = options.fetcher ?? fetch;
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const remaining = Math.max(1, Math.ceil(deadline - performance.now()));
    const response = await fetcher(url, {
      signal: AbortSignal.timeout(Math.min(30000, remaining)),
      cache: 'no-store',
    });
    if (response.status === 200) {
      const metadata = await response.json();
      assert.equal(metadata.dist?.integrity, integrity, 'Published archive integrity mismatch.');
      return metadata;
    }
    await response.body?.cancel();
    assert.ok(
      [404, 429, 500, 502, 503, 504].includes(response.status),
      `Registry verification failed with HTTP ${response.status}.`,
    );
    const waitMs = Math.min(pollIntervalMs, deadline - performance.now());
    if (waitMs > 0) await delay(waitMs);
  }
  throw new Error(
    'npm accepted the publication, but registry verification timed out. Verify availability before retrying; do not republish the version.',
  );
}
