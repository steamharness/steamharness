import { describe, expect, it, vi } from "vitest";
import { consumeKanbanDatabaseRevisionStream } from "../revision-stream";

describe("Kanban database-space revision stream", () => {
  it("parses snapshots, revisions, CRLF chunks, and unavailable events", async () => {
    const encoder = new TextEncoder();
    const chunks = [
      "event: snapshot\r\ndata: {\"resolvedTarget\":\"1.0.0\",\"revisions\":[{\"alias\":\"stocks\",",
      "\"revision\":\"1\"}]}\r\n\r\nevent: revision\ndata: {\"alias\":\"stocks\",\"revision\":\"2\"}\n\n",
      "event: heartbeat\ndata: {}\n\nevent: unavailable\ndata: {\"message\":\"safe\"}\n\n",
    ];
    const onSnapshot = vi.fn();
    const onRevision = vi.fn();
    const onUnavailable = vi.fn();
    await consumeKanbanDatabaseRevisionStream(new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }), { onSnapshot, onRevision, onUnavailable });

    expect(onSnapshot).toHaveBeenCalledWith({
      resolvedTarget: "1.0.0",
      revisions: [{ alias: "stocks", revision: "1" }],
    });
    expect(onRevision).toHaveBeenCalledWith({ alias: "stocks", revision: "2" });
    expect(onUnavailable).toHaveBeenCalledOnce();
  });

  it("rejects malformed revision payloads", async () => {
    const encoder = new TextEncoder();
    await expect(consumeKanbanDatabaseRevisionStream(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode("event: revision\ndata: {\"alias\":\"stocks\"}\n\n"));
        controller.close();
      },
    }), {})).rejects.toThrow(/invalid/);
  });

  it("dispatches the final event when the stream closes without an empty line", async () => {
    const encoder = new TextEncoder();
    const onRevision = vi.fn();
    await consumeKanbanDatabaseRevisionStream(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(
          "event: revision\ndata: {\"alias\":\"stocks\",\"revision\":\"final\"}",
        ));
        controller.close();
      },
    }), { onRevision });

    expect(onRevision).toHaveBeenCalledWith({ alias: "stocks", revision: "final" });
  });

  it("cancels a pending stream read when the caller aborts", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      cancel,
    });
    const consuming = consumeKanbanDatabaseRevisionStream(stream, {}, controller.signal);

    controller.abort(new Error("workspace changed"));
    await expect(consuming).resolves.toBeUndefined();
    expect(cancel).toHaveBeenCalledOnce();
  });
});
