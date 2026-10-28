import { writeProjectFixture } from '../../scripts/test-project-fixture.mjs';
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  analyzeProjectScriptSource,
  inspectProjectScripts,
  inspectProjectStructure,
  validateProjectScriptSource,
} from "../executor/rules";
import { runLocalProjectWithReport } from "../executor/index";

test("executor projectType is extracted as the structure mode", () => {
  const projectAnalysis = analyzeProjectScriptSource(createExecutorSource('projectType: "workflow",'));
  const conversationAnalysis = analyzeProjectScriptSource(createExecutorSource(`
    projectType: "conversation",
    conversation: { attachments: { images: true } },
  `));

  assert.equal(projectAnalysis.executorProjectType, "workflow");
  assert.equal(conversationAnalysis.executorProjectType, "conversation");
  assert.deepEqual(conversationAnalysis.executorConversation, {
    attachments: { images: true },
  });
});

test("quoted executor project type and conversation keys are extracted", () => {
  const analysis = analyzeProjectScriptSource(createExecutorSource(`
    "projectType": "conversation",
    "conversation": { "attachments": { images: true } },
  `));

  assert.equal(analysis.executorProjectType, "conversation");
  assert.deepEqual(analysis.executorConversation, {
    attachments: { images: true },
  });
});

test("missing and unknown executor project types are rejected", () => {
  const missing = analyzeProjectScriptSource(createExecutorSource(""));
  const unknown = analyzeProjectScriptSource(createExecutorSource('projectType: "agent",'));

  assert.equal(missing.executorProjectType, undefined);
  assert.equal(unknown.executorProjectType, undefined);
  assert.equal(missing.executorConfigurationViolations.length, 1);
  assert.equal(unknown.executorConfigurationViolations.length, 1);
});

test("static validation only rejects a missing executor and defers dynamic configuration", () => {
  const noExecutor = validateProjectScriptSource(`
    export const demoProject = steamharness.defineProject({
      name: "demo",
      run() { return { errCode: 0, errMessage: "" }; },
    });
  `);
  const dynamicExecutor = analyzeProjectScriptSource(`
    const demoProject = steamharness.defineProject({
      name: "demo",
      run() { return { errCode: 0, errMessage: "" }; },
    });
    const config = {
      projectType: "workflow",
      workflow: demoProject,
      createInput() { return { errCode: 0, errMessage: "" }; },
    };
    export const executor = steamharness.defineExecutor(config);
  `);

  assert.equal(
    noExecutor.some((violation) =>
      violation.type === "invalid_executor_project_type" &&
      /must export steamharness\.defineExecutor/.test(violation.message)
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
  const projectDir = await mkdtemp(path.join(tmpdir(), "steamharness-project-type-no-executor-"));
  try {
    await writeFile(path.join(projectDir, "index.ts"), `
      export const demoProject = steamharness.defineProject({
        name: "demo",
        run() { return { errCode: 0, errMessage: "" }; },
      });
    `, "utf8");

    const inspection = inspectProjectScripts({
      cwd: projectDir,
      projectDir,
      projectName: "no-executor",
    });

    assert.equal(
      inspection.violations.some((violation) =>
        violation.type === "invalid_executor_project_type" && violation.name === "executor"
      ),
      true,
    );
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("legacy conversation settings produce warnings instead of blocking execution", () => {
  const legacy = analyzeProjectScriptSource(createExecutorSource(`
    projectType: "conversation",
    conversation: { enabled: true },
  `));
  const conflict = analyzeProjectScriptSource(createExecutorSource(`
    projectType: "workflow",
    conversation: { inputQueue: { enabled: true } },
  `));

  assert.equal(legacy.executorConfigurationViolations.length, 0);
  assert.equal(conflict.executorConfigurationViolations.length, 0);
  assert.equal(legacy.structureWarnings.some((warning) => /conversation\.enabled/.test(warning.message)), true);
  assert.equal(conflict.structureWarnings.some((warning) => /ignored/.test(warning.message)), true);

  const quotedLegacy = analyzeProjectScriptSource(createExecutorSource(`
    "projectType": "conversation",
    "conversation": { "enabled": true },
  `));
  assert.equal(quotedLegacy.structureWarnings.some((warning) => /conversation\.enabled/.test(warning.message)), true);
});

test("structure inspection warns about conflicting executor project types across files", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "steamharness-project-type-conflict-"));
  try {
    await Promise.all([
      writeFile(path.join(projectDir, "index.ts"), createExecutorSource('projectType: "workflow",'), "utf8"),
      writeFile(path.join(projectDir, "secondary.ts"), createExecutorSource('projectType: "conversation",'), "utf8"),
    ]);

    const inspection = inspectProjectStructure({
      cwd: projectDir,
      projectDir,
      projectName: "conflicting-project-types",
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
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("runtime rejects a conversation executor without projectType", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "steamharness-project-type-legacy-runtime-"));
  try {
    await Promise.all([
      writeProjectFixture(path.join(projectDir, "package.json"), JSON.stringify({
        id: "11111111-1111-4111-8111-111111111111",
        name: "legacy-conversation-runtime",
        version: "0.1.0",
        type: "module",
        defaultEntry:"main",entries:[{entryId:"main",type:"workflow",name:"Main",root:".",entry:"index.ts",databases:[]}], projectInfo:{},
      }), "utf8"),
      writeFile(path.join(projectDir, "index.ts"), `
        const legacyProject = steamharness.defineProject({
          name: "legacy-conversation-runtime",
          async run(_input, context) {
            return {
              errCode: 0,
              errMessage: "",
              conversationEnabled: context.conversation.enabled,
            };
          },
        });
        export const executor = steamharness.defineExecutor({
          conversation: { enabled: true },
          workflow: legacyProject,
          createInput() { return { errCode: 0, errMessage: "" }; },
        });
        export default legacyProject;
      `, "utf8"),
    ]);

    const report = await runLocalProjectWithReport({
      projectDir,
      projectName: "legacy-conversation-runtime",
      conversationId: "legacy-thread",
    });

    assert.equal(report.status, "failed");
    assert.match(JSON.stringify(report.result), /script validation failed/);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("runtime rejects a Workflow executor without projectType", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "steamharness-project-type-entrypoint-runtime-"));
  try {
    await Promise.all([
      writeProjectFixture(path.join(projectDir, "package.json"), JSON.stringify({
        id: "22222222-2222-4222-8222-222222222222",
        name: "inferred-workflow-runtime",
        version: "0.1.0",
        type: "module",
        defaultEntry:"main",entries:[{entryId:"main",type:"workflow",name:"Main",root:".",entry:"index.ts",databases:[]}], projectInfo:{},
      }), "utf8"),
      writeFile(path.join(projectDir, "index.ts"), `
        const inferredProject = steamharness.defineProject({
          name: "inferred-workflow-runtime",
          async run() { return { errCode: 0, errMessage: "", inferred: true }; },
        });
        export const executor = steamharness.defineExecutor({
          defaultEntrypoint: "main",
          entrypoints: [steamharness.defineEntrypoint({
            id: "main",
            title: "Main",
            workflow: inferredProject,
            createInput() { return { errCode: 0, errMessage: "" }; },
          })],
        });
        export default inferredProject;
      `, "utf8"),
    ]);

    const report = await runLocalProjectWithReport({
      projectDir,
      projectName: "inferred-workflow-runtime",
    });

    assert.equal(report.status, "failed");
    assert.match(JSON.stringify(report.result), /script validation failed/);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("projectType alone controls runtime conversation context", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "steamharness-project-type-runtime-"));
  const projectDir = path.join(rootDir, "workflow");
  const conversationDir = path.join(rootDir, "conversation");

  try {
    await Promise.all([
      writeRuntimeProject(projectDir, "workflow"),
      writeRuntimeProject(conversationDir, "conversation"),
    ]);

    const [projectReport, conversationReport] = await Promise.all([
      runLocalProjectWithReport({
        projectDir,
        projectName: "workflow-mode",
        conversationId: "ignored-thread",
      }),
      runLocalProjectWithReport({
        projectDir: conversationDir,
        projectName: "conversation-mode",
        conversationId: "active-thread",
      }),
    ]);

    assert.equal(projectReport.result.ok, true);
    assert.equal(conversationReport.result.ok, true);
    if (!projectReport.result.ok || !conversationReport.result.ok) return;
    const projectOutput = (projectReport.result.data as {
      output?: Record<string, unknown>;
    }).output;
    const conversationOutput = (conversationReport.result.data as {
      output?: Record<string, unknown>;
    }).output;
    assert.equal(projectOutput?.["conversationEnabled"], false);
    assert.equal(projectOutput?.["conversationId"], undefined);
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
  const projectDir = await mkdtemp(path.join(tmpdir(), "steamharness-project-type-legacy-"));
  try {
    await Promise.all([
      writeProjectFixture(path.join(projectDir, "package.json"), JSON.stringify({
        id: "33333333-3333-4333-8333-333333333333",
        name: "legacy-runtime",
        version: "0.1.0",
        type: "module",
        defaultEntry:"main",entries:[{entryId:"main",type:"workflow",name:"Main",root:".",entry:"index.ts",databases:[]}], projectInfo:{},
      }), "utf8"),
      writeFile(path.join(projectDir, "index.ts"), `
        export const projectType = "workflow";
        export const workflow = globalThis.steamharness.defineProject({
          name: "legacy-runtime",
          run() { return { errCode: 0, errMessage: "" }; },
        });
        export function createInput() {
          return { errCode: 0, errMessage: "" };
        }
        export default workflow;
      `, "utf8"),
    ]);

    const report = await runLocalProjectWithReport({
      projectDir,
      projectName: "legacy-runtime",
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
    await rm(projectDir, { recursive: true, force: true });
  }
});

function createExecutorSource(configuration: string): string {
  const execution = /projectType\s*:\s*["']workflow["']/.test(configuration)
    ? `
      defaultEntrypoint: "main",
      entrypoints: [steamharness.defineEntrypoint({
        id: "main",
        title: "Main",
        workflow: demoProject,
        createInput() { return { errCode: 0, errMessage: "" }; },
      })],`
    : `
      workflow: demoProject,
      createInput() { return { errCode: 0, errMessage: "" }; },`;
  return `
    const demoProject = steamharness.defineProject({
      name: "demo",
      run() { return { errCode: 0, errMessage: "" }; },
    });
    export const executor = steamharness.defineExecutor({
      ${configuration}
      ${execution}
    });
  `;
}

async function writeRuntimeProject(
  projectDir: string,
  projectType: "workflow" | "conversation",
): Promise<void> {
  await mkdir(projectDir, { recursive: true });
  await Promise.all([
    writeProjectFixture(path.join(projectDir, "package.json"), JSON.stringify({
      id: projectType === "workflow"
        ? "44444444-4444-4444-8444-444444444444"
        : "55555555-5555-4555-8555-555555555555",
      name: `${projectType}-mode`,
      version: "0.1.0",
      type: "module",
      defaultEntry:"main",entries:[{entryId:"main",type:projectType,name:"Main",root:".",entry:"index.ts",databases:[]}], projectInfo:{},
    }), "utf8"),
    writeFile(path.join(projectDir, "index.ts"), `
      const runtimeProject = steamharness.defineProject({
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
      export const executor = steamharness.defineExecutor({
        projectType: "${projectType}",
        ${projectType === "workflow" ? `
        defaultEntrypoint: "main",
        entrypoints: [steamharness.defineEntrypoint({
          id: "main",
          title: "Main",
          workflow: runtimeProject,
          createInput() { return { errCode: 0, errMessage: "" }; },
        })],` : `
        workflow: runtimeProject,
        createInput() { return { errCode: 0, errMessage: "" }; },`}
      });
      export default runtimeProject;
    `, "utf8"),
  ]);
}
