import { writeProjectFixture } from '../../scripts/test-project-fixture.mjs';
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspectLocalProjectStructure } from "../executor/index";
import { parseConversationDefaultInputArgs } from "../executor/default-input";
import { defineProjectExecutor } from "../executor/definition";
import { assertProjectParamDeclarations } from "../executor/param-definition";
import { analyzeProjectScriptSource } from "../executor/rules";
import { defineProject } from "../workflow/index";

test("parseConversationDefaultInputArgs reads fixed default composer flags", () => {
  const result = parseConversationDefaultInputArgs([
    "--message",
    "hello",
    "--images",
    JSON.stringify([{
      id: "wf-image",
      name: "hello.png",
      mimeType: "image/png",
      size: 12,
      kind: "image",
      storage: "server",
      createdAt: "2026-06-17T00:00:00.000Z",
    }]),
    "--files",
    JSON.stringify([{
      id: "wf-file",
      name: "spec.pdf",
      mimeType: "application/pdf",
      size: 24,
      kind: "file",
      storage: "path",
      path: "/tmp/spec.pdf",
      createdAt: "2026-06-17T00:00:00.000Z",
    }]),
    "--videos",
    JSON.stringify([{
      id: "wf-video",
      name: "clip.mp4",
      mimeType: "video/mp4",
      size: 36,
      kind: "file",
      storage: "server",
      createdAt: "2026-06-17T00:00:00.000Z",
    }]),
  ]);

  assert.equal(result.message, "hello");
  assert.equal(result.images.length, 1);
  assert.equal(result.images[0]?.id, "wf-image");
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0]?.id, "wf-file");
  assert.equal(result.videos.length, 1);
  assert.equal(result.videos[0]?.id, "wf-video");
});

test("parseConversationDefaultInputArgs accepts local path values for files and images", () => {
  const result = parseConversationDefaultInputArgs([
    "--images",
    "/tmp/test.png",
    "--files",
    "/tmp/spec.pdf",
  ]);

  assert.equal(result.message, "");
  assert.equal(result.images[0]?.storage, "path");
  assert.equal(result.images[0]?.path, "/tmp/test.png");
  assert.equal(result.files[0]?.storage, "path");
  assert.equal(result.files[0]?.path, "/tmp/spec.pdf");
});

test("conversation inputQueue is exposed through structure reports", async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "steamharness-conversation-input-"));
  try {
    await Promise.all([
      writeProjectFixture(path.join(projectDir, "package.json"), JSON.stringify({id:crypto.randomUUID(),defaultEntry:"main",entries:[{entryId:"main",name:"Main",type:"conversation",root:".",entry:"index.ts",databases:[]}],
        name: "conversation-structure-test",
        version: "0.1.0",
        type: "module",
      }), "utf8"),
      writeFile(path.join(projectDir, "index.ts"), `
        const conversationProject = steamharness.defineProject({
          name: "conversation",
          run(input) { return input; },
        });
        export const executor = steamharness.defineExecutor({
          projectType: "conversation",
          workflow: conversationProject,
          conversation: {
            inputQueue: { enabled: true },
            openai: { enabled: true, outputItemId: "assistant-response" },
            attachments: { images: true, videos: true, files: true },
          },
          createInput() { return { errCode: 0, errMessage: "" }; },
        });
        export { conversationProject as workflow };
        export default conversationProject;
      `, "utf8"),
    ]);

    const report = inspectLocalProjectStructure({ projectDir, projectName: "conversation" });
    assert.equal(report.projectType, "conversation");
    assert.equal("defaultInput" in (report.conversation ?? {}), false);
    assert.equal(report.conversation?.attachments?.videos, true);
    assert.equal(report.conversation?.inputQueue?.enabled, true);
    assert.deepEqual(report.conversation?.openai, {
      enabled: true,
      outputItemId: "assistant-response",
    });
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("Conversation needs no input setting and rejects removed input settings", () => {
  const definition = {
    projectType: "conversation" as const,
    workflow: defineProject({ name: "standard-input", run: (input: string) => input }),
    createInput: ({ args }: { args: string[] }) => parseConversationDefaultInputArgs(args).message,
  };
  assert.equal(defineProjectExecutor(definition), definition);
  for (const enabled of [true, false]) {
    assert.throws(() => defineProjectExecutor({
      ...definition,
      conversation: { defaultInput: { enabled } } as never,
    }), /conversation\.defaultInput was removed/);
    const analysis = analyzeProjectScriptSource(`steamharness.defineExecutor({
      projectType: "conversation", workflow: flow,
      conversation: { "defaultInput": { enabled: ${enabled} } },
      createInput() { return {}; },
    });`);
    assert.equal(analysis.executorConfigurationViolations.some(violation => /defaultInput was removed/.test(violation.message)), true);
  }
});

test("Conversation rejects custom main fields and flags owned by its standard input", () => {
  assert.throws(() => assertProjectParamDeclarations([
    { name: "question", flag: "--question", type: "string", control: "textarea" },
  ], "conversation"), /standard message input/);
  for (const flag of ["--message", "--images", "--videos", "--files"]) {
    assert.throws(() => assertProjectParamDeclarations([{
      kind: "auxiliary", id: "input", label: "Input",
      fields: [{ name: "custom", flag, type: "string" }],
    }], "conversation"), /reserved for the standard input/);
  }
  const analysis = analyzeProjectScriptSource(`steamharness.defineExecutor({
    projectType: "conversation", workflow: flow,
    params: [{ name: "question", flag: "--question", type: "string", control: "textarea" }],
    createInput() { return {}; },
  });`);
  assert.equal(analysis.executorConfigurationViolations.some(violation => /standard message input/.test(violation.message)), true);
  assert.doesNotThrow(() => assertProjectParamDeclarations([
    { name: "question", flag: "--question", type: "string", control: "textarea" },
  ], "workflow"));
});
