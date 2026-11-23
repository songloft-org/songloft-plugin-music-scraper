#!/usr/bin/env bash
set -euo pipefail

pnpm install --frozen-lockfile --package-import-method=copy

# The published Linux compiler needs its executable bit restored after install.
jsc="$(find node_modules/.pnpm -path '*/node_modules/@songloft/jsc-linux-x64/bin/jsc' -print -quit)"
test -f "$jsc"
chmod u+x "$jsc"

pnpm typecheck
pnpm build
pnpm validate

package=dist/music-scraper.jsplugin.zip
unzip -tq "$package"
unzip -Z1 "$package" | awk '$0 == "main.jsc" { found=1 } END { exit !found }'
