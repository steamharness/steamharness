import { readFile } from "node:fs/promises";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";

export function createWorkflowCodemode(options: { memoryLimitBytes?: number; timeoutMs?: number }) {
  const memoryLimitBytes = options.memoryLimitBytes ?? 64 * 1024 * 1024, timeoutMs = options.timeoutMs ?? 300_000;
  if (!Number.isSafeInteger(memoryLimitBytes) || memoryLimitBytes < 1024 * 1024 || memoryLimitBytes > 256 * 1024 * 1024
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new Error("Invalid Code Mode memory or time limit.");
  const bundled = !import.meta.url.endsWith(".ts");
  const sandbox = new CodemodeSandbox({ memoryLimitBytes, timeoutMs, ...(bundled ? {
    workerUrl: new URL("./agent-codemode-worker.js", import.meta.url),
    wasm: readFile(new URL("./quickjs.wasm", import.meta.url)).then(bytes => WebAssembly.compile(bytes)),
  } : {}) });
  return { sandbox, extension: createCodemodeExtension({ sandbox, models: false }) };
}
