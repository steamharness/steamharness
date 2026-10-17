/**
 * Server-Sent Events parser for the MiniMax chat/completions stream.
 *
 * The MiniMax streaming response looks like:
 *
 *   data: {"id":"...","choices":[{"delta":{"content":"hello"}}]}
 *
 *   data: {"id":"...","choices":[{"delta":{"content":" world"}}]}
 *
 *   data: [DONE]
 *
 *  we want to:
 *  - tolerate chunks that split a single event across network reads,
 *  - ignore comment lines (starting with `:`),
 *  - stop when `data: [DONE]` is received,
 *  - yield JSON-decoded chunks to the caller.
 */

export interface SseEvent {
  /** Raw event name. Defaults to `message` if the event never set one. */
  event: string;
  /** Decoded JSON payload, or the raw string if parsing failed. */
  data: unknown;
}

const DEFAULT_EVENT = "message";

interface DrainResult {
  events: SseEvent[];
  remaining: string;
}

export async function* parseSseStream(
  body: ReadableStream<Uint8Array> | null,
  signal: AbortSignal | undefined = undefined,
): AsyncGenerator<SseEvent, void, void> {
  if (body === null) {
    return;
  }

  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let pendingAbort = signal;

  const onAbort = (): void => {
    reader.cancel().catch(() => undefined);
  };
  pendingAbort?.addEventListener("abort", onAbort, { once: true });

  try {
    while (true) {
      if (pendingAbort?.aborted === true) {
        return;
      }
      const { value, done: streamDone } = await reader.read();
      if (streamDone) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const drained = drainBuffer(buffer);
      buffer = drained.remaining;
      for (const event of drained.events) {
        if (event.data === "[DONE]") {
          return;
        }
        yield event;
      }
    }

    buffer += decoder.decode();
    if (buffer.length > 0) {
      const drained = drainBuffer(`${buffer}\n`);
      for (const event of drained.events) {
        if (event.data === "[DONE]") {
          return;
        }
        yield event;
      }
    }
  } finally {
    pendingAbort?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

function drainBuffer(buffer: string): DrainResult {
  const events: SseEvent[] = [];
  let dataLines: string[] = [];
  let eventName = DEFAULT_EVENT;

  let lineStart = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    const char = buffer[i];
    if (char !== "\n") {
      continue;
    }
    const rawLine = buffer.slice(lineStart, i).replace(/\r$/, "");
    lineStart = i + 1;
    consumeLine(rawLine);
    if (rawLine.length === 0) {
      const event = dispatch(eventName, dataLines);
      if (event !== null) {
        events.push(event);
      }
      dataLines = [];
      eventName = DEFAULT_EVENT;
    }
  }

  return { events, remaining: buffer.slice(lineStart) };

  function consumeLine(line: string): void {
    if (line.length === 0 || line.startsWith(":")) {
      return;
    }
    const separator = line.indexOf(":");
    if (separator === -1) {
      if (line === "event") {
        eventName = DEFAULT_EVENT;
      }
      return;
    }
    const field = line.slice(0, separator);
    const value = line.slice(separator + 1).replace(/^ /, "");
    if (field === "event") {
      eventName = value === "" ? DEFAULT_EVENT : value;
      return;
    }
    if (field === "data") {
      dataLines.push(value);
    }
  }
}

function dispatch(name: string, dataParts: string[]): SseEvent | null {
  if (dataParts.length === 0) {
    return null;
  }
  return {
    event: name,
    data: tryParseJson(dataParts.join("\n")),
  };
}

function tryParseJson(value: string): unknown {
  if (value === "") {
    return "";
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}
