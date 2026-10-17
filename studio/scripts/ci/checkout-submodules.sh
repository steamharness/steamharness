#!/usr/bin/env bash
set -euo pipefail

: "${CI_SERVER_URL:?Run this script in GitLab CI.}"
: "${CI_JOB_TOKEN:?The CI job token is required.}"
studio_git_url="${CI_SERVER_URL/\/\//\/\/gitlab-ci-token:$CI_JOB_TOKEN@}/"
studio_git_options=()
studio_checkout_upstream=false
for studio_submodule in "$@"; do
  if [[ "$studio_submodule" == upstream/vscode ]]; then
    studio_checkout_upstream=true
    studio_upstream_commit="$(git rev-parse HEAD:upstream/vscode)"
    if [[ -d "${STUDIO_UPSTREAM_REPOSITORY_CACHE:-}/objects" ]] && \
      git --git-dir="$STUDIO_UPSTREAM_REPOSITORY_CACHE" cat-file -e "$studio_upstream_commit^{commit}" 2>/dev/null; then
      studio_git_options=(-c "submodule.upstream/vscode.url=$STUDIO_UPSTREAM_REPOSITORY_CACHE" -c protocol.file.allow=always)
      echo "Using cached VS Code source: $studio_upstream_commit"
    fi
  fi
done
git \
  -c "url.$studio_git_url.insteadOf=ssh://git@yuhe.space:7202/" \
  -c 'url.https://github.com/.insteadOf=git@github.com:' \
  "${studio_git_options[@]}" \
  submodule update --init --depth 1 -- "$@"

if [[ "$studio_checkout_upstream" == true && -n "${STUDIO_UPSTREAM_REPOSITORY_CACHE:-}" ]]; then
  if [[ ! -d "$STUDIO_UPSTREAM_REPOSITORY_CACHE/objects" ]]; then
    git clone --bare --no-local --depth 1 "$PWD/upstream/vscode" "$STUDIO_UPSTREAM_REPOSITORY_CACHE"
  fi
  git --git-dir="$STUDIO_UPSTREAM_REPOSITORY_CACHE" fetch --depth 1 "$PWD/upstream/vscode" +HEAD:refs/heads/studio-ci
  git --git-dir="$STUDIO_UPSTREAM_REPOSITORY_CACHE" symbolic-ref HEAD refs/heads/studio-ci
fi
