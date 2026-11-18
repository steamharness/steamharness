#!/usr/bin/env bash
set -euo pipefail

: "${CI_PROJECT_DIR:?Full tests must run in GitLab CI.}"
[[ "$(uname -s)" == Linux ]]
cd "$CI_PROJECT_DIR"
rm -rf .studio/ci-results
mkdir -p .studio/ci-results
for studio_tool in xvfb-run dbus-run-session openbox; do
  command -v "$studio_tool" >/dev/null || { echo "Missing Linux test dependency: $studio_tool" >&2; exit 1; }
done
printf 'Runner: %s; architecture: %s; Node: %s\n' "${CI_RUNNER_DESCRIPTION:-unknown}" "$(uname -m)" "$(node --version)"

bash scripts/ci/checkout-submodules.sh upstream/vscode
npm ci --no-audit --no-fund
export STUDIO_STEAMHARNESS_SOURCE="$CI_PROJECT_DIR/.."
corepack pnpm --dir "$STUDIO_STEAMHARNESS_SOURCE" install --frozen-lockfile --store-dir "$STUDIO_PNPM_STORE_DIR"
corepack pnpm --dir "$STUDIO_STEAMHARNESS_SOURCE/harness" build
corepack pnpm --dir "$STUDIO_STEAMHARNESS_SOURCE/cli" build
for studio_project in examples/bot examples/workflow examples/kanban tests/fixtures/conversation-features; do
  corepack pnpm --dir "$studio_project" install --frozen-lockfile --store-dir "$STUDIO_PNPM_STORE_DIR"
done
npm run check 2>&1 | tee .studio/ci-results/check.log
studio_install_options="${NODE_OPTIONS:-} --max-old-space-size=768 --max-semi-space-size=16"
studio_install_options+=" --require=$CI_PROJECT_DIR/scripts/ci/limit-install.cjs"
for studio_attempt in 1 2 3; do
  studio_setup_log=".studio/ci-results/setup-attempt-$studio_attempt.log"
  if STUDIO_CI_DEFER_POSTINSTALL=1 NODE_OPTIONS="$studio_install_options" npm run setup 2>&1 | tee "$studio_setup_log"; then
    break
  fi
  if [[ "$studio_attempt" == 3 ]] || ! grep -Eq 'ETIMEDOUT|ECONNRESET|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|fetch failed' "$studio_setup_log"; then
    exit 1
  fi
  echo "Retrying Studio setup after a network failure ($studio_attempt/3)."
  sleep 5
done
NODE_OPTIONS="$studio_install_options" STUDIO_CI_SERIAL_BUILD=1 GOMAXPROCS=1 GOMEMLIMIT=512MiB \
  npm run build 2>&1 | tee .studio/ci-results/build.log
npm run electron 2>&1 | tee .studio/ci-results/electron.log
upstream/vscode/node_modules/.bin/playwright install chromium
export STEAMHARNESS_UI_CLI_ROOT="$STUDIO_STEAMHARNESS_SOURCE/cli"
export STEAMHARNESS_UI_BROWSER=chromium

xvfb-run --auto-servernum --server-args='-screen 0 1920x1080x24 -nolisten tcp' \
  dbus-run-session -- bash -c 'openbox > .studio/ci-results/openbox.log 2>&1 & studio_window_manager=$!; trap "kill $studio_window_manager 2>/dev/null || true" EXIT; node scripts/ci/run-ui-tests.mjs'
