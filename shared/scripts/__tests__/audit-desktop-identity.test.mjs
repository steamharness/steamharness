import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  auditDesktopIdentity,
  DesktopIdentityAuditError,
  parseAuditArgs,
  SPLIT_REPOSITORIES,
} from "../audit-desktop-identity.mjs";

test("Desktop identity audit includes every split repository", () => {
  assert.equal(SPLIT_REPOSITORIES.includes("build-in/build-in-studio-control"), true);
  assert.equal(SPLIT_REPOSITORIES.length, 8);
});

test("Desktop identity audit scans the relocated built-in production files by default", async () => {
  const splitRoot = await mkdtemp(path.join(os.tmpdir(), "workflow-desktop-identity-nested-"));
  try {
    await Promise.all(SPLIT_REPOSITORIES.map(repository => mkdir(path.join(splitRoot, repository), { recursive: true })));
    await writeFiles(path.join(splitRoot, "build-in/build-in-developer-assistant"), {
      "src/runtime.ts": "workflow.isApp();\n",
    });
    await assert.rejects(auditDesktopIdentity({ splitRoot }), error => {
      assert.equal(error.violations[0].repository, "build-in/build-in-developer-assistant");
      assert.equal(error.violations[0].kind, "runtime-helper");
      return true;
    });
  } finally {
    await rm(splitRoot, { recursive: true, force: true });
  }
});

test("Desktop identity audit rejects aliases and fallbacks in production files", async () => {
  const splitRoot = await mkdtemp(path.join(os.tmpdir(), "workflow-desktop-identity-audit-"));
  await writeFiles(path.join(splitRoot, "desktop"), {
    "package.json": '{"name":"@steamharness/app"}\n',
    "src/runtime.ts": [
      'const platform = value === "app" ? "desktop" : value;',
      'const legacyEnvironment = "STEAMHARNESS_APP_RUNTIME_EVENTS";',
      'const legacyChannel = "local-app-state:get";',
      "workflow.isApp();",
    ].join("\n"),
  });

  await assert.rejects(
    auditDesktopIdentity({ splitRoot, repositories: ["desktop"] }),
    (error) => {
      assert.equal(error instanceof DesktopIdentityAuditError, true);
      assert.deepEqual(
        [...new Set(error.violations.map((violation) => violation.kind))].sort(),
        ["environment", "ipc", "package", "runtime-helper", "runtime-value"],
      );
      return true;
    },
  );
});

test("Desktop identity audit allows only explicit old-value rejection guards", async () => {
  const splitRoot = await mkdtemp(path.join(os.tmpdir(), "workflow-desktop-identity-rejection-"));
  await writeFiles(path.join(splitRoot, "harness"), {
    "package.json": '{"name":"steamharness"}\n',
    "src/runtime-platform.ts": [
      'if (normalized === "app") {',
      '  throw new TypeError(\'STEAMHARNESS_RUNTIME_PLATFORM="app" is no longer supported; use "desktop".\');',
      "}",
    ].join("\n"),
    "src/__tests__/runtime-platform.test.ts": 'expect(normalize("app")).toThrow();\n',
    "CHANGELOG.next.md": "旧 app 值不再兼容。\n",
  });
  await writeFiles(path.join(splitRoot, "build-in/build-in-studio-control"), {
    "package.json": '{"name":"@steamharness/builtin-studio-control"}\n',
    "scripts/builtin-release.mjs": [
      'if (Object.hasOwn(release, "minAppVersion")) {',
      '  throw new Error("minAppVersion is not supported; use minDesktopVersion.");',
      "}",
    ].join("\n"),
  });

  const result = await auditDesktopIdentity({
    splitRoot,
    repositories: ["harness", "build-in/build-in-studio-control"],
  });
  assert.equal(result.repositories.length, 2);
  assert.equal(result.filesChecked, 4);
});

test("Desktop identity audit does not treat Electron app APIs as product aliases", async () => {
  const splitRoot = await mkdtemp(path.join(os.tmpdir(), "workflow-desktop-electron-app-"));
  await writeFiles(path.join(splitRoot, "desktop"), {
    "package.json": '{"name":"@steamharness/desktop"}\n',
    "src/main.ts": [
      'import { app, type App } from "electron";',
      'const appPath = app.getAppPath();',
      'const archive = "app.asar";',
      'const bundle = "SteamHarness.app";',
      "export { appPath, archive, bundle };",
    ].join("\n"),
  });

  await assert.doesNotReject(auditDesktopIdentity({ splitRoot, repositories: ["desktop"] }));
});

test("Desktop identity audit can scope an independent CI checkout to Shared", async () => {
  const splitRoot = await mkdtemp(path.join(os.tmpdir(), "workflow-desktop-identity-shared-ci-"));
  await writeFiles(path.join(splitRoot, "shared"), {
    "package.json": '{"name":"@steamharness/shared-workspace"}\n',
    "i18n/index.ts": 'export const namespace = "desktop";\n',
  });

  assert.deepEqual(parseAuditArgs(["--", "--repositories", "shared"]), {
    repositories: ["shared"],
  });
  assert.throws(
    () => parseAuditArgs(["--repositories", "shared,missing"]),
    /Unknown split repository: missing/u,
  );
  const result = await auditDesktopIdentity({ splitRoot, repositories: ["shared"] });
  assert.deepEqual(result.repositories, ["shared"]);
  assert.equal(result.filesChecked, 2);
});

async function writeFiles(root, files) {
  for (const [relativePath, content] of Object.entries(files)) {
    const target = path.join(root, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
}
