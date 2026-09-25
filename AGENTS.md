# Repository guide

Veytrawl is a TypeScript SDK and CLI for semantic page extraction, focused crawling, interactive element lookup, and change monitoring. The minimum supported runtime is Node.js 24. Core workflows must work without an API key or embedding model.

## Code layout

- `packages/core`: SDK lifecycle, HTTP/browser loading, extraction, storage, privacy, and network policy.
- `packages/dom`: semantic snapshots, accessible names, structure, and ranking.
- `packages/crawler`: discovery budgets, robots rules, pacing, cancellation, and path filtering.
- `packages/selectors`: element resolution and selector caching.
- `packages/watch`: transactional baselines, differences, history, retention, and feeds.
- `packages/providers`: optional local ranking and remote decisions.
- `packages/cli`: command parsing, output, and diagnostics.
- `tests`: local fixtures and behavior/security regressions.
- `scripts`, `benchmarks`, and `examples`: verification, measurements, and runnable examples.

## Working on changes

Inspect the current branch, working tree, relevant implementation, and tests before editing. Preserve unrelated work. Keep changes small enough to review and use descriptive names, strict types, bounded inputs, and cancellation-aware asynchronous operations.

Keep code, identifiers, messages, and documentation in English. Source code is intentionally comment-free; describe public behavior in the README and release changes in the changelog. Preserve copyright and license notices.

Use exact dependency versions and update the lockfile together with the manifest. Keep Node type definitions aligned with Node 24. The source audit uses the TypeScript compiler API; changing the compiler version requires verifying that audit, not removing it.

## Commands and checks

```bash
npm ci --ignore-scripts
npx --no-install playwright install chromium
npm run check
npm run format:check
npm run verify:source
npm test
node --test scripts/verify-publishing.mjs
npm run verify:package
```

Run focused tests while developing, then the checks relevant to the final change. `npm run release:check` runs the local release gate. Hosted CI covers Node on Windows, Linux, and macOS, plus the supported Bun paths. Optional embedding and provider checks are separate; report whether they were actually exercised.

Formatting settings are in `package.json`. The format scripts target project sources explicitly so local research and generated files are not modified.

## Security and data handling

Keep the default private-network restrictions and Chromium sandbox enabled. Validate redirects and DNS results before requests. Custom fetchers are a documented trust boundary. Never weaken network policy, data redaction, resource budgets, or integrity checks to make a test pass.

Use synthetic data and explicitly permitted local servers in tests. Never use a person's database, browser profile, API key, or private page content as a fixture. Do not print credentials, authentication configuration, or private filesystem paths in logs or reports.

Remote providers are opt-in and may receive page content. Preserve that distinction in behavior and documentation. Retention and reset are logical deletion, not secure erasure.

## Git and package boundaries

Stage explicit files and review the staged diff. Local documentation, prompts, editor/agent configuration, legacy state, and generated reports do not belong in the public source. Keep local exclusions in `.git/info/exclude` when they are intentionally absent from the shared ignore file. `AGENTS.md` is the requested repository guide; it is not part of the npm package.

Do not commit `.npmrc`, `.prettierignore`, or `.prettierrc.json`. Source and package allowlists must reject local-only material even when it is force-added. Keep the npm archive limited to compiled runtime files, declarations, package metadata, README, changelog, and MIT license.

Follow repository pull-request rules and the user's authorized scope. Do not bypass checks, rewrite published tags, or republish an existing npm version. Keep manifest, lockfile, CLI version, and release notes consistent. Before a release, inspect the exact archive; afterward, verify public availability, integrity, provenance, and a clean installation. npm may take time to process an accepted publication, so retry verification within its bound rather than publishing the version again.
