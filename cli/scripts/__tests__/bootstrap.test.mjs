import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { bootstrapRepository } from "../bootstrap.mjs";
import { assertIsolatedInstall } from "../install-guard.mjs";

test("bootstrap prepares copied Shared packages once before install", async () => {
  const calls = [];
  const result = await bootstrapRepository({
    root: path.resolve("checkout", "cli"),
    env: { WORKFLOW_BOOTSTRAP_TEST: "1" },
    argv: ["--frozen-lockfile"],
    prepare: async ({ env }) => calls.push(`prepare:${env.WORKFLOW_REPOSITORY_MODE ?? "current"}`),
    install: async ({ argv }) => {
      calls.push(`install:${argv.join(" ")}`);
      return 0;
    },
  });
  assert.equal(result, 0);
  assert.deepEqual(calls, ["prepare:main", "install:--frozen-lockfile"]);
});

test("bootstrap does not refresh Shared packages after an install failure", async () => {
  const calls = [];
  await assert.rejects(bootstrapRepository({
    root: path.resolve("checkout", "cli"),
    env: {},
    prepare: async ({ env }) => calls.push(`prepare:${env.WORKFLOW_REPOSITORY_MODE ?? "current"}`),
    install: async () => {
      calls.push("install:failed");
      throw new Error("install failed");
    },
  }), /install failed/);
  assert.deepEqual(calls, ["prepare:main", "install:failed"]);
});

test("install guard accepts copied packages and rejects source links or missing preparation", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "workflow-cli-install-guard-"));
  const copiedRoot = path.join(parent, "copied");
  const linkedRoot = path.join(parent, "linked");
  const source = path.join(parent, "shared", "i18n");
  await Promise.all([
    mkdir(path.join(copiedRoot, ".shared", "i18n"), { recursive: true }),
    mkdir(path.join(linkedRoot, ".shared"), { recursive: true }),
    mkdir(source, { recursive: true }),
  ]);
  await symlink(source, path.join(linkedRoot, ".shared", "i18n"), process.platform === "win32" ? "junction" : "dir");
  await assert.doesNotReject(assertIsolatedInstall({ root: copiedRoot }));
  await assert.rejects(assertIsolatedInstall({ root: linkedRoot }), /Direct install is disabled/);
  await assert.rejects(assertIsolatedInstall({ root: path.join(parent, "missing") }), /Shared packages are not prepared/);
});
