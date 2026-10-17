import { realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { i18n, translateSteamHarnessError } from "@steamharness/i18n";
import { prepareCliInvocation } from "./locale";

export async function main(argv = process.argv.slice(2)): Promise<number> {
  if (argv[0] === "__openai-responses-runner") {
    const { isolateOpenAIRunnerStdout } = await import("./openai-runner-stdio");
    const writeProtocolLine = isolateOpenAIRunnerStdout();
    const { register } = await import("tsx/esm/api");
    register();
    const runner = await import("./openai-responses-runner");
    return runner.main({ writeProtocolLine });
  }

  const prepared = prepareCliInvocation(argv);
  argv = prepared.argv;

  if (argv[0] === "web") {
    const webCli = await import("./web");
    return webCli.main(argv.slice(1));
  }

  if (argv[0] === "workspace") {
    const workspaceCli = await import("./workspace");
    await workspaceCli.main(argv.slice(1), { localeInitialized: true });
    return typeof process.exitCode === "number" ? process.exitCode : 0;
  }

  if (argv[0] === "mcp") {
    const mcpCli = await import("./mcp");
    return mcpCli.main(argv.slice(1));
  }

  if (
    argv.length === 0 ||
    argv[0] === "help" ||
    argv[0] === "--help" ||
    argv[0] === "-h"
  ) {
    process.stdout.write(`${formatHelp()}\n`);
    return 0;
  }

  const { register } = await import("tsx/esm/api");
  register();
  const localCli = await import("./local");
  return localCli.main(argv, { localeInitialized: true });
}

function formatHelp(): string {
  return `${i18n.t("rootHelp", { ns: "cli" })}\n\n  steamharness web [project-directory]  ${i18n.language.startsWith('zh') ? '\u5728\u6d4f\u89c8\u5668\u6253\u5f00\u672c\u5730\u9879\u76ee' : 'Open a local project in a browser'}`;
}

/**
 * Whether this module is the process entry point.
 *
 * `path.resolve` alone is not enough. A package manager that links packages
 * into a store — pnpm, and anything else that symlinks `node_modules/<name>` —
 * reaches this file through a symlink, while Node resolves an ESM module URL to
 * the real path, so the two never match and the CLI exits silently at exit code
 * 0 having done nothing. Compare both forms: the resolved one is for the linked
 * invocation, the unresolved one for `--preserve-symlinks` and for embedded
 * runners whose entry path is not on disk.
 */
function isCliEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  const absolute = path.resolve(entry);
  const candidates = new Set([absolute]);
  try {
    candidates.add(realpathSync(absolute));
  } catch {
    // A path that cannot be resolved keeps only its own form.
  }
  return [...candidates].some((candidate) => import.meta.url === pathToFileURL(candidate).href);
}

if (isCliEntryPoint()) {
  main().then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((error: unknown) => {
    console.error(translateSteamHarnessError(error));
    process.exitCode = 1;
  });
}
