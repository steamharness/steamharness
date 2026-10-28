import { Type } from "@earendil-works/pi-ai";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { getOrThrow, type ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { Context } from "@earendil-works/chord/context";
import { pageInteger } from "./result-pages";

const PAGE_BYTES = 38_000;

/** Keep native image/line reads; add byte continuation on the same authorized environment. */
export function withEnvironmentByteReads(tool: ToolRegistration): ToolRegistration {
  if (tool.name !== "read") return tool;
  return {
    ...tool,
    outputLimits: { ...tool.outputLimits, maxLines: 40_000 },
    description: `${tool.description}\nFor long text lines, use byteOffset=0 to read raw UTF-8 text, then byteOffset=nextByteOffset from the previous result. Omit offset and limit in byte mode. This works without bash.`,
    parameters: Type.Unsafe({ ...tool.parameters, properties: {
      ...(tool.parameters as { properties: Record<string, unknown> }).properties,
      byteOffset: { type: "integer", minimum: 0, description: "UTF-8 byte offset for long-line continuation. Omit offset and limit. Use nextByteOffset returned by the previous read." },
    } }),
    async execute(args, api, context) {
      const input = args as { path: string; byteOffset?: number; offset?: number; limit?: number };
      if (input.byteOffset === undefined) {
        const result = await tool.execute(args, api, context);
        const truncation = (result.details as { truncation?: { firstLineExceedsLimit?: boolean; outputBytes?: number } } | undefined)?.truncation;
        if (!truncation?.firstLineExceedsLimit || api.env === undefined) return result;
        // Give read-only children an executable continuation for the partial line.
        const absolute = await resolveReadPath(api.env, input.path, context);
        const reader = getOrThrow(await api.env.openBinaryReader(absolute, undefined, context));
        try {
          const scan = getOrThrow(await reader.scanLines({ startLine: Math.max(0, Math.trunc(input.offset ?? 1) - 1) }, context));
          const prefix = scan.start === 0 ? getOrThrow(await reader.read(0, 3, context)) : undefined;
          const bom = prefix?.[0] === 0xef && prefix[1] === 0xbb && prefix[2] === 0xbf ? 3 : 0;
          const nextByteOffset = scan.start + bom + (truncation.outputBytes ?? 0);
          return { ...result, details: { ...result.details as object, nextByteOffset },
            diagnostics: (result.diagnostics ?? []).map(diagnostic => diagnostic.code === "truncated"
              ? { ...diagnostic, message: `Long line truncated. Continue read with byteOffset=${nextByteOffset}; omit offset and limit.` } : diagnostic) };
        } finally { await reader.close(context); }
      }
      if (input.offset !== undefined || input.limit !== undefined) throw new Error("Use byteOffset without offset or limit.");
      if (api.env === undefined) throw new Error("No execution environment is available.");
      const absolute = await resolveReadPath(api.env, input.path, context);
      const reader = getOrThrow(await api.env.openBinaryReader(absolute, undefined, context));
      try {
        const info = getOrThrow(await reader.info(context));
        const start = pageInteger(input.byteOffset, 0, "byteOffset", 0, info.size);
        const bytes = getOrThrow(await reader.read(start, Math.min(PAGE_BYTES + 4, info.size - start), context));
        if (bytes.length > 0 && (bytes[0]! & 0xc0) === 0x80) throw new Error("byteOffset must be at a UTF-8 character boundary; use nextByteOffset.");
        let end = Math.min(bytes.length, PAGE_BYTES);
        if (end < bytes.length) while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
        const nextByteOffset = start + end;
        const truncated = nextByteOffset < info.size;
        return { output: [{ type: "text", text: new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes.subarray(0, end)) }],
          details: { byteOffset: start, bytes: info.size, truncated, ...(truncated ? { nextByteOffset } : {}) },
          diagnostics: truncated ? [{ severity: "info", code: "truncated", message: `Continue read with byteOffset=${nextByteOffset}.` }] : [] };
      } finally { await reader.close(context); }
    },
  };
}

/** Match the native reader's pasted-path normalization and filename variants. */
async function resolveReadPath(env: ExecutionEnv, input: string, context: Context): Promise<string> {
  const normalized = input.replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, " ").replace(/^@/, "");
  const resolved = getOrThrow(await env.absolutePath(normalized, context));
  for (const candidate of new Set([resolved, resolved.replace(/ (AM|PM)\./gi, "\u202f$1."), resolved.normalize("NFD"),
    resolved.replace(/'/g, "\u2019"), resolved.normalize("NFD").replace(/'/g, "\u2019")])) {
    if (getOrThrow(await env.exists(candidate, context))) return candidate;
  }
  return resolved;
}
