#!/usr/bin/env bash
set -euo pipefail
task_root="$(cd "$(dirname "$0")/.." && pwd)"
task_runtime="$task_root/.veytrawl/linux-runtime"
if [ ! -x "$task_runtime/bin/node" ] && [ -x "$task_root/.semweb/linux-runtime/bin/node" ]; then
  task_runtime="$task_root/.semweb/linux-runtime"
fi
case "$(uname -m)" in x86_64) task_arch=x64 ;; aarch64) task_arch=arm64 ;; *) exit 2 ;; esac
task_version=v24.19.0
task_archive="node-$task_version-linux-$task_arch.tar.xz"
mkdir -p "$task_runtime"
if [ ! -x "$task_runtime/bin/node" ]; then
  curl --fail --location --max-time 120 "https://nodejs.org/dist/$task_version/$task_archive" -o "$task_runtime/$task_archive"
  curl --fail --location --max-time 30 "https://nodejs.org/dist/$task_version/SHASUMS256.txt" -o "$task_runtime/SHASUMS256.txt"
  task_expected="$(awk -v name="$task_archive" '$2 == name {print $1}' "$task_runtime/SHASUMS256.txt")"
  task_actual="$(sha256sum "$task_runtime/$task_archive" | cut -d ' ' -f 1)"
  [ ${#task_expected} -eq 64 ] && [ "$task_expected" = "$task_actual" ]
  tar -mxJf "$task_runtime/$task_archive" -C "$task_runtime" --strip-components=1 --no-same-owner --no-same-permissions "node-$task_version-linux-$task_arch/bin/node"
fi
cd "$task_root"
"$task_runtime/bin/node" --version
if [ "${1:-}" = "--browser" ]; then
  export PLAYWRIGHT_BROWSERS_PATH="$task_root/.veytrawl/browsers-linux"
  if [ ! -d "$PLAYWRIGHT_BROWSERS_PATH" ] && [ -d "$task_root/.semweb/browsers-linux" ]; then
    export PLAYWRIGHT_BROWSERS_PATH="$task_root/.semweb/browsers-linux"
  fi
  "$task_runtime/bin/node" node_modules/playwright/cli.js install chromium --only-shell
  "$task_runtime/bin/node" --test --test-concurrency=1 dist/tests/*.test.js
else
  "$task_runtime/bin/node" --test dist/tests/engine.test.js dist/tests/hardening.test.js
  "$task_runtime/bin/node" --test --test-name-pattern='CLI crawl|Jev adapter' dist/tests/cli-provider.test.js
fi
