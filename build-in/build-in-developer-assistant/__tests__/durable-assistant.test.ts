import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import type { AgentOutputPayload, ConversationState, TokenUsageAggregate, UserInputRequest } from "steamharness";
import type { AgentSessionSnapshot } from "steamharness/agent";

const directories: string[] = [], children: ChildProcess[] = [];
const root = path.resolve(import.meta.dirname, "..");
const loader = createRequire(path.join(root, "node_modules/@steamharness/cli/package.json")).resolve("tsx");
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
  }
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});
function worker(directory: string, scenario: string, phase: string) {
  const child = spawn(process.execPath, ["--import", pathToFileURL(loader).href, "--conditions=development",
    path.join(import.meta.dirname, "fixtures/durable-assistant-worker.ts"), directory, scenario, phase], {
    cwd: root, env: { ...process.env, STEAMHARNESS_DEVELOPER_ASSISTANT_HOST: "vscode", STEAMHARNESS_DEVELOPER_ASSISTANT_WORKDIR: directory,
      STEAMHARNESS_DEVELOPER_ASSISTANT_WORKSPACE_MANIFEST: path.join(directory, "workspace.json"), STEAMHARNESS_STUDIO_CONTROL_MCP_SERVER: "",
      STEAMHARNESS_DEVELOPER_ASSISTANT_CODE_MODE: scenario === "extensions" ? "true" : "false" },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  children.push(child); return child;
}
interface Result {
  type: string; calls: number; output: AgentOutputPayload; request: UserInputRequest;
  conversation: ConversationState; usage: TokenUsageAggregate;
  snapshot: AgentSessionSnapshot; childTools: string[];
}

it("streams thinking, an inline preface and a real read tool without failing or replaying the task", async () => {
  const directory = await temporary();
  await writeFile(path.join(directory, "inspected.md"), "streamed fixture");
  const initial = await finished(directory, "blocks", "initial");
  const replay = await finished(directory, "blocks", "replay");
  expect(initial.calls).toBe(2); expect(replay.calls).toBe(0);
  expect(initial.snapshot.tasks).toEqual([]); expect(initial.snapshot.foreground).toBe(false);
  expect(initial.snapshot.history.filter(task => task.toolName === "read")).toHaveLength(1);
  expect(initial.snapshot.history.every(task => task.status === "completed" && !task.stopping)).toBe(true);
  const answer = initial.snapshot.turns.flatMap(turn => turn.items).filter(item => item.metadata?.partType === "text");
  expect(answer.map(item => item.content).join("")).toBe("I will inspect the fixture. Inspection complete.");
  expect(answer.every(item => item.contentType === "markdown" && item.collapsed === false)).toBe(true);
  const turn = initial.snapshot.turns[0];
  expect(turn.usage).toMatchObject({ calls: 2, totalTokens: initial.usage.totalTokens });
  const scope = initial.snapshot.contexts.find(scope => scope.conversationId === initial.snapshot.conversationId)!;
  expect(scope.contextUsage?.used).toBeGreaterThan(0);
  expect(scope.contextUsage!.used).toBeLessThan(turn.usage!.totalTokens);
  expect(scope.outputs).toMatchObject([{ display: { type: "ring", placement: "composer-right" },
    content: { value: scope.contextUsage!.used, total: 100_000, unit: "tokens" } }]);
  expect(replay.snapshot.contexts.map(scope => scope.contextUsage)).toEqual(initial.snapshot.contexts.map(scope => scope.contextUsage));
  expect(replay.snapshot.turns).toEqual(initial.snapshot.turns);
  expect(visibleItems(replay.output).filter(item => item.metadata?.partType === "text"))
    .toEqual(visibleItems(initial.output).filter(item => item.metadata?.partType === "text"));
}, 45_000);

it("resumes the actual assistant's QuickJS script and checkpointed background task without repeating a completed write", async () => {
  const directory = await temporary();
  const initial = worker(directory, "extensions", "initial");
  const checkpoint = await receive(initial, "checkpoint");
  expect(checkpoint.snapshot.resources?.codeMode).toBe(true);
  expect(checkpoint.snapshot.tasks.some(task => task.kind === "fixture.timer" && task.wakeAt)).toBe(true);
  expect(checkpoint.snapshot.history.some(task => task.toolName === "write" && task.parentId)).toBe(true);
  expect(checkpoint.snapshot.history.find(task => task.toolName === "write" && task.parentId)?.arguments).toMatchObject({ path: "recovered.txt" });
  const exited = once(initial, "exit"); initial.kill("SIGKILL"); await exited;
  await writeFile(path.join(directory, "recovered.txt"), "preserve after code mode crash");
  const resumed = await finished(directory, "extensions", "resume");
  const replay = await finished(directory, "extensions", "replay");
  expect(resumed.calls).toBe(1); expect(replay.calls).toBe(0);
  expect(await readFile(path.join(directory, "recovered.txt"), "utf8")).toBe("preserve after code mode crash");
  expect(resumed.snapshot.history.some(task => task.kind === "fixture.timer" && task.status === "completed")).toBe(true);
  expect(resumed.snapshot.history.find(task => task.toolName === "codemode")?.script).toContain("tools.write");
  expect(resumed.snapshot.turns.flatMap(turn => turn.items).filter(item => item.metadata?.partType === "text").every(item => item.contentType === "markdown" && item.collapsed === false)).toBe(true);
  expect(visibleItems(replay.output)).toEqual(visibleItems(resumed.output));
  expectContextReplay(replay, resumed);
}, 45_000);
async function receive(child: ChildProcess, type: string): Promise<Result> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Assistant worker did not publish ${type}: ${stderr}`)); }, 15_000);
    const log = (chunk: Buffer) => { stderr += chunk.toString(); };
    const message = (value: Result) => {
      if (value.type === type) { cleanup(); resolve(value); }
      else stderr += `Unexpected message: ${JSON.stringify(value)}\n`;
    };
    const exit = (code: number | null) => { cleanup(); reject(new Error(`Assistant worker exited (${code}): ${stderr}`)); };
    const cleanup = () => { clearTimeout(timer); child.off("message", message); child.off("exit", exit); child.stderr!.off("data", log); };
    child.on("message", message); child.on("exit", exit); child.stderr!.on("data", log);
  });
}

it("recovers actual assistant background tools, reports once, and persists plan, reset and independent fork controls", async () => {
  const directory = await temporary();
  await writeFile(path.join(directory, "inspected.md"), "durable inspection fixture");
  const initial = worker(directory, "session", "initial");
  const checkpoint = await receive(initial, "checkpoint");
  expect(checkpoint.childTools).toEqual(["find", "grep", "ls", "read"]);
  expect(checkpoint.snapshot.history.some(task => task.toolName === "read" && task.status === "completed")).toBe(true);
  const exited = once(initial, "exit"); initial.kill("SIGKILL"); await exited;
  const resumed = await finished(directory, "session", "resume");
  const replay = await finished(directory, "session", "replay");
  expect(resumed.calls).toBe(4); expect(replay.calls).toBe(0);
  expect(resumed.snapshot.turns.filter(turn => turn.requestId.startsWith("report:"))).toHaveLength(1);
  expect(resumed.snapshot.turns.filter(turn => turn.requestId === "session-follow-up")).toHaveLength(1);
  expect(resumed.snapshot.plan).toMatchObject({ version: 2, items: [{ id: "inspect", status: "completed" }] });
  expect(resumed.snapshot.epoch).toBe(1);
  const fork = resumed.snapshot.conversations.find(conversation => conversation.forkEntryId)!;
  expect(resumed.snapshot.contexts.find(context => context.conversationId === fork.id)?.plan.version).toBe(1);
  expect(resumed.snapshot.tasks).toEqual([]);
  expect(resumed.snapshot.usage).toHaveLength(3);
  const forkTurn = resumed.snapshot.turns.find(turn => turn.requestId === "session-fork-input")!;
  expect(forkTurn.usage?.calls).toBe(1);
  expect(forkTurn.usage!.totalTokens).toBeLessThan(resumed.usage.totalTokens);
  const forkContext = resumed.snapshot.contexts.find(scope => scope.conversationId === fork.id)!;
  expect(forkContext.contextUsage?.used).toBe(forkTurn.usage!.totalTokens);
  expect(forkContext.outputs?.[0].content).toEqual({ value: forkContext.contextUsage!.used, total: 100_000, unit: "tokens" });
  expect(replay.snapshot.contexts.map(scope => scope.contextUsage)).toEqual(resumed.snapshot.contexts.map(scope => scope.contextUsage));
  expect(replay.snapshot.turns).toEqual(resumed.snapshot.turns);
  expect(replay.usage).toMatchObject({ calls: resumed.usage.calls, totalTokens: resumed.usage.totalTokens });
  expect(visibleItems(replay.output)).toEqual(visibleItems(resumed.output));
  expectContextReplay(replay, resumed);
  expect(resumed.snapshot.turns.flatMap(turn => turn.items).filter(item => item.metadata?.partType === "text").every(item => item.contentType === "markdown" && item.collapsed === false)).toBe(true);
}, 45_000);
async function finished(directory: string, scenario: string, phase: string, type = "done") {
  const child = worker(directory, scenario, phase), exited = once(child, "exit");
  try {
    const result = await receive(child, type);
    expect((await exited)[0]).toBe(0); return result;
  } catch (cause) {
    const locks = await Promise.all((await readdir(path.join(directory, "kv"), { recursive: true }))
      .filter(name => name.endsWith(".lock")).map(async name => ({ name,
        record: await readFile(path.join(directory, "kv", name), "utf8").catch(() => "released"),
      })));
    throw new Error(`${scenario}/${phase}: ${String(cause)}; KV locks: ${JSON.stringify(locks)}`, { cause });
  }
}
async function temporary() {
  const directory = await mkdtemp(path.join(tmpdir(), "workflow-assistant-durable-"));
  directories.push(directory);
  const target = { kind: "folder", folderId: "fixture" };
  await writeFile(path.join(directory, "workspace.json"), JSON.stringify({ schemaVersion: 2, primaryTarget: target, warnings: [],
    roots: [{ target, name: "Fixture", rootPath: directory, role: "primary", depth: 0 }] }));
  return directory;
}
const visibleItems = (output: AgentOutputPayload) => output.items.filter(item =>
  item.metadata?.kind !== "agent-session" && item.display?.placement !== "composer-right");
function expectContextReplay(replay: Result, initial: Result): void {
  expect(replay.snapshot.contexts.map(scope => scope.contextUsage)).toEqual(initial.snapshot.contexts.map(scope => scope.contextUsage));
  expect(replay.output.items.filter(item => item.display?.placement === "composer-right"))
    .toEqual(initial.output.items.filter(item => item.display?.placement === "composer-right"));
}
function durableState(output: AgentOutputPayload) { return output.items.find(item => item.metadata?.kind === "agent-session")?.content as { version: number; conversationId: number; ownerId: string; turns: unknown[] }; }

it("recovers the actual assistant after SIGKILL without repeating a committed write, answer or usage", async () => {
  const directory = await temporary(), initial = worker(directory, "crash", "initial");
  await receive(initial, "checkpoint");
  expect(await readFile(path.join(directory, "recovered.txt"), "utf8")).toBe("created");
  const exited = once(initial, "exit"); initial.kill("SIGKILL"); await exited;
  await writeFile(path.join(directory, "recovered.txt"), "preserve after crash");
  const resumed = await finished(directory, "crash", "resume");
  const replay = await finished(directory, "crash", "replay");
  expect(resumed.calls).toBe(1); expect(replay.calls).toBe(0);
  expect(await readFile(path.join(directory, "recovered.txt"), "utf8")).toBe("preserve after crash");
  expect(visibleItems(replay.output)).toEqual(visibleItems(resumed.output));
  expectContextReplay(replay, resumed);
  expect(durableState(replay.output)).toMatchObject({ version: 1, conversationId: durableState(resumed.output).conversationId, turns: durableState(resumed.output).turns });
  expect(durableState(replay.output).ownerId).not.toBe(durableState(resumed.output).ownerId);
  const answer = replay.output.items.find(item => item.metadata?.partType === "text")!;
  expect(answer).toMatchObject({ content: "Durable assistant completed.", contentType: "markdown", collapsed: false });
  expect(replay.conversation.messages.map(message => message.role)).toEqual(["user", "assistant"]);
  expect(replay.usage.totalTokens).toBe(resumed.usage.totalTokens);
  expect(replay.usage.calls).toBe(resumed.usage.calls);
}, 45_000);

it("restores the assistant's ask and plan decisions across processes without applying them to a new run", async () => {
  const directory = await temporary();
  const ask = await finished(directory, "approval", "ask", "waiting");
  expect(ask.request.metadata?.type).toBe("agent-ask");
  const decisions = [{ requestId: ask.request.requestId, nodeName: ask.request.nodeName,
    values: { [ask.request.params[0]!.name]: "option:0" }, request: ask.request, submittedAt: new Date().toISOString() }];
  await writeFile(path.join(directory, "decisions.json"), JSON.stringify(decisions));
  const plan = await finished(directory, "approval", "answer", "waiting");
  expect(plan.request.metadata?.type).toBe("agent-plan-approval");
  decisions.push({ requestId: plan.request.requestId, nodeName: plan.request.nodeName,
    values: { decision: "approve" }, request: plan.request, submittedAt: new Date().toISOString() });
  await writeFile(path.join(directory, "decisions.json"), JSON.stringify(decisions));
  const approved = await finished(directory, "approval", "approve");
  expect(approved.output.agent).toBe("build");
  expect(await readFile(path.join(directory, "recovered.txt"), "utf8")).toBe("created");
  const replay = await finished(directory, "approval", "replay");
  expect(replay.calls).toBe(0); expect(visibleItems(replay.output)).toEqual(visibleItems(approved.output));
  expectContextReplay(replay, approved);
  const fresh = await finished(directory, "approval", "fresh", "waiting");
  expect(fresh.calls).toBe(1); expect(fresh.request.requestId).not.toBe(plan.request.requestId);
}, 45_000);

it("retains the original plan, its revision and Build output in session history after approval and reopening", async () => {
  const directory = await temporary();
  const plan = await finished(directory, "approval-session", "plan", "waiting");
  const text = (snapshot: AgentSessionSnapshot) => snapshot.turns.flatMap(turn => turn.items).filter(item => item.metadata?.partType === "text").map(item => item.content);
  expect(text(plan.snapshot)).toEqual(["A seven-day reading plan."]);
  const decisions = [{ requestId: plan.request.requestId, nodeName: plan.request.nodeName,
    values: { decision: "decline", instructions: "Change it to thirty days" }, request: plan.request, submittedAt: new Date().toISOString() }];
  await writeFile(path.join(directory, "decisions.json"), JSON.stringify(decisions));
  const revised = await finished(directory, "approval-session", "revise", "waiting");
  expect(revised.request.requestId).not.toBe(plan.request.requestId);
  expect(text(revised.snapshot)).toEqual(["A seven-day reading plan.", "A thirty-day reading plan."]);
  decisions.push({ requestId: revised.request.requestId, nodeName: revised.request.nodeName,
    values: { decision: "approve", instructions: "" }, request: revised.request, submittedAt: new Date().toISOString() });
  await writeFile(path.join(directory, "decisions.json"), JSON.stringify(decisions));
  const approved = await finished(directory, "approval-session", "approve");
  expect(text(approved.snapshot)).toEqual(["A seven-day reading plan.", "A thirty-day reading plan.", "Approved task completed."]);
  expect(approved.snapshot.turns).toHaveLength(3);
  expect(approved.snapshot.turns.every(turn => turn.status === "done")).toBe(true);
  expect(await readFile(path.join(directory, "recovered.txt"), "utf8")).toBe("created");
  const reopened = await finished(directory, "approval-session", "replay");
  expect(reopened.calls).toBe(0);
  expect(reopened.snapshot.turns).toEqual(approved.snapshot.turns);
}, 45_000);

it("continues the actual assistant's committed partial answer after SIGKILL and replays the same output", async () => {
  const directory = await temporary(), initial = worker(directory, "stream", "initial");
  await receive(initial, "checkpoint");
  const exited = once(initial, "exit"); initial.kill("SIGKILL"); await exited;
  const resumed = await finished(directory, "stream", "resume");
  const replay = await finished(directory, "stream", "replay");
  expect(resumed.calls).toBe(1); expect(replay.calls).toBe(0);
  const answers = resumed.output.items.filter(item => item.metadata?.partType === "text");
  expect(answers.map(item => item.content).join("")).toBe("Durable assistant continued after interruption.");
  expect(answers.every(item => item.contentType === "markdown" && item.collapsed === false)).toBe(true);
  expect(visibleItems(replay.output)).toEqual(visibleItems(resumed.output));
  expectContextReplay(replay, resumed);
  expect(replay.usage).toMatchObject({ totalTokens: resumed.usage.totalTokens, calls: resumed.usage.calls });
  expect(replay.conversation.messages.map(message => message.role)).toEqual(["user", "assistant"]);
}, 45_000);
