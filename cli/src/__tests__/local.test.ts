import { writeProjectFixture } from '../../scripts/test-project-fixture.mjs';
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { it } from "vitest";
import * as steamHarness from "steamharness";
import { createLocalProjectKVStore, HarnessError } from "steamharness";
import { STEAMHARNESS_RUNTIME_LOCALE_ENV } from "steamharness";
import {
  formatParamResolverFailure,
  assertLocalCliCoreCompatible,
  main,
  parseProjectArgs,
  createDesktopRuntimeEventEmitter,
  STEAMHARNESS_DESKTOP_RUNTIME_EVENTS_ENV,
  STEAMHARNESS_DESKTOP_RUNTIME_EVENT_PREFIX,
  STEAMHARNESS_PARAM_ERROR_MARKER,
} from "../local";
import { prepareCliInvocation } from "../locale";
import { resolveHarnessVersion } from "./harness-source";

it("check validates all registered entries and supports selecting one entry", async () => {
  const projectDir = await createArgsEchoProject();
  const packagePath = path.join(projectDir, "steamharness.json");
  const pkg = JSON.parse(await readFile(packagePath, "utf8"));
  pkg.entries.push({ ...pkg.entries[0], entryId: "second", name: "Second" });
  await writeFile(packagePath, JSON.stringify(pkg));
  const output: string[] = [];
  const log = console.log;
  console.log = value => { output.push(String(value)); };
  try {
    assert.equal(await main(["check", projectDir]), 0);
    assert.deepEqual(JSON.parse(output.at(-1)!).entries.map((entry: { entryId: string }) => entry.entryId), ["main", "second"]);
    pkg.entries[1].type = "conversation";
    await writeFile(packagePath, JSON.stringify(pkg));
    await assert.rejects(main(["check", projectDir]), /second.*conversation/);
    assert.equal(await main(["check", projectDir, "--entry", "main"]), 0);
    assert.equal(JSON.parse(output.at(-1)!).entryId, "main");
  } finally {
    console.log = log;
    await rm(projectDir, { recursive: true, force: true });
  }
});

it("run command preserves workflow args after explicit separator", async () => {
  const projectDir = await createArgsEchoProject();
  const originalStdoutWrite = process.stdout.write;
  const chunks: string[] = [];

  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
    return true;
  }) as typeof process.stdout.write;

  try {
    const exitCode = await main([
      "run",
      projectDir,
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
  const projectDir = await createArgsEchoProject();
  const output: string[] = [];
  const originalLog = console.log;
  console.log = ((value?: unknown) => output.push(String(value ?? ""))) as typeof console.log;

  try {
    assert.equal(await main(["structure", projectDir]), 0);
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
    await rm(projectDir, { recursive: true, force: true });
  }
});

it("structure and check use only steamharness.json for project metadata", async () => {
  const projectDir = await createArgsEchoProject();
  const packagePath = path.join(projectDir, "package.json");
  const npm = JSON.parse(await readFile(packagePath, "utf8"));
  await writeFile(packagePath, JSON.stringify({ ...npm, name: "unrelated-npm-package", version: "9.9.9",
    id: "not-a-project-id", steamHarness: { entries: [] }, projectInfo: { relatedProjects: [] } }));
  const document = JSON.parse(await readFile(path.join(projectDir, "steamharness.json"), "utf8"));
  const output: string[] = [];
  const originalLog = console.log;
  console.log = value => { output.push(String(value)); };
  try {
    assert.equal(await main(["structure", projectDir]), 0);
    const structure = JSON.parse(output.at(-1)!);
    assert.equal(structure.projectId, document.id);
    assert.equal(structure.entryName, "Main");
    assert.equal(await main(["check", projectDir]), 0);
    const aggregate = JSON.parse(output.at(-1)!);
    assert.equal(aggregate.name, document.name);
    assert.equal(aggregate.version, document.version);
  } finally {
    console.log = originalLog;
    await rm(projectDir, { recursive: true, force: true });
  }
});

it("runs image, video, and audio paths through the published Core file input", async () => {
  const projectDir = await createArgsEchoProject();
  const originalStdoutWrite = process.stdout.write;
  const chunks: string[] = [];
  try {
    await writeFile(path.join(projectDir, "index.ts"), `
      import type { CliTestOutputPayload } from "./interface";
      const filesNode = steamharness.createFileInputNode({ accept: ["image/*", "video/*", "audio/*"] });
      const outputNode = steamharness.createOutputNode({
        name: "output",
        format(input): CliTestOutputPayload {
          return { errCode: 0, errMessage: "", items: [{ id: "media", title: "Output", content: JSON.stringify(input), contentType: "json" }] };
        },
      });
      export const mediaProject = steamharness.defineProject({
        name: "media-input",
        async run(input, context) {
          const files = await steamharness.runNode(filesNode, [...input.images, ...input.videos, ...input.files], context);
          const media = await Promise.all(files.map(async file => ({ name: file.name, mimeType: file.mimeType, bytes: (await file.readBuffer()).length })));
          return steamharness.runNode(outputNode, media, context);
        },
      });
      export const executor = steamharness.defineExecutor({
        projectType: "workflow",
        defaultEntrypoint: "media",
        entrypoints: [steamharness.defineEntrypoint({
          id: "media", title: "Media", workflow: mediaProject,
          createInput({ args }) { return steamharness.parseConversationDefaultInputArgs(args); },
        })],
      });
      export { mediaProject as workflow };
      export default mediaProject;
    `);
    for (const name of ["frame.png", "clip.mp4", "recording.wav"]) await writeFile(path.join(projectDir, name), "media");
    process.stdout.write = ((chunk: string | Uint8Array) => { chunks.push(String(chunk)); return true; }) as typeof process.stdout.write;
    const exitCode = await main([
      "run", projectDir, "--", "--images", path.join(projectDir, "frame.png"),
      "--videos", path.join(projectDir, "clip.mp4"), "--files", path.join(projectDir, "recording.wav"),
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
    await rm(projectDir, { recursive: true, force: true });
  }
});

it("local commands reject projects without explicit entry registrations", async () => {
  const projectDir = await createArgsEchoProject(false);
  try {
    await assert.rejects(
      () => main(["json", projectDir]),
      /steamharness\.json/,
    );
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

it("local commands require an exact project Core version and allow patch changes", async () => {
  const projectDir = await createArgsEchoProject();
  const packagePath = path.join(projectDir, "package.json");
  const manifest = JSON.parse(await readFile(packagePath, "utf8")) as {
    devDependencies: Record<string, string>;
  };
  const cliManifest = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { devDependencies: Record<string, string> };
  const cliRequiredCoreVersion = cliManifest.devDependencies["steamharness"];
  const hostCoreVersion = await resolveHarnessVersion();
  const semver = createRequire(import.meta.url)("semver") as { parse(value: string): { major: number; minor: number; patch: number } };
  const version = semver.parse(hostCoreVersion);
  const projectRequiredCoreVersion = `${version.major}.${version.minor}.${version.patch + 1}`;
  const incompatibleVersion = `${version.major}.${version.minor + 1}.0`;

  try {
    manifest.devDependencies["steamharness"] = projectRequiredCoreVersion;
    await writeFile(packagePath, JSON.stringify(manifest), "utf8");
    assert.deepEqual(assertLocalCliCoreCompatible(projectDir, hostCoreVersion), {
      cliRequiredCoreVersion,
      projectRequiredCoreVersion,
    });

    manifest.devDependencies["steamharness"] = incompatibleVersion;
    await writeFile(packagePath, JSON.stringify(manifest), "utf8");
    assert.throws(
      () => assertLocalCliCoreCompatible(projectDir, hostCoreVersion),
      /requires exact Core.*compatibility line.*provides Core/,
    );

    manifest.devDependencies["steamharness"] = `^${hostCoreVersion}`;
    await writeFile(packagePath, JSON.stringify(manifest), "utf8");
    assert.throws(() => assertLocalCliCoreCompatible(projectDir, hostCoreVersion), /exact SemVer/);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

it.each(["build-in", "ci-namespace"])("nested built-ins resolve Core from the aggregate root under %s without escaping it", async parent => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cli-nested-builtin-"));
  const directory = path.join(root, parent, "build-in-studio-control");
  await mkdir(directory, { recursive: true });
  await mkdir(path.join(root, "harness"));
  const packagePath = path.join(directory, "package.json");
  const manifest = { devDependencies: { "steamharness": "link:../../harness" } };
  const version = await resolveHarnessVersion();
  await writeProjectFixture(path.join(root, "harness/package.json"), JSON.stringify({ name: "steamharness", version }));
  await writeFile(packagePath, JSON.stringify(manifest));
  try {
    assert.equal(assertLocalCliCoreCompatible(directory, version, { mode: "dev" }).projectRequiredCoreVersion, version);
    assert.throws(() => assertLocalCliCoreCompatible(directory, version, { mode: "main" }), /exact published version/);
    manifest.devDependencies["steamharness"] = "link:../../../core";
    await writeFile(packagePath, JSON.stringify(manifest));
    assert.throws(() => assertLocalCliCoreCompatible(directory, version, { mode: "dev" }), /inside the workspace root/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("structure rejects obsolete related-project fields before reporting success", async () => {
  const projectDir = await createArgsEchoProject();
  const packagePath = path.join(projectDir, "steamharness.json");
  const manifest = JSON.parse(await readFile(packagePath, "utf8")) as {
    projectInfo: Record<string, unknown>;
  };
  manifest.projectInfo.relatedProjects = [{
    alias: "stocks",
    projectId: "22222222-2222-4222-8222-222222222222",
    access: { read: "all", write: "none" },
  }];
  await writeFile(packagePath, JSON.stringify(manifest), "utf8");
  const output: string[] = [];
  const originalLog = console.log;
  console.log = ((value?: unknown) => output.push(String(value ?? ""))) as typeof console.log;

  try {
    assert.equal(await main(["structure", projectDir]), 1);
    const report = JSON.parse(output.join("\n")) as {
      diagnostics: { error?: { message?: string } };
    };
    assert.match(
      report.diagnostics.error?.message ?? "",
      /Project database and related-project declarations were removed|steamHarness\.projectInfo\.relatedProjects was removed/,
    );
  } finally {
    console.log = originalLog;
    await rm(projectDir, { recursive: true, force: true });
  }
});

it("run command parses tool permission overrides before workflow args", () => {
  const parsed = parseProjectArgs([
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
  const parsed = parseProjectArgs([
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
  const parsed = parseProjectArgs([path.join(os.tmpdir(), "workflow"), "--", "--prompt", "hello"], { json: true });

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
    const parsed = parseProjectArgs(prepared.argv.slice(1), { json: true });

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
  const output = formatParamResolverFailure(new HarnessError({
    type: "input_validation",
    message: "SteamHarness Server login is not configured.",
    metadata: {
      steamHarnessI18n: {
        namespace: "common",
        key: "projectServerLoginRequired",
      },
    },
  }));

  assert.equal(output.startsWith(STEAMHARNESS_PARAM_ERROR_MARKER), true);
  assert.deepEqual(JSON.parse(output.slice(STEAMHARNESS_PARAM_ERROR_MARKER.length)), {
    type: "input_validation",
    message: "SteamHarness Server login is not configured.",
    metadata: {
      steamHarnessI18n: {
        namespace: "common",
        key: "projectServerLoginRequired",
      },
    },
  });
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
  assert.match(result.stdout, /steamharness \[--locale <zh-CN\|en>] <run\|json\|check\|structure\|resolve-params\|mcp>/);
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

async function createArgsEchoProject(declareStorage = true): Promise<string> {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "steamharness-cli-"));

  await writeProjectFixture(
    path.join(projectDir, "package.json"),
    JSON.stringify({
      id: "11111111-1111-4111-8111-111111111111",
      name: "@steamharness/cli-test-workflow",
      type: "module",
      devDependencies: { "steamharness": await resolveHarnessVersion() },
      ...(declareStorage
        ? {  defaultEntry: 'main', entries: [{entryId:'main',name:'Main',type:'workflow',root:'.',entry:'index.ts',databases:[]}], projectInfo:{}  }
        : {}),
    }),
  );
  await writeFile(
    path.join(projectDir, "interface.ts"),
    [
      "export interface RunPayload {",
      "  errCode: number;",
      "  errMessage: string;",
      "}",
      "",
      "export interface ExecutorResult<Output extends RunPayload> {",
      "  ok: boolean;",
      "  data?: Output;",
      "  error?: unknown;",
      "}",
      "",
      "export interface CliTestOutputPayload extends RunPayload {",
      "  items: Array<{ id: string; title: string; content: unknown; contentType?: string; collapsed?: boolean }>;",
      "}",
      "",
      "export type CliTestOutput = ExecutorResult<CliTestOutputPayload>;",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(projectDir, "index.ts"),
    [
      "import type { CliTestOutputPayload } from \"./interface\";",
      "",
      "interface CliInput {",
      "  args: string[];",
      "  conversationId?: string;",
      "  fileStoreReady: boolean;",
      "}",
      "",
      "const outputNode = steamharness.createOutputNode<CliInput, CliTestOutputPayload>({",
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
      "export const cliTestProject = steamharness.defineProject<CliInput, CliTestOutputPayload>({",
      "  name: \"cli-test\",",
      "  run(input, context) {",
      "    return steamharness.runNode(outputNode, input, context);",
      "  },",
      "});",
      "",
      "export const executor = steamharness.defineExecutor<CliInput, CliTestOutputPayload>({",
      "  projectType: \"workflow\",",
      "  defaultEntrypoint: \"main\",",
      "  entrypoints: [steamharness.defineEntrypoint<CliInput, CliTestOutputPayload>({",
      "    id: \"main\", title: \"Main\",",
      "    group: { id: \"operations\", title: \"Operations\", order: 10 },",
      "    workflow: cliTestProject,",
      "    createInput(context) {",
      "      return {",
      "        args: context.args,",
      "        conversationId: context.conversationId,",
      "        fileStoreReady: context.projectDir !== \"\",",
      "      };",
      "    },",
      "  })],",
      "});",
      "",
      "export { cliTestProject as workflow };",
      "export default cliTestProject;",
      "",
    ].join("\n"),
  );

  return projectDir;
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
