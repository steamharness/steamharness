import { spawn } from "node:child_process";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  AGENT_ASK_TOOL_NAME,
  createAgentAskRequestId,
  readAgentQuestions,
} from "./ask";
import type { AgentQuestion } from "./types";

/**
 * The subset of TypeBox this module needs. Passed in by the runtime so the SDK
 * stays out of the package's static import graph.
 */
export interface TypeboxLike {
  Object(properties: Record<string, unknown>, options?: Record<string, unknown>): unknown;
  String(options?: Record<string, unknown>): unknown;
  Number(options?: Record<string, unknown>): unknown;
  Boolean(options?: Record<string, unknown>): unknown;
  Array(items: unknown, options?: Record<string, unknown>): unknown;
  Optional(schema: unknown): unknown;
  /** Wraps a raw JSON Schema as a schema the SDK accepts unchanged. */
  Unsafe(schema: unknown): unknown;
}

export interface AgentToolScope {
  /** Directory relative paths resolve against. */
  workdir: string;
  /** Absolute directories the tools may read from and write to. */
  allowedDirectories: string[];
  /**
   * Lifts the containment check entirely.
   *
   * Set for the `auto` permission policy, which mirrors OpenCode's `--auto`:
   * approving every permission that is not explicitly denied also approves
   * reaching outside the workspace.
   */
  allowAnyPath?: boolean;
}

export const BUILTIN_AGENT_TOOL_NAMES = [
  "read",
  "write",
  "edit",
  "bash",
  "grep",
  "find",
  "ls",
] as const;

export type BuiltinAgentToolName = (typeof BUILTIN_AGENT_TOOL_NAMES)[number];

/** Tools that only observe the workspace; the `read-only` policy keeps just these. */
export const READ_ONLY_AGENT_TOOL_NAMES: readonly string[] = ["read", "grep", "find", "ls"];

/** Tools whose effect leaves the process; these always pause for approval under `workspace`. */
export const MUTATING_AGENT_TOOL_NAMES: readonly string[] = ["write", "edit", "bash"];

/**
 * Static description of every built-in tool.
 *
 * Kept separate from the factories because an executor has to declare its tool
 * permissions before any run — and therefore before a working directory — exists.
 */
export interface BuiltinAgentToolDescriptor {
  name: BuiltinAgentToolName;
  label: string;
  description: string;
}

export const BUILTIN_AGENT_TOOL_CATALOG: readonly BuiltinAgentToolDescriptor[] = [
  { name: "read", label: "Read", description: "读取工作目录中的文本文件。" },
  { name: "write", label: "Write", description: "创建或覆盖工作目录中的文件。" },
  { name: "edit", label: "Edit", description: "按精确文本块修改工作目录中的文件。" },
  // The built-in projects declare this catalogue inline and compare the two
  // against the published Core, so a wording change here lands with a release
  // and their copy follows in the same round.
  { name: "bash", label: "Shell", description: "在工作目录中执行 shell 命令（以宿主机权限运行，不受工作区限制）。" },
  { name: "grep", label: "Search", description: "按正则表达式搜索文件内容。" },
  { name: "find", label: "Find files", description: "按路径子串查找文件。" },
  { name: "ls", label: "List", description: "列出目录内容。" },
];

const DEFAULT_READ_LIMIT = 400;
const DEFAULT_GREP_LIMIT = 100;
const DEFAULT_FIND_LIMIT = 200;
const DEFAULT_BASH_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 60_000;
/**
 * Size at which `read` stops loading a whole file into memory.
 *
 * A log or a database dump is gigabytes; reading it whole to return the first
 * four hundred lines is how a tool call takes the process down with it. Past
 * this the leading bytes are streamed, and the call is answered with the slice
 * it asked for out of them.
 */
const MAX_READ_BYTES = 8 * 1024 * 1024;
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", "dist", ".shared", "coverage"]);

/**
 * The tool the model asks the user with.
 *
 * Only the schema lives here: a call is intercepted before it runs, by the
 * same hook that stops a tool needing approval, because that is where a pause
 * can be raised.
 *
 * Offered while planning only: the answer to "which of these two approaches?"
 * is what a plan is for, and a build turn is executing a plan that was already
 * agreed. The questions are the model's own, so the arguments are read
 * defensively — a call it cannot phrase is refused rather than shown to the
 * user as an empty form.
 */
export function createAskUserTool(input: { Type: TypeboxLike }): AgentTool {
  return {
    name: AGENT_ASK_TOOL_NAME,
    label: "Ask the user",
    description:
      "Ask the user one or more questions and wait for the answers. Use it while planning when the decision is theirs: which approach to take, which of two places to change, what a requirement means. A question may offer options for them to pick from, and may also let them answer in their own words. The answers come back in the next turn.",
    parameters: input.Type.Object({
      questions: input.Type.Array(
        input.Type.Object({
          question: input.Type.String({ description: "The question to put to the user." }),
          header: input.Type.Optional(input.Type.String({ description: "Short label for the question." })),
          options: input.Type.Optional(input.Type.Array(
            input.Type.Object({
              label: input.Type.String({ description: "What this option says." }),
              description: input.Type.Optional(input.Type.String({ description: "What picking it means." })),
            }),
            { description: "Choices to offer. Leave out to ask for a written answer." },
          )),
          multiple: input.Type.Optional(input.Type.Boolean({ description: "Let the user pick more than one option." })),
          custom: input.Type.Optional(input.Type.Boolean({ description: "Also accept an answer in the user's own words." })),
        }),
        { description: "The questions to ask." },
      ),
    }),
    async execute() {
      // The call never gets this far: it is answered by the before-tool-call
      // hook, which is where a pause can be raised — an error thrown from a
      // tool's own execute becomes a result the model reads past instead of a
      // parked run. Reaching here means this run had no way to ask.
      throw new Error("Asking the user is not available in this run.");
    },
  } as unknown as AgentTool;
}

export function createBuiltinAgentTools(input: {
  Type: TypeboxLike;
  scope: AgentToolScope;
}): AgentTool[] {
  return [
    createReadTool(input),
    createWriteTool(input),
    createEditTool(input),
    createBashTool(input),
    createGrepTool(input),
    createFindTool(input),
    createLsTool(input),
  ].map(tool => ({ ...tool, replay: READ_ONLY_AGENT_TOOL_NAMES.includes(tool.name) ? "safe" : "never" })) as unknown as AgentTool[];
}

export function selectAgentToolNames(
  requested: readonly string[] | undefined,
  available: readonly string[],
): string[] {
  const pool = requested === undefined ? available : requested;
  const known = new Set(available);
  return pool.filter((name) => known.has(name));
}

function createReadTool({ Type, scope }: { Type: TypeboxLike; scope: AgentToolScope }) {
  return {
    name: "read",
    label: "Read",
    description:
      "Read a text file. Paths are relative to the working directory. Returns numbered lines; use offset and limit for large files.",
    parameters: Type.Object({
      path: Type.String({ description: "File path to read." }),
      offset: Type.Optional(Type.Number({ description: "1-based first line to return." })),
      limit: Type.Optional(Type.Number({ description: "Maximum number of lines." })),
    }),
    async execute(_toolCallId: string, params: { path: string; offset?: number; limit?: number }) {
      const file = await resolveInsideScope(scope, params.path);
      const stats = await fs.stat(file);
      if (stats.isDirectory()) {
        throw new Error(`${params.path} is a directory; use the ls tool.`);
      }

      const offset = Math.max(1, Math.trunc(params.offset ?? 1));
      const limit = Math.max(1, Math.trunc(params.limit ?? DEFAULT_READ_LIMIT));

      if (stats.size > MAX_READ_BYTES) {
        const slice = await readLineRange(file, offset, limit);
        const body = slice.lines.map((line, index) => `${offset + index}\t${line}`).join("\n");
        return {
          content: [
            {
              type: "text" as const,
              text: `${body}\n… (large file: ${String(stats.size)} bytes; only the first ${String(MAX_READ_BYTES)} were read)`,
            },
          ],
          details: { path: file, truncated: true, bytes: stats.size, requestedFrom: offset },
        };
      }

      const text = await fs.readFile(file, "utf8");
      const lines = text.split("\n");
      const slice = lines.slice(offset - 1, offset - 1 + limit);
      const body = slice.map((line, index) => `${offset + index}\t${line}`).join("\n");
      const truncated = offset - 1 + slice.length < lines.length;

      return {
        content: [{ type: "text" as const, text: truncated ? `${body}\n… (truncated)` : body }],
        details: { path: file, lines: lines.length, truncated },
      };
    },
  };
}

function createWriteTool({ Type, scope }: { Type: TypeboxLike; scope: AgentToolScope }) {
  return {
    name: "write",
    label: "Write",
    description:
      "Create or overwrite a file. Parent directories are created when missing.",
    parameters: Type.Object({
      path: Type.String({ description: "File path to write." }),
      content: Type.String({ description: "Full file content." }),
    }),
    async execute(_toolCallId: string, params: { path: string; content: string }) {
      const file = await resolveInsideScope(scope, params.path);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, params.content, "utf8");
      return {
        content: [{ type: "text" as const, text: `Wrote ${params.content.length} characters to ${file}.` }],
        details: { path: file, bytes: Buffer.byteLength(params.content, "utf8") },
      };
    },
  };
}

function createEditTool({ Type, scope }: { Type: TypeboxLike; scope: AgentToolScope }) {
  return {
    name: "edit",
    label: "Edit",
    description:
      "Replace exact text blocks in a file. Every oldText must appear exactly once, otherwise the edit is rejected.",
    parameters: Type.Object({
      path: Type.String({ description: "File path to edit." }),
      edits: Type.Array(
        Type.Object({
          oldText: Type.String({ description: "Exact text to replace." }),
          newText: Type.String({ description: "Replacement text." }),
        }),
        { description: "Edits applied in order." },
      ),
    }),
    async execute(
      _toolCallId: string,
      params: { path: string; edits: Array<{ oldText: string; newText: string }> },
    ) {
      const file = await resolveInsideScope(scope, params.path);
      let text = await fs.readFile(file, "utf8");
      let applied = 0;

      for (const [index, edit] of params.edits.entries()) {
        const occurrences = countOccurrences(text, edit.oldText);
        if (occurrences === 0) {
          throw new Error(`Edit ${index + 1}: oldText was not found in ${params.path}.`);
        }
        if (occurrences > 1) {
          throw new Error(
            `Edit ${index + 1}: oldText appears ${occurrences} times in ${params.path}; it must be unique.`,
          );
        }
        // The function form keeps `$&` and friends in the replacement literal:
        // "replace this text with that text" is the contract, and a model
        // writing `$'` into a file means the two characters it typed.
        text = text.replace(edit.oldText, () => edit.newText);
        applied += 1;
      }

      await fs.writeFile(file, text, "utf8");
      return {
        content: [{ type: "text" as const, text: `Applied ${applied} edit(s) to ${file}.` }],
        details: { path: file, edits: applied },
      };
    },
  };
}

function createBashTool({ Type, scope }: { Type: TypeboxLike; scope: AgentToolScope }) {
  return {
    name: "bash",
    label: "Shell",
    description: [
      "Run a shell command in the working directory. Returns combined stdout and stderr.",
      "Commands run with the host process's own privileges and are not confined to the working directory,",
      "so only run what the task actually needs.",
    ].join(" "),
    parameters: Type.Object({
      command: Type.String({ description: "Command to run." }),
      timeout: Type.Optional(Type.Number({ description: "Timeout in milliseconds." })),
    }),
    async execute(
      _toolCallId: string,
      params: { command: string; timeout?: number },
      signal?: AbortSignal,
    ) {
      const result = await runShellCommand(params.command, scope.workdir, {
        timeoutMs: Math.max(1, Math.trunc(params.timeout ?? DEFAULT_BASH_TIMEOUT_MS)),
        signal,
      });
      if (result.exitCode !== 0) {
        throw new Error(
          `Command exited with code ${String(result.exitCode)}.\n${result.output}`,
        );
      }
      return {
        content: [{ type: "text" as const, text: result.output === "" ? "(no output)" : result.output }],
        details: { command: params.command, exitCode: result.exitCode },
      };
    },
  };
}

function createGrepTool({ Type, scope }: { Type: TypeboxLike; scope: AgentToolScope }) {
  return {
    name: "grep",
    label: "Search",
    description: "Search file contents with a regular expression under the working directory.",
    parameters: Type.Object({
      pattern: Type.String({ description: "JavaScript regular expression source." }),
      path: Type.Optional(Type.String({ description: "Directory or file to search." })),
      limit: Type.Optional(Type.Number({ description: "Maximum matches to return." })),
    }),
    async execute(_toolCallId: string, params: { pattern: string; path?: string; limit?: number }) {
      const root = await resolveInsideScope(scope, params.path ?? ".");
      const regexp = compileRegExp(params.pattern);
      const limit = Math.max(1, Math.trunc(params.limit ?? DEFAULT_GREP_LIMIT));
      const matches: string[] = [];

      for await (const file of walkFiles(root)) {
        if (matches.length >= limit) break;
        const text = await readTextFileOrUndefined(file);
        if (text === undefined) continue;
        for (const [index, line] of text.split("\n").entries()) {
          if (matches.length >= limit) break;
          if (regexp.test(line)) {
            matches.push(`${path.relative(scope.workdir, file)}:${index + 1}: ${line.trim()}`);
          }
        }
      }

      return {
        content: [
          {
            type: "text" as const,
            text: matches.length === 0 ? "No matches." : matches.join("\n"),
          },
        ],
        details: { pattern: params.pattern, matches: matches.length },
      };
    },
  };
}

function createFindTool({ Type, scope }: { Type: TypeboxLike; scope: AgentToolScope }) {
  return {
    name: "find",
    label: "Find files",
    description: "List files whose path contains a substring, under the working directory.",
    parameters: Type.Object({
      query: Type.String({ description: "Substring to match against the file path." }),
      limit: Type.Optional(Type.Number({ description: "Maximum paths to return." })),
    }),
    async execute(_toolCallId: string, params: { query: string; limit?: number }) {
      const limit = Math.max(1, Math.trunc(params.limit ?? DEFAULT_FIND_LIMIT));
      const found: string[] = [];

      for await (const file of walkFiles(scope.workdir)) {
        if (found.length >= limit) break;
        const relative = path.relative(scope.workdir, file);
        if (relative.toLowerCase().includes(params.query.toLowerCase())) {
          found.push(relative);
        }
      }

      return {
        content: [
          { type: "text" as const, text: found.length === 0 ? "No files matched." : found.join("\n") },
        ],
        details: { query: params.query, files: found.length },
      };
    },
  };
}

function createLsTool({ Type, scope }: { Type: TypeboxLike; scope: AgentToolScope }) {
  return {
    name: "ls",
    label: "List",
    description: "List the entries of a directory.",
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "Directory to list. Defaults to the working directory." })),
    }),
    async execute(_toolCallId: string, params: { path?: string }) {
      const directory = await resolveInsideScope(scope, params.path ?? ".");
      const entries = await fs.readdir(directory, { withFileTypes: true });
      const rendered = entries
        .filter((entry) => !SKIPPED_DIRECTORIES.has(entry.name))
        .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
        .sort();

      return {
        content: [{ type: "text" as const, text: rendered.join("\n") }],
        details: { path: directory, entries: rendered.length },
      };
    },
  };
}

/**
 * Resolves a caller-supplied path and refuses anything outside the allowed
 * roots. Tools run with the same privileges as the host process, so this is
 * the only thing keeping a model-issued path inside the workspace.
 *
 * Both the path and the roots are resolved through `fs.realpath` first: the
 * lexical comparison this used to make was satisfied by any path *string* that
 * started with a root, so a symbolic link inside the workspace — `data ->
 * ~/.ssh`, say, in a repository the agent is asked to read — carried every file
 * tool straight out of it.
 */
export async function resolveInsideScope(scope: AgentToolScope, requested: string): Promise<string> {
  const trimmed = requested.trim();
  if (trimmed === "") {
    throw new Error("A path is required.");
  }

  const absolute = path.resolve(scope.workdir, trimmed);
  if (scope.allowAnyPath === true) {
    return absolute;
  }

  const allowed = scope.allowedDirectories.length === 0 ? [scope.workdir] : scope.allowedDirectories;
  const [roots, target] = await Promise.all([
    Promise.all(allowed.map((directory) => resolveRealPathOrSelf(path.resolve(directory)))),
    resolveRealPathOrSelf(absolute),
  ]);
  const permitted = roots.some((root) => target === root || target.startsWith(root + path.sep));

  if (!permitted) {
    throw new Error(`Path "${requested}" is outside the directories this agent may access.`);
  }

  return absolute;
}

/**
 * The real path of a path that may not exist yet.
 *
 * `fs.realpath` fails on a missing path — which is exactly the write case — and
 * the parent directories are what a symbolic link could be hiding in, so the
 * nearest existing ancestor is resolved and the missing tail re-appended.
 */
async function resolveRealPathOrSelf(absolute: string): Promise<string> {
  const missing: string[] = [];
  let current = absolute;

  for (;;) {
    try {
      const real = await fs.realpath(current);
      return missing.length === 0 ? real : path.join(real, ...missing.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        // Nothing along the path exists; the lexical answer is all there is.
        return absolute;
      }
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

/** Lines `[offset, offset + limit)` of a file, read without loading all of it. */
async function readLineRange(
  file: string,
  offset: number,
  limit: number,
): Promise<{ lines: string[] }> {
  // Bounded by bytes as well as lines: one minified line can be as large as the
  // file that contains it.
  const stream = createReadStream(file, { encoding: "utf8", end: MAX_READ_BYTES - 1 });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  const lines: string[] = [];

  try {
    let index = 0;
    for await (const line of reader) {
      index += 1;
      if (index < offset) continue;
      if (lines.length >= limit) break;
      lines.push(line);
    }
  } finally {
    reader.close();
    stream.destroy();
  }

  return { lines };
}

async function runShellCommand(
  command: string,
  cwd: string,
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<{ exitCode: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      // Its own process group, so a timeout can take the whole tree with it:
      // the shell is only the parent of whatever the command actually started,
      // and killing it alone leaves `sleep 600 &` and its siblings running.
      detached: process.platform !== "win32",
    });
    let output = "";
    let settled = false;

    const timer = setTimeout(() => {
      killProcessTree(child);
      finish(null, `\n[command timed out after ${options.timeoutMs} ms]`);
    }, options.timeoutMs);

    const onAbort = () => {
      killProcessTree(child);
      finish(null, "\n[command aborted]");
    };

    function finish(exitCode: number | null, suffix = ""): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve({ exitCode, output: truncate(appendBuffer(output, suffix)) });
    }

    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => {
      output = appendBuffer(output, chunk.toString("utf8"));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output = appendBuffer(output, chunk.toString("utf8"));
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => finish(code));
  });
}

/**
 * Kills a spawned command and everything it started.
 *
 * The child leads its own process group (see `detached` above), so a negative
 * pid addresses the group. Windows has no equivalent, and `child.kill` is all
 * that is available there.
 */
function killProcessTree(child: { pid?: number; kill(signal: NodeJS.Signals): boolean }): void {
  if (process.platform !== "win32" && typeof child.pid === "number") {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // The group is gone already, or never existed; fall through to the pid.
    }
  }

  child.kill("SIGKILL");
}

function appendBuffer(current: string, chunk: string): string {
  if (current.length >= MAX_OUTPUT_CHARS) return current;
  return (current + chunk).slice(0, MAX_OUTPUT_CHARS);
}

function truncate(value: string): string {
  return value.length <= MAX_OUTPUT_CHARS
    ? value
    : `${value.slice(0, MAX_OUTPUT_CHARS)}\n… (output truncated)`;
}

async function* walkFiles(root: string): AsyncGenerator<string> {
  let stats;
  try {
    stats = await fs.stat(root);
  } catch {
    return;
  }

  if (stats.isFile()) {
    yield root;
    return;
  }

  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".") continue;
    if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
    // Symbolic links are not followed: a link out of the scope would read a
    // file this tool may not touch, and a link cycle would walk forever.
    if (entry.isSymbolicLink()) continue;
    const child = path.join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(child);
    } else if (entry.isFile()) {
      yield child;
    }
  }
}

async function readTextFileOrUndefined(file: string): Promise<string | undefined> {
  try {
    const stats = await fs.stat(file);
    if (stats.size > 2_000_000) return undefined;
    return await fs.readFile(file, "utf8");
  } catch {
    return undefined;
  }
}

function compileRegExp(pattern: string): RegExp {
  try {
    return new RegExp(pattern, "i");
  } catch (error) {
    throw new Error(`Invalid regular expression: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function countOccurrences(text: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  let index = text.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = text.indexOf(needle, index + needle.length);
  }
  return count;
}
