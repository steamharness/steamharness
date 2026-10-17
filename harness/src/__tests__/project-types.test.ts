import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  analyzeWorkflowScriptSource,
  inspectWorkflowScripts,
  inspectWorkflowStructure,
  validateWorkflowScriptSource,
} from "../executor/rules";
import { runLocalWorkflowWithReport } from "../executor/index";

test("executor projectType is extracted as the structure mode", () => {
  const workflowAnalysis = analyzeWorkflowScriptSource(createExecutorSource('projectType: "workflow",'));
  const conversationAnalysis = analyzeWorkflowScriptSource(createExecutorSource(`
    projectType: "conversation",
    conversation: { attachments: { images: true } },
  `));

  assert.equal(workflowAnalysis.executorProjectType, "workflow");
  assert.equal(conversationAnalysis.executorProjectType, "conversation");
  assert.deepEqual(conversationAnalysis.executorConversation, {
    attachments: { images: true },
  });
});

test("quoted executor project type and conversation keys are extracted", () => {
  const analysis = analyzeWorkflowScriptSource(createExecutorSource(`
    "projectType": "conversation",
    "conversation": { "attachments": { images: true } },
  `));

  assert.equal(analysis.executorProjectType, "conversation");
  assert.deepEqual(analysis.executorConversation, {
    attachments: { images: true },
  });
});

test("missing and unknown executor project types use compatibility inference", () => {
  const missing = analyzeWorkflowScriptSource(createExecutorSource(""));
  const unknown = analyzeWorkflowScriptSource(createExecutorSource('projectType: "agent",'));

  assert.equal(missing.executorProjectType, "conversation");
  assert.equal(unknown.executorProjectType, "conversation");
  assert.equal(missing.executorConfigurationViolations.length, 0);
  assert.equal(unknown.executorConfigurationViolations.length, 0);
  assert.equal(missing.structureWarnings.some((warning) => /inferred/.test(warning.message)), true);
  assert.equal(unknown.structureWarnings.some((warning) => /inferred/.test(warning.message)), true);
});

test("static validation only rejects a missing executor and defers dynamic configuration", () => {
  const noExecutor = validateWorkflowScriptSource(`
    export const demoWorkflow = workflow.defineWorkflow({
      name: "demo",
      run() { return { errCode: 0, errMessage: "" }; },
    });
  `);
  const dynamicExecutor = analyzeWorkflowScriptSource(`
    const demoWorkflow = workflow.defineWorkflow({
      name: "demo",
      run() { return { errCode: 0, errMessage: "" }; },
    });
    const config = {
      projectType: "workflow",
      workflow: demoWorkflow,
      createInput() { return { errCode: 0, errMessage: "" }; },
    };
    export const executor = workflow.defineExecutor(config);
  `);

  assert.equal(
    noExecutor.some((violation) =>
      violation.type === "invalid_executor_project_type" &&
      /must export workflow\.defineExecutor/.test(violation.message)
    ),
    true,
  );
  assert.equal(
    dynamicExecutor.executorConfigurationViolations.length,
    0,
  );
  assert.equal(
    dynamicExecutor.structureWarnings.some((warning) => /resolved at runtime/.test(warning.message)),
    true,
  );
});

test("workflow script inspection rejects a project without an executor", async () => {
  const workflowDir = await mkdtemp(path.join(tmpdir(), "workflow-project-type-no-executor-"));
  try {
    await writeFile(path.join(workflowDir, "index.ts"), `
      export const demoWorkflow = workflow.defineWorkflow({
        name: "demo",
        run() { return { errCode: 0, errMessage: "" }; },
      });
    `, "utf8");

    const inspection = inspectWorkflowScripts({
      cwd: workflowDir,
      workflowDir,
      workflowName: "no-executor",
    });

    assert.equal(
      inspection.violations.some((violation) =>
        violation.type === "invalid_executor_project_type" && violation.name === "executor"
      ),
      true,
    );
  } finally {
    await rm(workflowDir, { recursive: true, force: true });
  }
});

test("legacy conversation settings produce warnings instead of blocking execution", () => {
  const legacy = analyzeWorkflowScriptSource(createExecutorSource(`
    projectType: "conversation",
    conversation: { enabled: true },
  `));
  const conflict = analyzeWorkflowScriptSource(createExecutorSource(`
    projectType: "workflow",
    conversation: { inputQueue: { enabled: true } },
  `));

  assert.equal(legacy.executorConfigurationViolations.length, 0);
  assert.equal(conflict.executorConfigurationViolations.length, 0);
  assert.equal(legacy.structureWarnings.some((warning) => /conversation\.enabled/.test(warning.message)), true);
  assert.equal(conflict.structureWarnings.some((warning) => /ignored/.test(warning.message)), true);

  const quotedLegacy = analyzeWorkflowScriptSource(createExecutorSource(`
    "projectType": "conversation",
    "conversation": { "enabled": true },
  `));
  assert.equal(quotedLegacy.structureWarnings.some((warning) => /conversation\.enabled/.test(warning.message)), true);
});

test("structure inspection warns about conflicting executor project types across files", async () => {
  const workflowDir = await mkdtemp(path.join(tmpdir(), "workflow-project-type-conflict-"));
  try {
    await Promise.all([
      writeFile(path.join(workflowDir, "index.ts"), createExecutorSource('projectType: "workflow",'), "utf8"),
      writeFile(path.join(workflowDir, "secondary.ts"), createExecutorSource('projectType: "conversation",'), "utf8"),
    ]);

    const inspection = inspectWorkflowStructure({
      cwd: workflowDir,
      workflowDir,
      workflowName: "conflicting-project-types",
    });
    assert.equal(
      inspection.diagnostics.violations.length,
      0,
    );
    assert.equal(
      inspection.diagnostics.warnings.some((warning) =>
        /conflicting executor project types/.test(warning.message)
      ),
      true,
    );
  } finally {
    await rm(workflowDir, { recursive: true, force: true });
  }
});

test("runtime infers a legacy conversation executor without projectType", async () => {
  const workflowDir = await mkdtemp(path.join(tmpdir(), "workflow-project-type-legacy-runtime-"));
  try {
    await Promise.all([
      writeFile(path.join(workflowDir, "package.json"), JSON.stringify({
        id: "11111111-1111-4111-8111-111111111111",
        name: "legacy-conversation-runtime",
        version: "0.1.0",
        type: "module",
        workflowCode: { projectInfo: { dataStorage: { mode: "local" } } },
      }), "utf8"),
      writeFile(path.join(workflowDir, "index.ts"), `
        const legacyWorkflow = workflow.defineWorkflow({
          name: "legacy-conversation-runtime",
          async run(_input, context) {
            return {
              errCode: 0,
              errMessage: "",
              conversationEnabled: context.conversation.enabled,
            };
          },
        });
        export const executor = workflow.defineExecutor({
          conversation: { enabled: true },
          workflow: legacyWorkflow,
          createInput() { return { errCode: 0, errMessage: "" }; },
        });
        export default legacyWorkflow;
      `, "utf8"),
    ]);

    const report = await runLocalWorkflowWithReport({
      workflowDir,
      workflowName: "legacy-conversation-runtime",
      conversationId: "legacy-thread",
    });

    assert.equal(report.status, "success");
    assert.equal(report.result.ok, true);
    if (!report.result.ok) return;
    assert.equal((report.result.data as { output?: { conversationEnabled?: boolean } })
      .output?.conversationEnabled, true);
  } finally {
    await rm(workflowDir, { recursive: true, force: true });
  }
});

test("runtime infers a Workflow executor with entrypoints but no projectType", async () => {
  const workflowDir = await mkdtemp(path.join(tmpdir(), "workflow-project-type-entrypoint-runtime-"));
  try {
    await Promise.all([
      writeFile(path.join(workflowDir, "package.json"), JSON.stringify({
        id: "22222222-2222-4222-8222-222222222222",
        name: "inferred-workflow-runtime",
        version: "0.1.0",
        type: "module",
        workflowCode: { projectInfo: { dataStorage: { mode: "local" } } },
      }), "utf8"),
      writeFile(path.join(workflowDir, "index.ts"), `
        const inferredWorkflow = workflow.defineWorkflow({
          name: "inferred-workflow-runtime",
          async run() { return { errCode: 0, errMessage: "", inferred: true }; },
        });
        export const executor = workflow.defineExecutor({
          defaultEntrypoint: "main",
          entrypoints: [workflow.defineEntrypoint({
            id: "main",
            title: "Main",
            workflow: inferredWorkflow,
            createInput() { return { errCode: 0, errMessage: "" }; },
          })],
        });
        export default inferredWorkflow;
      `, "utf8"),
    ]);

    const report = await runLocalWorkflowWithReport({
      workflowDir,
      workflowName: "inferred-workflow-runtime",
    });

    assert.equal(report.status, "success");
    assert.equal(report.result.ok, true);
  } finally {
    await rm(workflowDir, { recursive: true, force: true });
  }
});

test("projectType alone controls runtime conversation context", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "workflow-project-type-runtime-"));
  const workflowDir = path.join(rootDir, "workflow");
  const conversationDir = path.join(rootDir, "conversation");

  try {
    await Promise.all([
      writeRuntimeProject(workflowDir, "workflow"),
      writeRuntimeProject(conversationDir, "conversation"),
    ]);

    const [workflowReport, conversationReport] = await Promise.all([
      runLocalWorkflowWithReport({
        workflowDir,
        workflowName: "workflow-mode",
        conversationId: "ignored-thread",
      }),
      runLocalWorkflowWithReport({
        workflowDir: conversationDir,
        workflowName: "conversation-mode",
        conversationId: "active-thread",
      }),
    ]);

    assert.equal(workflowReport.result.ok, true);
    assert.equal(conversationReport.result.ok, true);
    if (!workflowReport.result.ok || !conversationReport.result.ok) return;
    const workflowOutput = (workflowReport.result.data as {
      output?: Record<string, unknown>;
    }).output;
    const conversationOutput = (conversationReport.result.data as {
      output?: Record<string, unknown>;
    }).output;
    assert.equal(workflowOutput?.["conversationEnabled"], false);
    assert.equal(workflowOutput?.["conversationId"], undefined);
    assert.deepEqual({
      conversationEnabled: conversationOutput?.["conversationEnabled"],
      conversationId: conversationOutput?.["conversationId"],
    }, {
      conversationEnabled: true,
      conversationId: "active-thread",
    });
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("runtime reports static violations before server storage connection checks", async () => {
  const workflowDir = await mkdtemp(path.join(tmpdir(), "workflow-project-type-legacy-"));
  try {
    await Promise.all([
      writeFile(path.join(workflowDir, "package.json"), JSON.stringify({
        id: "33333333-3333-4333-8333-333333333333",
        name: "legacy-runtime",
        version: "0.1.0",
        type: "module",
        workflowCode: { projectInfo: { dataStorage: { mode: "server" } } },
      }), "utf8"),
      writeFile(path.join(workflowDir, "index.ts"), `
        export const projectType = "workflow";
        export const workflow = globalThis.workflow.defineWorkflow({
          name: "legacy-runtime",
          run() { return { errCode: 0, errMessage: "" }; },
        });
        export function createInput() {
          return { errCode: 0, errMessage: "" };
        }
        export default workflow;
      `, "utf8"),
    ]);

    const report = await runLocalWorkflowWithReport({
      workflowDir,
      workflowName: "legacy-runtime",
      env: {} as NodeJS.ProcessEnv,
    });

    assert.equal(report.status, "failed");
    assert.equal(report.result.ok, true);
    if (!report.result.ok) return;
    assert.match(
      String((report.result.data as { errMessage?: string }).errMessage),
      /script validation failed/,
    );
  } finally {
    await rm(workflowDir, { recursive: true, force: true });
  }
});

function createExecutorSource(configuration: string): string {
  const execution = /projectType\s*:\s*["']workflow["']/.test(configuration)
    ? `
      defaultEntrypoint: "main",
      entrypoints: [workflow.defineEntrypoint({
        id: "main",
        title: "Main",
        workflow: demoWorkflow,
        createInput() { return { errCode: 0, errMessage: "" }; },
      })],`
    : `
      workflow: demoWorkflow,
      createInput() { return { errCode: 0, errMessage: "" }; },`;
  return `
    const demoWorkflow = workflow.defineWorkflow({
      name: "demo",
      run() { return { errCode: 0, errMessage: "" }; },
    });
    export const executor = workflow.defineExecutor({
      ${configuration}
      ${execution}
    });
  `;
}

async function writeRuntimeProject(
  workflowDir: string,
  projectType: "workflow" | "conversation",
): Promise<void> {
  await mkdir(workflowDir, { recursive: true });
  await Promise.all([
    writeFile(path.join(workflowDir, "package.json"), JSON.stringify({
      id: projectType === "workflow"
        ? "44444444-4444-4444-8444-444444444444"
        : "55555555-5555-4555-8555-555555555555",
      name: `${projectType}-mode`,
      version: "0.1.0",
      type: "module",
      workflowCode: { projectInfo: { dataStorage: { mode: "local" } } },
    }), "utf8"),
    writeFile(path.join(workflowDir, "index.ts"), `
      const runtimeWorkflow = workflow.defineWorkflow({
        name: "${projectType}-mode",
        async run(_input, context) {
          return {
            errCode: 0,
            errMessage: "",
            conversationEnabled: context.conversation.enabled,
            ...(context.conversation.conversationId === undefined
              ? {}
              : { conversationId: context.conversation.conversationId }),
          };
        },
      });
      export const executor = workflow.defineExecutor({
        projectType: "${projectType}",
        ${projectType === "workflow" ? `
        defaultEntrypoint: "main",
        entrypoints: [workflow.defineEntrypoint({
          id: "main",
          title: "Main",
          workflow: runtimeWorkflow,
          createInput() { return { errCode: 0, errMessage: "" }; },
        })],` : `
        workflow: runtimeWorkflow,
        createInput() { return { errCode: 0, errMessage: "" }; },`}
      });
      export default runtimeWorkflow;
    `, "utf8"),
  ]);
}
