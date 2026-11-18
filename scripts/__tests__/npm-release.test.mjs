import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  fetchRegistryState,
  npmReleasePlan,
  parseDatedVersion,
  parseDevVersion,
  runNpmRelease,
  serviceChannelForPlan,
  verifyPublishState,
} from "../npm-release.mjs";

const release = (version) => ({
  eventName: "workflow_dispatch",
  ref: `refs/tags/steamharness/v${version}`,
  coreVersion: version,
  cliVersion: version,
  cliCoreVersion: version,
  cliPeerVersion: version,
});

test("the command resolves its repository root independently of the working directory", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "npm-release-command-")));
  const registry = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ versions: { "0.1.2": {} }, "dist-tags": { latest: "0.1.2" } }));
  });
  try {
    await new Promise((resolve, reject) => {
      registry.once("error", reject);
      registry.listen(0, "127.0.0.1", resolve);
    });
    for (const name of ["harness", "cli", "scripts", "unrelated-cwd"]) {
      await mkdir(path.join(root, name));
    }
    await copyFile(new URL("../npm-release.mjs", import.meta.url), path.join(root, "scripts/npm-release.mjs"));
    await writeFile(path.join(root, "harness/package.json"), JSON.stringify({ name: "steamharness", version: "0.2.0" }));
    await writeFile(path.join(root, "cli/package.json"), JSON.stringify({ name: "@steamharness/cli", version: "0.2.0",
      devDependencies: { steamharness: "0.2.0" }, peerDependencies: { steamharness: "0.2.0" } }));
    const envPath = path.join(root, "github-env");
    await promisify(execFile)(process.execPath, [path.join(root, "scripts/npm-release.mjs")], {
      cwd: path.join(root, "unrelated-cwd"),
      env: { ...process.env, GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/tags/steamharness/v0.2.0",
        GITHUB_ENV: envPath,
        STEAMHARNESS_NPM_REGISTRY_URL: `http://127.0.0.1:${registry.address().port}` },
      timeout: 10_000,
    });
    assert.equal(await readFile(envPath, "utf8"), "NPM_DIST_TAG=latest\nSTEAMHARNESS_SERVICE_CHANNEL=main\n");
  } finally {
    await new Promise((resolve) => registry.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test("manually selected stable and alpha refs select separate npm tags", () => {
  assert.deepEqual(npmReleasePlan(release("0.1.3")), { version: "0.1.3", distTag: "latest" });
  assert.deepEqual(npmReleasePlan(release("0.1.3-20261117001")), { version: "0.1.3-20261117001", distTag: "alpha" });
});

test("ordinary releases and pushes cannot publish, and a dev prerelease cannot publish from a tag", () => {
  for (const eventName of ["release", "push"]) assert.throws(() => npmReleasePlan({ ...release("0.1.3"), eventName }), /manual/);
  assert.throws(() => npmReleasePlan(release("0.1.3-dev.20261117001")), /prerelease/);
});

test("tag identity, paired versions, SDK pin and peer pin must all agree", () => {
  const plan = release("0.1.3");
  assert.throws(() => npmReleasePlan({ ...plan, ref: "refs/tags/steamharness/v0.1.2" }), /tag/);
  assert.throws(() => npmReleasePlan({ ...plan, cliVersion: "0.1.2" }), /versions/);
  assert.throws(() => npmReleasePlan({ ...plan, cliCoreVersion: "0.1.2" }), /SDK/);
  assert.throws(() => npmReleasePlan({ ...plan, cliPeerVersion: "^0.1.3" }), /peerDependency/);
  assert.throws(() => npmReleasePlan({ ...plan, cliPeerVersion: undefined }), /peerDependency/);
});

test("dated versions require a real calendar date and a 001-999 sequence", () => {
  assert.deepEqual(parseDatedVersion("0.2.0-20261117001"), { date: "20261117", month: 11, day: 17, year: 2026, sequence: 1 });
  assert.deepEqual(parseDatedVersion("0.2.0-20240229003"), { date: "20240229", month: 2, day: 29, year: 2024, sequence: 3 });
  assert.equal(parseDatedVersion("0.2.0-20260229001"), undefined, "2026 is not a leap year");
  assert.equal(parseDatedVersion("0.2.0-20261312001"), undefined, "month 13");
  assert.equal(parseDatedVersion("0.2.0-20261132001"), undefined, "day 32");
  assert.equal(parseDatedVersion("0.2.0-20261117000"), undefined, "sequence 000");
  assert.equal(parseDevVersion("0.2.0-dev.20261117001").sequence, 1);
  assert.equal(parseDevVersion("0.2.0-dev.20261117000"), undefined);
  assert.throws(() => npmReleasePlan(release("0.2.0-20261132001")), /calendar|dated/i);
  assert.throws(() => npmReleasePlan(release("0.2.0-20261117000")), /calendar|dated/i);
});

test("manual dev publication retains its branch and prerelease restrictions", () => {
  const plan = { eventName: "workflow_dispatch", ref: "refs/heads/dev", coreVersion: "0.1.3-dev.20261117001", cliVersion: "0.1.3-dev.20261117001", cliCoreVersion: "0.1.3-dev.20261117001", cliPeerVersion: "0.1.3-dev.20261117001" };
  assert.deepEqual(npmReleasePlan(plan), { version: "0.1.3-dev.20261117001", distTag: "dev" });
  assert.throws(() => npmReleasePlan({ ...plan, ref: "refs/heads/main" }), /dev/);
  assert.throws(() => npmReleasePlan({ ...plan, ...release("0.1.3"), eventName: "workflow_dispatch", ref: "refs/heads/dev" }), /dev/);
  assert.throws(() => npmReleasePlan({ ...plan, coreVersion: "0.1.3-dev.20261117000", cliVersion: "0.1.3-dev.20261117000", cliCoreVersion: "0.1.3-dev.20261117000", cliPeerVersion: "0.1.3-dev.20261117000" }), /dev/);
});

test("each dist-tag bakes the matching service channel", () => {
  assert.equal(serviceChannelForPlan({ distTag: "alpha" }), "alpha");
  assert.equal(serviceChannelForPlan({ distTag: "latest" }), "main");
  assert.equal(serviceChannelForPlan({ distTag: "dev" }), "dev");
  assert.throws(() => serviceChannelForPlan({ distTag: "next" }), /dist-tag/);
});

test("the registry gate rejects republishing and stable downgrades, and passes fresh versions", () => {
  const plan = { version: "0.2.0", distTag: "latest" };
  assert.throws(() => verifyPublishState({
    plan,
    registry: { steamharness: { versions: ["0.2.0"], latest: "0.1.2" }, "@steamharness/cli": { versions: [], latest: "0.1.2" } },
  }), /already published/);
  assert.throws(() => verifyPublishState({
    plan,
    registry: { steamharness: { versions: ["0.1.2"], latest: "0.1.2" }, "@steamharness/cli": { versions: ["0.2.0"], latest: "0.1.2" } },
  }), /already published/);
  assert.throws(() => verifyPublishState({
    plan: { version: "0.1.3", distTag: "latest" },
    registry: { steamharness: { versions: ["0.2.0"], latest: "0.2.0" }, "@steamharness/cli": { versions: [], latest: "0.2.0" } },
  }), /higher than the npm latest/);
  const ok = verifyPublishState({
    plan,
    registry: { steamharness: { versions: ["0.1.2"], latest: "0.1.2" }, "@steamharness/cli": { versions: ["0.1.2"], latest: "0.1.2" } },
  });
  assert.deepEqual(ok.checkedPackages, ["steamharness", "@steamharness/cli"]);
});

const stubRegistry = (map) => async (url) => {
  const name = decodeURIComponent(new URL(url).pathname.slice(1));
  const entry = map[name];
  if (entry === undefined) return { ok: false, status: 404, json: async () => ({ error: "Not found" }) };
  return { ok: true, status: 200, json: async () => entry };
};

test("registry reads treat 404 as not-published and refuse on network errors", async () => {
  const state = await fetchRegistryState({
    fetchImpl: stubRegistry({ steamharness: { versions: { "0.1.2": {} }, "dist-tags": { latest: "0.1.2" } } }),
    packages: ["steamharness", "@steamharness/cli"],
  });
  assert.deepEqual(state["steamharness"], { versions: ["0.1.2"], latest: "0.1.2" });
  assert.deepEqual(state["@steamharness/cli"], { versions: [], latest: undefined });
  await assert.rejects(
    fetchRegistryState({ fetchImpl: async () => { throw new Error("ENETUNREACH"); }, packages: ["steamharness"] }),
    /ENETUNREACH/,
  );
  await assert.rejects(
    fetchRegistryState({ fetchImpl: async () => ({ ok: false, status: 502, json: async () => ({}) }), packages: ["steamharness"] }),
    /HTTP 502/,
  );
});

test("the entrypoint exports NPM_DIST_TAG and STEAMHARNESS_SERVICE_CHANNEL for a manual alpha dispatch", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "npm-release-"));
  try {
    const version = "0.2.0-20261117001";
    await mkdir(path.join(root, "harness"), { recursive: true });
    await mkdir(path.join(root, "cli"), { recursive: true });
    await Promise.all([
      writeFile(path.join(root, "harness/package.json"), `${JSON.stringify({ name: "steamharness", version })}\n`),
      writeFile(path.join(root, "cli/package.json"), `${JSON.stringify({
        name: "@steamharness/cli",
        version,
        devDependencies: { steamharness: version },
        peerDependencies: { steamharness: version },
      })}\n`),
    ]);
    const envPath = path.join(root, "github-env");
    await writeFile(envPath, "");
    const result = await runNpmRelease({
      root,
      env: { GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: `refs/tags/steamharness/v${version}`, GITHUB_ENV: envPath },
      fetchImpl: stubRegistry({
        steamharness: { versions: { "0.1.2": {} }, "dist-tags": { latest: "0.1.2" } },
        "@steamharness/cli": { versions: { "0.1.2": {} }, "dist-tags": { latest: "0.1.2" } },
      }),
    });
    assert.equal(result.distTag, "alpha");
    assert.equal(result.serviceChannel, "alpha");
    const env = await readFile(envPath, "utf8");
    assert.match(env, /^NPM_DIST_TAG=alpha$/mu);
    assert.match(env, /^STEAMHARNESS_SERVICE_CHANNEL=alpha$/mu);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the entrypoint refuses to export for an already published stable version", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "npm-release-"));
  try {
    await mkdir(path.join(root, "harness"), { recursive: true });
    await mkdir(path.join(root, "cli"), { recursive: true });
    await writeFile(path.join(root, "harness/package.json"), `${JSON.stringify({ name: "steamharness", version: "0.2.0" })}\n`);
    await writeFile(path.join(root, "cli/package.json"), `${JSON.stringify({
      name: "@steamharness/cli",
      version: "0.2.0",
      devDependencies: { steamharness: "0.2.0" },
      peerDependencies: { steamharness: "0.2.0" },
    })}\n`);
    const envPath = path.join(root, "github-env");
    await writeFile(envPath, "");
    await assert.rejects(runNpmRelease({
      root,
      env: { GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/tags/steamharness/v0.2.0", GITHUB_ENV: envPath },
      fetchImpl: stubRegistry({
        steamharness: { versions: { "0.2.0": {} }, "dist-tags": { latest: "0.2.0" } },
        "@steamharness/cli": { versions: {}, "dist-tags": {} },
      }),
    }), /already published/);
    assert.equal(await readFile(envPath, "utf8"), "", "a refused plan must not export any tag");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
