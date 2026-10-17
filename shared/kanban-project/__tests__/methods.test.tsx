import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KanbanPreviewFrame } from "../KanbanPreviewFrame";
import {
  assertKanbanMethodJson, createKanbanBridgeScript, createKanbanMethodRegistry, createKanbanMethodSession,
  KANBAN_METHOD_CATALOG_MESSAGE, KANBAN_METHOD_INVOKE_MESSAGE, KANBAN_METHOD_RESULT_MESSAGE,
  parseKanbanMethodDefinitions, parseKanbanMethodInvocation, type KanbanBrowserApi,
} from "../index";

afterEach(() => { cleanup(); vi.useRealTimers(); });
const definition = { name: "map.focus", description: "Focus a map region", inputSchema: { type: "object" as const } };

function connectPage(configurationId = "one", timeoutMs?: number) {
  const configuration = { id: configurationId, name: configurationId, params: {} };
  const listeners: Array<(event: MessageEvent) => void> = [];
  const messages: Record<string, unknown>[] = [];
  const parent = { postMessage(message: Record<string, unknown>) { messages.push(message); session.receive(message); } };
  const dispatch = (data: Record<string, unknown>, source: unknown = parent) => {
    listeners.forEach((listener) => listener({ source, data } as MessageEvent));
  };
  const session = createKanbanMethodSession({ nonce: "nonce", getConfiguration: () => configuration,
    getPresentation: () => ({ mode: "card" }), timeoutMs, postMessage: (data) => dispatch(data) });
  const page = { parent, setTimeout, clearTimeout, dispatchEvent: vi.fn(),
    addEventListener(type: string, listener: (event: MessageEvent) => void) { if (type === "message") listeners.push(listener); },
  } as unknown as Window & { steamHarnessKanban: KanbanBrowserApi };
  const script = createKanbanBridgeScript(configuration, "nonce").replace(/^<script[^>]*>/, "").replace(/<\/script>$/, "");
  new Function("window", "document", script)(page, { readyState: "complete" });
  const invoke = (method = definition.name, args: Record<string, any> = {}, signal?: AbortSignal) => session.invoke({
    instanceId: session.instanceId, configurationId, method, args,
  }, signal);
  return { page, session, invoke, dispatch, messages, configuration };
}

describe("Kanban registered methods", () => {
  it("discovers and calls a page handler with JSON and invocation context", async () => {
    const link = connectPage();
    const handler = vi.fn((input, context) => ({ region: input.name, configurationId: context.configuration.id }));
    const unregister = link.page.steamHarnessKanban.methods.register(definition, handler);
    expect(link.session.getState()).toMatchObject({ ready: true, configurationId: "one", methods: [definition] });
    const metadata = link.session.getState();
    metadata.methods[0]!.name = "tampered";
    await expect(link.invoke("map.focus", { name: "军营" })).resolves.toEqual({ region: "军营", configurationId: "one" });
    expect(handler).toHaveBeenCalledWith({ name: "军营" }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    unregister();
    await expect(link.invoke()).rejects.toMatchObject({ code: "KANBAN_METHOD_UNAVAILABLE" });
    link.session.close();
  });

  it("only accepts the authenticated parent and refuses duplicate or stale calls", async () => {
    const link = connectPage();
    const handler = vi.fn(() => "ok");
    link.page.steamHarnessKanban.methods.register(definition, handler);
    const call = { type: KANBAN_METHOD_INVOKE_MESSAGE, nonce: "nonce", requestId: "manual", revision: 2,
      configurationId: "one", method: "map.focus", input: {} };
    link.dispatch({ ...call, nonce: "wrong" });
    link.dispatch(call, {});
    await Promise.resolve();
    expect(handler).not.toHaveBeenCalled();
    link.dispatch({ ...call, configurationId: "other" });
    expect(link.messages.at(-1)).toMatchObject({ ok: false, error: { code: "KANBAN_METHOD_STALE" } });
    await expect(link.invoke()).resolves.toBe("ok");
    const request = link.messages.find((message) => message.type === KANBAN_METHOD_RESULT_MESSAGE && message.ok === true)!;
    link.dispatch({ ...call, requestId: request.requestId });
    await Promise.resolve();
    expect(handler).toHaveBeenCalledTimes(1);
    link.session.close();
  });

  it("cancels handlers, bounds waits and ignores their late results", async () => {
    vi.useFakeTimers();
    const link = connectPage("one", 20);
    let finish: (value: string) => void = () => {};
    let signal: AbortSignal | undefined;
    link.page.steamHarnessKanban.methods.register(definition, (_input, context) => {
      signal = context.signal;
      return new Promise<string>((resolve) => { finish = resolve; });
    });
    const pending = link.invoke();
    const rejected = expect(pending).rejects.toMatchObject({ code: "KANBAN_METHOD_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(21);
    await rejected;
    expect(signal?.aborted).toBe(true);
    finish("late");
    await Promise.resolve();
    const controller = new AbortController();
    const cancelled = link.invoke("map.focus", {}, controller.signal);
    const cancelledAssertion = expect(cancelled).rejects.toMatchObject({ code: "KANBAN_METHOD_CANCELLED" });
    await Promise.resolve();
    controller.abort();
    await cancelledAssertion;
    const closing = link.invoke();
    const closingAssertion = expect(closing).rejects.toMatchObject({ code: "KANBAN_METHOD_INSTANCE_UNAVAILABLE" });
    link.session.close();
    await closingAssertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("isolates project, source, configuration and simultaneous preview instances", async () => {
    const registry = createKanbanMethodRegistry();
    const first = connectPage("default");
    const second = connectPage("profile-1");
    for (const link of [first, second]) link.page.steamHarnessKanban.methods.register(definition, (_input, context) => context.configuration.id);
    const unregisterFirst = registry.register({ projectId: "map", source: "local", location: "workspace" }, first.session);
    const unregisterSecond = registry.register({ projectId: "map", source: "local", location: "card", cardId: "card-1" }, second.session);
    expect(registry.list("map", "local").map((item) => item.configurationId)).toEqual(["default", "profile-1"]);
    const input = { instanceId: second.session.instanceId, configurationId: "profile-1", method: "map.focus", args: {} };
    await expect(registry.invoke("map", "local", input)).resolves.toBe("profile-1");
    await expect(registry.invoke("other", "local", input)).rejects.toMatchObject({ code: "KANBAN_METHOD_INSTANCE_UNAVAILABLE" });
    await expect(registry.invoke("map", "server", input)).rejects.toMatchObject({ code: "KANBAN_METHOD_INSTANCE_UNAVAILABLE" });
    await expect(registry.invoke("map", "local", { ...input, configurationId: "default" })).rejects.toMatchObject({ code: "KANBAN_METHOD_STALE" });
    unregisterSecond();
    await expect(registry.invoke("map", "local", input)).rejects.toMatchObject({ code: "KANBAN_METHOD_INSTANCE_UNAVAILABLE" });
    unregisterFirst(); first.session.close(); second.session.close();
  });

  it("rejects invalid catalogs, invocations and oversized/non-JSON results", async () => {
    for (const value of [undefined, NaN, { value: undefined }, { value: new Date() }, "x".repeat(65_536)]) {
      expect(() => assertKanbanMethodJson(value)).toThrow();
    }
    expect(() => parseKanbanMethodDefinitions([definition, definition])).toThrow();
    expect(() => parseKanbanMethodDefinitions([{ ...definition, inputSchema: { type: "string" } }])).toThrow();
    expect(() => parseKanbanMethodInvocation({ instanceId: "i", method: "eval", args: {}, projectId: "other" })).toThrow();
    const link = connectPage();
    link.page.steamHarnessKanban.methods.register(definition, () => undefined as never);
    await expect(link.invoke()).rejects.toMatchObject({ code: "KANBAN_METHOD_FAILED" });
    link.session.close();
  });

  it("invalidates pending calls and catalog revisions when the iframe document reloads", async () => {
    const postMessage = vi.fn();
    const session = createKanbanMethodSession({ nonce: "nonce", getConfiguration: () => ({ id: "one", name: "One", params: {} }),
      getPresentation: () => ({ mode: "fullscreen" }), postMessage });
    session.receive({ type: "steamharness:kanban-ready", nonce: "nonce", documentId: "old" });
    session.receive({ type: KANBAN_METHOD_CATALOG_MESSAGE, nonce: "nonce", documentId: "old", configurationId: "one", revision: 10, methods: [definition] });
    const pending = session.invoke({ instanceId: session.instanceId, configurationId: "one", method: "map.focus", args: {} });
    const rejected = expect(pending).rejects.toMatchObject({ code: "KANBAN_METHOD_INSTANCE_UNAVAILABLE" });
    session.receive({ type: "steamharness:kanban-ready", nonce: "nonce", documentId: "new" });
    await rejected;
    session.receive({ type: KANBAN_METHOD_CATALOG_MESSAGE, nonce: "nonce", documentId: "old", configurationId: "one", revision: 11, methods: [definition] });
    expect(session.getState().methods).toEqual([]);
    session.receive({ type: KANBAN_METHOD_CATALOG_MESSAGE, nonce: "nonce", documentId: "new", configurationId: "one", revision: 1, methods: [definition] });
    expect(session.getState().methods).toEqual([definition]);
    session.close();
  });

  it("registers a real preview frame, validates its message source and cleans up on configuration change", async () => {
    const registry = createKanbanMethodRegistry();
    const props = { projectName: "Map", previewUrl: "about:blank", previewNonce: "nonce",
      configuration: { id: "one", name: "One", params: {} }, methodRegistry: registry,
      methodTarget: { projectId: "map", source: "local" as const, location: "workspace" as const } };
    const view = render(<KanbanPreviewFrame {...props} />);
    const frame = view.container.querySelector("iframe")!;
    const post = vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(() => {});
    const send = (data: Record<string, unknown>, source: Window | null = frame.contentWindow) => act(() => {
      window.dispatchEvent(new MessageEvent("message", { source, data: { nonce: "nonce", ...data } }));
    });
    send({ type: KANBAN_METHOD_CATALOG_MESSAGE, configurationId: "one", revision: 1, methods: [definition] }, window);
    expect(registry.list("map", "local")[0]!.methods).toEqual([]);
    send({ type: "steamharness:kanban-ready" });
    send({ type: KANBAN_METHOD_CATALOG_MESSAGE, configurationId: "one", revision: 1, methods: [definition] });
    const instanceId = registry.list("map", "local")[0]!.instanceId;
    const pending = registry.invoke("map", "local", { instanceId, configurationId: "one", method: "map.focus", args: {} });
    const request = post.mock.calls.at(-1)![0];
    const rejected = expect(pending).rejects.toMatchObject({ code: "KANBAN_METHOD_INSTANCE_UNAVAILABLE" });
    view.rerender(<KanbanPreviewFrame {...props} configuration={{ id: "two", name: "Two", params: {} }} />);
    await rejected;
    send({ type: KANBAN_METHOD_RESULT_MESSAGE, requestId: request.requestId, ok: true, value: "late" });
    expect(registry.list("map", "local")[0]!.instanceId).not.toBe(instanceId);
    view.unmount();
    expect(registry.list("map", "local")).toEqual([]);
  });
});
