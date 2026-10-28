import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  createLocalProjectMcpFileResolver,
  createProjectMcpServer,
  type McpExecutionReport,
  type McpRunSnapshot,
  type McpRunSnapshotMessage,
  type McpRunner,
  type McpStructureReport,
} from "@steamharness/workflow-mcp";
import {
  isProjectAuthConfigLoggedIn,
  normalizeProjectAuthConfig,
  resolveProjectDesktopConfigFilePath,
} from "@steamharness/auth-config";
import { i18n } from "@steamharness/i18n";
import { readCliAuthConfigSync } from "./auth-config";
import { assertProjectUuid } from "@steamharness/workflow-ids";

export const STEAMHARNESS_MCP_CLI_ENTRYPOINT_ENV = "STEAMHARNESS_MCP_CLI_ENTRYPOINT";
export const STEAMHARNESS_MCP_DESKTOP_AUDIT_IPC_ENV = "STEAMHARNESS_MCP_DESKTOP_AUDIT_IPC";

export interface McpCliOptions {
  projectDir: string;
  dataDir: string;
  fileStoreDir: string;
  kvStoreDir: string;
  persistentValueStoreDir: string;
  fileCreateStoreDir: string;
  desktopConfigDir?: string;
  cliAuthDir?: string;
  entryId?: string;
  /** Absolute entrypoint used when this process spawns a JSON/structure worker. */
  workerEntrypoint?: string;
}

interface McpResumeState {
  entrypointId: string;
  entrypointTitle: string;
  input: Record<string, unknown>;
  args: string[];
  snapshot: McpRunSnapshot;
}

export type McpRunSnapshotWriter = (snapshot: McpRunSnapshot) => Promise<void> | void;

const STEAMHARNESS_MCP_WORKER_TERMINATION_GRACE_MS = 2_000;

export async function main(argv = process.argv.slice(2)): Promise<number> {
  if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(`${i18n.t("mcpHelp", { ns: "cli" })}\n`);
    return 0;
  }

  const options = parseProjectMcpCliOptions(argv);
  const projectId = readProjectId(options.projectDir);
  const runner = new McpCliRunner({
    ...options,
    workerEntrypoint: resolveProjectMcpWorkerEntrypoint(),
  }, createProjectMcpDesktopAuditWriter());
  const structure = await runner.inspectStructure();
  const server = createProjectMcpServer({
    projectId,
    entryId: structure.entryId!,
    structure,
    runner,
    fileInputMode: "local",
    resolveFiles: createLocalProjectMcpFileResolver({ fileStoreDir: options.fileStoreDir }),
    instructions: `Run entrypoints from workflow project ${structure.workflow.name}. Reconnect after project changes.`,
  });
  const transport = new StdioServerTransport();
  let closePromise: Promise<void> | undefined;
  const close = () => {
    closePromise ??= runner.close().finally(() => server.close()).catch((error: unknown) => {
      process.stderr.write(`${formatError(error)}\n`);
    });
    return closePromise;
  };
  const requestClose = () => { void close(); };
  process.once("SIGINT", requestClose);
  process.once("SIGTERM", requestClose);
  process.stdin.once("end", requestClose);
  process.stdin.once("close", requestClose);
  await server.connect(transport);
  return 0;
}

export function parseProjectMcpCliOptions(argv: string[]): McpCliOptions {
  const projectArg = argv[0]?.trim();
  if (!projectArg || projectArg.startsWith("-")) {
    throw new Error("steamharness mcp requires a workflow project directory as its first argument.");
  }
  const projectDir = path.resolve(process.cwd(), projectArg);
  assertProjectDirectory(projectDir);
  let dataDir = path.join(os.homedir(), ".steamharness");
  let fileStoreDir: string | undefined;
  let kvStoreDir: string | undefined;
  let persistentValueStoreDir: string | undefined;
  let fileCreateStoreDir: string | undefined;
  let desktopConfigDir: string | undefined;
  let cliAuthDir: string | undefined;
  let entryId: string | undefined;

  for (let index = 1; index < argv.length; index += 1) {
    const option = argv[index];
    const value = argv[index + 1];
    if (!option || !value || value.startsWith("-")) {
      throw new Error(`Missing value for ${option ?? "MCP option"}.`);
    }
    index += 1;
    switch (option) {
      case "--data-dir": dataDir = resolveAbsoluteOption(value, option); break;
      case "--file-store-dir": fileStoreDir = resolveAbsoluteOption(value, option); break;
      case "--kv-store-dir": kvStoreDir = resolveAbsoluteOption(value, option); break;
      case "--persistent-value-store-dir":
        persistentValueStoreDir = resolveAbsoluteOption(value, option);
        break;
      case "--file-create-store-dir": fileCreateStoreDir = resolveAbsoluteOption(value, option); break;
      case "--desktop-config-dir": desktopConfigDir = resolveAbsoluteOption(value, option); break;
      case "--auth-dir": cliAuthDir = resolveAbsoluteOption(value, option); break;
      case "--entry": entryId = value; break;
      default: throw new Error(`Unknown steamharness mcp option: ${option}`);
    }
  }

  dataDir = path.resolve(dataDir);
  return {
    projectDir,
    dataDir,
    fileStoreDir: fileStoreDir ?? path.join(dataDir, "workflow-files"),
    kvStoreDir: kvStoreDir ?? path.join(dataDir, "workflow-kv"),
    persistentValueStoreDir: persistentValueStoreDir ?? path.join(dataDir, "workflow-persistent-values"),
    fileCreateStoreDir: fileCreateStoreDir ?? path.join(dataDir, "workflow-created-files"),
    desktopConfigDir,
    cliAuthDir,
    entryId,
  };
}

export class McpCliRunner implements McpRunner {
  private readonly resumeStates = new Map<string, McpResumeState>();
  private readonly activeChildren = new Set<ChildProcessWithoutNullStreams>();
  private readonly terminationTimers = new Map<ChildProcessWithoutNullStreams, ReturnType<typeof setTimeout>>();
  private projectName = "workflow";

  constructor(
    private readonly options: McpCliOptions,
    private readonly writeRunSnapshot?: McpRunSnapshotWriter,
  ) {}

  async inspectStructure(): Promise<McpStructureReport> {
    const result = await this.runWorker(["structure", this.options.projectDir, ...(this.options.entryId ? ["--entry", this.options.entryId] : [])]);
    const extracted = extractTrailingJson(result.stdout, isProjectMcpStructureCandidate);
    if (!extracted || result.exitCode !== 0) {
      const diagnostics = extracted ?? extractTrailingJson(result.stdout, isRecord);
      throw new Error(readWorkerFailure(result, diagnostics?.value));
    }
    const structure = extracted.value;
    if (structure.projectType !== "workflow") {
      throw new Error(`Project type "${String(structure.projectType)}" cannot be exposed through MCP.`);
    }
    forwardProjectStdout(result.stdout.slice(0, extracted.startIndex));
    this.projectName = structure.workflow.name;
    return structure;
  }

  async run(request: Parameters<McpRunner["run"]>[0]): Promise<McpExecutionReport> {
    const execution = await this.runJsonWorker({
      projectId: request.projectId,
      entryId: request.entryId,
      entrypointId: request.entrypointId,
      entrypointTitle: request.entrypointTitle,
      input: request.input,
      args: request.args,
      resolvedInputs: [],
      signal: request.signal,
    });
    const report = execution.report;
    if (report.status === "waiting_for_input") {
      this.resumeStates.set(report.runId, {
        entrypointId: request.entrypointId,
        entrypointTitle: request.entrypointTitle,
        input: { ...request.input },
        args: [...request.args],
        snapshot: execution.snapshot,
      });
    }
    return report;
  }

  async resume(request: Parameters<McpRunner["resume"]>[0]): Promise<McpExecutionReport> {
    const state = this.resumeStates.get(request.runId);
    if (!state || state.snapshot.projectId !== request.projectId || state.snapshot.entryId !== request.entryId || state.entrypointId !== request.entrypointId) {
      throw new Error(`Workflow MCP run "${request.runId}" is no longer available for resume.`);
    }
    const resolvedInputs = [...state.snapshot.resolvedUserInputs, {
      requestId: request.requestId,
      nodeName: request.nodeName,
      values: request.values,
      submittedAt: new Date().toISOString(),
    }];
    let execution: Awaited<ReturnType<McpCliRunner["runJsonWorker"]>>;
    try {
      execution = await this.runJsonWorker({
        projectId: request.projectId,
      entryId: request.entryId,
        entrypointId: state.entrypointId,
        entrypointTitle: state.entrypointTitle,
        input: state.input,
        args: state.args,
        runId: request.runId,
        startedAt: state.snapshot.startedAt,
        previousSnapshot: state.snapshot,
        resolvedInputs,
        signal: request.signal,
      });
    } catch (error) {
      this.resumeStates.delete(request.runId);
      throw error;
    }
    const report = execution.report;
    if (report.status !== "waiting_for_input") this.resumeStates.delete(request.runId);
    else state.snapshot = execution.snapshot;
    return report;
  }

  async cancel(request: Parameters<NonNullable<McpRunner["cancel"]>>[0]): Promise<void> {
    const state = this.resumeStates.get(request.runId);
    if (state === undefined) return;
    if (state.snapshot.projectId !== request.projectId || state.snapshot.entryId !== request.entryId || state.entrypointId !== request.entrypointId) throw new Error("MCP run belongs to another entry.");
    this.resumeStates.delete(request.runId);
    const reason = request.reason === "elicitation_declined"
      ? "The user declined the requested workflow input."
      : request.reason === "elicitation_cancelled"
        ? "The user cancelled the requested workflow input."
        : request.reason === "elicitation_failed"
          ? "The MCP elicitation response could not be processed."
          : "The MCP request was cancelled.";
    await this.recordAbortedResumeState(request.runId, state, reason);
  }

  async close(): Promise<void> {
    const pendingRuns = [...this.resumeStates.entries()];
    this.resumeStates.clear();
    for (const [runId, state] of pendingRuns) {
      await this.recordAbortedResumeState(
        runId,
        state,
        "The MCP connection closed before the requested workflow input was resumed.",
      );
    }
    const children = [...this.activeChildren];
    for (const child of children) this.terminateChild(child);
    await Promise.all(children.map((child) => waitForChildClose(child)));
  }

  private async recordAbortedResumeState(
    runId: string,
    state: McpResumeState,
    reason: string,
  ): Promise<void> {
    const endedAt = new Date().toISOString();
    const report = createSyntheticProjectMcpReport({
      runId,
      projectName: this.projectName,
      entrypointId: state.entrypointId,
      entrypointTitle: state.entrypointTitle,
      status: "aborted",
      startedAt: state.snapshot.startedAt,
      endedAt,
      exitCode: 130,
      stdout: state.snapshot.stdout,
      stderr: appendDiagnostic(state.snapshot.stderr, reason),
      message: reason,
      previousReport: state.snapshot.report,
      resolvedUserInputs: state.snapshot.resolvedUserInputs,
    });
    await this.recordRunSnapshot({
      ...state.snapshot,
      endedAt,
      exitCode: 130,
      stderr: appendDiagnostic(state.snapshot.stderr, reason),
      report,
    });
  }

  private async runJsonWorker(options: {
    projectId: string;
    entryId: string;
    entrypointId: string;
    entrypointTitle: string;
    input: Record<string, unknown>;
    args: string[];
    runId?: string;
    startedAt?: string;
    previousSnapshot?: McpRunSnapshot;
    resolvedInputs: McpRunSnapshot["resolvedUserInputs"];
    signal: AbortSignal;
  }): Promise<{ report: McpExecutionReport; snapshot: McpRunSnapshot }> {
    const runId = options.runId ?? randomUUID();
    const startedAt = options.startedAt ?? new Date().toISOString();
    const previousStdout = options.previousSnapshot?.stdout ?? "";
    const previousStderr = options.previousSnapshot?.stderr ?? "";
    await this.recordRunSnapshot({
      projectId: options.projectId,
      entryId: options.entryId,
      entrypointId: options.entrypointId,
      entrypointTitle: options.entrypointTitle,
      input: { ...options.input },
      args: [...options.args],
      resolvedUserInputs: [...options.resolvedInputs],
      startedAt,
      endedAt: startedAt,
      exitCode: 0,
      stdout: previousStdout,
      stderr: previousStderr,
      report: createSyntheticProjectMcpReport({
        runId,
        projectName: this.projectName,
        entrypointId: options.entrypointId,
        entrypointTitle: options.entrypointTitle,
        status: "running",
        startedAt,
        endedAt: startedAt,
        exitCode: 0,
        stdout: previousStdout,
        stderr: previousStderr,
        previousReport: options.previousSnapshot?.report,
        resolvedUserInputs: options.resolvedInputs,
      }),
    });
    const hostArgs = [
      "json",
      this.options.projectDir,
      "--entrypoint",
      options.entrypointId,
      "--run-id",
      runId,
      ...(options.resolvedInputs.length > 0
        ? ["--resolved-user-inputs-json", JSON.stringify(options.resolvedInputs)]
        : []),
      "--file-store-dir",
      this.options.fileStoreDir,
      "--entry", options.entryId,
      "--",
      ...options.args,
    ];
    let result: WorkerResult | undefined;
    try {
      result = await this.runWorker(hostArgs, options.signal);
      const extracted = extractTrailingJson(result.stdout, isProjectMcpExecutionCandidate);
      if (!extracted) {
        const diagnostics = extractTrailingJson(result.stdout, isRecord);
        throw new Error(readWorkerFailure(result, diagnostics?.value));
      }
      const workerStdout = result.stdout.slice(0, extracted.startIndex);
      forwardProjectStdout(workerStdout);
      if (extracted.value.runId !== runId) {
        throw new Error("Workflow MCP worker changed the host-assigned run ID.");
      }
      const endedAt = new Date().toISOString();
      const stdout = appendCapturedOutput(previousStdout, workerStdout);
      const stderr = appendCapturedOutput(previousStderr, result.stderr);
      const snapshot: McpRunSnapshot = {
        projectId: options.projectId,
      entryId: options.entryId,
        entrypointId: options.entrypointId,
        entrypointTitle: options.entrypointTitle,
        input: { ...options.input },
        args: [...options.args],
        resolvedUserInputs: [...options.resolvedInputs],
        startedAt,
        endedAt,
        exitCode: result.exitCode,
        stdout,
        stderr,
        report: extracted.value,
      };
      await this.recordRunSnapshot(snapshot);
      return { report: extracted.value, snapshot };
    } catch (error) {
      const workerFailure = error instanceof McpWorkerError ? error.result : undefined;
      const diagnostics = result ?? workerFailure;
      const workerStdout = diagnostics?.stdout ?? "";
      const workerStderr = diagnostics?.stderr ?? "";
      forwardProjectStdout(workerStdout);
      const stdout = appendCapturedOutput(previousStdout, workerStdout);
      const stderr = appendCapturedOutput(previousStderr, workerStderr);
      const endedAt = new Date().toISOString();
      const aborted = options.signal.aborted;
      const message = formatError(aborted ? options.signal.reason ?? error : error);
      const exitCode = aborted ? 130 : diagnostics?.exitCode ?? 1;
      const persistedStderr = appendDiagnostic(stderr, message);
      const report = createSyntheticProjectMcpReport({
        runId,
        projectName: this.projectName,
        entrypointId: options.entrypointId,
        entrypointTitle: options.entrypointTitle,
        status: aborted ? "aborted" : "failed",
        startedAt,
        endedAt,
        exitCode,
        stdout,
        stderr: persistedStderr,
        message,
        previousReport: options.previousSnapshot?.report,
        resolvedUserInputs: options.resolvedInputs,
      });
      await this.recordRunSnapshot({
        projectId: options.projectId,
      entryId: options.entryId,
        entrypointId: options.entrypointId,
        entrypointTitle: options.entrypointTitle,
        input: { ...options.input },
        args: [...options.args],
        resolvedUserInputs: [...options.resolvedInputs],
        startedAt,
        endedAt,
        exitCode,
        stdout,
        stderr: persistedStderr,
        report,
      });
      throw error;
    }
  }

  private async recordRunSnapshot(snapshot: McpRunSnapshot): Promise<void> {
    if (this.writeRunSnapshot === undefined) return;
    try {
      await this.writeRunSnapshot(snapshot);
    } catch (error) {
      process.stderr.write(`Unable to persist the Desktop MCP run snapshot: ${formatError(error)}\n`);
    }
  }

  private runWorker(args: string[], signal?: AbortSignal): Promise<WorkerResult> {
    const mainScript = this.options.workerEntrypoint ?? resolveProjectMcpWorkerEntrypoint();
    const execArgs = workerExecArguments(process.execArgv, mainScript);
    const child = spawn(process.execPath, [...execArgs, mainScript, ...args], {
      cwd: this.options.projectDir,
      env: {
        ...process.env,
        ...readSavedProjectMcpAuthEnv(this.options),
        ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE ?? "1",
        ...(this.options.desktopConfigDir
          ? { STEAMHARNESS_DESKTOP_CONFIG_DIR: this.options.desktopConfigDir }
          : {}),
        ...(this.options.cliAuthDir ? { STEAMHARNESS_CLI_AUTH_DIR: this.options.cliAuthDir } : {}),
        STEAMHARNESS_KV_STORE_DIR: this.options.kvStoreDir,
        STEAMHARNESS_PERSISTENT_VALUE_STORE_DIR: this.options.persistentValueStoreDir,
        STEAMHARNESS_FILE_STORE_DIR: this.options.fileStoreDir,
        STEAMHARNESS_FILE_CREATE_STORE_DIR: this.options.fileCreateStoreDir,
        STEAMHARNESS_DESKTOP_RUNTIME_EVENTS: "0",
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.activeChildren.add(child);
    return new Promise((resolve, reject) => {
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      const abort = () => this.terminateChild(child);
      let settled = false;
      const cleanup = () => {
        this.activeChildren.delete(child);
        const terminationTimer = this.terminationTimers.get(child);
        if (terminationTimer) clearTimeout(terminationTimer);
        this.terminationTimers.delete(child);
        signal?.removeEventListener("abort", abort);
      };
      const settleError = (error: unknown) => {
        if (settled) return;
        settled = true;
        const cause = error instanceof Error ? error : new Error(String(error));
        reject(new McpWorkerError(cause.message, {
          exitCode: signal?.aborted ? 130 : 1,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        }, { cause }));
      };
      signal?.addEventListener("abort", abort, { once: true });
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => {
        stderr.push(chunk);
        process.stderr.write(chunk);
      });
      // Workers never consume MCP protocol input; close stdin so a loader or
      // project cannot wait on an unrelated inherited pipe.
      child.stdin.end();
      child.once("error", (error) => {
        // A spawn error is terminal, but Node may still emit close later. Keep
        // the child tracked until close so runner.close() can reap it.
        if (!signal?.aborted && child.exitCode === null && child.signalCode === null) {
          this.terminateChild(child);
        }
        settleError(signal?.aborted ? signal.reason ?? new Error("Workflow MCP call was cancelled.") : error);
      });
      child.once("close", (exitCode) => {
        cleanup();
        if (settled) return;
        if (signal?.aborted) {
          settleError(signal.reason ?? new Error("Workflow MCP call was cancelled."));
          return;
        }
        settled = true;
        resolve({
          exitCode: exitCode ?? 1,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
      });
      if (signal?.aborted) abort();
    });
  }

  private terminateChild(child: ChildProcessWithoutNullStreams): void {
    if (child.exitCode !== null || child.signalCode !== null || this.terminationTimers.has(child)) return;
    child.kill("SIGTERM");
    const timer = setTimeout(() => {
      this.terminationTimers.delete(child);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, STEAMHARNESS_MCP_WORKER_TERMINATION_GRACE_MS);
    timer.unref();
    this.terminationTimers.set(child, timer);
  }
}

type McpIpcSend = (
  message: McpRunSnapshotMessage,
  callback: (error: Error | null) => void,
) => boolean;

export function createProjectMcpDesktopAuditWriter(options: {
  env?: NodeJS.ProcessEnv;
  send?: McpIpcSend;
} = {}): McpRunSnapshotWriter | undefined {
  const env = options.env ?? process.env;
  if (env[STEAMHARNESS_MCP_DESKTOP_AUDIT_IPC_ENV] !== "1") return undefined;
  const send = options.send ?? (typeof process.send === "function"
    ? process.send.bind(process) as McpIpcSend
    : undefined);
  if (send === undefined) return undefined;

  return (snapshot) => new Promise<void>((resolve, reject) => {
    try {
      send({ type: "project_mcp_run_snapshot", snapshot }, (error) => {
        if (error) reject(error);
        else resolve();
      });
    } catch (error) {
      reject(error);
    }
  });
}

function createSyntheticProjectMcpReport(options: {
  runId: string;
  projectName: string;
  entrypointId: string;
  entrypointTitle: string;
  status: McpExecutionReport["status"];
  startedAt: string;
  endedAt: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  message?: string;
  previousReport?: unknown;
  resolvedUserInputs?: McpRunSnapshot["resolvedUserInputs"];
}): McpExecutionReport & Record<string, unknown> {
  const previousSource = isRecord(options.previousReport) ? options.previousReport : {};
  const {
    pendingUserInput: _pendingUserInput,
    result: _result,
    ...previous
  } = previousSource;
  const previousRunner = isRecord(previous["runner"]) ? previous["runner"] : {};
  const startedAtMs = Date.parse(options.startedAt);
  const endedAtMs = Date.parse(options.endedAt);
  const durationMs = Number.isFinite(startedAtMs) && Number.isFinite(endedAtMs)
    ? Math.max(0, endedAtMs - startedAtMs)
    : 0;
  const result = options.status === "running"
    ? undefined
    : {
        ok: false,
        error: {
          type: options.status === "aborted" ? "project_cancelled" : "execution",
          message: options.message ?? "Workflow execution did not complete.",
        },
      };

  return {
    ...previous,
    runId: options.runId,
    projectName: options.projectName,
    entrypointId: options.entrypointId,
    entrypointTitle: options.entrypointTitle,
    status: options.status,
    startedAt: options.startedAt,
    endedAt: options.endedAt,
    durationMs,
    resolvedUserInputs: [...(options.resolvedUserInputs ?? [])],
    runner: {
      ...previousRunner,
      exitCode: options.exitCode,
      stdout: options.stdout,
      stderr: options.stderr,
    },
    ...(result === undefined ? {} : { result }),
  };
}

function appendCapturedOutput(previous: string, current: string): string {
  if (previous === "") return current;
  if (current === "") return previous;
  return previous.endsWith("\n") || current.startsWith("\n")
    ? `${previous}${current}`
    : `${previous}\n${current}`;
}

function appendDiagnostic(value: string, message: string): string {
  const current = value.trimEnd();
  const diagnostic = message.trim();
  if (diagnostic === "") return current;
  return current === "" ? diagnostic : `${current}\n${diagnostic}`;
}

/**
 * Resolve the exact CLI module that is currently running. Electron and npm
 * bin launchers do not all populate argv in the same way, so Desktop may set
 * an explicit absolute path through STEAMHARNESS_MCP_CLI_ENTRYPOINT.
 */
const DEVELOPMENT_CONDITION_ARGUMENTS = /^(?:--conditions[= ]|-C[= ])?development$/u;

/**
 * The worker is the CLI itself. A TypeScript entrypoint runs under a loader and
 * wants the same development conditions this process started with; a built
 * entrypoint must not inherit them, because the harness package resolves to its
 * TypeScript sources under that condition and a plain Node process cannot load
 * them.
 */
export function workerExecArguments(execArgv: readonly string[], entrypoint: string): string[] {
  const kept = execArgv.filter((argument) => !argument.startsWith("--inspect"));
  if (/\.[cm]?tsx?$/u.test(entrypoint)) return kept;
  return kept.filter((argument, index) => !(
    DEVELOPMENT_CONDITION_ARGUMENTS.test(argument)
    || ((argument === "--conditions" || argument === "-C") && kept[index + 1] === "development")
  ));
}

export function resolveProjectMcpWorkerEntrypoint(
  processArgv: readonly string[] = process.argv,
  processEnv: NodeJS.ProcessEnv = process.env,
): string {
  const configuredValue = processEnv[STEAMHARNESS_MCP_CLI_ENTRYPOINT_ENV];
  const candidate = configuredValue === undefined
    ? processArgv[1]?.trim()
    : configuredValue.trim();
  if (!candidate) throw new Error("Unable to resolve the steamharness CLI entrypoint.");
  if (candidate.startsWith("-")) {
    throw new Error("Unable to resolve the steamharness CLI entrypoint.");
  }
  return path.isAbsolute(candidate) ? path.normalize(candidate) : path.resolve(process.cwd(), candidate);
}

interface WorkerResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

class McpWorkerError extends Error {
  constructor(
    message: string,
    readonly result: WorkerResult,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "McpWorkerError";
  }
}

function waitForChildClose(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("close", () => resolve()));
}

function extractTrailingJson<T>(
  value: string,
  predicate: (value: unknown) => value is T,
): { value: T; startIndex: number } | undefined {
  for (let index = value.lastIndexOf("{"); index >= 0;) {
    if (value[index] !== "{") continue;
    try {
      const parsed = JSON.parse(value.slice(index).trim()) as unknown;
      if (predicate(parsed)) {
        return { value: parsed, startIndex: index };
      }
    } catch {
      // Project logs may contain JSON fragments before the final report.
    }
    if (index === 0) break;
    index = value.lastIndexOf("{", index - 1);
  }
  return undefined;
}

function isProjectMcpReportCandidate(value: unknown): boolean {
  return isProjectMcpStructureCandidate(value) || isProjectMcpExecutionCandidate(value);
}

function isProjectMcpStructureCandidate(value: unknown): value is McpStructureReport {
  return isRecord(value) && typeof value.projectType === "string" &&
    isRecord(value.workflow) && typeof value.workflow.name === "string";
}

function isProjectMcpExecutionCandidate(value: unknown): value is McpExecutionReport {
  return isRecord(value) && typeof value.runId === "string" && isProjectMcpRunStatus(value.status);
}

function isProjectMcpRunStatus(value: unknown): boolean {
  return value === "running" || value === "waiting_for_input" || value === "success" ||
    value === "failed" || value === "aborted" || value === "timed_out";
}

function forwardProjectStdout(value: string): void {
  const output = value.trim();
  if (output !== "") process.stderr.write(`${output}\n`);
}

function readWorkerFailure(result: WorkerResult, parsed?: unknown): string {
  if (isRecord(parsed)) {
    const diagnostics = isRecord(parsed["diagnostics"]) ? parsed["diagnostics"] : undefined;
    const error = isRecord(parsed["error"])
      ? parsed["error"]
      : diagnostics && isRecord(diagnostics["error"])
        ? diagnostics["error"]
        : parsed;
    if (typeof error["message"] === "string" && error["message"].trim() !== "") {
      return compactWorkerErrorMessage([
        error["message"],
        ...readWorkerViolationMessages(error),
      ].join(" "));
    }
  }
  return `Workflow worker exited with code ${result.exitCode}. Check MCP host stderr for local diagnostics.`;
}

function readWorkerViolationMessages(error: Record<string, unknown>): string[] {
  const metadata = isRecord(error["metadata"]) ? error["metadata"] : undefined;
  const violations = metadata && Array.isArray(metadata["violations"])
    ? metadata["violations"]
    : [];
  const messages = violations.flatMap((violation) => (
    isRecord(violation) && typeof violation["message"] === "string"
      ? [violation["message"].trim()]
      : []
  )).filter((message) => message !== "");
  return [...new Set(messages)];
}

function compactWorkerErrorMessage(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= 500 ? compact : `${compact.slice(0, 497)}...`;
}

function readProjectId(projectDir: string): string {
  const packagePath = path.join(projectDir, "steamharness.json");
  const packageJson = JSON.parse(readFileSync(packagePath, "utf8")) as unknown;
  if (!isRecord(packageJson) || typeof packageJson["id"] !== "string" || packageJson["id"].trim() === "") {
    throw new Error("Workflow MCP requires steamharness.json to contain an immutable project id.");
  }
  return assertProjectUuid(packageJson["id"], "Workflow MCP project id");
}

function assertProjectDirectory(projectDir: string): void {
  let info;
  try {
    info = lstatSync(projectDir);
  } catch {
    throw new Error(`Workflow MCP project directory does not exist: ${projectDir}`);
  }
  if (!info.isDirectory()) {
    throw new Error(`Workflow MCP project path is not a directory: ${projectDir}`);
  }
}

export function readSavedProjectMcpAuthEnv(
  options: McpCliOptions,
  processEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const explicitServerUrl = processEnv.STEAMHARNESS_SERVER_URL?.trim() ?? "";
  const explicitAdminKey = processEnv.STEAMHARNESS_SERVER_ADMIN_KEY?.trim() ?? "";
  if (explicitServerUrl !== "" || explicitAdminKey !== "") {
    if (explicitServerUrl === "" || explicitAdminKey === "") {
      throw new Error(
        "STEAMHARNESS_SERVER_URL and STEAMHARNESS_SERVER_ADMIN_KEY must be provided together for MCP workers.",
      );
    }
    // An explicit pair is authoritative. Never merge one explicit value with
    // a saved credential from Desktop or the CLI auth directory.
    return {};
  }
  const env = {
    ...processEnv,
    ...(options.desktopConfigDir ? { STEAMHARNESS_DESKTOP_CONFIG_DIR: options.desktopConfigDir } : {}),
    ...(options.cliAuthDir ? { STEAMHARNESS_CLI_AUTH_DIR: options.cliAuthDir } : {}),
  };
  const desktopAuth = readDesktopAuth(options.desktopConfigDir);
  const auth = desktopAuth && isProjectAuthConfigLoggedIn(desktopAuth)
    ? desktopAuth
    : readCliAuthConfigSync(env);
  if (!isProjectAuthConfigLoggedIn(auth)) return {};
  return {
    STEAMHARNESS_SERVER_URL: auth.serverUrl,
    STEAMHARNESS_SERVER_ADMIN_KEY: auth.apiKey,
  };
}

function readDesktopAuth(configDir: string | undefined) {
  if (!configDir) return undefined;
  try {
    const raw = JSON.parse(readFileSync(resolveProjectDesktopConfigFilePath({
      STEAMHARNESS_DESKTOP_CONFIG_DIR: configDir,
    }), "utf8")) as unknown;
    return normalizeProjectAuthConfig(isRecord(raw) && "auth" in raw ? raw["auth"] : raw);
  } catch {
    return undefined;
  }
}

function resolveAbsoluteOption(value: string, option: string): string {
  if (!path.isAbsolute(value)) throw new Error(`${option} requires an absolute path.`);
  return path.normalize(value);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
