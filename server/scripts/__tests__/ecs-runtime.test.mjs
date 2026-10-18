import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildEcsEnv } from "../write-ecs-env.mjs";

const root = path.resolve(import.meta.dirname, "../..");

const readEcsFile = (name) => readFile(path.join(root, "docker", "ecs", name), "utf8");

test("ECS Compose pins public Server images and keeps its database private", async () => {
  const compose = await readFile(path.join(root, "docker", "ecs", "docker-compose.yml"), "utf8");
  for (const image of [
    "postgres:15-alpine",
    "nginx:1.27-alpine",
  ]) assert.match(compose, new RegExp(`image: ${image.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`, "u"));
  assert.match(compose, /127\.0\.0\.1:7125:5432/u);
  assert.doesNotMatch(compose, /redis|7134/iu);
  assert.match(compose, /network_mode: host/u);
});

test("ECS agent recovery is additive and contains the expected systemd channels", async () => {
  const agent = await readFile(path.join(root, "docker", "ecs", "ecs-runtime-agent.sh"), "utf8");
  assert.match(agent, /compose up --detach --no-recreate --pull never --wait/u);
  assert.doesNotMatch(agent, /compose down -v|docker volume rm/u);
  assert.match(agent, /steamharness-server-stable/u);
  assert.match(agent, /steamharness-server-alpha/u);
  assert.match(agent, /steamharness-docs/u);
  assert.match(agent, /certbot.*renew|renew.*certbot/u);
  assert.match(agent, /timeout --kill-after=5s.*docker pull/u);
});

// The certificate is issued as one multi-SAN cert (despite the
// "steamharness.yuhe.space" name). For the HTTP-01 challenge to be served, every
// SAN must appear in a `listen 80` server_name in whichever nginx config is
// active — the HTTP-only bootstrap config before the cert exists, and the
// HTTPS config afterwards. A name present in one but not the other fails
// silently at issuance time, which is why this is asserted rather than
// commented.
function certificateDomains(agent) {
  const block = /CERTIFICATE_DOMAINS=\(([\s\S]*?)\n\)/u.exec(agent);
  assert.ok(block, "the agent must declare CERTIFICATE_DOMAINS");
  return block[1].split("\n").map((line) => line.trim()).filter((line) => line !== "");
}

function port80ServerNames(conf) {
  const names = new Set();
  for (const line of conf.split("\n")) {
    if (!/listen\s+80\b/u.test(line)) continue;
    const match = /server_name\s+([^;]+);/u.exec(line);
    if (match === null) continue;
    for (const name of match[1].trim().split(/\s+/u)) {
      if (name !== "_") names.add(name);
    }
  }
  return names;
}

test("every certificate domain is servable for the ACME challenge on port 80", async () => {
  const agent = await readFile(path.join(root, "docker", "ecs", "ecs-runtime-agent.sh"), "utf8");
  const domains = certificateDomains(agent);
  assert.ok(domains.length > 0, "the certificate domain list must not be empty");

  for (const confName of ["nginx-http.conf", "nginx-https.conf"]) {
    const conf = await readFile(path.join(root, "docker", "ecs", confName), "utf8");
    const served = port80ServerNames(conf);
    for (const domain of domains) {
      assert.ok(
        served.has(domain),
        `${confName} must list ${domain} in a port-80 server_name so its ACME challenge can be served`,
      );
    }
  }
});

test("the certificate covers exactly the deployed hostnames", async () => {
  const agent = await readFile(path.join(root, "docker", "ecs", "ecs-runtime-agent.sh"), "utf8");
  // 精确集合而不是逐个包含：certbot 会为名单里的每个名字续签，
  // 多一个域名就意味着为无人服务的站点维持一张证书。
  assert.deepEqual([...certificateDomains(agent)].sort(), [
    "alpha-web.steamharness.yuhe.space",
    "alpha.steamharness.yuhe.space",
    "api.steamharness.yuhe.space",
    "docs.steamharness.yuhe.space",
    "hooks.steamharness.yuhe.space",
    "steamharness.yuhe.space",
  ]);
});

test("the certificate path can add a domain to an existing certificate", async () => {
  const agent = await readFile(path.join(root, "docker", "ecs", "ecs-runtime-agent.sh"), "utf8");
  // `certbot renew` re-issues the STORED domain set only, so a name added to
  // the list would never reach the certificate if renew were the only path.
  assert.match(agent, /certificate_covers_domains/u);
  assert.match(agent, /certonly[\s\S]*--expand/u);
});

/**
 * The body of every `server { ... }` block, found by counting braces.
 *
 * These vhosts used to be one line each, so a line-based reader was enough.
 * Alpha now splits its traffic across several `location` blocks, and a reader
 * that only looks at lines mentioning `listen` would drop that vhost from the
 * map entirely — silently, which is the failure this parser exists to prevent.
 * Comments are stripped first so a commented-out directive cannot satisfy an
 * assertion.
 */
function serverBlocks(conf) {
  const source = conf.replace(/#[^\n]*/gu, "");
  const blocks = [];
  let depth = 0;
  let start = -1;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") {
      depth += 1;
      // Depth 2 is "directly inside `http {`", which is where vhosts live.
      if (depth === 2 && /(?:^|\s)server$/u.test(source.slice(0, index).trimEnd())) start = index;
      continue;
    }
    if (char !== "}") continue;
    if (depth === 2 && start !== -1) blocks.push(source.slice(start + 1, index));
    depth -= 1;
  }
  return blocks;
}

/** The HTTPS vhosts, as `hostname -> { locations }`. */
function httpsVhosts(conf) {
  const vhosts = new Map();
  for (const block of serverBlocks(conf)) {
    if (!/listen\s+443\b/u.test(block)) continue;
    const names = /server_name\s+([^;]+);/u.exec(block);
    if (names === null) continue;
    const locations = [];
    for (const match of block.matchAll(/location\s+(?:(=|\^~|~)\s+)?([^\s{]+)\s*\{([^{}]*)\}/gu)) {
      const proxy = /proxy_pass\s+http:\/\/([A-Za-z0-9_]+);/u.exec(match[3]);
      locations.push({
        modifier: match[1] ?? "",
        path: match[2],
        upstream: proxy === null ? undefined : proxy[1],
      });
    }
    for (const name of names[1].trim().split(/\s+/u)) vhosts.set(name, { locations });
  }
  return vhosts;
}

/**
 * Which location nginx would use for `requestPath`, by its own precedence:
 * an exact match wins, then the longest `^~`/plain prefix, then a regex.
 */
function resolveLocation(vhost, requestPath) {
  const candidates = vhost.locations.filter((location) => {
    if (location.modifier === "=") return location.path === requestPath;
    if (location.modifier === "~") return new RegExp(location.path, "u").test(requestPath);
    return requestPath.startsWith(location.path);
  });
  const exact = candidates.find((location) => location.modifier === "=");
  if (exact !== undefined) return exact;
  const prefixes = candidates.filter((location) => location.modifier !== "~");
  if (prefixes.length === 0) return candidates.find((location) => location.modifier === "~");
  return prefixes.sort((left, right) => right.path.length - left.path.length)[0];
}

/** The upstream serving the hosted web app, and the unit behind it. */
const WEB_UPSTREAM = "steamharness_web_alpha";

function upstreamPorts(conf) {
  const ports = new Map();
  for (const match of conf.matchAll(/upstream\s+([A-Za-z0-9_]+)\s*\{\s*server\s+127\.0\.0\.1:(\d+);/gu)) {
    ports.set(match[1], Number(match[2]));
  }
  return ports;
}

test("the web release's port agrees between its unit file and the proxy in front of it", async () => {
  // A port that disagrees in two places is a site that answers 502 while both
  // halves of it look healthy on their own, which is exactly the kind of
  // mistake a runtime health check per unit will never catch.
  const conf = await readEcsFile("nginx-https.conf");
  const upstreams = upstreamPorts(conf);
  const unit = await readEcsFile("steamharness-web-alpha.service");
  const port = Number(/--port\s+(\d+)/u.exec(unit)?.[1]);

  assert.ok(Number.isInteger(port), "steamharness-web-alpha.service must declare a port");
  assert.equal(
    upstreams.get(WEB_UPSTREAM),
    port,
    `nginx must proxy ${WEB_UPSTREAM} to the port its unit listens on`,
  );
  // The health check the agent waits on has to be the same port, or a release
  // that never came up is reported as deployed.
  const agent = await readEcsFile("ecs-runtime-agent.sh");
  assert.match(
    agent,
    new RegExp(`deploy_web\\(\\)[\\s\\S]*?wait_http http://127\\.0\\.0\\.1:${port}/`, "u"),
    "deploy-web must wait on the port the web release actually listens on",
  );
});

test("the web app's host serves the app at its root and the API from the Server", async () => {
  // Same origin on purpose: the page's own API calls are first-party, so the
  // session cookie needs neither CORS nor a cross-site policy. Neither half may
  // quietly take the other's traffic — the Server's SPA answers `/` with 200 and
  // a page, so a misrouted API path would look like a working site.
  const conf = await readEcsFile("nginx-https.conf");
  const vhosts = httpsVhosts(conf);
  const vhost = vhosts.get("alpha-web.steamharness.yuhe.space");
  assert.ok(vhost, "alpha-web.steamharness.yuhe.space must have an HTTPS vhost");

  for (const requestPath of ["/api/auth/session", "/api/workflows", "/api/workflows/abc/runs"]) {
    assert.equal(
      resolveLocation(vhost, requestPath).upstream,
      "steamharness_alpha",
      `${requestPath} must be served by the Alpha Server`,
    );
  }
  for (const requestPath of ["/", "/assets/index-abc123.js", "/monaco/vs/loader.js", "/brand/icon.svg"]) {
    assert.equal(
      resolveLocation(vhost, requestPath).upstream,
      WEB_UPSTREAM,
      `${requestPath} must be served by the web app`,
    );
  }

  // 只服务已登记的域名：多出来的 vhost 会把流量悄悄转给另一个服务。
  assert.deepEqual([...vhosts.keys()].sort(), [
    "alpha-web.steamharness.yuhe.space",
    "alpha.steamharness.yuhe.space",
    "api.steamharness.yuhe.space",
    "docs.steamharness.yuhe.space",
    "hooks.steamharness.yuhe.space",
    "steamharness.yuhe.space",
  ]);
});

test("every certificate domain has an HTTPS vhost to be served by", async () => {
  const [agent, conf] = await Promise.all([readEcsFile("ecs-runtime-agent.sh"), readEcsFile("nginx-https.conf")]);
  const vhosts = httpsVhosts(conf);
  for (const domain of certificateDomains(agent)) {
    assert.ok(vhosts.has(domain), `${domain} is in the certificate SAN list but has no HTTPS vhost`);
  }
});






test("a config change actually reaches the running nginx", async () => {
  // Selecting a config only rewrites the file the container mounts; a running
  // nginx keeps the one it loaded. Without a reload, a hostname added here is
  // refused by whatever server block used to be the default — which is how the
  // ACME challenge for a new name fails while the file on disk looks right.
  const agent = await readEcsFile("ecs-runtime-agent.sh");
  assert.match(agent, /reload_nginx_config\(\) \{[\s\S]*?grep -qx workflow-ecs-nginx \|\| return 0[\s\S]*?nginx -s reload/u);
  // Both paths that pick a config have to reach it: the bootstrap that installs
  // one, and the ensure/recover path that brings the services back up.
  assert.match(agent, /ensure_compose\(\)[\s\S]*?reload_nginx_config/u);
  assert.match(agent, /bootstrap\(\)[\s\S]*?select_nginx_config[\s\S]*?reload_nginx_config/u);
  // A host with no nginx container yet must not fail the bootstrap.
  assert.match(agent, /workflow-ecs-nginx \|\| return 0/u);
});

test("a live hostname is never proxied to another service on port 80", async () => {
  // The bootstrap nginx config is active until the certificate exists. A live
  // hostname sharing a port-80 block with a `location /` proxy would serve
  // another service on its hostname during that window — the ACME
  // challenge only needs the challenge location, so such a block must refuse
  // traffic rather than forward it.
  const conf = await readFile(path.join(root, "docker", "ecs", "nginx-http.conf"), "utf8");
  for (const line of conf.split("\n")) {
    if (!/listen\s+80\b/u.test(line) || !line.includes("wflive")) continue;
    assert.doesNotMatch(
      line,
      /proxy_pass/u,
      `a port-80 block listing a live hostname must not proxy elsewhere: ${line.trim()}`,
    );
  }
});
