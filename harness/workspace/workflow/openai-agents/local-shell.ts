import { spawn } from "node:child_process";
import path from "node:path";
import type { Shell, ShellAction, ShellOutputResult, ShellResult } from "@openai/agents";

export interface ControlledLocalShellOptions {
  workdir: string;
  signal?: AbortSignal;
  onCommand?: (event: { command: string; status: "completed" | "rejected" | "timeout" }) => void;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_LENGTH = 12_000;
const MAX_OUTPUT_LENGTH = 24_000;
const MAX_COMMANDS = 3;
const MAX_COMMAND_LENGTH = 1_000;
const DANGEROUS_COMMAND_PATTERN = /(^|[;&|]\s*)(rm|mv|cp|chmod|chown|sudo|su|dd|mkfs|mount|umount|curl|wget|ssh|scp|rsync|nc|node|python|python3|perl|ruby|php|npm|pnpm|yarn|git|del|erase|rd|rmdir|copy|move|powershell|pwsh|cmd)\b/i;
const WRITE_REDIRECT_PATTERN = /(^|[^>])>(?!>)/;
const APPEND_REDIRECT_PATTERN = />>/;

export function createControlledLocalShell(options: ControlledLocalShellOptions): Shell {
  const workdir = resolveLocalShellWorkdir(options.workdir);

  return {
    async run(action: ShellAction): Promise<ShellResult> {
      const commands = normalizeShellCommands(action.commands);
      const timeoutMs = clampShellNumber(action.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
      const maxOutputLength = clampShellNumber(action.maxOutputLength, DEFAULT_MAX_OUTPUT_LENGTH, MAX_OUTPUT_LENGTH);
      const output: ShellOutputResult[] = [];

      for (const command of commands) {
        const rejection = validateShellCommand(command);
        if (rejection !== undefined) {
          options.onCommand?.({ command, status: "rejected" });
          output.push({
            stdout: "",
            stderr: rejection,
            outcome: { type: "exit", exitCode: 126 },
          });
          continue;
        }

        const result = await runShellCommand({ command, workdir, timeoutMs, maxOutputLength, signal: options.signal });
        options.onCommand?.({
          command,
          status: result.outcome.type === "timeout" ? "timeout" : "completed",
        });
        output.push(result);
      }

      return {
        output,
        maxOutputLength,
        providerData: {
          workdir,
          controlled: true,
        },
      };
    },
  };
}

export function resolveLocalShellWorkdir(workdir: string): string {
  const baseDir = process.cwd();
  const resolved = path.resolve(baseDir, workdir);
  const relative = path.relative(baseDir, resolved);

  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return resolved;
  }

  throw new Error("workdir must stay inside the workflow execution directory.");
}

export function validateShellCommand(command: string): string | undefined {
  const normalized = command.trim();
  if (normalized === "") {
    return "Command is empty.";
  }
  if (normalized.length > MAX_COMMAND_LENGTH) {
    return `Command is too long. Maximum length is ${MAX_COMMAND_LENGTH} characters.`;
  }
  if (DANGEROUS_COMMAND_PATTERN.test(normalized)) {
    return "Command is not allowed by the controlled local shell policy.";
  }
  if (WRITE_REDIRECT_PATTERN.test(normalized) || APPEND_REDIRECT_PATTERN.test(normalized)) {
    return "Shell output redirection is not allowed by the controlled local shell policy.";
  }

  return undefined;
}

export function resolveLocalShellInvocation(
  command: string,
  platform: NodeJS.Platform = process.platform,
  comSpec = process.env.ComSpec,
): { executable: string; args: string[] } {
  // App workflows can execute on both Windows and POSIX release targets.
  if (platform === "win32") {
    return {
      executable: comSpec ?? "cmd.exe",
      args: ["/d", "/s", "/c", command],
    };
  }

  return {
    executable: "/bin/sh",
    args: ["-lc", command],
  };
}

function normalizeShellCommands(commands: string[]): string[] {
  return commands
    .slice(0, MAX_COMMANDS)
    .map((command) => command.trim())
    .filter((command) => command !== "");
}

function clampShellNumber(value: number | undefined, defaultValue: number, maxValue: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return defaultValue;
  }

  return Math.min(Math.floor(value), maxValue);
}

function runShellCommand(input: {
  command: string;
  workdir: string;
  timeoutMs: number;
  maxOutputLength: number;
  signal?: AbortSignal;
}): Promise<ShellOutputResult> {
  return new Promise((resolve) => {
    const invocation = resolveLocalShellInvocation(input.command);
    const child = spawn(invocation.executable, invocation.args, {
      cwd: input.workdir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const finish = (result: ShellOutputResult) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", abort);
      resolve(result);
    };
    const abort = () => {
      timedOut = true;
      child.kill("SIGTERM");
    };
    const timer = setTimeout(abort, input.timeoutMs);

    input.signal?.addEventListener("abort", abort, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = truncateShellOutput(stdout + chunk.toString("utf8"), input.maxOutputLength);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = truncateShellOutput(stderr + chunk.toString("utf8"), input.maxOutputLength);
    });
    child.on("error", (error) => {
      finish({
        stdout,
        stderr: truncateShellOutput(`${stderr}${error.message}`, input.maxOutputLength),
        outcome: { type: "exit", exitCode: null },
      });
    });
    child.on("close", (code) => {
      finish({
        stdout,
        stderr,
        outcome: timedOut ? { type: "timeout" } : { type: "exit", exitCode: code },
      });
    });
  });
}

function truncateShellOutput(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}\n[output truncated]`;
}
