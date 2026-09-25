# Changelog

## 1.0.1 - 2026-09-24

- Update Undici to 8.10.2 and upgrade the pinned checkout and Node setup actions.
- Keep npm and local formatter configuration out of the source repository; share formatting settings through package metadata.
- Consolidate contributor and security guidance in the README and add a repository-specific AGENTS.md.
- Exclude local-only folders through private Git exclusions and retain strict source/package allowlists.
- Wait for npm processing before verifying a newly accepted release.

## 1.0.0 - 2026-09-24

First stable release of the SDK and CLI. The changes below were developed after 0.2.0-alpha.0; no 0.3 alpha was published.

- Add bounded parallel discovery with 1 to 8 workers, shared request pacing, path-prefix filters, queue/score controls, and progress callbacks.
- Deduplicate candidate URLs before ranking and preserve origin, redirect, robots, depth, and page limits with parallel fetching.
- Interrupt pending custom fetchers, ranking providers, and decision providers when crawling is canceled.
- Add `history()` and `resetWatch()` to the SDK and `history` and `reset` CLI commands. History can be exported as JSON, RSS, or Atom without contacting the monitored page.
- Retain at most 1,000 events per watch by default; configure `watchStore.maxEvents` or `watch --max-events`. A value of zero keeps live change detection without stored history.
- Open Watch and selector databases only on first use. Close is idempotent, and closed SDK clients reject further operations.
- Reject command options that were previously silently ignored, including browser-only waits without browser rendering.
- Add a crawl benchmark, regression coverage, and a manually dispatched OIDC publishing workflow gated by Windows, Linux, macOS, and Bun checks.
- Remove demonstration GIFs and local documentation from the package; consolidate usage guidance in the README.
- Publish the source under the existing MIT license and enable private vulnerability reporting.

Existing Watch snapshots and selector caches remain compatible. Retention applies when each watch is next checked; it does not immediately prune unrelated watches. Strict CLI validation can require removing formerly ignored flags.

## 0.2.0-alpha.0 - 2026-09-23

First public npm release. Includes semantic snapshots, readable extraction, focused discovery, executable semantic selectors with recovery, persistent Watch baselines and feeds, optional CPU embeddings, optional Jev decisions, and network/privacy safeguards.
