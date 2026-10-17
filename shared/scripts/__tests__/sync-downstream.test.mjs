import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  exportSharedSource,
  parseTargets,
  resolveGitLabServerUrl,
  syncRemoteTargets,
} from "../sync-downstream.mjs";

test("default exports include the retained consumers without the removed host", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workflow-shared-default-export-"));
  try {
    const sourceRoot = path.join(root, "dist", "source");
    await mkdir(path.join(sourceRoot, "i18n"), { recursive: true });
    await writeFile(path.join(sourceRoot, "i18n", "package.json"), '{"name":"@workflow-code/i18n"}\n', "utf8");
    const exported = await exportSharedSource({ root, sourceRoot, outputRoot: path.join(root, "consumers") });
    assert.deepEqual(exported.map((entry) => entry.name), ["core", "cli", "server"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Shared source exports to each explicit local downstream vendor directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workflow-shared-export-"));
  try {
    const sourceRoot = path.join(root, "dist", "source");
    const desktopRoot = path.join(root, "consumers", "desktop");
    const serverRoot = path.join(root, "consumers", "server");
    await mkdir(path.join(sourceRoot, "i18n"), { recursive: true });
    await mkdir(desktopRoot, { recursive: true });
    await mkdir(serverRoot, { recursive: true });
    await Promise.all([
      writeFile(path.join(sourceRoot, "i18n", "package.json"), '{"name":"@workflow-code/i18n"}\n', "utf8"),
      writeFile(path.join(sourceRoot, "i18n", "index.ts"), "export const locale = 'en';\n", "utf8"),
      writeFile(path.join(desktopRoot, "package.json"), '{"name":"@workflow-code/desktop"}\n', "utf8"),
      writeFile(path.join(serverRoot, "package.json"), '{"name":"@workflow-code/server"}\n', "utf8"),
    ]);
    const exported = await exportSharedSource({
      root,
      sourceRoot,
      targets: [desktopRoot, path.relative(root, serverRoot)].join(","),
    });
    assert.deepEqual(exported.map((entry) => entry.name), ["desktop", "server"]);
    assert.equal(
      await readFile(path.join(desktopRoot, "vendor", "shared", "i18n", "index.ts"), "utf8"),
      "export const locale = 'en';\n",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("remote synchronization is opt-in and target parsing is stable", async () => {
  assert.deepEqual(parseTargets(" ai/desktop,ai/server\nai/desktop/ "), ["ai/desktop", "ai/server"]);
  await assert.rejects(syncRemoteTargets({ enabled: false }), /requires WORKFLOW_SHARED_REMOTE_SYNC=true/);
});

test("remote synchronization reads its protected token from the internal-sync environment", async () => {
  const source = await readFile(path.resolve(import.meta.dirname, "../../.gitlab-ci.yml"), "utf8");
  assert.match(source, /sync:remote:[\s\S]*?environment:\s*\n\s+name: internal-sync\s*\n\s+action: prepare/u);
  assert.match(source, /sync:remote:[\s\S]*?CI_COMMIT_BEFORE_SHA != "0{40}"/u);
  assert.match(source, /WORKFLOW_SHARED_REMOTE_SYNC:-/u);
  assert.match(source, /Remote synchronization is not enabled for this protected ref\./u);
});

test("alpha CI skips push pipelines and advances through one mirrored Core cascade", async () => {
  const source = await readFile(path.resolve(import.meta.dirname, "../../.gitlab-ci.yml"), "utf8");
  assert.match(source, /workflow:\s*\n\s+auto_cancel:\s*\n\s+on_job_failure: all/u);
  assert.match(source, /alpha-release\.mjs reserve --if-changed/u);
  assert.match(source, /sync:alpha:[\s\S]*?No release-worthy Shared changes[\s\S]*?sync:downstream -- --skip-local --skip-ci --remote --branch alpha/u);
  assert.match(source, /snapshot:alpha:[\s\S]*?workspace-snapshot\.mjs --skip-ci --submodule shared/u);
  assert.match(source, /trigger:core:alpha:[\s\S]*?needs:[\s\S]*?job: alpha:prepare[\s\S]*?artifacts: true[\s\S]*?job: retention:alpha[\s\S]*?WORKFLOW_ALPHA_CASCADE: "true"[\s\S]*?project: "\$CI_PROJECT_NAMESPACE\/core"[\s\S]*?strategy: mirror/u);
  assert.doesNotMatch(source, /trigger:core:alpha:[\s\S]*?WORKFLOW_ALPHA_CHANGED:/u);
});

test("remote synchronization keeps the GitLab port and credentials out of command arguments", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workflow-shared-remote-"));
  try {
    const sourceRoot = path.join(root, "dist", "source");
    await mkdir(path.join(sourceRoot, "i18n"), { recursive: true });
    await writeFile(path.join(sourceRoot, "i18n", "package.json"), '{"name":"@workflow-code/i18n"}\n', "utf8");
    const calls = [];
    await syncRemoteTargets({
      root,
      sourceRoot,
      enabled: true,
      token: "secret-sync-token",
      skipCi: true,
      targets: "workflow/desktop",
      serverUrl: "http://yuhe.space:7201",
      runCommand: async (command, args, options) => {
        calls.push({ command, args, env: options.env });
        return args.includes("--porcelain") ? "" : "";
      },
    });
    const clone = calls.find((call) => call.args.includes("clone"));
    assert.equal(clone.args.at(-2), "http://yuhe.space:7201/workflow/desktop.git");
    assert.equal(clone.args.join(" ").includes("secret-sync-token"), false);
    assert.equal(clone.env.GIT_CONFIG_KEY_0, "http.extraHeader");
    assert.equal(Buffer.from(clone.env.GIT_CONFIG_VALUE_0.slice("Authorization: Basic ".length), "base64").toString("utf8"), "oauth2:secret-sync-token");
    assert.equal(resolveGitLabServerUrl({ protocol: "http", host: "yuhe.space", port: "7201" }), "http://yuhe.space:7201");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("remote synchronization captures push failures and retries a non-fast-forward update", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workflow-shared-retry-"));
  try {
    const sourceRoot = path.join(root, "dist", "source");
    await mkdir(path.join(sourceRoot, "i18n"), { recursive: true });
    await writeFile(path.join(sourceRoot, "i18n", "package.json"), '{"name":"@workflow-code/i18n"}\n', "utf8");
    let pushAttempts = 0;
    await syncRemoteTargets({
      root,
      sourceRoot,
      enabled: true,
      token: "secret-sync-token",
      skipCi: true,
      targets: "workflow/desktop",
      serverUrl: "http://yuhe.space:7201",
      attempts: 2,
      runCommand: async (_command, args, options) => {
        if (args.includes("--porcelain")) return " M vendor/shared/i18n/package.json\n";
        if (args.includes("push")) {
          pushAttempts += 1;
          assert.equal(options.capture, true);
          assert.deepEqual(args.slice(0, 4), ["push", "-o", "ci.skip", "origin"]);
          if (pushAttempts === 1) throw new Error("git push exited 1: non-fast-forward");
        }
        return "";
      },
    });
    assert.equal(pushAttempts, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
