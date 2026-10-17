import type { KanbanRelatedProjectRevision } from "./index";

export interface KanbanRevisionStreamCallbacks {
  onSnapshot?(event: {
    resolvedTarget: string;
    revisions: KanbanRelatedProjectRevision[];
  }): void;
  onRevision?(event: KanbanRelatedProjectRevision): void;
  onUnavailable?(): void;
}

export async function consumeKanbanRelatedProjectRevisionStream(
  stream: ReadableStream<Uint8Array>,
  callbacks: KanbanRevisionStreamCallbacks,
  signal?: AbortSignal,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let aborted = signal?.aborted === true;
  const cancelReader = () => {
    aborted = true;
    void reader.cancel(signal?.reason).catch(() => undefined);
  };
  if (signal?.aborted) cancelReader();
  else signal?.addEventListener("abort", cancelReader, { once: true });
  try {
    while (!aborted) {
      const result = await reader.read();
      buffer += decoder.decode(result.value, { stream: !result.done });
      let boundary = findSseBoundary(buffer);
      while (boundary !== undefined) {
        const block = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        dispatchKanbanRevisionEvent(block, callbacks);
        boundary = findSseBoundary(buffer);
      }
      if (result.done) break;
    }
    if (!aborted && buffer.trim() !== "") {
      dispatchKanbanRevisionEvent(buffer, callbacks);
    }
  } finally {
    signal?.removeEventListener("abort", cancelReader);
    if (aborted) await reader.cancel(signal?.reason).catch(() => undefined);
    reader.releaseLock();
  }
}

function findSseBoundary(value: string): { index: number; length: number } | undefined {
  const lf = value.indexOf("\n\n");
  const crlf = value.indexOf("\r\n\r\n");
  if (lf < 0 && crlf < 0) return undefined;
  if (crlf >= 0 && (lf < 0 || crlf < lf)) return { index: crlf, length: 4 };
  return { index: lf, length: 2 };
}

function dispatchKanbanRevisionEvent(
  block: string,
  callbacks: KanbanRevisionStreamCallbacks,
): void {
  let event = "message";
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("event:")) event = line.slice("event:".length).trim();
    if (line.startsWith("data:")) data.push(line.slice("data:".length).trimStart());
  }
  if (data.length === 0 || event === "heartbeat") return;
  if (event === "unavailable") {
    callbacks.onUnavailable?.();
    return;
  }
  const value = JSON.parse(data.join("\n")) as unknown;
  if (event === "revision") {
    const revision = readKanbanRevision(value);
    callbacks.onRevision?.(revision);
    return;
  }
  if (event === "snapshot") {
    if (!isRecord(value) || typeof value["resolvedTarget"] !== "string" || !Array.isArray(value["revisions"])) {
      throw new Error("Kanban related-project revision snapshot is invalid.");
    }
    const snapshot = {
      resolvedTarget: value["resolvedTarget"],
      revisions: value["revisions"].map(readKanbanRevision),
    };
    callbacks.onSnapshot?.(snapshot);
  }
}

function readKanbanRevision(value: unknown): KanbanRelatedProjectRevision {
  if (
    !isRecord(value) ||
    typeof value["alias"] !== "string" ||
    typeof value["revision"] !== "string" ||
    value["alias"].trim() === "" ||
    value["revision"].trim() === ""
  ) throw new Error("Kanban related-project revision event is invalid.");
  return { alias: value["alias"], revision: value["revision"] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
