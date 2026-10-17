import assert from "node:assert/strict";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = await mkdtemp(path.join(tmpdir(), "workflow-agent-dist-"));
const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
let requests = 0;
let codemode = false, scriptOutput = "";
const server = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  const input = JSON.parse(body);
  requests++;
  response.writeHead(200, { "content-type": "text/event-stream" });
  if (codemode && !input.messages.some(message => message.role === "tool")) {
    response.end(`data: ${JSON.stringify({ id: "script", object: "chat.completion.chunk", model: "dist-smoke", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [
      { index: 0, id: "script-call", type: "function", function: { name: "codemode", arguments: JSON.stringify({ code: 'text(await tools.echo({})); text(typeof process);' }) } },
    ] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
    return;
  }
  if (codemode) scriptOutput = JSON.stringify(input.messages.filter(message => message.role === "tool"));
  for (const event of [
    { choices: [{ index: 0, delta: { role: "assistant", content: "Dist durable ready." }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } },
  ]) response.write(`data: ${JSON.stringify({ id: "smoke", object: "chat.completion.chunk", model: "dist-smoke", ...event })}\n\n`);
  response.end("data: [DONE]\n\n");
});

try {
  await cp(path.join(root, "dist"), path.join(temporary, "dist"), { recursive: true });
  await writeFile(path.join(temporary, "package.json"), JSON.stringify({ type: "module" }));
  // Only declared production dependencies are available. Pi, Chord and MCP must
  // load from the copied bundle, without source or development dependencies.
  for (const dependency of Object.keys(manifest.dependencies)) {
    const target = path.join(temporary, "node_modules", dependency);
    await mkdir(path.dirname(target), { recursive: true });
    await symlink(path.join(root, "node_modules", dependency), target, process.platform === "win32" ? "junction" : "dir");
  }
  await writeFile(path.join(temporary, "consumer.ts"), `
import { createAgentRegistry, defineAgentTask, defineAgentExtension, type AgentNativeTool, type AgentSessionOptions } from "./dist/agent.js";
const task = defineAgentTask<{ value: string }, { phase: "done" }, string>({
  name: "test.typed", version: 1, initial: () => ({ phase: "done" }),
  phases: { done: async (task, runtime, context) => {
    const input: string = task.input.value;
    // @ts-expect-error Task inputs retain their declared types.
    const invalid: number = task.input.value;
    await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: input } }), context);
  } },
  abort: async (_task, runtime, context) => { await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context); },
});
const registry = createAgentRegistry();
registry.install(defineAgentExtension({ name: "typed", tasks: [task] }));
// @ts-expect-error Registry is not any when Pi development dependencies are absent.
registry.install("invalid");
const session: AgentSessionOptions = { registry };
const tool: AgentNativeTool = { name: "typed", description: "Typed tool", parameters: { type: "object" }, replay: "safe", execute: async () => ({ output: [{ type: "text", text: "typed" }] }) };
// @ts-expect-error Native tools only accept supported replay policies.
tool.replay = "sometimes";
void session;
`);
  await writeFile(path.join(temporary, "tsconfig.json"), JSON.stringify({ compilerOptions: {
    target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, skipLibCheck: true, types: ["node"],
  }, files: ["consumer.ts"] }));
  await promisify(execFile)(process.execPath, [path.join(root, "node_modules/typescript/bin/tsc"), "--project", "tsconfig.json"], { cwd: temporary });
  const { createAgent } = await import(pathToFileURL(path.join(temporary, "dist/agent.js")).href);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const usage = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const agent = await createAgent({
      provider: "openai", model: "dist-smoke", baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: "offline-fixture", apiKind: "openai-completions", contextWindow: 8192,
      workdir: temporary, databasePath: path.join(temporary, "agent.sqlite"), tools: [],
    });
    let answer = "";
    try {
      for await (const event of agent.run({ prompt: "Hello", requestId: "same-dist-request" }, {
        reportUsage: record => { usage.push(record.recordId); },
      })) if (event.type === "text_delta") answer += event.delta;
    } finally { await agent.close(); }
    assert.equal(answer, "Dist durable ready.");
  }
  assert.equal(requests, 1);
  assert.equal(usage.length, 2);
  assert.ok(usage[0]);
  assert.equal(usage[0], usage[1]);
  codemode = true;
  const sandbox = await createAgent({ provider: "openai", model: "dist-smoke", baseUrl: `http://127.0.0.1:${address.port}/v1`,
    apiKey: "offline-fixture", apiKind: "openai-completions", contextWindow: 8192, workdir: temporary, session: { codeMode: {}, nativeTools: [{
      name: "echo", description: "An authorized nested tool", replay: "safe", parameters: { type: "object", properties: {} },
      execute: async () => ({ output: [{ type: "text", text: "isolated 42" }] }),
    }] } });
  try { for await (const _event of sandbox.run({ prompt: "Execute the script", requestId: "code-dist" })) { /* Drain the real worker. */ } }
  finally { await sandbox.close(); }
  assert.match(scriptOutput, /isolated 42/); assert.match(scriptOutput, /undefined/);
  console.log("Copied dist: typed extension API, SQLite replay and QuickJS worker/WASM nested execution passed with production dependencies only.");
} finally {
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  await rm(temporary, { recursive: true, force: true });
}
