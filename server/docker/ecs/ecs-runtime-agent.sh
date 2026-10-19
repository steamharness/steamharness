#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${STEAMHARNESS_REMOTE_ROOT:-/srv/steamharness-release}"
COMPOSE_DIR="$ROOT/compose"
COMPOSE_FILE="$COMPOSE_DIR/docker-compose.yml"
ENV_FILE="$ROOT/.env"
AGENT_DIR="$ROOT/bin"
RUNTIME_DIR="$ROOT/runtime"

log() { printf '[ecs-agent] %s\n' "$*"; }
die() { printf '[ecs-agent] ERROR: %s\n' "$*" >&2; exit 1; }

compose() {
  local -a args=(compose --project-name steamharness-ecs --file "$COMPOSE_FILE")
  [[ -f "$ENV_FILE" ]] && args+=(--env-file "$ENV_FILE")
  docker "${args[@]}" "$@"
}

require_root() {
  [[ -d "$ROOT" ]] || die "runtime root does not exist: $ROOT"
  [[ -f "$COMPOSE_FILE" ]] || die "Compose file does not exist: $COMPOSE_FILE"
}

ensure_docker() {
  if ! systemctl is-active --quiet docker; then
    systemctl start docker
  fi
  for _ in {1..30}; do docker info >/dev/null 2>&1 && return 0; sleep 1; done
  die "Docker daemon did not become ready"
}

install_units() {
  local node_bin="${STEAMHARNESS_NODE_BIN:-$(command -v node || true)}"
  [[ -x "$node_bin" ]] || die "Node.js is required on ECS; set STEAMHARNESS_NODE_BIN to an absolute path"
  mkdir -p /etc/systemd/system "$RUNTIME_DIR" "$ROOT/nginx/logs" "$ROOT/certs" "$ROOT/acme"
  mkdir -p "$ROOT/server-data/stable" "$ROOT/server-data/alpha"
  mkdir -p "$ROOT/published/web/alpha"
  for unit in steamharness-server-stable steamharness-server-alpha steamharness-docs steamharness-web-alpha; do
    sed -e "s#__ROOT__#$ROOT#g" -e "s#__NODE_BIN__#$node_bin#g" \
      "$COMPOSE_DIR/$unit.service" > "/etc/systemd/system/$unit.service"
  done
  systemctl disable --now nginx.service 2>/dev/null || true
  systemctl daemon-reload
  systemctl enable steamharness-server-stable steamharness-server-alpha steamharness-docs steamharness-web-alpha
}

select_nginx_config() {
  mkdir -p "$ROOT/nginx"
  cp "$COMPOSE_DIR/proxy_params" "$ROOT/nginx/proxy_params"
  if [[ -s "$ROOT/certs/live/steamharness.yuhe.space/fullchain.pem" && -s "$ROOT/certs/live/steamharness.yuhe.space/privkey.pem" ]]; then
    cp "$COMPOSE_DIR/nginx-https.conf" "$ROOT/nginx/nginx.conf"
    log "HTTPS Nginx configuration selected"
  else
    cp "$COMPOSE_DIR/nginx-http.conf" "$ROOT/nginx/nginx.conf"
    log "HTTP-only Nginx configuration selected until certificates are installed"
  fi
}

bootstrap() {
  mkdir -p "$ROOT" "$COMPOSE_DIR" "$RUNTIME_DIR" "$ROOT/incoming" "$ROOT/nginx/logs" "$ROOT/certs" "$ROOT/acme"
  require_root
  install_units
  select_nginx_config
  ensure_docker
  compose config --quiet
  reload_nginx_config
  log "ECS runtime bootstrap completed"
}

# `select_nginx_config` only replaces the file the container mounts. A running
# nginx keeps serving whatever it loaded, so a hostname added to the config does
# not answer until something reloads it — and the failure that produces is the
# ACME challenge for a new name being refused while the file on disk looks
# correct. Reloading here is what makes a config change actually take effect.
reload_nginx_config() {
  docker ps --format '{{.Names}}' | grep -qx steamharness-ecs-nginx || return 0
  compose exec --no-tty nginx nginx -t
  compose exec --no-tty nginx nginx -s reload
  log "Nginx reloaded with the selected configuration"
}

ensure_compose() {
  ensure_docker
  compose config --quiet
  compose up --detach --no-recreate --pull never --wait --wait-timeout 180 \
    server-postgres nginx
  reload_nginx_config
}

start_unit() {
  local unit="$1"
  if ! systemctl is-active --quiet "$unit.service"; then systemctl start "$unit.service"; fi
}

wait_http() {
  local url="$1"
  for _ in {1..60}; do
    curl --connect-timeout 3 --max-time 5 --fail --silent --show-error "$url" >/dev/null 2>&1 && return 0
    sleep 2
  done
  log "health check failed: $url" >&2
  return 1
}

ensure_release() {
  require_root
  ensure_compose
  [[ -L "$ROOT/deployments/server/stable/current" ]] || die "Stable release is not deployed yet"
  [[ -L "$ROOT/published/docs/current" ]] || die "Docs release is not deployed yet"
  start_unit steamharness-server-stable
  start_unit steamharness-docs
  wait_http http://127.0.0.1:7130/health
  wait_http http://127.0.0.1:7132/
  log "Stable runtime ensured"
}

ensure_alpha() {
  require_root
  ensure_compose
  [[ -L "$ROOT/deployments/server/alpha/current" ]] || die "Alpha release is not deployed yet"
  start_unit steamharness-server-alpha
  wait_http http://127.0.0.1:7140/health
  log "Alpha runtime ensured"
}

# Single source of truth for the SAN set the deployment must cover.
# `nginx-https.conf` and `nginx-http.conf` must list the same hostnames in their
# port-80 ACME blocks, otherwise the HTTP-01 challenge for a new name cannot be
# served and issuance fails.
CERTIFICATE_DOMAINS=(
  steamharness.yuhe.space
  api.steamharness.yuhe.space
  hooks.steamharness.yuhe.space
  alpha.steamharness.yuhe.space
  docs.steamharness.yuhe.space
  alpha-web.steamharness.yuhe.space
)

# True when the stored certificate already covers every domain above.
# Reads the listing through the certbot image so this does not depend on the
# host having a usable openssl.
certificate_covers_domains() {
  local listing domain
  listing="$("${certbot[@]}" "$certbot_image" certificates 2>/dev/null || true)"
  for domain in "${CERTIFICATE_DOMAINS[@]}"; do
    grep -qE "(^|[[:space:]])${domain}([[:space:]]|$)" <<<"$listing" || return 1
  done
  return 0
}

certificate() {
  local email="${1:-${STEAMHARNESS_ACME_EMAIL:-}}"
  [[ -n "$email" ]] || die "STEAMHARNESS_ACME_EMAIL is required"
  require_root
  ensure_docker
  mkdir -p "$ROOT/certs" "$ROOT/acme"
  compose up --detach --no-recreate --pull never nginx
  local certbot_image="${STEAMHARNESS_CERTBOT_IMAGE:-certbot/certbot:v2.11.0}"
  local -a certbot=(docker run --rm --network host
    --volume "$ROOT/certs:/etc/letsencrypt"
    --volume "$ROOT/acme:/var/www/acme")
  # `certbot renew` only re-issues the STORED domain set, so it can never pick
  # up a hostname added to this list. Whenever the stored certificate does not
  # cover every domain — a cold host, or a name added since the last issuance —
  # issue (or expand) explicitly; otherwise renew normally.
  if ! certificate_covers_domains; then
    [[ "$email" != *"@example.com" ]] || die "Refusing placeholder ACME email"
    local -a domain_args=()
    local domain
    for domain in "${CERTIFICATE_DOMAINS[@]}"; do domain_args+=(-d "$domain"); done
    log "Issuing/expanding certificate for ${#CERTIFICATE_DOMAINS[@]} domains"
    "${certbot[@]}" "$certbot_image" certonly --webroot -w /var/www/acme \
      --cert-name steamharness.yuhe.space \
      "${domain_args[@]}" --expand \
      --email "$email" --agree-tos --no-eff-email --non-interactive
  else
    "${certbot[@]}" "$certbot_image" renew --webroot -w /var/www/acme --non-interactive
  fi
  select_nginx_config
  compose up --detach --no-recreate --pull never nginx
  compose exec --no-tty nginx nginx -t
  compose exec --no-tty nginx nginx -s reload
  log "ECS certificate issuance/renewal completed"
}

deploy_server() {
  local channel="$1" archive="$2" release_id="$3"
  [[ "$channel" == stable || "$channel" == alpha ]] || die "channel must be stable or alpha"
  [[ -f "$archive" ]] || die "runtime archive does not exist: $archive"
  [[ "$release_id" =~ ^[A-Za-z0-9._-]+$ ]] || die "invalid release id"
  [[ -f "$ROOT/migration-audit/data-restored.json" ]] || die "Complete the data migration before deploying Server"
  local base="$ROOT/deployments/server/$channel"
  local release="$base/releases/$release_id"
  local staging="$base/releases/.staging-$release_id-$$"
  mkdir -p "$base/releases"
  rm -rf "$staging"
  mkdir -p "$staging"
  tar -xzf "$archive" -C "$staging"
  [[ -f "$staging/dist/index.js" ]] || die "runtime archive is missing dist/index.js"
  [[ -f "$staging/runtime.json" ]] || die "runtime archive is missing runtime.json"
  node "$COMPOSE_DIR/validate-runtime.mjs" "$staging" "$channel"
  if [[ -e "$release" ]]; then
    node -e 'const fs = require("node:fs"); const [a,b] = process.argv.slice(1).map(p => JSON.parse(fs.readFileSync(p))); for (const k of ["channel","version","commitSha","platform","architecture"]) if(a[k] !== b[k]) process.exit(1)' "$staging/runtime.json" "$release/runtime.json" || die "release id already contains another runtime"
    rm -rf "$staging"
  else
    mv "$staging" "$release"
  fi
  local current="$base/current"
  local previous=""
  [[ -L "$current" ]] && previous="$(readlink "$current")"
  ensure_compose
  atomic_link "releases/$release_id" "$current"
  local unit="steamharness-server-$channel.service" port=7130
  [[ "$channel" == alpha ]] && port=7140
  if ! systemctl restart "$unit" || ! wait_http "http://127.0.0.1:$port/health"; then
    if [[ -n "$previous" ]]; then
      atomic_link "$previous" "$current"
      systemctl restart "$unit" || true
    else
      systemctl stop "$unit"
      rm -f "$current"
    fi
    die "failed to start $unit; current link was rolled back"
  fi
  rm -f "$archive"
  log "$channel Server deployed: $release_id"
}

deploy_docs() {
  local archive="$1" commit="$2"
  [[ "$commit" =~ ^[0-9a-f]{40}$ ]] || die "Docs deployment requires a full commit SHA"
  [[ -f "$archive" ]] || die "Docs archive does not exist: $archive"
  local base="$ROOT/published/docs"
  local release="$base/releases/$commit" staging="$base/releases/.staging-$commit-$$"
  mkdir -p "$base/releases"
  rm -rf "$staging"
  mkdir -p "$staging"
  tar -xzf "$archive" -C "$staging"
  [[ -f "$staging/deployment.json" && -f "$staging/index.html" ]] || die "Docs archive is incomplete"
  node -e 'const fs = require("node:fs"); if (JSON.parse(fs.readFileSync(process.argv[1])).commitSha !== process.argv[2]) process.exit(1)' "$staging/deployment.json" "$commit" || die "Docs commit metadata mismatch"
  if [[ -e "$release" ]]; then rm -rf "$staging"; else mv "$staging" "$release"; fi
  local previous="$(readlink "$base/current" || true)"
  atomic_link "releases/$commit" "$base/current"
  if ! systemctl restart steamharness-docs.service || ! wait_http http://127.0.0.1:7132/; then
    if [[ -n "$previous" ]]; then
      atomic_link "$previous" "$base/current"
      systemctl restart steamharness-docs.service || true
    else
      systemctl stop steamharness-docs.service
      rm -f "$base/current"
    fi
    die "Docs health check failed; current link was rolled back"
  fi
  rm -f "$archive"
  log "Docs deployed: $commit"
}

deploy_web() {
  local archive="$1" commit="$2"
  [[ "$commit" =~ ^[0-9a-f]{40}$ ]] || die "Web deployment requires a full commit SHA"
  [[ -f "$archive" ]] || die "Web archive does not exist: $archive"
  local base="$ROOT/published/web/alpha"
  local release="$base/releases/$commit" staging="$base/releases/.staging-$commit-$$"
  mkdir -p "$base/releases"
  rm -rf "$staging"
  mkdir -p "$staging"
  tar -xzf "$archive" -C "$staging"
  [[ -f "$staging/deployment.json" && -f "$staging/index.html" ]] || die "Web archive is incomplete"
  node -e 'const fs = require("node:fs"); if (JSON.parse(fs.readFileSync(process.argv[1])).commitSha !== process.argv[2]) process.exit(1)' "$staging/deployment.json" "$commit" || die "Web commit metadata mismatch"
  if [[ -e "$release" ]]; then rm -rf "$staging"; else mv "$staging" "$release"; fi
  local previous="$(readlink "$base/current" || true)"
  atomic_link "releases/$commit" "$base/current"
  if ! systemctl restart steamharness-web-alpha.service || ! wait_http http://127.0.0.1:7152/; then
    if [[ -n "$previous" ]]; then
      atomic_link "$previous" "$base/current"
      systemctl restart steamharness-web-alpha.service || true
    else
      systemctl stop steamharness-web-alpha.service
      rm -f "$base/current"
    fi
    die "Web health check failed; current link was rolled back"
  fi
  rm -f "$archive"
  log "Web deployed: $commit"
}

atomic_link() {
  local destination="$1" link="$2"
  ln -s "$destination" "$link.new-$$"
  mv -Tf "$link.new-$$" "$link"
}

status() {
  printf '%s\n' '--- docker ---'
  docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' || true
  printf '%s\n' '--- systemd ---'
  systemctl --no-pager --plain --full status steamharness-server-stable steamharness-server-alpha steamharness-docs steamharness-web-alpha 2>/dev/null || true
  printf '%s\n' '--- web releases ---'
  [[ -L "$ROOT/published/web/alpha/current" ]] && readlink "$ROOT/published/web/alpha/current" || echo "web/alpha: not deployed"
  printf '%s\n' '--- health ---'
  for url in http://127.0.0.1:7130/health http://127.0.0.1:7140/health http://127.0.0.1:7132/ http://127.0.0.1:7152/; do
    printf '%s: ' "$url"
    curl --fail --silent "$url" >/dev/null 2>&1 && echo ok || echo unavailable
  done
}

image_check() {
  [[ $# -eq 1 ]] || die "Usage: image-check <image>"
  [[ "$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$1" 2>/dev/null)" == linux/amd64 ]]
}

image_pull() {
  [[ $# -eq 1 ]] || die "Usage: image-pull <image>"
  ensure_docker
  local timeout_seconds="${STEAMHARNESS_IMAGE_PULL_TIMEOUT_SECONDS:-120}"
  [[ "$timeout_seconds" =~ ^[1-9][0-9]*$ ]] || die "STEAMHARNESS_IMAGE_PULL_TIMEOUT_SECONDS must be a positive integer"
  timeout --kill-after=5s "${timeout_seconds}s" docker pull --platform linux/amd64 "$1"
}

image_id() {
  [[ $# -eq 1 ]] || die "Usage: image-id <image>"
  docker image inspect --format '{{.Id}}' "$1"
}

migrate() {
  mkdir -p "$ROOT/migration-audit"
  local audit="$ROOT/migration-audit/$(date -u +%Y%m%dT%H%M%SZ).txt"
  {
    echo "started=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "host=$(hostname -f 2>/dev/null || hostname)"
    echo "root=$ROOT"
    docker volume ls --format '{{.Name}}' | sort
    echo "migration requires CI to upload verified pg_dump and volume archives before restore"
    echo "completed=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } | tee "$audit"
  log "Migration audit recorded at $audit"
}

command="${1:-}"
if [[ "$command" != status && "$command" != image-* ]]; then
  mkdir -p "$ROOT"
  exec 9>"$ROOT/.runtime.lock"
  flock -w 900 9 || die "Another ECS runtime operation is still running"
fi
case "$command" in
  bootstrap) bootstrap ;;
  deploy-server) [[ $# -eq 4 ]] || die "Usage: deploy-server <stable|alpha> <archive> <release-id>"; require_root; deploy_server "$2" "$3" "$4" ;;
  deploy-docs) [[ $# -eq 3 ]] || die "Usage: deploy-docs <archive> <commit-sha>"; require_root; deploy_docs "$2" "$3" ;;
  deploy-web) [[ $# -eq 3 ]] || die "Usage: deploy-web <archive> <commit-sha>"; require_root; deploy_web "$2" "$3" ;;
  image-check) image_check "$2" ;;
  image-pull) image_pull "$2" ;;
  image-id) image_id "$2" ;;
  ensure) [[ $# -eq 2 ]] || die "Usage: ensure <release|alpha>"; [[ "$2" == release ]] && ensure_release || [[ "$2" == alpha ]] && ensure_alpha || die "unknown ensure target: $2" ;;
  certificate) certificate "${2:-}" ;;
  status) require_root; status ;;
  migrate) require_root; migrate ;;
  *) die "Usage: bootstrap | deploy-server <stable|alpha> <archive> <release-id> | deploy-docs <archive> <commit-sha> | ensure <release|alpha> | certificate <email> | status | migrate" ;;
esac
