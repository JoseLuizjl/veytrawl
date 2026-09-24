# Changelog

## 0.3.0-alpha.0 - unreleased

- Add bounded parallel discovery with 1 to 8 workers, shared request pacing, path-prefix filters, queue/score controls, and progress callbacks.
- Deduplicate candidate URLs before ranking and preserve origin, redirect, robots, depth, and page limits with parallel fetching.
- Interrupt pending custom fetchers, ranking providers, and decision providers when crawling is canceled.
- Add `history()` and `resetWatch()` to the SDK and `history` and `reset` CLI commands. History can be exported as JSON, RSS, or Atom without contacting the monitored page.
- Retain at most 1,000 events per watch by default; configure `watchStore.maxEvents` or `watch --max-events`. A value of zero keeps live change detection without stored history.
- Open Watch and selector databases only on first use. Close is idempotent, and closed SDK clients reject further operations.
- Reject command options that were previously silently ignored, including browser-only waits without browser rendering.
- Add a crawl benchmark, regression coverage, a manually dispatched OIDC publishing workflow gated by Windows, Linux, macOS, and Bun checks.

Existing Watch snapshots and selector caches remain compatible. Retention applies when each watch is next checked; it does not immediately prune unrelated watches. Strict CLI validation can require removing formerly ignored flags.

## 0.2.0-alpha.0 - 2026-09-23

First public npm release. Includes semantic snapshots, readable extraction, focused discovery, executable semantic selectors with recovery, persistent Watch baselines and feeds, optional CPU embeddings, optional Jev decisions, and network/privacy safeguards.
