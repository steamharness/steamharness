import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspectLocalWorkflowStructure, HarnessError } from "../index";

test("Workflow structure exposes validated schedule presets", async () => {
  const workflowDir = await createScriptProject("workflow", {
    schedulePresets: [{
      id: "market-sync",
      title: "Market sync",
      entrypointId: "main",
      timezone: "Asia/Shanghai",
      trigger: {
        kind: "window-interval",
        weekdays: [1, 2, 3, 4, 5],
        windows: [{ start: "09:30", end: "11:30" }],
        intervalMinutes: 5,
      },
      paramValues: { symbols: "000725.SZ" },
    }],
  });
  try {
    const report = inspectLocalWorkflowStructure({ workflowDir });
    assert.deepEqual(report.schedulePresets, [{
      id: "market-sync",
      title: "Market sync",
      entrypointId: "main",
      timezone: "Asia/Shanghai",
      trigger: {
        kind: "window-interval",
        weekdays: [1, 2, 3, 4, 5],
        windows: [{ start: "09:30", end: "11:30" }],
        intervalMinutes: 5,
      },
      paramValues: { symbols: "000725.SZ" },
    }]);
  } finally {
    await rm(workflowDir, { recursive: true, force: true });
  }
});

test("schedule presets must reference an existing Workflow entrypoint", async () => {
  const workflowDir = await createScriptProject("workflow", {
    schedulePresets: [{
      id: "invalid",
      title: "Invalid",
      entrypointId: "missing",
      timezone: "UTC",
      trigger: { kind: "cron", expression: "0 9 * * 1-5" },
      paramValues: {},
    }],
  });
  try {
    assert.throws(
      () => inspectLocalWorkflowStructure({ workflowDir }),
      (error: unknown) => error instanceof HarnessError && /unknown entrypoint/.test(error.message),
    );
  } finally {
    await rm(workflowDir, { recursive: true, force: true });
  }
});

test("schedule presets must satisfy the selected entrypoint static params", async () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{}, /symbols is required/],
    [{ symbols: "000725.SZ", unknown: true }, /unknown parameter.*unknown/],
    [{ symbols: "000725.SZ", limit: "many" }, /limit must be a number/],
    [{ symbols: "000725.SZ", period: "monthly" }, /unsupported option "monthly"/],
    [{ symbols: "000725.SZ", date: "2026-02-30" }, /date must use YYYY-MM-DD/],
  ];
  for (const [paramValues, expected] of cases) {
    const workflowDir = await createScriptProject("workflow", {
      schedulePresets: [{
        id: "invalid-params",
        title: "Invalid params",
        entrypointId: "main",
        timezone: "UTC",
        trigger: { kind: "cron", expression: "0 9 * * 1-5" },
        paramValues,
      }],
    });
    try {
      assert.throws(
        () => inspectLocalWorkflowStructure({ workflowDir }),
        (error: unknown) => error instanceof HarnessError && expected.test(error.message),
      );
    } finally {
      await rm(workflowDir, { recursive: true, force: true });
    }
  }
});

test("Conversation and Kanban projects reject schedule presets", async () => {
  const conversationDir = await createScriptProject("conversation", {
    schedulePresets: [],
  });
  const kanbanDir = await mkdtemp(path.join(os.tmpdir(), "workflow-schedule-kanban-"));
  await Promise.all([
    writeFile(path.join(kanbanDir, "package.json"), JSON.stringify({
      id: "schedule-kanban",
      name: "Schedule Kanban",
      version: "0.1.0",
      steamHarness: {
        projectType: "kanban",
        schedulePresets: [],
        kanban: { artifactDir: "dist", entry: "index.html" },
      },
    })),
    mkdir(path.join(kanbanDir, "dist"), { recursive: true }).then(() =>
      writeFile(path.join(kanbanDir, "dist", "index.html"), "<!doctype html>")),
  ]);
  try {
    assert.throws(() => inspectLocalWorkflowStructure({ workflowDir: conversationDir }), /Only Workflow/);
    assert.throws(() => inspectLocalWorkflowStructure({ workflowDir: kanbanDir }), /Only Workflow/);
  } finally {
    await Promise.all([
      rm(conversationDir, { recursive: true, force: true }),
      rm(kanbanDir, { recursive: true, force: true }),
    ]);
  }
});

async function createScriptProject(
  projectType: "workflow" | "conversation",
  steamHarness: Record<string, unknown>,
): Promise<string> {
  const workflowDir = await mkdtemp(path.join(os.tmpdir(), "workflow-schedule-project-"));
  await Promise.all([
    writeFile(path.join(workflowDir, "package.json"), JSON.stringify({
      name: "schedule-project",
      version: "0.1.0",
      type: "module",
      steamHarness,
    })),
    writeFile(path.join(workflowDir, "index.ts"), projectType === "workflow" ? `
      const main = workflow.defineWorkflow({
        name: "main",
        run(input) { return input; },
      });
      export const executor = workflow.defineExecutor({
        projectType: "workflow",
        defaultEntrypoint: "main",
        entrypoints: [workflow.defineEntrypoint({
          id: "main",
          title: "Main",
          workflow: main,
          params: [
            { name: "symbols", flag: "--symbols", type: "string", required: true },
            { name: "limit", flag: "--limit", type: "number" },
            {
              name: "period",
              flag: "--period",
              type: "string",
              options: [{ value: "daily" }, { value: "weekly" }],
            },
            { name: "date", flag: "--date", type: "string", control: "date" },
          ],
          createInput() { return { errCode: 0, errMessage: "" }; },
        })],
      });
    ` : `
      const main = workflow.defineWorkflow({
        name: "main",
        run(input) { return input; },
      });
      export const executor = workflow.defineExecutor({
        projectType: "conversation",
        workflow: main,
        createInput() { return { errCode: 0, errMessage: "" }; },
      });
    `),
  ]);
  return workflowDir;
}
