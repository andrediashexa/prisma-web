#!/bin/sh
# Browser tests of the front end (issue #5), in the Playwright image, against
# the running compose stack with the mocks:
#
#   E2E_USER=admin E2E_PASSWORD=... scripts/ui-tests.sh [playwright args]
#
# Uses the host network to reach the proxy on 127.0.0.1 (UI_BASE overrides it).
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
: "${E2E_USER:?set E2E_USER (an administrator)}"
: "${E2E_PASSWORD:?set E2E_PASSWORD}"
exec docker run --rm --network host --ipc host \
  -e E2E_USER -e E2E_PASSWORD -e UI_BASE -e UI_MOCK_URL \
  -v "$ROOT/ui-tests:/w" -v prisma-web-ui-npm:/w/node_modules -w /w \
  mcr.microsoft.com/playwright:v1.55.0-noble \
  sh -c 'npm ci --no-audit --no-fund --silent && npx playwright test "$@"' sh "$@"
