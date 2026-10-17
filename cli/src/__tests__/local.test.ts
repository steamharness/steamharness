import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it } from "vitest";
import * as steamHarness from "steamharness";
import { createLocalWorkflowKVStore, WorkflowError } from "steamharness";
import { STEAMHARNESS_RUNTIME_LOCALE_ENV } from "steamharness";
import {
  formatParamResolverFailure,
  assertLocalCliCoreCompatible,
  main,
  parseWorkflowArgs,
  createDesktopRuntimeEventEmitter,
  STEAMHARNESS_DESKTOP_RUNTIME_EVENTS_ENV,
  STEAMHARNESS_DESKTOP_RUNTIME_EVENT_PREFIX,
  STEAMHARNESS_PARAM_ERROR_MARKER,
} from "../local";
import type { CliWorkflowKVStore } from "../related-projects";
import { prepareCliInvocation } from "../locale";

it("run command preserves workflow args after explicit separator", async () => {
  const workflowDir = await createArgsEchoWorkflow();
  const originalStdoutWrite = process.stdout.write;
  const chunks: string[] = [];

  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
    return true;
  }) as typeof process.stdout.write;

  try {
    const exitCode = await main([
      "run",
      workflowDir,
      "--conversation-id",
      "cli-conversation",
      "--file-store-dir",
      path.join(os.tmpdir(), "workflow-files"),
      "--entrypoint",
      "main",
      "--",
      "--json",
      "--conversation-id",
      "workflow-conversation",
      "--file-store-dir",
      "workflow-files",
      "--entrypoint",
      "workflow-owned",
    ]);

    assert.equal(exitCode, 0);
  } finally {
    process.stdout.write = originalStdoutWrite;
  }

  const outputText = chunks.join("").trim();
  const output = JSON.parse(outputText.slice(outputText.indexOf("{"))) as {
    args: string[];
    conversationId?: string;
    fileStoreReady?: boolean;
  };

  assert.deepEqual(output.args, [
    "--json",
    "--conversation-id",
    "workflow-conversation",
    "--file-store-dir",
    "workflow-files",
    "--entrypoint",
    "workflow-owned",
  ]);
  assert.equal(output.conversationId, "cli-conversation");
  assert.equal(output.fileStoreReady, true);
});

it("structure preserves workflow entrypoint group metadata", async () => {
  const workflowDir = await createArgsEchoWorkflow();
  const output: string[] = [];
  const originalLog = console.log;
  console.log = ((value?: unknown) => output.push(String(value ?? ""))) as typeof console.log;

  try {
    assert.equal(await main(["structure", workflowDir]), 0);
    const structure = JSON.parse(output.join("\n")) as {
      entrypoints?: Array<{ id: string; group?: { id: string; title: string; order?: number } }>;
    };
    assert.deepEqual(structure.entrypoints?.map((entrypoint) => ({
      id: entrypoint.id,
      group: entrypoint.group,
    })), [{
      id: "main",
      group: { id: "operations", title: "Operations", order: 10 },
    }]);
  } finally {
    console.log = originalLog;
    await rm(workflowDir, { recursive: true, force: true });
  }
});

it("runs image, video, and audio paths through the published Core file input", async () => {
  const workflowDir = await createArgsEchoWorkflow();
  const originalStdoutWrite = process.stdout.write;
  const chunks: string[] = [];
  try {
    await writeFile(path.join(workflowDir, "index.ts"), `
      import type { CliTestOutputPayload } from "./interface";
      const filesNode = workflow.createFileInputNode({ accept: ["image/*", "video/*", "audio/*"] });
      const outputNode = workflow.createOutputNode({
        name: "output",
        format(input): CliTestOutputPayload {
          return { errCode: 0, errMessage: "", items: [{ id: "media", title: "Output", content: JSON.stringify(input), contentType: "json" }] };
        },
      });
      export const mediaWorkflow = workflow.defineWorkflow({
        name: "media-input",
        async run(input, context) {
          const files = await workflow.runNode(filesNode, [...input.images, ...input.videos, ...input.files], context);
          const media = await Promise.all(files.map(async file => ({ name: file.name, mimeType: file.mimeType, bytes: (await file.readBuffer()).length })));
          return workflow.runNode(outputNode, media, context);
        },
      });
      export const executor = workflow.defineExecutor({
        projectType: "workflow",
        defaultEntrypoint: "media",
        entrypoints: [workflow.defineEntrypoint({
          id: "media", title: "Media", workflow: mediaWorkflow,
          createInput({ args }) { return workflow.parseConversationDefaultInputArgs(args); },
        })],
      });
      export { mediaWorkflow as workflow };
      export default mediaWorkflow;
    `);
    for (const name of ["frame.png", "clip.mp4", "recording.wav"]) await writeFile(path.join(workflowDir, name), "media");
    process.stdout.write = ((chunk: string | Uint8Array) => { chunks.push(String(chunk)); return true; }) as typeof process.stdout.write;
    const exitCode = await main([
      "run", workflowDir, "--", "--images", path.join(workflowDir, "frame.png"),
      "--videos", path.join(workflowDir, "clip.mp4"), "--files", path.join(workflowDir, "recording.wav"),
    ]);
    assert.equal(exitCode, 0, chunks.join(""));
    const output = chunks.join("").trim();
    assert.deepEqual(JSON.parse(output.slice(output.indexOf("["))), [
      { name: "frame.png", mimeType: "image/png", bytes: 5 },
      { name: "clip.mp4", mimeType: "video/mp4", bytes: 5 },
      { name: "recording.wav", mimeType: "audio/wav", bytes: 5 },
    ]);
  } finally {
    process.stdout.write = originalStdoutWrite;
    await rm(workflowDir, { recursive: true, force: true });
  }
});

it("local commands reject projects without an explicit data storage declaration", async () => {
  const workflowDir = await createArgsEchoWorkflow(false);
  try {
    await assert.rejects(
      () => main(["json", workflowDir]),
      /dataStorage\.mode must be declared before this project can run or access data/,
    );
  } finally {
    await rm(workflowDir, { recursive: true, force: true });
  }
});

it("local commands require an exact project Core version and allow patch changes", async () => {
  const workflowDir = await createArgsEchoWorkflow();
  const packagePath = path.join(workflowDir, "package.json");
  const manifest = JSON.parse(await readFile(packagePath, "utf8")) as {
    devDependencies: Record<string, string>;
  };
  const cliManifest = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { devDependencies: Record<string, string> };
  const cliRequiredCoreVersion = cliManifest.devDependencies["steamharness"];

  try {
    manifest.devDependencies["steamharness"] = "0.2.99";
    await writeFile(packagePath, JSON.stringify(manifest), "utf8");
    assert.deepEqual(assertLocalCliCoreCompatible(workflowDir, "0.2.0"), {
      cliRequiredCoreVersion,
      projectRequiredCoreVersion: "0.2.99",
    });

    manifest.devDependencies["steamharness"] = "0.3.0";
    await writeFile(packagePath, JSON.stringify(manifest), "utf8");
    assert.throws(
      () => assertLocalCliCoreCompatible(workflowDir, "0.2.9"),
      /requires exact Core 0\.3\.0 \(0\.3\.x compatibility line\).*provides Core 0\.2\.9/,
    );

    manifest.devDependencies["steamharness"] = "^0.2.0";
    await writeFile(packagePath, JSON.stringify(manifest), "utf8");
    assert.throws(() => assertLocalCliCoreCompatible(workflowDir, "0.2.0"), /exact SemVer/);
  } finally {
    await rm(workflowDir, { recursive: true, force: true });
  }
});

it.each(["build-in", "ci-namespace"])("nested built-ins resolve Core from the aggregate root under %s without escaping it", async parent => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cli-nested-builtin-"));
  const directory = path.join(root, parent, "build-in-studio-control");
  await mkdir(directory, { recursive: true });
  await mkdir(path.join(root, "core"));
  const packagePath = path.join(directory, "package.json");
  const manifest = { devDependencies: { "steamharness": "link:../../core" } };
  await writeFile(path.join(root, "core/package.json"), JSON.stringify({ name: "steamharness", version: "0.2.99" }));
  await writeFile(packagePath, JSON.stringify(manifest));
  try {
    assert.equal(assertLocalCliCoreCompatible(directory, "0.2.4", { mode: "dev" }).projectRequiredCoreVersion, "0.2.99");
    assert.throws(() => assertLocalCliCoreCompatible(directory, "0.2.4", { mode: "main" }), /exact published version/);
    manifest.devDependencies["steamharness"] = "link:../../../core";
    await writeFile(packagePath, JSON.stringify(manifest));
    assert.throws(() => assertLocalCliCoreCompatible(directory, "0.2.4", { mode: "dev" }), /inside the workspace root/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("structure rejects obsolete related-project fields before reporting success", async () => {
  const workflowDir = await createArgsEchoWorkflow();
  const packagePath = path.join(workflowDir, "package.json");
  const manifest = JSON.parse(await readFile(packagePath, "utf8")) as {
    steamHarness: { projectInfo: Record<string, unknown> };
  };
  manifest.steamHarness.projectInfo.relatedProjects = [{
    alias: "stocks",
    projectId: "22222222-2222-4222-8222-222222222222",
    access: { read: "all", write: "none" },
  }];
  await writeFile(packagePath, JSON.stringify(manifest), "utf8");
  const output: string[] = [];
  const originalLog = console.log;
  console.log = ((value?: unknown) => output.push(String(value ?? ""))) as typeof console.log;

  try {
    assert.equal(await main(["structure", workflowDir]), 1);
    const report = JSON.parse(output.join("\n")) as {
      diagnostics: { error?: { message?: string } };
    };
    assert.match(
      report.diagnostics.error?.message ?? "",
      /steamHarness\.projectInfo\.relatedProjects\[0] contains unsupported fields/,
    );
  } finally {
    console.log = originalLog;
    await rm(workflowDir, { recursive: true, force: true });
  }
});

it("run command parses tool permission overrides before workflow args", () => {
  const parsed = parseWorkflowArgs([
    path.join(os.tmpdir(), "workflow"),
    "--tool-permissions-json",
    JSON.stringify({
      search: { enabled: true, autoApprove: false },
      ignored: { enabled: "yes" },
    }),
    "--",
    "--tool-permissions-json",
    "workflow-owned",
  ], { json: true });

  // App/server pass tool policies through an internal CLI flag; the
  // value must not leak into workflow argv, while workflow args after "--"
  // still pass through unchanged.
  assert.deepEqual(parsed.toolPermissionPolicies, {
    search: { enabled: true, autoApprove: false },
    ignored: { enabled: undefined, autoApprove: undefined },
  });
  assert.deepEqual(parsed.args, ["--tool-permissions-json", "workflow-owned"]);
});

it("run command parses entrypoint before the separator and preserves it after", () => {
  const parsed = parseWorkflowArgs([
    "/tmp/workflow",
    "--entrypoint",
    "validate",
    "--",
    "--entrypoint",
    "workflow-owned",
  ], { json: true });

  assert.equal(parsed.entrypointId, "validate");
  assert.deepEqual(parsed.args, ["--entrypoint", "workflow-owned"]);
});

it("run command leaves tool permissions undefined when host does not pass overrides", () => {
  const parsed = parseWorkflowArgs([path.join(os.tmpdir(), "workflow"), "--", "--prompt", "hello"], { json: true });

  // CLI default behavior is executor registrations only.
  assert.equal(parsed.toolPermissionPolicies, undefined);
  assert.deepEqual(parsed.args, ["--prompt", "hello"]);
});

it("global locale parsing removes CLI options but preserves workflow-owned args", () => {
  withRuntimeLocale(undefined, () => {
    const prepared = prepareCliInvocation([
      "--locale",
      "en",
      "run",
      path.join(os.tmpdir(), "workflow"),
      "--",
      "--locale",
      "workflow-owned",
    ]);
    const parsed = parseWorkflowArgs(prepared.argv.slice(1), { json: true });

    assert.equal(prepared.locale, "en");
    assert.equal(process.env[STEAMHARNESS_RUNTIME_LOCALE_ENV], "en");
    assert.deepEqual(parsed.args, ["--locale", "workflow-owned"]);
  });
});

it("global locale parsing accepts either command position and rejects unsupported values", () => {
  assert.deepEqual(
    prepareCliInvocation(["--locale", "en", "workspace", "--help"]).argv,
    ["workspace", "--help"],
  );
  assert.deepEqual(
    prepareCliInvocation(["workspace", "--locale=zh-CN", "--help"]).argv,
    ["workspace", "--help"],
  );
  assert.throws(
    () => prepareCliInvocation(["--locale", "fr", "--help"]),
    /zh-CN.*en/,
  );
  assert.throws(
    () => prepareCliInvocation(["--locale", "en", "--locale", "zh-CN", "--help"]),
    /只能指定一次|only be specified once/,
  );
});

it("emits runtime events only for the Desktop variable", () => {
  const originalDesktopValue = process.env[STEAMHARNESS_DESKTOP_RUNTIME_EVENTS_ENV];
  const originalLegacyValue = process.env.STEAMHARNESS_APP_RUNTIME_EVENTS;
  const originalWrite = process.stdout.write;
  const chunks: string[] = [];

  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
    return true;
  }) as typeof process.stdout.write;

  try {
    delete process.env[STEAMHARNESS_DESKTOP_RUNTIME_EVENTS_ENV];
    process.env.STEAMHARNESS_APP_RUNTIME_EVENTS = "1";
    assert.equal(createDesktopRuntimeEventEmitter(), undefined);

    process.env[STEAMHARNESS_DESKTOP_RUNTIME_EVENTS_ENV] = "1";
    const emit = createDesktopRuntimeEventEmitter();
    assert.equal(typeof emit, "function");
    emit?.({ type: "run_started", timestamp: new Date("2026-08-13T00:00:00.000Z") } as never);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0]?.startsWith(STEAMHARNESS_DESKTOP_RUNTIME_EVENT_PREFIX), true);
  } finally {
    process.stdout.write = originalWrite;
    restoreEnv(STEAMHARNESS_DESKTOP_RUNTIME_EVENTS_ENV, originalDesktopValue);
    restoreEnv("STEAMHARNESS_APP_RUNTIME_EVENTS", originalLegacyValue);
  }
});

function withRuntimeLocale(value: string | undefined, run: () => void): void {
  const previous = process.env[STEAMHARNESS_RUNTIME_LOCALE_ENV];
  try {
    if (value === undefined) {
      delete process.env[STEAMHARNESS_RUNTIME_LOCALE_ENV];
    } else {
      process.env[STEAMHARNESS_RUNTIME_LOCALE_ENV] = value;
    }
    run();
  } finally {
    if (previous === undefined) {
      delete process.env[STEAMHARNESS_RUNTIME_LOCALE_ENV];
    } else {
      process.env[STEAMHARNESS_RUNTIME_LOCALE_ENV] = previous;
    }
  }
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

it("param resolver failures retain localizable metadata after the CLI marker", () => {
  const output = formatParamResolverFailure(new WorkflowError({
    type: "input_validation",
    message: "Workflow Server login is not configured.",
    metadata: {
      steamHarnessI18n: {
        namespace: "common",
        key: "workflowServerLoginRequired",
      },
    },
  }));

  assert.equal(output.startsWith(STEAMHARNESS_PARAM_ERROR_MARKER), true);
  assert.deepEqual(JSON.parse(output.slice(STEAMHARNESS_PARAM_ERROR_MARKER.length)), {
    type: "input_validation",
    message: "Workflow Server login is not configured.",
    metadata: {
      steamHarnessI18n: {
        namespace: "common",
        key: "workflowServerLoginRequired",
      },
    },
  });
});

const hasProjectStorageCore = typeof (steamHarness as unknown as {
  createRemoteWorkflowRelatedProjectKVStoreFromEnv?: unknown;
}).createRemoteWorkflowRelatedProjectKVStoreFromEnv === "function";

it.runIf(hasProjectStorageCore)("CLI forwards the local PersistentValue store directory", async () => {
  const workflowDir = await createPersistentValueCliWorkflow();
  const persistentValueStoreDir = await mkdtemp(path.join(os.tmpdir(), "steamharness-cli-persistent-value-"));
  const originalStoreDir = process.env.STEAMHARNESS_PERSISTENT_VALUE_STORE_DIR;
  const originalLog = console.log;
  process.env.STEAMHARNESS_PERSISTENT_VALUE_STORE_DIR = persistentValueStoreDir;
  console.log = (() => undefined) as typeof console.log;

  try {
    assert.equal(await main(["json", workflowDir]), 0);
    const store = (createLocalWorkflowKVStore as unknown as (options: {
      rootDir: string;
      storageKind: "persistent_value";
    }) => CliWorkflowKVStore)({
      rootDir: persistentValueStoreDir,
      storageKind: "persistent_value",
    });
    assert.equal(await store.getValue({
      storageKind: "persistent_value",
      scope: "project",
      projectId: "22222222-2222-4222-8222-222222222222",
      key: "local-key",
    }), "from-cli");
  } finally {
    console.log = originalLog;
    if (originalStoreDir === undefined) {
      delete process.env.STEAMHARNESS_PERSISTENT_VALUE_STORE_DIR;
    } else {
      process.env.STEAMHARNESS_PERSISTENT_VALUE_STORE_DIR = originalStoreDir;
    }
    await rm(workflowDir, { recursive: true, force: true });
    await rm(persistentValueStoreDir, { recursive: true, force: true });
  }
});

it("built unified CLI help executes from the CLI package", async (context) => {
  const cliPath = path.resolve("dist", "index.js");
  if (!existsSync(cliPath)) {
    context.skip();
    return;
  }

  const result = await runNode(cliPath, ["--help"]);

  // keeps the packaged root CLI executable in the second-round test
  // layer without invoking any workflow or external service.
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /steamharness \[--locale <zh-CN\|en>] <run\|json\|structure\|resolve-params\|mcp>/);
  assert.match(result.stdout, /steamharness \[--locale <zh-CN\|en>] workspace <command>/);
  assert.equal(result.stderr.trim(), "");
});

it("built unified CLI localizes help and accepts locale before workspace dispatch", async (context) => {
  const cliPath = path.resolve("dist", "index.js");
  if (!existsSync(cliPath)) {
    context.skip();
    return;
  }

  const english = await runNode(cliPath, ["--locale", "en", "workspace", "--help"]);
  assert.equal(english.exitCode, 0);
  assert.match(english.stdout, /Usage: steamharness/);
  assert.match(english.stdout, /Global options:/);

  const chinese = await runNode(cliPath, ["workspace", "--locale", "zh-CN", "--help"]);
  assert.equal(chinese.exitCode, 0);
  assert.match(chinese.stdout, /用法：steamharness/);
  assert.match(chinese.stdout, /全局选项：/);

  const unsupported = await runNode(cliPath, ["--locale", "fr", "--help"]);
  assert.equal(unsupported.exitCode, 1);
  assert.match(unsupported.stderr, /zh-CN.*en/);
});

it("core package manifest publishes built dist entrypoints", async () => {
  const packageJson = JSON.parse(await readFile(path.resolve("node_modules", "steamharness", "package.json"), "utf8")) as {
    private?: boolean;
    files?: string[];
    publishConfig?: { access?: string };
    types?: string;
    exports?: { ".": { types?: string; import?: string } };
  };

  assert.equal(packageJson.private, undefined);
  assert.deepEqual(packageJson.files, ["dist", "README.md"]);
  assert.equal(packageJson.publishConfig?.access, "public");
  assert.equal(packageJson.types, "./dist/index.d.ts");
  assert.equal(packageJson.exports?.["."].types, "./dist/index.d.ts");
  assert.equal(packageJson.exports?.["."].import, "./dist/index.js");
});

async function createArgsEchoWorkflow(declareStorage = true): Promise<string> {
  const workflowDir = await mkdtemp(path.join(os.tmpdir(), "steamharness-cli-"));

  await writeFile(
    path.join(workflowDir, "package.json"),
    JSON.stringify({
      id: "11111111-1111-4111-8111-111111111111",
      name: "@steamharness/cli-test-workflow",
      type: "module",
      devDependencies: { "steamharness": "0.2.0" },
      ...(declareStorage
        ? { steamHarness: { projectInfo: { dataStorage: { mode: "local" } } } }
        : {}),
    }),
  );
  await writeFile(
    path.join(workflowDir, "interface.ts"),
    [
      "export interface WorkflowPayload {",
      "  errCode: number;",
      "  errMessage: string;",
      "}",
      "",
      "export interface WorkflowExecutorResult<Output extends WorkflowPayload> {",
      "  ok: boolean;",
      "  data?: Output;",
      "  error?: unknown;",
      "}",
      "",
      "export interface CliTestOutputPayload extends WorkflowPayload {",
      "  items: Array<{ id: string; title: string; content: unknown; contentType?: string; collapsed?: boolean }>;",
      "}",
      "",
      "export type CliTestOutput = WorkflowExecutorResult<CliTestOutputPayload>;",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(workflowDir, "index.ts"),
    [
      "import type { CliTestOutputPayload } from \"./interface\";",
      "",
      "interface CliInput {",
      "  args: string[];",
      "  conversationId?: string;",
      "  fileStoreReady: boolean;",
      "}",
      "",
      "const outputNode = workflow.createOutputNode<CliInput, CliTestOutputPayload>({",
      "  name: \"output\",",
      "  format(input) {",
      "    return {",
      "      errCode: 0,",
      "      errMessage: \"\",",
      "      items: [{",
      "        id: \"cli-output\",",
      "        title: \"Output\",",
      "        content: JSON.stringify(input),",
      "        contentType: \"json\",",
      "        collapsed: false,",
      "      }],",
      "    };",
      "  },",
      "});",
      "",
      "export const cliTestWorkflow = workflow.defineWorkflow<CliInput, CliTestOutputPayload>({",
      "  name: \"cli-test\",",
      "  run(input, context) {",
      "    return workflow.runNode(outputNode, input, context);",
      "  },",
      "});",
      "",
      "export const executor = workflow.defineExecutor<CliInput, CliTestOutputPayload>({",
      "  projectType: \"workflow\",",
      "  defaultEntrypoint: \"main\",",
      "  entrypoints: [workflow.defineEntrypoint<CliInput, CliTestOutputPayload>({",
      "    id: \"main\", title: \"Main\",",
      "    group: { id: \"operations\", title: \"Operations\", order: 10 },",
      "    workflow: cliTestWorkflow,",
      "    createInput(context) {",
      "      return {",
      "        args: context.args,",
      "        conversationId: context.conversationId,",
      "        fileStoreReady: context.workflowDir !== \"\",",
      "      };",
      "    },",
      "  })],",
      "});",
      "",
      "export { cliTestWorkflow as workflow };",
      "export default cliTestWorkflow;",
      "",
    ].join("\n"),
  );

  return workflowDir;
}

async function createPersistentValueCliWorkflow(): Promise<string> {
  const workflowDir = await mkdtemp(path.join(os.tmpdir(), "steamharness-cli-persistent-value-workflow-"));
  await writeFile(
    path.join(workflowDir, "package.json"),
    JSON.stringify({
      id: "22222222-2222-4222-8222-222222222222",
      type: "module",
      devDependencies: { "steamharness": "0.2.0" },
      steamHarness: { projectInfo: { dataStorage: { mode: "local" } } },
    }),
  );
  await writeFile(
    path.join(workflowDir, "index.ts"),
    [
      "const outputNode = workflow.createOutputNode({",
      "  name: \"output\",",
      "  format() {",
      "    return { errCode: 0, errMessage: \"\", items: [] };",
      "  },",
      "});",
      "",
      "export const persistentCliWorkflow = workflow.defineWorkflow({",
      "  name: \"persistent-cli-test\",",
      "  async run(input, context) {",
      "    await context.storage.local.persistentValue.setValue(\"local-key\", \"from-cli\");",
      "    return workflow.runNode(outputNode, input, context);",
      "  },",
      "});",
      "",
      "export const executor = workflow.defineExecutor({",
      "  projectType: \"workflow\",",
      "  defaultEntrypoint: \"main\",",
      "  entrypoints: [workflow.defineEntrypoint({",
      "    id: \"main\", title: \"Main\", workflow: persistentCliWorkflow,",
      "    createInput() { return {}; },",
      "  })],",
      "});",
      "",
      "export { persistentCliWorkflow as workflow };",
      "export default persistentCliWorkflow;",
      "",
    ].join("\n"),
  );
  return workflowDir;
}

function runNode(
  scriptPath: string,
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        NODE_OPTIONS: removeNodeOptionsConditions(process.env.NODE_OPTIONS ?? ""),
      },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("close", (exitCode) => {
      resolve({
        exitCode: exitCode ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

function removeNodeOptionsConditions(value: string): string {
  return value
    .split(/\s+/)
    .filter((part) => part !== "--conditions=development" && part !== "--conditions" && part !== "development")
    .join(" ")
    .trim();
}
