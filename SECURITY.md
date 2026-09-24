# Security and privacy

Veytrawl is an alpha library and CLI, not a security sandbox. Use the latest verified release, review the content and destinations you process, and apply operating-system isolation when running untrusted sites. No dependency scan or automated test proves an absence of vulnerabilities.

## Report a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/JoseLuizjl/veytrawl/security/advisories/new) for security issues. Include the affected version, a minimal reproduction, and the impact. Do not include real credentials or private page content. Use public issues for ordinary bugs.

## Data handling

There is no application telemetry or analytics endpoint. Ordinary operation contacts the URLs you request and their browser resources, plus DNS infrastructure. Browser sites may run their own tracking code. Model downloads contact Hugging Face only when embeddings are enabled and files are needed. The optional Jev provider sends a goal and candidate text only when explicitly configured. Package installation, browser installation, and dependency audits also contact their respective services.

Passwords, raw form values, and editable text are excluded from default semantic snapshots. Explicit accessibility-tree extraction can expose additional page content. CLI errors redact the local home directory and common secret patterns. Provider input redacts common tokens, sensitive URL parameters, and email addresses. Redaction is best effort: names, arbitrary identifiers, unusual credentials, and sensitive ordinary text may remain. Review data before enabling remote inference or sharing output.

Snapshots, URLs, selector identities, Watch events, and exports intentionally retain useful page content and may contain personal information. SQLite data is not encrypted. In the 0.3 development version, event retention is bounded per watch and reset removes one watch identity. These are logical deletions, not secure erasure of database pages or backups. New database and export files use owner-only POSIX permissions; Windows uses inherited directory ACLs. Existing directory permissions are not rewritten. Store data in a private directory and protect backups. Source and npm allowlists exclude local state, credentials, generated reports, and source maps. `.env.example` must remain empty of credentials.

## Network and browser boundaries

HTTP(S) is required and embedded URL credentials are rejected. Private and reserved IP destinations are blocked by default, including IPv4-mapped IPv6. Every DNS answer must be public; the validated addresses are passed directly to the connection, and redirects are checked before fetching. Browser HTTP resources use the same guarded transport. WebSockets, service workers, downloads, and unsolicited popups are disabled in managed sessions. Time, response-size, request-count, and total-response budgets bound common resource abuse.

`allowPrivateNetwork: true` and `--allow-private-network` disable the public-network restriction. Use them only for trusted local or intranet targets, never with arbitrary untrusted input. Custom fetchers and caller-created Playwright pages are the caller's responsibility. Crawl origin, robots, and optional path rules restrict navigation; browser subresources may still contact other public origins.

The browser helper enables Chromium's sandbox by default. Keep it enabled. Run hostile websites as an unprivileged OS user in a disposable container or VM with outbound network rules, no host mounts, no credentials, and resource limits. Routing is an application-layer control, not a comprehensive firewall; browser-native protocols, browser defects, CPU exhaustion, and unknown vulnerabilities still require isolation. Fresh browser contexts do not use the user's normal browser profile. Resource routing may affect sites that require streaming, WebSockets, or service workers.

Provider decisions are restricted to supplied candidate IDs. Page text is untrusted evidence, never an instruction to execute shell commands. Locate returns a locator and does not automatically click. Consumers must authorize consequential actions themselves.

## Dependencies and release controls

The project uses the official HTTPS npm registry, TLS verification, exact direct dependency versions, a lockfile, and `ignore-scripts=true`. This setting prevents automatic install hooks; explicit verification commands still execute. An installed library cannot enforce npm settings in another project. Review dependency changes and use `npm ci --ignore-scripts` in consuming projects where practical.

Run `npm run release:check` before packaging or publishing. It checks formatting, source hygiene, tests, clean-package installation, and known dependency advisories. The content audit checks packed files, including compiled code, and fails without echoing detected secret values. This is a targeted guard, not an exhaustive malware or personal-data scanner. No install or postinstall hook is shipped. The package is built explicitly before packing because automatic lifecycle scripts are disabled.

Releases must pass the source, package, dependency, and test checks. The GitHub publishing workflow verifies the version tag and repository identity, runs platform checks, and requests npm provenance. It requires a configured npm trusted publisher and does not store a publishing token in the repository.

If a credential was exposed, revoke it at its provider and issue a new one. Removing a file does not revoke the credential or remove copies from logs, messages, backups, or repository history.
