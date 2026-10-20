import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Stream } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  ElicitRequestSchema,
  ErrorCode,
  type ElicitResult,
} from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createProjectMcpDesktopAuditWriter,
  parseProjectMcpCliOptions,
  readSavedProjectMcpAuthEnv,
  resolveProjectMcpWorkerEntrypoint,
  McpCliRunner,
} from "../mcp";
import { main as cliMain } from "../index";
import { resolveHarnessVersion } from "./harness-source";

const cliPath = path.resolve("dist/index.js");
const temporaryDirectories: string[] = [];
const connections: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.allSettled(connections.splice(0).map((connection) => connection.close()));
  await Promise.allSettled(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe("steamharness mcp", () => {
  it("falls back to saved CLI authentication when Desktop is not logged in", async () => {
    const desktopConfigDir = await createTemporaryDirectory("steamharness-mcp-desktop-auth-");
    const cliAuthDir = await createTemporaryDirectory("steamharness-mcp-cli-auth-");
    await writeFile(path.join(desktopConfigDir, "workflow-desktop.json"), JSON.stringify({
      auth: { serverUrl: "", apiKey: "" },
    }), "utf8");
    await writeFile(path.join(cliAuthDir, "workflow-auth.json"), JSON.stringify({
      serverUrl: "https://steamharness.example.com",
      apiKey: "cli-saved-key",
    }), "utf8");
    const options = parseProjectMcpCliOptions([
      process.cwd(),
      "--desktop-config-dir", desktopConfigDir,
      "--auth-dir", cliAuthDir,
    ]);

    assert.deepEqual(readSavedProjectMcpAuthEnv(options, {}), {
      STEAMHARNESS_SERVER_URL: "https://steamharness.example.com",
      STEAMHARNESS_SERVER_ADMIN_KEY: "cli-saved-key",
    });
  });

  it("does not combine a partial explicit MCP credential with saved auth", () => {
    const options = parseProjectMcpCliOptions([process.cwd()]);

    assert.throws(
      () => readSavedProjectMcpAuthEnv(options, {
        STEAMHARNESS_SERVER_URL: "https://explicit.example.com",
      }),
      /must be provided together/i,
    );
    assert.throws(
      () => readSavedProjectMcpAuthEnv(options, {
        STEAMHARNESS_SERVER_ADMIN_KEY: "explicit-key",
      }),
      /must be provided together/i,
    );
    assert.deepEqual(
      readSavedProjectMcpAuthEnv(options, {
        STEAMHARNESS_SERVER_URL: "https://explicit.example.com",
        STEAMHARNESS_SERVER_ADMIN_KEY: "explicit-key",
      }),
      {},
    );
  });

  it("prints MCP help when the subcommand receives a help flag", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await expect(cliMain(["mcp", "--help"])).resolves.toBe(0);
      expect(write).toHaveBeenCalledWith(expect.stringContaining("steamharness mcp <workflow-dir>"));
    } finally {
      write.mockRestore();
    }
  });

  it("uses a dedicated IPC message for Desktop run snapshots", async () => {
    const send = vi.fn((_message, callback: (error: Error | null) => void) => {
      callback(null);
      return true;
    });
    const writer = createProjectMcpDesktopAuditWriter({
      env: { STEAMHARNESS_MCP_DESKTOP_AUDIT_IPC: "1" },
      send,
    });
    const snapshot: Parameters<NonNullable<ReturnType<typeof createProjectMcpDesktopAuditWriter>>>[0] = {
      projectId: "11111111-1111-4111-8111-111111111111",
      entrypointId: "main",
      entrypointTitle: "Main",
      input: { message: "hello" },
      args: ["--message", "hello"],
      resolvedUserInputs: [],
      startedAt: "2026-08-31T00:00:00.000Z",
      endedAt: "2026-08-31T00:00:01.000Z",
      exitCode: 0,
      stdout: "project log\n",
      stderr: "",
      report: { runId: "run-1", status: "success", nodes: [{ name: "main" }] },
    };

    await expect(writer?.(snapshot)).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledWith({
      type: "project_mcp_run_snapshot",
      snapshot,
    }, expect.any(Function));
    expect(createProjectMcpDesktopAuditWriter({ env: {}, send })).toBeUndefined();
  });

  it("captures complete running and final snapshots outside MCP stdout", async () => {
    const projectDir = await createMcpProject();
    const dataDir = await createTemporaryDirectory("steamharness-mcp-audit-");
    const snapshots: Array<Parameters<NonNullable<ReturnType<typeof createProjectMcpDesktopAuditWriter>>>[0]> = [];
    const runner = new McpCliRunner({
      ...parseProjectMcpCliOptions([projectDir, "--data-dir", dataDir]),
      workerEntrypoint: cliPath,
    }, (snapshot) => { snapshots.push(snapshot); });
    await runner.inspectStructure();

    const report = await runner.run({
      projectId: "11111111-1111-4111-8111-111111111111",
      entrypointId: "main",
      entrypointTitle: "Main MCP fixture",
      input: { message: "audit", count: 2 },
      args: ["--message", "audit", "--count", "2"],
      signal: new AbortController().signal,
    });
    await runner.close();

    expect(snapshots.map((snapshot) => (snapshot.report as { status: string }).status))
      .toEqual(["running", "success"]);
    expect(snapshots[1]).toMatchObject({
      projectId: "11111111-1111-4111-8111-111111111111",
      input: { message: "audit", count: 2 },
      args: ["--message", "audit", "--count", "2"],
      exitCode: 0,
    });
    expect(snapshots[1]?.stdout).toContain("fixture-project-log");
    expect(snapshots[1]?.report).toEqual(report);
    expect(JSON.stringify(snapshots[1]?.report)).toContain("fixture-output");
  });

  it("keeps one complete snapshot lineage across consecutive input resumes", async () => {
    const projectDir = await createMcpProject();
    const dataDir = await createTemporaryDirectory("steamharness-mcp-resume-audit-");
    const snapshots: Array<Parameters<NonNullable<ReturnType<typeof createProjectMcpDesktopAuditWriter>>>[0]> = [];
    const runner = new McpCliRunner({
      ...parseProjectMcpCliOptions([projectDir, "--data-dir", dataDir]),
      workerEntrypoint: cliPath,
    }, (snapshot) => { snapshots.push(snapshot); });
    await runner.inspectStructure();
    const signal = new AbortController().signal;

    let report = await runner.run({
      projectId: "11111111-1111-4111-8111-111111111111",
      entrypointId: "main",
      entrypointTitle: "Main MCP fixture",
      input: { message: "interactive", interact: true },
      args: ["--message", "interactive", "--interact"],
      signal,
    });
    const runId = report.runId;
    const firstPending = report.pendingUserInput;
    if (!firstPending) throw new Error("Expected first pending input.");
    report = await runner.resume({
      projectId: "11111111-1111-4111-8111-111111111111",
      entrypointId: "main",
      entrypointTitle: "Main MCP fixture",
      runId,
      requestId: firstPending.requestId,
      nodeName: firstPending.nodeName,
      values: { name: "Ada" },
      signal,
    });
    const secondPending = report.pendingUserInput;
    if (!secondPending) throw new Error("Expected second pending input.");
    report = await runner.resume({
      projectId: "11111111-1111-4111-8111-111111111111",
      entrypointId: "main",
      entrypointTitle: "Main MCP fixture",
      runId,
      requestId: secondPending.requestId,
      nodeName: secondPending.nodeName,
      values: { approved: true },
      signal,
    });
    await runner.close();

    expect(report.status).toBe("success");
    expect(snapshots.map((snapshot) => (snapshot.report as { status: string }).status))
      .toEqual(["running", "waiting_for_input", "running", "waiting_for_input", "running", "success"]);
    expect(snapshots.map((snapshot) => (snapshot.report as { runId: string }).runId))
      .toEqual(Array.from({ length: 6 }, () => runId));
    expect(snapshots.map((snapshot) => snapshot.resolvedUserInputs.length))
      .toEqual([0, 0, 1, 1, 2, 2]);
    expect(snapshots.every((snapshot) =>
      JSON.stringify(snapshot.input) === JSON.stringify({ message: "interactive", interact: true })
    )).toBe(true);
    expect(snapshots.at(-1)?.stdout.split("fixture-project-log").length).toBe(4);
    expect((snapshots[4]?.report as { pendingUserInput?: unknown }).pendingUserInput).toBeUndefined();
  });

  it("finalizes a pending input run when the MCP connection closes", async () => {
    const projectDir = await createMcpProject();
    const dataDir = await createTemporaryDirectory("steamharness-mcp-close-audit-");
    const snapshots: Array<Parameters<NonNullable<ReturnType<typeof createProjectMcpDesktopAuditWriter>>>[0]> = [];
    const runner = new McpCliRunner({
      ...parseProjectMcpCliOptions([projectDir, "--data-dir", dataDir]),
      workerEntrypoint: cliPath,
    }, (snapshot) => { snapshots.push(snapshot); });
    await runner.inspectStructure();

    const report = await runner.run({
      projectId: "11111111-1111-4111-8111-111111111111",
      entrypointId: "main",
      entrypointTitle: "Main MCP fixture",
      input: { message: "close", interact: true },
      args: ["--message", "close", "--interact"],
      signal: new AbortController().signal,
    });
    expect(report.status).toBe("waiting_for_input");

    await runner.close();

    expect(snapshots.map((snapshot) => (snapshot.report as { status: string }).status))
      .toEqual(["running", "waiting_for_input", "aborted"]);
    expect(snapshots.at(-1)).toMatchObject({
      exitCode: 130,
      input: { message: "close", interact: true },
      args: ["--message", "close", "--interact"],
      report: {
        runId: report.runId,
        status: "aborted",
      },
    });
    expect(snapshots.at(-1)?.report).not.toHaveProperty("pendingUserInput");
    expect(snapshots.at(-1)?.stderr).toContain("MCP connection closed");
  });

  it("records a distinct terminal diagnostic when MCP elicitation fails", async () => {
    const projectDir = await createMcpProject();
    const dataDir = await createTemporaryDirectory("steamharness-mcp-elicitation-failure-");
    const snapshots: Array<Parameters<NonNullable<ReturnType<typeof createProjectMcpDesktopAuditWriter>>>[0]> = [];
    const runner = new McpCliRunner({
      ...parseProjectMcpCliOptions([projectDir, "--data-dir", dataDir]),
      workerEntrypoint: cliPath,
    }, (snapshot) => { snapshots.push(snapshot); });
    await runner.inspectStructure();
    const signal = new AbortController().signal;
    const report = await runner.run({
      projectId: "11111111-1111-4111-8111-111111111111",
      entrypointId: "main",
      entrypointTitle: "Main MCP fixture",
      input: { message: "invalid elicitation", interact: true },
      args: ["--message", "invalid elicitation", "--interact"],
      signal,
    });
    const pending = report.pendingUserInput;
    if (!pending) throw new Error("Expected pending input.");

    await runner.cancel({
      projectId: "11111111-1111-4111-8111-111111111111",
      entrypointId: "main",
      entrypointTitle: "Main MCP fixture",
      runId: report.runId,
      requestId: pending.requestId,
      reason: "elicitation_failed",
      signal,
    });

    expect(snapshots.map((snapshot) => (snapshot.report as { status: string }).status))
      .toEqual(["running", "waiting_for_input", "aborted"]);
    expect(snapshots.at(-1)?.report).not.toHaveProperty("pendingUserInput");
    expect(snapshots.at(-1)?.stderr).toContain("elicitation response could not be processed");
  });

  it("initializes, lists fixed tools, calls a workflow, and keeps project logs off stdout", async () => {
    const projectDir = await createMcpProject();
    const connection = await connectProjectMcp(projectDir);

    assert.deepEqual(connection.client.getServerVersion(), {
      name: "workflow-11111111-1111-4111-8111-111111111111",
      version: "0.1.0",
    });
    const tools = await connection.client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name), ["main"]);
    assert.match(tools.tools[0]?.description ?? "", /temporary MCP fixture/i);

    const result = await connection.client.callTool({
      name: "main",
      arguments: { message: "hello", count: 2 },
    });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    assert.deepEqual(result.structuredContent, {
      runId: (result.structuredContent as { runId: string }).runId,
      status: "success",
      entrypointId: "main",
      entrypointTitle: "Main MCP fixture",
      output: {
        errCode: 0,
        errMessage: "",
        items: [{
          id: "fixture-output",
          title: "Fixture output",
          content: "hello",
          contentType: "text",
          collapsed: false,
        }],
        echo: { message: "hello", count: 2, delayMs: 0, interact: false, useRelated: false },
      },
    });
    assert.match(connection.readStderr(), /fixture-project-log/);

    await assert.rejects(
      () => connection.client.callTool({ name: "main", arguments: { message: "ok", unknown: true } }),
      (error: unknown) => isMcpErrorCode(error, ErrorCode.InvalidParams),
    );
  });

  it("imports absolute file paths into the configured managed-file store", async () => {
    const projectDir = await createMcpProject();
    const sourceFile = path.join(projectDir, "source.txt");
    await writeFile(sourceFile, "managed content", "utf8");
    const connection = await connectProjectMcp(projectDir);

    const result = await connection.client.callTool({
      name: "main",
      arguments: { message: "file", file: sourceFile },
    });
    const output = (result.structuredContent as {
      output: { echo: { file: Array<{ id: string; name: string; projectId: string }> } };
    }).output;
    const file = output.echo.file[0];
    assert.equal(file?.name, "source.txt");
    assert.equal(file?.projectId, "11111111-1111-4111-8111-111111111111");
    assert.equal(
      await readFile(path.join(connection.dataDir, "workflow-files", file?.id ?? "", "content"), "utf8"),
      "managed content",
    );

    await assert.rejects(
      () => connection.client.callTool({
        name: "main",
        arguments: { message: "file", file: "source.txt" },
      }),
      (error: unknown) => isMcpErrorCode(error, ErrorCode.InvalidParams),
    );
  });

  it("resumes one run through consecutive form elicitations", async () => {
    const projectDir = await createMcpProject();
    const responses: ElicitResult[] = [
      { action: "accept", content: { name: "Ada" } },
      { action: "accept", content: { approved: true } },
    ];
    const connection = await connectProjectMcp(projectDir, responses);

    const result = await connection.client.callTool({
      name: "main",
      arguments: { message: "interactive", interact: true },
    });
    assert.equal(result.isError, undefined);
    assert.equal((result.structuredContent as { status: string }).status, "success");
    assert.deepEqual(
      (result.structuredContent as { output: { echo: unknown } }).output.echo,
      {
        message: "interactive",
        count: 1,
        firstAnswer: "Ada",
        approved: true,
      },
    );
    assert.equal(responses.length, 0);
  });

  it("passes confirmed related projects into the real workflow worker", async () => {
    const dependencyDir = await createRelatedProject();
    const projectDir = await createMcpProject("33333333-3333-4333-8333-333333333333");
    const connection = await connectProjectMcp(projectDir, undefined, [
      { alias: "dependency", projectDir: dependencyDir },
    ]);

    const result = await connection.client.callTool({
      name: "main",
      arguments: { message: "related" },
    });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    assert.equal(
      (result.structuredContent as { output: { echo: { message: string } } }).output.echo.message,
      "related",
    );
  });

  it("cancels the active workflow worker when the MCP request is aborted", async () => {
    const projectDir = await createMcpProject();
    const connection = await connectProjectMcp(projectDir);
    const controller = new AbortController();
    const call = connection.client.callTool(
      { name: "main", arguments: { message: "slow", delayMs: 30_000 } },
      undefined,
      { signal: controller.signal, timeout: 35_000 },
    );

    setTimeout(() => controller.abort(new Error("cancel fixture")), 100).unref();
    await assert.rejects(call, /cancel|abort/i);

    const result = await connection.client.callTool({
      name: "main",
      arguments: { message: "after cancellation" },
    });
    assert.equal((result.structuredContent as { status: string }).status, "success");
  });

  it("rejects Conversation projects before opening the MCP protocol", async () => {
    const projectDir = await createConversationProject();
    const dataDir = await createTemporaryDirectory("steamharness-mcp-data-");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cliPath, "mcp", projectDir, "--data-dir", dataDir],
      cwd: projectDir,
      stderr: "pipe",
    });
    const client = new Client({ name: "cli-mcp-test", version: "1.0.0" });
    connections.push(client, transport);

    await assert.rejects(() => client.connect(transport));
    const stderr = await readStreamAfterClose(transport.stderr);
    assert.match(stderr, /project type "conversation" cannot be exposed through MCP/i);
  });

  it("reports the structure validation diagnostic when a Workflow project is invalid", async () => {
    const projectDir = await createMcpProject();
    const sourcePath = path.join(projectDir, "index.ts");
    const source = await readFile(sourcePath, "utf8");
    await writeFile(
      sourcePath,
      source.replace('name: "message", flag: "--message"', 'name: "message"'),
      "utf8",
    );
    const dataDir = await createTemporaryDirectory("steamharness-mcp-data-");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cliPath, "mcp", projectDir, "--data-dir", dataDir],
      cwd: projectDir,
      stderr: "pipe",
    });
    const client = new Client({ name: "cli-mcp-test", version: "1.0.0" });
    connections.push(client, transport);

    await assert.rejects(() => client.connect(transport));
    const stderr = await readStreamAfterClose(transport.stderr);
    assert.match(stderr, /must declare static name and flag values/i);
  });

  it("ignores a complete JSON object printed by project logs before the report", async () => {
    const projectDir = await createMcpProject();
    const sourcePath = path.join(projectDir, "index.ts");
    const source = await readFile(sourcePath, "utf8");
    await writeFile(
      sourcePath,
      source.replace(
        'console.log("fixture-project-log");',
        'console.log(JSON.stringify({ projectType: "workflow", workflow: { name: "log-object" } }));',
      ),
      "utf8",
    );
    const connection = await connectProjectMcp(projectDir);
    assert.deepEqual((await connection.client.listTools()).tools.map((tool) => tool.name), ["main"]);
  });

  it("rejects malformed MCP CLI arguments with actionable messages", async () => {
    assert.throws(
      () => parseProjectMcpCliOptions([]),
      /requires a workflow project directory/i,
    );
    assert.throws(
      () => parseProjectMcpCliOptions(["--data-dir"]),
      /requires a workflow project directory/i,
    );
    const projectDir = await createMcpProject();
    assert.throws(
      () => parseProjectMcpCliOptions([projectDir, "--data-dir"]),
      /Missing value for --data-dir/i,
    );
    const filePath = path.join(projectDir, "package.json");
    assert.throws(
      () => parseProjectMcpCliOptions([filePath]),
      /not a directory/i,
    );
  });

  it("resolves an explicit worker entrypoint before argv and normalizes relative paths", () => {
    const configured = resolveProjectMcpWorkerEntrypoint(
      ["/usr/bin/node", "ignored-entrypoint.mjs"],
      { STEAMHARNESS_MCP_CLI_ENTRYPOINT: "./configured-entrypoint.mjs" },
    );
    assert.equal(configured, path.resolve("configured-entrypoint.mjs"));
    assert.equal(
      resolveProjectMcpWorkerEntrypoint(["/usr/bin/node", "./argv-entrypoint.mjs"], {}),
      path.resolve("argv-entrypoint.mjs"),
    );
  });

  it("rejects missing or flag-like worker entrypoints", () => {
    assert.throws(
      () => resolveProjectMcpWorkerEntrypoint(["/usr/bin/node"], {}),
      /Unable to resolve/i,
    );
    assert.throws(
      () => resolveProjectMcpWorkerEntrypoint(["/usr/bin/node", "--inspect"], {}),
      /Unable to resolve/i,
    );
    assert.throws(
      () => resolveProjectMcpWorkerEntrypoint(["/usr/bin/node"], {
        STEAMHARNESS_MCP_CLI_ENTRYPOINT: "   ",
      }),
      /Unable to resolve/i,
    );
  });
});

async function connectProjectMcp(
  projectDir: string,
  elicitationResponses?: ElicitResult[],
  relatedProjects: Array<{ alias: string; projectDir: string }> = [],
): Promise<{
  client: Client;
  transport: StdioClientTransport;
  dataDir: string;
  readStderr(): string;
}> {
  const dataDir = await createTemporaryDirectory("steamharness-mcp-data-");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      cliPath,
      "mcp",
      projectDir,
      "--data-dir",
      dataDir,
      ...relatedProjects.flatMap((project) => [
        "--related-project",
        `${project.alias}=${project.projectDir}`,
      ]),
    ],
    cwd: projectDir,
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });
  const client = new Client(
    { name: "cli-mcp-test", version: "1.0.0" },
    elicitationResponses ? { capabilities: { elicitation: { form: {} } } } : undefined,
  );
  if (elicitationResponses) {
    client.setRequestHandler(ElicitRequestSchema, async () => {
      const response = elicitationResponses.shift();
      if (!response) throw new Error("Missing fixture elicitation response.");
      return response;
    });
  }
  await client.connect(transport);
  connections.push(client, transport);
  return { client, transport, dataDir, readStderr: () => stderr };
}

async function createMcpProject(relatedProjectId?: string): Promise<string> {
  const projectDir = await createTemporaryDirectory("steamharness-mcp-project-");
  await writeFile(path.join(projectDir, "package.json"), JSON.stringify({
    id: "11111111-1111-4111-8111-111111111111",
    name: "@steamharness/mcp-test-workflow",
    type: "module",
    devDependencies: { "steamharness": await resolveHarnessVersion() },
    steamHarness: {
      projectInfo: {
        dataStorage: { mode: "local" },
        relatedProjects: relatedProjectId ? [{
          alias: "dependency",
          projectId: relatedProjectId,
          grantToRelatedProject: {
            read: { mode: "all" },
            write: { mode: "all" },
          },
        }] : [],
      },
    },
  }), "utf8");
  await writeFile(path.join(projectDir, "index.ts"), [
    'console.log("fixture-project-log");',
    "",
    "const firstInputNode = steamharness.createUserInputNode({",
    '  name: "first-input", title: "Name",',
    '  params: [{ name: "name", flag: "--name", type: "string", required: true }],',
    "});",
    "const secondInputNode = steamharness.createUserInputNode({",
    '  name: "second-input", title: "Approval",',
    '  params: [{ name: "approved", flag: "--approved", type: "boolean", required: true }],',
    "});",
    "const outputNode = steamharness.createOutputNode({",
    '  name: "fixture-output",',
    "  format(input) {",
    "    return {",
    "      errCode: 0, errMessage: \"\",",
    "      items: [{ id: \"fixture-output\", title: \"Fixture output\", content: input.message, contentType: \"text\", collapsed: false }],",
    "      echo: input,",
    "    };",
    "  },",
    "});",
    "",
    "const fixtureProject = steamharness.defineProject({",
    '  name: "mcp-fixture",',
    "  async run(input, context) {",
    "    if (input.delayMs > 0) {",
    "      await new Promise((resolve, reject) => {",
    "        const timer = setTimeout(resolve, input.delayMs);",
    "        context.abortSignal?.addEventListener(\"abort\", () => { clearTimeout(timer); reject(context.abortSignal.reason); }, { once: true });",
    "      });",
    "    }",
    "    if (input.interact) {",
    "      const first = await steamharness.runNode(firstInputNode, {}, context);",
    "      const second = await steamharness.runNode(secondInputNode, {}, context);",
    "      return steamharness.runNode(outputNode, { message: input.message, count: input.count, firstAnswer: first.values.name, approved: second.values.approved }, context);",
    "    }",
    "    if (input.useRelated) {",
    '      const kv = context.storage.local.relatedProjects.get("dependency").kv;',
    '      await kv.setValue("mcp-test", "related-value");',
    '      const relatedValue = await kv.getValue("mcp-test");',
    "      return steamharness.runNode(outputNode, { ...input, relatedValue }, context);",
    "    }",
    "    return steamharness.runNode(outputNode, input, context);",
    "  },",
    "});",
    "",
    "export const executor = steamharness.defineExecutor({",
    '  projectType: "workflow", defaultEntrypoint: "main",',
    "  entrypoints: [steamharness.defineEntrypoint({",
    '    id: "main", title: "Main MCP fixture", description: "Runs the temporary MCP fixture.", workflow: fixtureProject,',
    "    params: [",
    '      { name: "message", flag: "--message", type: "string", required: true, description: "Message to echo." },',
    '      { name: "count", flag: "--count", type: "number", required: false, defaultValue: "1" },',
    '      { name: "file", flag: "--file", type: "file", required: false },',
    '      { name: "delayMs", flag: "--delay-ms", type: "number", required: false, defaultValue: "0" },',
    '      { name: "interact", flag: "--interact", type: "boolean", required: false, defaultValue: "false" },',
    '      { name: "useRelated", flag: "--use-related", type: "boolean", required: false, defaultValue: "false" },',
    "    ],",
    "    createInput({ args }) {",
    "      const read = (flag) => { const index = args.indexOf(flag); return index === -1 ? undefined : args[index + 1]; };",
    "      const file = read(\"--file\");",
    "      return {",
    '        message: read("--message") ?? "",',
    '        count: Number(read("--count") ?? "1"),',
    "        ...(file ? { file: JSON.parse(file) } : {}),",
    '        delayMs: Number(read("--delay-ms") ?? "0"),',
    '        interact: args.includes("--interact"),',
    '        useRelated: args.includes("--use-related"),',
    "      };",
    "    },",
    "  })],",
    "});",
    "export { fixtureProject as workflow };",
    "export default fixtureProject;",
    "",
  ].join("\n"), "utf8");
  return projectDir;
}

async function createConversationProject(): Promise<string> {
  const projectDir = await createTemporaryDirectory("steamharness-mcp-conversation-");
  await writeFile(path.join(projectDir, "package.json"), JSON.stringify({
    id: "22222222-2222-4222-8222-222222222222",
    name: "@steamharness/mcp-test-conversation",
    type: "module",
    devDependencies: { "steamharness": await resolveHarnessVersion() },
    steamHarness: { projectInfo: { dataStorage: { mode: "local" } } },
  }), "utf8");
  await writeFile(path.join(projectDir, "index.ts"), [
    'const conversationProject = steamharness.defineProject({ name: "conversation", run(input) { return input; } });',
    "export const executor = steamharness.defineExecutor({",
    '  projectType: "conversation", workflow: conversationProject, params: [], createInput() { return {}; },',
    "});",
    "export { conversationProject as workflow };",
    "export default conversationProject;",
    "",
  ].join("\n"), "utf8");
  return projectDir;
}

async function createRelatedProject(): Promise<string> {
  const projectDir = await createTemporaryDirectory("steamharness-mcp-related-");
  await writeFile(path.join(projectDir, "package.json"), JSON.stringify({
    id: "33333333-3333-4333-8333-333333333333",
    name: "@steamharness/mcp-test-related",
    type: "module",
    steamHarness: {
      projectInfo: {
        dataStorage: { mode: "local" },
        relatedProjects: [{
          alias: "consumer",
          projectId: "11111111-1111-4111-8111-111111111111",
          grantToRelatedProject: {
            read: { mode: "all" },
            write: { mode: "all" },
          },
        }],
      },
    },
  }), "utf8");
  return projectDir;
}

async function createTemporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function isMcpErrorCode(error: unknown, code: number): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: unknown }).code === code;
}

async function readStreamAfterClose(stream: Stream | null): Promise<string> {
  if (!stream) return "";
  let value = "";
  stream.on("data", (chunk: Buffer | string) => {
    value += chunk.toString();
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  return value;
}
