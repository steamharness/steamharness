import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  analyzeProjectScriptSource,
  runLocalProjectWithReport,
} from "../index";

test("tool approval honors executor defaults, host overrides, waiting approval and resume", async () => {
  const projectDir = await createToolApprovalProject();

  const autoApproved = await runLocalProjectWithReport({
    projectDir,
    args: ["--tool", "search"],
  });
  assert.equal(autoApproved.status, "success");
  assertSuccessfulToolResult(autoApproved.result, "search", "search:ran");

  const disabledByDefault = await runLocalProjectWithReport({
    projectDir,
    args: ["--tool", "write"],
  });
  assert.equal(disabledByDefault.status, "failed");
  assertReportedToolDenial(disabledByDefault.result, "Tool \"write\" is disabled");

  const enabledByHost = await runLocalProjectWithReport({
    projectDir,
    args: ["--tool", "write"],
    toolPermissionPolicies: {
      write: { enabled: true, autoApprove: true },
      unknown: { enabled: true, autoApprove: true },
    },
  });
  assert.equal(enabledByHost.status, "success");
  assertSuccessfulToolResult(enabledByHost.result, "write", "write:ran");

  const waiting = await runLocalProjectWithReport({
    projectDir,
    runId: "run-approval",
    args: ["--tool", "review"],
    toolPermissionPolicies: {
      review: { enabled: true, autoApprove: false },
    },
    userInput: {
      getResolvedInput() {
        return undefined;
      },
      requestInput() {
        return undefined;
      },
    },
  });
  assert.equal(waiting.status, "waiting_for_input");
  assert.equal(waiting.pendingUserInput?.nodeName, "tool-approval");
  assert.equal(waiting.pendingUserInput?.metadata?.type, "tool-approval");
  assert.equal(waiting.pendingUserInput?.metadata?.toolName, "review");
  assert.equal(waiting.pendingUserInput?.params[0]?.name, "approved");

  const approved = await runLocalProjectWithReport({
    projectDir,
    runId: "run-approval",
    args: ["--tool", "review"],
    toolPermissionPolicies: {
      review: { enabled: true, autoApprove: false },
    },
    userInput: {
      getResolvedInput(requestId, request) {
        return {
          requestId,
          nodeName: request?.nodeName ?? "tool-approval",
          values: { approved: true },
          submittedAt: new Date("2026-06-15T00:00:00.000Z"),
          request,
        };
      },
      requestInput() {
        throw new Error("requestInput should not run after approval.");
      },
    },
  });
  assert.equal(approved.status, "success");
  assertSuccessfulToolResult(approved.result, "review", "review:ran");

  const rejected = await runLocalProjectWithReport({
    projectDir,
    args: ["--tool", "review"],
    toolPermissionPolicies: {
      review: { enabled: true, autoApprove: false },
    },
    userInput: {
      getResolvedInput(requestId, request) {
        return {
          requestId,
          nodeName: request?.nodeName ?? "tool-approval",
          values: { approved: false },
          submittedAt: new Date("2026-06-15T00:00:00.000Z"),
          request,
        };
      },
      requestInput() {
        throw new Error("requestInput should not run after rejection.");
      },
    },
  });
  assert.equal(rejected.status, "failed");
  assertReportedToolDenial(rejected.result, "Tool \"review\" was rejected");
});

test("workflow structure extracts executor tool registrations", () => {
  const analysis = analyzeProjectScriptSource(`
    export const executor = steamharness.defineExecutor({
      projectType: "workflow",
      defaultEntrypoint: "main",
      entrypoints: [steamharness.defineEntrypoint({
        id: "main", title: "Main", workflow: demo,
        tools: [
          { name: "search", label: "Search", description: "Find data", enabled: true, autoApprove: false },
        ],
        createInput() { return {}; },
      })],
    });
  `);

  assert.deepEqual(analysis.executorEntrypoints?.[0]?.tools, [
    {
      name: "search",
      label: "Search",
      description: "Find data",
      enabled: true,
      autoApprove: false,
    },
  ]);
});

test("local workflow reports preserve aborted status and terminal events", async () => {
  const projectDir = await createToolApprovalProject();
  const controller = new AbortController();
  const eventTypes: string[] = [];

  const report = await runLocalProjectWithReport({
    projectDir,
    abortSignal: controller.signal,
    onRuntimeEvent(event) {
      eventTypes.push(event.type);
      if (event.type === "project_started") {
        controller.abort(new Error("Cancelled by test."));
      }
    },
  });

  assert.equal(report.status, "aborted");
  assert.equal((report.result.ok ? report.result.data as { errCode?: number } : {}).errCode, 499);
  assert.deepEqual(eventTypes, ["project_started", "project_aborted"]);
});

async function createToolApprovalProject(): Promise<string> {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "steamharness-tool-approval-"));

  await writeFile(
    path.join(projectDir, "package.json"),
    JSON.stringify({
      id: "11111111-1111-4111-8111-111111111111",
      name: "@steamharness/tool-approval-test",
      type: "module",
      steamHarness: { projectInfo: { dataStorage: { mode: "local" } } },
    }),
  );
  await writeFile(
    path.join(projectDir, "interface.ts"),
    [
      "export interface RunPayload { errCode: number; errMessage: string; }",
      "export interface ToolApprovalPayload extends RunPayload { tool: string; value: string; }",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(projectDir, "index.ts"),
    [
      "import type { ToolApprovalPayload } from \"./interface\";",
      "",
      "interface ToolInput { tool: string; }",
      "const approval = steamharness.createToolApprovalGate();",
      "const tools = {",
      "  search: approval.wrap(\"search\", () => \"search:ran\"),",
      "  write: approval.wrap(\"write\", () => \"write:ran\"),",
      "  review: approval.wrap(\"review\", () => \"review:ran\"),",
      "};",
      "",
      "export const toolApprovalProject = steamharness.defineProject<ToolInput, ToolApprovalPayload>({",
      "  name: \"tool-approval-test\",",
      "  async run(input, context) {",
      "    const runTool = tools[input.tool as keyof typeof tools];",
      "    const value = await runTool(context);",
      "    return { errCode: 0, errMessage: \"\", tool: input.tool, value };",
      "  },",
      "});",
      "",
      "export const executor = steamharness.defineExecutor<ToolInput, ToolApprovalPayload>({",
      "  projectType: \"workflow\",",
      "  defaultEntrypoint: \"main\",",
      "  entrypoints: [steamharness.defineEntrypoint<ToolInput, ToolApprovalPayload>({",
      "    id: \"main\", title: \"Main\", workflow: toolApprovalProject,",
      "    tools: [",
      "    { name: \"search\", label: \"Search\", description: \"Search data\", enabled: true, autoApprove: true },",
      "    { name: \"write\", label: \"Write\", description: \"Write data\", enabled: false, autoApprove: false },",
      "    { name: \"review\", label: \"Review\", description: \"Review data\", enabled: true, autoApprove: false },",
      "    ],",
      "    createInput(context) {",
      "      const index = context.args.indexOf(\"--tool\");",
      "      return { tool: index >= 0 ? context.args[index + 1] ?? \"search\" : \"search\" };",
      "    },",
      "  })],",
      "});",
      "",
      "export { toolApprovalProject as workflow };",
      "export default toolApprovalProject;",
      "",
    ].join("\n"),
  );

  return projectDir;
}

function assertReportedToolDenial(
  result: Awaited<ReturnType<typeof runLocalProjectWithReport>>["result"],
  message: string,
) {
  assert.equal(result.ok, true);
  const data = result.data as {
    errCode?: number;
    errMessage?: string;
    output?: unknown;
  };
  assert.equal(data.errCode, 403);
  assert.match(data.errMessage ?? "", new RegExp(escapeRegExp(message)));
  assert.equal(data.output, null);
}

function assertSuccessfulToolResult(
  result: Awaited<ReturnType<typeof runLocalProjectWithReport>>["result"],
  tool: string,
  value: string,
) {
  assert.equal(result.ok, true);
  const data = result.data as {
    errCode?: number;
    errMessage?: string;
    output?: {
      errCode?: number;
      errMessage?: string;
      tool?: string;
      value?: string;
      items?: unknown[];
    };
  };
  assert.equal(data.errCode, 0);
  assert.equal(data.errMessage, "");
  assert.equal(data.output?.errCode, 0);
  assert.equal(data.output?.errMessage, "");
  assert.equal(data.output?.tool, tool);
  assert.equal(data.output?.value, value);
  assert.equal(Array.isArray(data.output?.items), true);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
