#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != Linux ]]; then
  echo "Studio CI requires the Linux runner." >&2
  return 1 2>/dev/null || exit 1
fi

studio_ci_root="${CI_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
studio_node_version="$(tr -d '[:space:]' < "$studio_ci_root/.nvmrc")"
studio_cache="${STUDIO_CI_CACHE_DIR:-$HOME/.cache/workflow-studio/${CI_PROJECT_ID:-local}}"
case "$(uname -m)" in
  x86_64) studio_node_arch=x64 ;;
  aarch64) studio_node_arch=arm64 ;;
  *) echo "Unsupported Linux architecture." >&2; return 1 2>/dev/null || exit 1 ;;
esac
studio_node_name="node-v$studio_node_version-linux-$studio_node_arch"
studio_node_dir="$studio_cache/$studio_node_name"
mkdir -p "$studio_cache"

if [[ ! -x "$studio_node_dir/bin/node" ]]; then
  studio_download="$(mktemp -d "$studio_cache/node-download.XXXXXX")"
  studio_archive="$studio_node_name.tar.xz"
  curl --fail --location --retry 3 --retry-all-errors --connect-timeout 15 --max-time 300 \
    "https://nodejs.org/dist/v$studio_node_version/$studio_archive" -o "$studio_download/$studio_archive"
  curl --fail --location --retry 3 --retry-all-errors --connect-timeout 15 --max-time 60 \
    "https://nodejs.org/dist/v$studio_node_version/SHASUMS256.txt" -o "$studio_download/SHASUMS256.txt"
  (cd "$studio_download" && awk -v archive="$studio_archive" '$2 == archive { print }' SHASUMS256.txt | sha256sum --check --status)
  tar -xJf "$studio_download/$studio_archive" -C "$studio_cache"
  rm -rf "$studio_download"
fi

export PATH="$studio_node_dir/bin:$PATH"
export npm_config_cache="$studio_cache/npm"
export npm_config_jobs=1
export npm_config_ensure=true
export npm_config_prefer_offline=true
export npm_config_fetch_retries=4
export npm_config_fetch_retry_mintimeout=1000
export npm_config_fetch_retry_maxtimeout=10000
export npm_config_fetch_timeout=120000
export npm_config_foreground_scripts=true
export COREPACK_HOME="$studio_cache/corepack"
export PNPM_HOME="$studio_cache/pnpm-bin"
export PLAYWRIGHT_BROWSERS_PATH="$studio_cache/playwright"
export STUDIO_PNPM_STORE_DIR="$studio_cache/pnpm-store"
export STUDIO_ELECTRON_CACHE_DIR="$studio_cache/electron"
export STUDIO_UPSTREAM_REPOSITORY_CACHE="$studio_cache/upstream.git"
mkdir -p "$PNPM_HOME" "$COREPACK_HOME"
corepack enable --install-directory "$PNPM_HOME"
corepack prepare pnpm@10.15.1 --activate
export PATH="$PNPM_HOME:$PATH"
test "$(node --version)" = "v$studio_node_version"
node --version
npm --version
corepack pnpm --version
