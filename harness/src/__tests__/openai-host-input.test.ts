import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  readOpenAIConversationHostInput,
  resolveLocalWorkflowParams,
  resolveWorkspaceWorkflowParams,
  runLocalWorkflowWithReport,
  runWorkspaceWorkflowWithReport,
  WorkflowError,
  type OpenAIConversationHostInput,
} from "../index";

const hostInput: OpenAIConversationHostInput = {
  kind: "openai.responses",
  requestId: "req_test",
  responseId: "resp_test",
  projectId: "11111111-1111-4111-8111-111111111111",
  model: "provider/model",
  messages: [
    {
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: "Default to Chinese." }],
    },
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "hello" }],
    },
  ],
  settings: { temperature: 0.2, verbosity: "high" },
};

test("OpenAI host input is typed, rejects malformed OpenAI payloads, and ignores other hosts", () => {
  assert.equal(readOpenAIConversationHostInput({ hostInput }), hostInput);
  assert.equal(readOpenAIConversationHostInput({ hostInput: { kind: "another-host" } }), undefined);
  assert.throws(
    () => readOpenAIConversationHostInput({ hostInput: { kind: "openai.responses" } }),
    (error: unknown) => error instanceof WorkflowError && /host input is invalid/u.test(error.message),
  );
});

test("local and workspace execution plus param resolution receive hostInput", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "steamharness-openai-host-input-"));
  const workflowName = "openai-host-input";
  const workflowDir = path.join(cwd, "workspace", "workflow", workflowName);
  try {
    await mkdir(workflowDir, { recursive: true });
    await writeFile(path.join(workflowDir, "package.json"), JSON.stringify({
      id: hostInput.projectId,
      name: workflowName,
      version: "0.1.0",
      type: "module",
      steamHarness: { projectInfo: { dataStorage: { mode: "local" } } },
    }), "utf8");
    await writeFile(path.join(workflowDir, "index.ts"), `
      const openaiWorkflow = workflow.defineWorkflow({
        name: "openai-host-input",
        run(input, context) {
          return {
            ...input,
            contextModel: context.metadata?.hostModel,
          };
        },
      });
      export const executor = workflow.defineExecutor({
        projectType: "conversation",
        workflow: openaiWorkflow,
        conversation: { openai: { enabled: true, outputItemId: "assistant-response" } },
        params: [{ kind: "auxiliary", id: "options", label: "Options", fields: [{ name: "modelEcho", flag: "--model", type: "string" }] }],
        createInput(context) {
          const input = workflow.readOpenAIConversationHostInput(context);
          return {
            errCode: 0,
            errMessage: "",
            responseId: input?.responseId,
            model: input?.model,
            verbosity: input?.settings.verbosity,
          };
        },
        resolveParams(context) {
          const input = workflow.readOpenAIConversationHostInput(context);
          return { params: { modelEcho: { value: input?.model ?? "missing" } } };
        },
        createContext(context) {
          const input = workflow.readOpenAIConversationHostInput(context);
          return { metadata: { hostModel: input?.model } };
        },
      });
      export default openaiWorkflow;
    `, "utf8");

    const local = await runLocalWorkflowWithReport({ workflowDir, hostInput });
    const workspace = await runWorkspaceWorkflowWithReport({ cwd, workflowName, hostInput });
    for (const report of [local, workspace]) {
      assert.equal(report.status, "success");
      assert.match(JSON.stringify(report.result), /resp_test/u);
      assert.match(JSON.stringify(report.result), /provider\/model/u);
      assert.match(JSON.stringify(report.result), /high/u);
    }

    const request = {
      args: [],
      draftText: "",
      inputMode: "form" as const,
      trigger: { kind: "init" as const },
    };
    assert.deepEqual(await resolveLocalWorkflowParams({ workflowDir, hostInput, request }), {
      params: { modelEcho: { value: "provider/model" } },
    });
    assert.deepEqual(await resolveWorkspaceWorkflowParams({ cwd, workflowName, hostInput, request }), {
      params: { modelEcho: { value: "provider/model" } },
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
