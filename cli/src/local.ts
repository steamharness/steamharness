import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createCliOutputStreamHooks,
  createWorkflowFailure,
  formatWorkflowExecutionJson,
  inspectLocalWorkflowStructure,
  parseToolPermissionPoliciesJson,
  resolveLocalWorkflowParams,
  runLocalWorkflowWithReport,
  type WorkflowExecutionReport,
  type WorkflowParamResolveRequest,
  type WorkflowRuntimeEvent,
  type WorkflowToolPermissionPolicyMap,
  type WorkflowUserInputResolved,
} from "workflow-code";
import { readWorkflowProjectInfo } from "@workflow-code/project-info";
import { i18n, translateWorkflowCodeError } from "@workflow-code/i18n";
import {
  assertCoreCompatibility,
  classifyVersionReference,
  normalizeExactVersion,
  readRequiredCoreVersion,
  resolveReleaseMode,
  resolveRequiredCoreVersion,
  type RepositoryMode,
} from "@workflow-code/runtime-compatibility";
import { prepareCliInvocation } from "./locale";
import {
  createCliRelatedProjectRuntime,
  parseCliRelatedProjectSpec,
  type CliRelatedProjectSpec,
} from "./related-projects";

type WorkflowCodeCommand = "run" | "json" | "structure" | "resolve-params" | "help";

export const WORKFLOW_DESKTOP_RUNTIME_EVENTS_ENV = "WORKFLOW_DESKTOP_RUNTIME_EVENTS";
export const WORKFLOW_DESKTOP_RUNTIME_EVENT_PREFIX = "__WORKFLOW_CODE_RUNTIME_EVENT__";
export const WORKFLOW_PARAM_ERROR_MARKER = "__WORKFLOW_CODE_PARAM_ERROR__";
const RESUME_RUNTIME_EVENT_AFTER_REQUEST_ID = "__workflowResumeRuntimeEventAfterRequestId";

export async function main(
  argv = process.argv.slice(2),
  options: { localeInitialized?: boolean } = {},
): Promise<number> {
  disableAiSdkWarningLogs();
  if (options.localeInitialized !== true) {
    argv = prepareCliInvocation(argv).argv;
  }
  const abortController = createProcessAbortController();

  const command = parseCommand(argv[0]);
  const args = command === "help" ? argv.slice(1) : argv.slice(1);

  if (command === "help") {
    console.log(formatHelp());
    return 0;
  }

  if (command === "structure") {
    return runStructureCommand(args);
  }
  if (command === "resolve-params") {
    return runResolveParamsCommand(args, abortController.signal);
  }

  const parsed = parseWorkflowArgs(args, {
    json: command === "json",
  });
  assertLocalCliCoreCompatible(parsed.workflowDir);
  const relatedProjectRuntime = createCliRelatedProjectRuntime({
    consumerProjectDir: parsed.workflowDir,
    relatedProjects: parsed.relatedProjects,
    localKvStoreDir: process.env.WORKFLOW_KV_STORE_DIR,
    localPersistentValueStoreDir: process.env.WORKFLOW_PERSISTENT_VALUE_STORE_DIR,
    runId: parsed.runId,
    conversationId: parsed.conversationId,
    env: process.env,
  });
  const storage = {
    host: "local" as const,
    local: {
      kvStore: relatedProjectRuntime.localKvStore,
      kvStoreDir: process.env.WORKFLOW_KV_STORE_DIR,
      persistentValueStoreDir: process.env.WORKFLOW_PERSISTENT_VALUE_STORE_DIR,
      relatedProjectResolver: relatedProjectRuntime.localResolver,
    },
    server: {
      relatedProjectResolver: relatedProjectRuntime.serverResolver,
    },
  } as unknown as NonNullable<Parameters<typeof runLocalWorkflowWithReport>[0]>["storage"];
  const report = await runLocalWorkflowWithReport({
    workflowDir: parsed.workflowDir,
    entrypointId: parsed.entrypointId,
    args: parsed.args,
    runId: parsed.runId,
    conversationId: parsed.conversationId,
    storage,
    fileStoreDir: parsed.fileStoreDir ?? process.env.WORKFLOW_FILE_STORE_DIR,
    userInput: createCliUserInputContext(parsed.resolvedUserInputs),
    toolPermissionPolicies: parsed.toolPermissionPolicies,
    fileCreateStoreDir: process.env.WORKFLOW_FILE_CREATE_STORE_DIR,
    nodeHooks: parsed.json ? undefined : createCliOutputStreamHooks(),
    onRuntimeEvent: parsed.json ? createDesktopRuntimeEventEmitter() : undefined,
    abortSignal: abortController.signal,
  });

  if (parsed.json) {
    console.log(formatWorkflowExecutionJson(report));
  } else if (report.status === "failed") {
    console.error(formatWorkflowExecutionJson(report));
  }

  return getReportExitCode(report);
}

function createProcessAbortController(): AbortController {
  const controller = new AbortController();
  let forcedExit: ReturnType<typeof setTimeout> | undefined;
  const abort = () => {
    if (!controller.signal.aborted) {
      // Electron run cancellation reaches local workflow context so
      // long-running SDK calls can receive an AbortSignal before process exit.
      controller.abort(new Error("Workflow CLI process was interrupted."));
      forcedExit = setTimeout(() => {
        process.exit(130);
      }, 5_000);
      forcedExit.unref?.();
    }
  };

  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  process.once("beforeExit", () => clearTimeout(forcedExit));
  return controller;
}

function parseCommand(value: string | undefined): WorkflowCodeCommand {
  if (value === undefined || value === "--help" || value === "-h" || value === "help") {
    return "help";
  }

  if (value === "run" || value === "json" || value === "structure" || value === "resolve-params") {
    return value;
  }

  throw new Error(i18n.t("unknownLocalCommand", { ns: "cli", command: value }));
}

async function runResolveParamsCommand(argv: string[], abortSignal: AbortSignal): Promise<number> {
  try {
    const parsed = parseWorkflowArgs(argv, { json: true });
    assertLocalCliCoreCompatible(parsed.workflowDir);
    const request = parseParamResolveRequest(readFileSync(0, "utf8"));
    const result = await resolveLocalWorkflowParams({
      workflowDir: parsed.workflowDir,
      entrypointId: parsed.entrypointId,
      request,
      abortSignal,
    });
    console.log(JSON.stringify(result));
    return 0;
  } catch (error) {
    console.error(formatParamResolverFailure(error));
    return 1;
  }
}

export function formatParamResolverFailure(error: unknown): string {
  return `${WORKFLOW_PARAM_ERROR_MARKER}${JSON.stringify(createWorkflowFailure(error).error)}`;
}

function parseParamResolveRequest(value: string): WorkflowParamResolveRequest {
  const parsed = JSON.parse(value) as Partial<WorkflowParamResolveRequest>;
  if (
    typeof parsed !== "object" || parsed === null ||
    typeof parsed.draftText !== "string" ||
    !Array.isArray(parsed.args) || !parsed.args.every((arg) => typeof arg === "string") ||
    (parsed.inputMode !== "form" && parsed.inputMode !== "raw") ||
    typeof parsed.trigger !== "object" || parsed.trigger === null ||
    (parsed.trigger.kind !== "init" && parsed.trigger.kind !== "input" && parsed.trigger.kind !== "param") ||
    (parsed.trigger.kind === "param" && typeof parsed.trigger.paramName !== "string")
  ) {
    throw new Error(i18n.t("invalidParamResolveRequest", { ns: "cli" }));
  }
  return parsed as WorkflowParamResolveRequest;
}

export function parseWorkflowArgs(
  argv: string[],
  options: { json: boolean },
): {
  workflowDir: string;
  args: string[];
  json: boolean;
  runId?: string;
  entrypointId?: string;
  conversationId?: string;
  fileStoreDir?: string;
  resolvedUserInputs: WorkflowUserInputResolved[];
  toolPermissionPolicies?: WorkflowToolPermissionPolicyMap;
  relatedProjects: CliRelatedProjectSpec[];
} {
  let json = options.json;
  let runId: string | undefined;
  let entrypointId: string | undefined;
  let conversationId: string | undefined;
  let fileStoreDir: string | undefined;
  let resolvedUserInputs: WorkflowUserInputResolved[] = [];
  let toolPermissionPolicies: WorkflowToolPermissionPolicyMap | undefined;
  const relatedProjects: CliRelatedProjectSpec[] = [];
  const filteredArgv: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      // Stop parsing workflow-code options at the explicit separator
      // so workflow args such as "--json" pass through unchanged.
      filteredArgv.push(...argv.slice(index));
      break;
    }

    if (arg === "--json") {
      json = true;
      continue;
    }

    if (arg === "--conversation-id") {
      conversationId = readWorkflowArgValue(argv, ++index, "--conversation-id");
      continue;
    }

    if (arg === "--run-id") {
      runId = readWorkflowArgValue(argv, ++index, "--run-id");
      continue;
    }

    if (arg === "--entrypoint") {
      entrypointId = readWorkflowArgValue(argv, ++index, "--entrypoint");
      continue;
    }

    if (arg === "--file-store-dir") {
      fileStoreDir = readWorkflowArgValue(argv, ++index, "--file-store-dir");
      continue;
    }

    if (arg === "--related-project") {
      relatedProjects.push(parseCliRelatedProjectSpec(
        readWorkflowArgValue(argv, ++index, "--related-project"),
      ));
      continue;
    }

    if (arg === "--resolved-user-inputs-json") {
      resolvedUserInputs = parseResolvedUserInputs(
        readWorkflowArgValue(argv, ++index, "--resolved-user-inputs-json"),
      );
      continue;
    }

    if (arg === "--tool-permissions-json") {
      // Internal host transport for App/server policy overrides.
      // The executor runtime filters unknown tools after reading registrations.
      toolPermissionPolicies = parseToolPermissionPoliciesJson(
        readWorkflowArgValue(argv, ++index, "--tool-permissions-json"),
      );
      continue;
    }

    filteredArgv.push(arg);
  }

  const [workflowDirArg, ...rest] = filteredArgv;

  if (
    workflowDirArg !== undefined &&
    workflowDirArg !== "--" &&
    !workflowDirArg.startsWith("-")
  ) {
    return {
      workflowDir: path.resolve(process.cwd(), workflowDirArg),
      args: removePnpmRunSeparator(rest),
      json,
      runId,
      entrypointId,
      conversationId,
      fileStoreDir,
      resolvedUserInputs,
      toolPermissionPolicies,
      relatedProjects,
    };
  }

  return {
    workflowDir: process.cwd(),
    args: removePnpmRunSeparator(filteredArgv),
    json,
    runId,
    entrypointId,
    conversationId,
    fileStoreDir,
    resolvedUserInputs,
    toolPermissionPolicies,
    relatedProjects,
  };
}

function createCliUserInputContext(resolvedInputs: WorkflowUserInputResolved[]) {
  return {
    [RESUME_RUNTIME_EVENT_AFTER_REQUEST_ID]: resolvedInputs.at(-1)?.requestId,
    getResolvedInput(requestId: string) {
      return resolvedInputs.find((input) => input.requestId === requestId);
    },
    requestInput() {
      // The CLI first phase is non-interactive: it records the
      // pending request in the JSON report and tells callers to resume with
      // --resolved-user-inputs-json instead of reading stdin.
      throw new Error(
        i18n.t("waitingForUserInput", { ns: "cli" }),
      );
    },
  };
}

function parseResolvedUserInputs(value: string): WorkflowUserInputResolved[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(i18n.t("resolvedInputsMustBeArray", { ns: "cli" }));
  }

  return parsed.map((item) => {
    if (
      typeof item !== "object" ||
      item === null ||
      typeof (item as { requestId?: unknown }).requestId !== "string" ||
      typeof (item as { nodeName?: unknown }).nodeName !== "string" ||
      typeof (item as { values?: unknown }).values !== "object" ||
      (item as { values?: unknown }).values === null ||
      typeof (item as { submittedAt?: unknown }).submittedAt !== "string"
    ) {
      throw new Error(i18n.t("invalidResolvedInput", { ns: "cli" }));
    }

    return {
      requestId: (item as { requestId: string }).requestId,
      nodeName: (item as { nodeName: string }).nodeName,
      values: (item as { values: Record<string, unknown> }).values,
      submittedAt: new Date((item as { submittedAt: string }).submittedAt),
    };
  });
}

export function createDesktopRuntimeEventEmitter(): ((event: WorkflowRuntimeEvent) => void) | undefined {
  if (process.env[WORKFLOW_DESKTOP_RUNTIME_EVENTS_ENV] !== "1") {
    return undefined;
  }

  return (event) => {
    // Keep local Desktop streaming events hidden behind a prefixed line so
    // the final JSON report remains parseable by existing CLI consumers.
    process.stdout.write(
      `${WORKFLOW_DESKTOP_RUNTIME_EVENT_PREFIX}${JSON.stringify(event, createRuntimeEventJsonReplacer())}\n`,
    );
  };
}

function createRuntimeEventJsonReplacer(): (key: string, value: unknown) => unknown {
  const ancestors: object[] = [];

  return function replacer(this: unknown, _key, value) {
    if (typeof value === "bigint") {
      return `${value.toString()}n`;
    }

    if (typeof value === "function") {
      return `[Function ${value.name || "anonymous"}]`;
    }

    if (typeof value === "symbol") {
      return value.toString();
    }

    if (typeof value === "object" && value !== null) {
      while (ancestors.length > 0 && ancestors.at(-1) !== this) {
        ancestors.pop();
      }

      if (ancestors.includes(value)) {
        return "[Circular]";
      }

      ancestors.push(value);
    }

    return value;
  };
}

function readWorkflowArgValue(argv: string[], index: number, name: string): string {
  const value = argv[index];
  if (value === undefined) {
    throw new Error(i18n.t("missingOptionValue", { ns: "cli", name }));
  }
  return value;
}

function runStructureCommand(argv: string[]): number {
  const parsed = parseWorkflowArgs(argv, { json: true });

  try {
    assertLocalCliCoreCompatible(parsed.workflowDir);
    const projectManifest = readJsonFile(
      path.join(parsed.workflowDir, "package.json"),
      "Workflow package.json",
    );
    readWorkflowProjectInfo(projectManifest);
    const report = inspectLocalWorkflowStructure({
      workflowDir: parsed.workflowDir,
    });

    console.log(JSON.stringify(report, null, 2));
    return 0;
  } catch (error) {
    console.log(formatWorkflowStructureError(error));
    return 1;
  }
}

export function assertLocalCliCoreCompatible(
  workflowDir: string,
  hostCoreVersion = readInstalledWorkflowCoreVersion(),
  options: { mode?: RepositoryMode } = {},
): { cliRequiredCoreVersion: string; projectRequiredCoreVersion: string } {
  // CLI 自己的清单是发布契约：它永远钉精确的 Core 版本，不接受相对路径。
  const cliManifest = readJsonFile(new URL("../package.json", import.meta.url), "CLI package.json");
  const cliRequiredCoreVersion = readRequiredCoreVersion(cliManifest);
  assertCoreCompatibility(hostCoreVersion, cliRequiredCoreVersion);

  const projectDirectory = path.resolve(workflowDir);
  const projectManifest = readJsonFile(path.join(projectDirectory, "package.json"), "Workflow package.json");
  // 内置项目位于 open-soucres/build-in/ 下；相对引用仍以开源源码根为边界。
  const parentDirectory = path.dirname(projectDirectory);
  const reference = classifyVersionReference(projectManifest, "workflow-code");
  const workspaceRoot = reference.kind === "local" && path.posix.normalize(reference.relative).startsWith("../../")
    && path.basename(projectDirectory).startsWith("build-in-")
    ? path.dirname(parentDirectory) : parentDirectory;
  // 项目在 dev 和功能分支上引用本地 Core，所以这里要解析相对路径；
  // Alpha/正式版本里不存在这种引用，走不到这条分支。
  const projectRequiredCoreVersion = resolveRequiredCoreVersion(projectManifest, {
    mode: options.mode ?? resolveReleaseMode(),
    repositoryDirectory: path.relative(workspaceRoot, projectDirectory).split(path.sep).join("/"),
    readSiblingManifest: (siblingDirectory) => readJsonFile(
      path.join(workspaceRoot, siblingDirectory, "package.json"),
      "Sibling Core package.json",
    ),
  });
  assertCoreCompatibility(hostCoreVersion, projectRequiredCoreVersion);
  return { cliRequiredCoreVersion, projectRequiredCoreVersion };
}

export function readInstalledWorkflowCoreVersion(env: NodeJS.ProcessEnv = process.env): string {
  const developmentRoot = env.WORKFLOW_LOCAL_CORE_ROOT?.trim();
  if (developmentRoot) {
    return readCoreVersionFromPackage(path.resolve(developmentRoot, "package.json"));
  }

  const coreEntry = fileURLToPath(import.meta.resolve("workflow-code"));
  let current = path.dirname(coreEntry);
  for (let depth = 0; depth < 8; depth += 1) {
    const packagePath = path.join(current, "package.json");
    try {
      const manifest = readJsonFile(packagePath, "Installed Core package.json");
      if (isRecord(manifest) && manifest["name"] === "workflow-code") {
        return readCoreVersion(manifest);
      }
    } catch {
      // Continue toward the resolved package root.
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`Unable to locate workflow-code package.json from ${coreEntry}.`);
}

function readCoreVersionFromPackage(packagePath: string): string {
  const manifest = readJsonFile(packagePath, "Core package.json");
  if (!isRecord(manifest) || manifest["name"] !== "workflow-code") {
    throw new Error(`Core package.json must declare name "workflow-code".`);
  }
  return readCoreVersion(manifest);
}

function readCoreVersion(manifest: Record<string, unknown>): string {
  const version = manifest["version"];
  if (typeof version !== "string") throw new Error(`Core package.json must declare an exact version.`);
  return normalizeExactVersion(version, "Installed Core version");
}

function readJsonFile(file: string | URL, label: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${label} could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function removePnpmRunSeparator(argv: string[]): string[] {
  const separatorIndex = argv.indexOf("--");

  if (separatorIndex < 0) {
    return argv;
  }

  return [
    ...argv.slice(0, separatorIndex),
    ...argv.slice(separatorIndex + 1),
  ];
}

function getReportExitCode(report: WorkflowExecutionReport): number {
  if (report.status === "failed") {
    return 1;
  }

  const result = report.result;

  if (
    result.ok &&
    typeof result.data === "object" &&
    result.data !== null &&
    "errCode" in result.data &&
    typeof result.data.errCode === "number"
  ) {
    return result.data.errCode === 0 ? 0 : 1;
  }

  return 0;
}

function formatWorkflowStructureError(error: unknown): string {
  return JSON.stringify(
    {
      workflow: {
        name: "",
      },
      definitions: {
        nodes: {},
        apiCalls: [],
        variables: {},
      },
      execution: {
        kind: "sequence",
        children: [],
      },
      diagnostics: {
        warnings: [],
        violations: [],
        error: createWorkflowFailure(error).error,
      },
    },
    null,
    2,
  );
}

function formatHelp(): string {
  return i18n.t("localHelp", { ns: "cli" });
}

function disableAiSdkWarningLogs(): void {
  (globalThis as typeof globalThis & {
    AI_SDK_LOG_WARNINGS?: false;
  }).AI_SDK_LOG_WARNINGS = false;
}

if (isCliEntrypoint()) {
  main().then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((error: unknown) => {
    console.error(translateWorkflowCodeError(error));
    process.exitCode = 1;
  });
}

function isCliEntrypoint(): boolean {
  return (
    process.argv[1] !== undefined &&
    import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  );
}
