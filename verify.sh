#!/usr/bin/env bash
# rich-paste checks. VERIFY_TIER=fast (default) runs everything local and offline;
# VERIFY_TIER=full adds the kimi-k3 replay (QA10, needs KIMI_API_KEY, spends a little quota).
# lr-verify-route: local
# (needs this machine's Hermes install for `hermes plugins validate`)
set -euo pipefail
exec </dev/null

ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel)}"
cd "$ROOT"
TIER="${VERIFY_TIER:-fast}"
echo "== rich-paste verify (tier=$TIER, root=$ROOT)"

[ -d node_modules/turndown ] || npm ci --no-audit --no-fund

echo "== QA2 QA3 QA4 QA8: pytest (interleave, rp_cache, plugin_api routes)"
uv run --quiet --no-project --with 'pytest==9.*' --with fastapi --with httpx --with pillow --with 'resvg-py==0.5.0' python -m pytest tests -q -p no:cacheprovider

echo "== QA5 QA6 QA7 + SDK surface guard: node --test (convert snapshots, settings, markers, plugin glue, real SDK exports)"
node --test tests/desktop/

echo "== QA9: rebuilt desktop/plugin.js is byte-identical to the checked-in one"
SNAP="$(mktemp)"
trap 'rm -f "$SNAP"' EXIT
cp desktop/plugin.js "$SNAP"
npm run --silent build >/dev/null 2>&1
if ! cmp -s "$SNAP" desktop/plugin.js; then
  cp "$SNAP" desktop/plugin.js
  echo "FAIL QA9: desktop/plugin.js is stale; run npm run build and commit it" >&2
  exit 1
fi
echo "QA9 ok: desktop/plugin.js up to date ($(wc -c < desktop/plugin.js | tr -d ' ') bytes)"

echo "== QA1: hermes plugins validate . --install-deps"
VALIDATE_OUT="$(hermes plugins validate . --install-deps 2>&1 || true)"
printf '%s\n' "$VALIDATE_OUT" | grep -E '^(✓|✗|◆|  ·|Validation)' || true
printf '%s\n' "$VALIDATE_OUT" | grep -qx 'Validation passed.' || { echo "FAIL QA1: validate did not pass" >&2; exit 1; }
if printf '%s\n' "$VALIDATE_OUT" | grep -q '^✗'; then echo "FAIL QA1: validate reported a failure" >&2; exit 1; fi

echo "== QA10: replay experiment through the middleware"
if [ "$TIER" = "full" ]; then
  uv run --quiet --no-project --with pillow python bench/replay_experiment.py
else
  uv run --quiet --no-project --with pillow python bench/replay_experiment.py --dry-run
  echo "QA10 real run: full tier only"
fi

echo "== verify ok (tier=$TIER)"
