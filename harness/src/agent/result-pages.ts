import { createHash } from "node:crypto";
import { HarnessError } from "../workflow/errors";

/** Leave room below the durable execution layer's 50 KiB text limit. */
export const MAX_TOOL_PAGE_BYTES = 40_000;
export const MAX_TOOL_PAGE_CHARS = 200_000;

export interface ResultPageArgs {
  resultOffset?: unknown;
  resultLimit?: unknown;
  resultHash?: unknown;
}

/** The same read-only continuation protocol is used by direct and MCP tools. */
export const RESULT_PAGE_PROPERTIES = {
  resultOffset: { type: "integer", minimum: 0, description: "UTF-16 offset in a paged JSON result. Continue with nextOffset and resultHash, keeping all original arguments." },
  resultLimit: { type: "integer", minimum: 1, maximum: MAX_TOOL_PAGE_CHARS, description: "Maximum characters in a JSON result page; its serialized UTF-8 byte budget may return fewer." },
  resultHash: { type: "string", pattern: "^[a-f0-9]{64}$", description: "Use the previous page's resultHash to detect changes between reads. If changed, restart at offset 0 without a hash." },
};

export const RESULT_PAGE_DESCRIPTION = "Large read results return paged=true, encoding=json, content, offset, totalChars, truncated, resultHash and nextOffset. Repeat the same read with resultOffset=nextOffset and resultHash until truncated=false; concatenate content and parse it as JSON. Do not repeat a write to retrieve its result.";

export function validateResultPageArgs(args: ResultPageArgs, readOnly: boolean): void {
  const provided = args.resultOffset !== undefined || args.resultLimit !== undefined || args.resultHash !== undefined;
  if (provided && !readOnly) invalidPage("Result pagination is only available for read actions; do not repeat a write to retrieve its result.");
  pageInteger(args.resultOffset, 0, "resultOffset", 0, Number.MAX_SAFE_INTEGER);
  pageInteger(args.resultLimit, MAX_TOOL_PAGE_CHARS, "resultLimit", 1, MAX_TOOL_PAGE_CHARS);
  if (args.resultHash !== undefined && (typeof args.resultHash !== "string" || !/^[a-f0-9]{64}$/.test(args.resultHash))) {
    invalidPage("resultHash must be the hash returned by the previous result page.");
  }
  if (typeof args.resultOffset === "number" && args.resultOffset > 0 && args.resultHash === undefined) {
    invalidPage("Continue with both resultOffset=nextOffset and the previous resultHash.");
  }
}

export function pageJsonResult(result: unknown, args: ResultPageArgs, envelope: Record<string, unknown> = {}): unknown {
  const serialized = JSON.stringify(result);
  const offset = pageInteger(args.resultOffset, 0, "resultOffset", 0, Number.MAX_SAFE_INTEGER);
  const limit = pageInteger(args.resultLimit, MAX_TOOL_PAGE_CHARS, "resultLimit", 1, MAX_TOOL_PAGE_CHARS);
  const resultHash = createHash("sha256").update(serialized).digest("hex");
  if (args.resultHash !== undefined && args.resultHash !== resultHash) {
    invalidPage("The result changed between pages. Restart with resultOffset=0 and omit resultHash.");
  }
  if (args.resultOffset === undefined && args.resultLimit === undefined && args.resultHash === undefined
    && Buffer.byteLength(serialized) <= MAX_TOOL_PAGE_BYTES) return result;
  return fitTextPage(serialized, offset, limit, content => ({ ...envelope, paged: true, encoding: "json", resultHash, ...content }));
}

/** Bound the complete serialized envelope, including escaped text and metadata. */
export function fitTextPage<T>(text: string, offset: number, limit: number,
  render: (page: { content: string; offset: number; totalChars: number; truncated: boolean; nextOffset?: number }) => T): T {
  if (offset > text.length || splitsSurrogate(text, offset)) invalidPage("offset must be within the text and at a complete character boundary.");
  const page = (length: number) => {
    let end = offset + length;
    if (splitsSurrogate(text, end)) end--;
    return render({ content: text.slice(offset, end), offset, totalChars: text.length, truncated: end < text.length,
      ...(end < text.length ? { nextOffset: end } : {}) });
  };
  let low = 0, high = Math.min(limit, text.length - offset);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(JSON.stringify(page(mid))) <= MAX_TOOL_PAGE_BYTES) low = mid;
    else high = mid - 1;
  }
  if ((low === 0 && offset < text.length) || (splitsSurrogate(text, offset + low) && low === 1)) {
    invalidPage("The page limit must fit at least one complete character; increase limit.");
  }
  const result = page(low);
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_TOOL_PAGE_BYTES) invalidPage("Result metadata exceeds the page byte budget.");
  return result;
}

export function pageInteger(value: unknown, fallback: number, name: string, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    invalidPage(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

export function splitsSurrogate(value: string, offset: number): boolean {
  return offset > 0 && /[\uD800-\uDBFF]/u.test(value[offset - 1]!) && /[\uDC00-\uDFFF]/u.test(value[offset] ?? "");
}

function invalidPage(message: string): never {
  throw new HarnessError({ type: "input_validation", message });
}
