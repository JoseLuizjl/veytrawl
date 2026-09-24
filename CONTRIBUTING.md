# Contributing

Use Node.js 24 or later and the committed npm lockfile. Install with `npm ci`; automatic dependency scripts are disabled by project configuration. Install Chromium explicitly with `npx --no-install playwright install chromium` when working on browser features.

Keep source code, identifiers, user-facing messages, and documentation in English. Code contains no comments; explain public behavior, security boundaries, and design tradeoffs in documentation. Keep the MIT license and third-party license notices intact. Prefer small modules with explicit responsibilities, descriptive names, strict TypeScript types, bounded inputs, and cancellation-aware asynchronous operations.

```bash
npm run format
npm run check
npm run verify:source
npm test
npm run verify:package
npm audit
```

Tests use local fixtures and explicitly opt into local-network access. Never point tests at a user's real database, credentials, or browser profile. Add regressions for behavioral changes and security boundaries. Do not add tests that simply repeat implementation details. Benchmarks should state their inputs and limitations and avoid recording usernames, absolute home paths, or hardware identifiers.

Never commit environment files, API keys, personal data, database files, dependency directories, generated reports, or archives. `.env.example` must contain empty placeholders only. The source check reports finding categories without printing values; it does not replace review. Optional live Jev verification requires a private environment credential and sends synthetic sample data. Offline embedding verification requires a cached model.

## Layout

- `packages/`: TypeScript SDK, CLI, parsers, fetchers, discovery, selectors, change tracking, and providers.
- `tests/`: local HTTP and browser fixtures, regressions, and security checks.
- `examples/`: runnable examples and a local browser demonstration.
- `benchmarks/`: extraction and ranking evaluations.
- `scripts/`: package checks, performance measurements, and release tooling.
- `.github/`: CI, dependency updates, and the publishing workflow.

Generated output belongs in ignored directories. Do not submit local planning documents, agent configuration, prompts, editor state, or model caches.

## Releases

`npm run release:check` checks a release without publishing it. Review the archive reported by `npm run verify:package`; it should contain compiled runtime files, TypeScript declarations, package metadata, the license, and the root project guides.

Keep the version in `package.json`, `package-lock.json`, and the CLI consistent. Update the changelog and distinguish released features from development features in the README. Run the Node.js platform matrix and Bun checks on the release commit.

For trusted publishing, configure the npm package's GitHub publisher with owner `JoseLuizjl`, repository `veytrawl`, workflow `publish.yml`, and environment `npm`. Create the matching GitHub environment and restrict it to release tags. Dispatch the publishing workflow on a `v<version>` tag only after all checks pass. The workflow publishes its verified archive with provenance; it never needs a repository-held npm token. After publication, verify the registry version and install the public package in a clean directory.
