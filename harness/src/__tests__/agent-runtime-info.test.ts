import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import corePackage from "../../package.json" with { type: "json" };
import { runLocalProjectWithReport } from "../executor";
import { testExecutionStorage } from "./runtime-test-storage";

test("runtime_info reports the loaded version and each executing Bot's own entry and workdir", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-runtime-info-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all((["cli-web", "studio"] as const).map(async (kind, index) => {
    const name = `Runtime fixture ${index}`;
    const version = `1.0.${index}`;
    const projectDir = path.join(root, String(index));
    await mkdir(path.join(projectDir, "workspace"), { recursive: true });
    const directory = await realpath(projectDir);
    const workdir = path.join(directory, "workspace");
    const entry = { entryId: "chat", name: `Chat ${index}`, type: "bot" };
    await Promise.all([
      writeFile(path.join(directory, "package.json"), JSON.stringify({ type: "module", version: "9.9.9", dependencies: { steamharness: "8.8.8" } })),
      writeFile(path.join(directory, "steamharness.json"), JSON.stringify({ name, version, defaultEntry: "chat", entries: [{ ...entry, root: ".", entry: "index.ts" }] })),
      writeFile(path.join(directory, "index.ts"), `
        import { fauxProvider, createModels, fauxAssistantMessage, fauxToolCall } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai"))};
        const fake = fauxProvider({ models: [{ id: "fixture", name: "Fixture", contextWindow: 8192, maxTokens: 100 }] });
        const models = createModels(); models.setProvider(fake.provider);
        fake.setResponses([
          request => {
            const tools = new Set();
            for (const message of request.messages) {
              if (message.role !== "system") continue;
              for (const removed of message.toolsRemoved ?? []) tools.delete(removed.name);
              for (const added of message.toolsAdded ?? []) tools.add(added.name);
            }
            if (!tools.has("runtime_info") || tools.has("bash")) return fauxAssistantMessage("Unexpected tools: " + [...tools].join(", "));
            return fauxAssistantMessage([fauxToolCall("runtime_info", {})], { stopReason: "toolUse" });
          },
          request => fauxAssistantMessage(request.messages.find(message => message.role === "toolResult" && message.toolName === "runtime_info")?.content[0]?.text ?? "Missing tool result"),
        ]);
        export const executor = steamharness.defineBot({
          engine: "agent",
          memory: { enabled: false },
          agent: { models, resolvedModel: models.getModel("faux", "fixture"), permissionPolicy: "read-only" },
          prepareInput(input) { return { ...input, prompt: "Which runtime am I using?", workdir: ${JSON.stringify(workdir)} }; },
        });
      `),
    ]);
    const host = { kind, ...(index === 0 && { cliVersion: "4.5.6" }) };
    const runtimeHost = { ...host, accessToken: "test-only-do-not-return" };
    const report = await runLocalProjectWithReport({ projectDir, runtimeHost, env: {}, storage: testExecutionStorage() });
    assert.equal(report.status, "success", JSON.stringify(report.error ?? report.result));
    const answer = report.outputs?.flatMap(output => output.output?.items ?? []).find(item => item.id === "agent-answer");
    assert.ok(typeof answer?.content === "string", "Expected an Agent answer containing the tool result");
    assert.deepEqual(JSON.parse(answer.content), {
      engine: "agent", coreVersion: corePackage.version, host,
      runtime: { name: "node", version: process.versions.node, platform: process.platform, arch: process.arch,
        ...(process.versions.electron !== undefined && { electronVersion: process.versions.electron }) },
      workdir, project: { name, version, directory, entry },
    });
  }));
});
