import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createKanbanArtifactEntryPath,
  createKanbanBridgeError,
  createKanbanBridgeScript,
  createInjectedKanbanParams,
  injectKanbanBridge,
  isKanbanJsonValue,
  isSafeKanbanAssetPath,
  parseKanbanBridgeCall,
  parseKanbanManifest,
  readKanbanEntryConfig,
  readKanbanAssetMimeType,
  createKanbanContentSecurityPolicy,
  getKanbanPreviewCapabilityRefreshDelay,
  KANBAN_PREVIEW_CAPABILITY_RETRY_MS,
  scheduleKanbanPreviewCapabilityRefresh,
  KANBAN_FILE_MAX_BYTES,
  KANBAN_PRESENTATION_CHANGE_EVENT,
  KANBAN_PRESENTATION_MESSAGE,
  type KanbanBrowserApi,
} from "../index";

describe("kanban project contract", () => {
  it("settles the host ready/configuration handshake without repeated events or method catalogs", () => {
    const configuration = { id: "map", name: "Map", params: { layers: ["ground"], view: { zoom: 1 } } };
    const listeners: Array<(event: MessageEvent) => void> = [];
    const outgoing: Array<Record<string, unknown>> = [];
    const pending: Array<Record<string, unknown>> = [];
    const parent = { postMessage(message: Record<string, unknown>) {
      outgoing.push(message);
      if (message.type === "steamharness:kanban-ready") pending.push({ type: "steamharness:kanban-configuration", nonce: "nonce", configuration });
    } };
    const pageWindow = {
      parent, setTimeout: () => 1, clearTimeout() {}, dispatchEvent: vi.fn(),
      addEventListener(type: string, listener: (event: MessageEvent) => void) { if (type === "message") listeners.push(listener); },
    } as unknown as Window & { steamHarnessKanban: KanbanBrowserApi };
    const send = (data: Record<string, unknown>) => { for (const listener of listeners) listener({ source: parent, data } as MessageEvent); };
    const settle = () => {
      for (let attempts = 0; pending.length && attempts < 10; attempts++) send(pending.shift()!);
      expect(pending).toHaveLength(0);
    };
    const script = createKanbanBridgeScript(configuration, "nonce").replace(/^<script[^>]*>/, "").replace(/<\/script>$/, "");
    new Function("window", "document", script)(pageWindow, { readyState: "complete" });
    settle();
    expect(outgoing.filter(message => message.type === "steamharness:kanban-ready")).toHaveLength(1);
    expect(pageWindow.dispatchEvent).not.toHaveBeenCalled();
    const unregister = pageWindow.steamHarnessKanban.methods.register({ name: "map.getInfo", description: "Map info", inputSchema: { type: "object" }, readOnly: true }, () => ({}));
    const catalogs = outgoing.length;
    for (let index = 0; index < 5; index++) send({ type: "steamharness:kanban-configuration", nonce: "nonce", configuration: structuredClone(configuration) });
    expect(outgoing).toHaveLength(catalogs);
    expect(pageWindow.dispatchEvent).not.toHaveBeenCalled();
    configuration.params.view.zoom = 2;
    send({ type: "steamharness:kanban-configuration", nonce: "nonce", configuration: structuredClone(configuration) });
    settle();
    expect(pageWindow.dispatchEvent).toHaveBeenCalledTimes(1);
    expect(pageWindow.steamHarnessKanban.getConfiguration().params).toEqual(configuration.params);
    expect(outgoing.at(-1)).toMatchObject({ type: "steamharness:kanban-method-catalog", methods: [{ name: "map.getInfo" }] });
    unregister();
  });

  it("validates the local Studio query and exposes only an argument-free read method", async () => {
    expect(parseKanbanBridgeCall({ requestId: 'stats', operation: 'studio.getLocalAnalysis', input: {} }).operation).toBe('studio.getLocalAnalysis');
    expect(() => parseKanbanBridgeCall({ requestId: 'stats', operation: 'studio.getLocalAnalysis', input: { path: '/other' } })).toThrow();
    const listeners: Array<(event: MessageEvent) => void> = [];
    const parent = { postMessage: vi.fn() };
    const pageWindow = { parent, setTimeout: () => 1, clearTimeout: () => {}, addEventListener: (_type: string, listener: (event: MessageEvent) => void) => listeners.push(listener) } as unknown as Window & { steamHarnessKanban: KanbanBrowserApi };
    const script = createKanbanBridgeScript({ id: '', name: '', params: {} }, 'nonce').replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '');
    new Function('window', 'document', script)(pageWindow, { readyState: 'complete' });
    const result = pageWindow.steamHarnessKanban.studio.getLocalAnalysis();
    const call = parent.postMessage.mock.calls.at(-1)![0];
    expect(call).toMatchObject({ operation: 'studio.getLocalAnalysis', input: {}, nonce: 'nonce' });
    for (const listener of listeners) listener({ source: parent, data: { type: 'steamharness:kanban-bridge-response', nonce: 'nonce', requestId: call.requestId, ok: true, value: { version: 1, projects: [] } } } as unknown as MessageEvent);
    await expect(result).resolves.toEqual({ version: 1, projects: [] });
  });
  it("exposes cloned presentation state and accepts only authenticated host mode changes", () => {
    const listeners: Array<(event: MessageEvent) => void> = [];
    const parent = { postMessage: vi.fn() };
    const pageWindow = {
      parent, setTimeout: () => 1, clearTimeout: () => {}, dispatchEvent: vi.fn(),
      addEventListener: (type: string, listener: (event: MessageEvent) => void) => { if (type === "message") listeners.push(listener); },
    } as unknown as Window & { steamHarnessKanban: KanbanBrowserApi };
    const script = createKanbanBridgeScript({ id: "profile", name: "Map", params: {} }, "nonce")
      .replace(/^<script[^>]*>/, "").replace(/<\/script>$/, "");
    new Function("window", "document", script)(pageWindow, { readyState: "complete" });
    const send = (mode: unknown, nonce = "nonce", source: unknown = parent) => {
      for (const listener of listeners) listener({ source, data: { type: KANBAN_PRESENTATION_MESSAGE, nonce, presentation: { mode } } } as MessageEvent);
    };
    expect(pageWindow.steamHarnessKanban.getPresentation()).toEqual({ mode: "fullscreen" });
    send("card", "wrong");
    send("card", "nonce", {});
    send("unknown");
    expect(pageWindow.dispatchEvent).not.toHaveBeenCalled();
    send("card");
    expect(pageWindow.dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: KANBAN_PRESENTATION_CHANGE_EVENT, detail: { mode: "card" } }));
    const presentation = pageWindow.steamHarnessKanban.getPresentation();
    presentation.mode = "phone";
    expect(pageWindow.steamHarnessKanban.getPresentation()).toEqual({ mode: "card" });
    send("card");
    expect(pageWindow.dispatchEvent).toHaveBeenCalledTimes(1);
    for (const mode of ["phone", "tablet", "fullscreen"] as const) {
      send(mode);
      expect(pageWindow.steamHarnessKanban.getPresentation()).toEqual({ mode });
    }
    expect(pageWindow.steamHarnessKanban.getConfiguration()).toEqual({ id: "profile", name: "Map", params: {} });
  });
  it("restricts file calls to bytes and managed ids without caller-selected project or paths", () => {
    expect(parseKanbanBridgeCall({ requestId: "upload", operation: "files.createFile", input: { database:"data", name: "map.png", mimeType: "image/png", base64: "AP8=" } })).toMatchObject({ operation: "files.createFile" });
    for (const input of [
      { name: "../map.png", base64: "AA==" },
      { name: "map.png", base64: "not base64" },
      { name: "map.png", mimeType: "image/png\r\nsecret", base64: "AA==" },
      { name: "map.png", base64: "AA==", projectId: "other" },
    ]) {
      expect(() => parseKanbanBridgeCall({ requestId: "bad", operation: "files.createFile", input })).toThrow();
    }
    for (const fileId of ["../private", "https://example.com/file", "wf_abc/../secret"]) {
      expect(() => parseKanbanBridgeCall({ requestId: "read", operation: "files.readFile", input: { database:"data", fileId } })).toThrow();
    }
    expect(() => parseKanbanBridgeCall({ requestId: "large", operation: "files.createFile", input: { database:"data",
      name: "map.png", base64: "A".repeat(Math.ceil(KANBAN_FILE_MAX_BYTES / 3) * 4),
    } })).toThrow(/50 MiB/);
  });

  it("round trips binary images through the nonce-bound browser file API", async () => {
    const listeners: Array<(event: MessageEvent) => void> = [];
    const messages: Array<Record<string, unknown>> = [];
    const parent = { postMessage: (message: Record<string, unknown>) => messages.push(message) };
    const pageWindow = {
      parent, setTimeout: () => 1, clearTimeout: () => {},
      addEventListener: (type: string, listener: (event: MessageEvent) => void) => { if (type === "message") listeners.push(listener); },
    } as unknown as Window & { steamHarnessKanban: KanbanBrowserApi };
    const script = createKanbanBridgeScript({ id: "profile", name: "Map", params: {} }, "nonce")
      .replace(/^<script[^>]*>/, "").replace(/<\/script>$/, "");
    new Function("window", "document", script)(pageWindow, { readyState: "complete" });
    const reply = (value: unknown) => {
      const request = messages.at(-1)!;
      for (const listener of listeners) listener({ source: parent, data: {
        type: "steamharness:kanban-bridge-response", nonce: "nonce", requestId: request["requestId"], ok: true, value,
      } } as unknown as MessageEvent);
    };
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 255]);
    const reference = { id: "wf_abc123", name: "map.png", mimeType: "image/png", size: 6, kind: "image", storage: "server", createdAt: "2026-10-08T00:00:00Z" };
    const uploaded = pageWindow.steamHarnessKanban.databases.get("data").files.createFile({ name: "map.png", mimeType: "image/png", buffer: bytes });
    const base64 = Buffer.from(bytes).toString("base64");
    expect(messages.at(-1)).toMatchObject({ operation: "files.createFile", input: { database:"data", name: "map.png", mimeType: "image/png", base64 } });
    reply(reference);
    await expect(uploaded).resolves.toEqual(reference);
    const downloaded = pageWindow.steamHarnessKanban.databases.get("data").files.readFile(reference.id);
    reply({ file: reference, base64 });
    const result = await downloaded;
    expect(new Uint8Array(result.buffer)).toEqual(bytes);
    const deleted = pageWindow.steamHarnessKanban.databases.get("data").files.deleteFile(reference.id);
    reply(true);
    await expect(deleted).resolves.toBe(true);
  });
  it("derives artifact paths from a registered entry", () => {
    expect(readKanbanEntryConfig({type:"kanban",entry:"index.html"})).toEqual({artifactDir:".",entry:"index.html"});
    const custom=readKanbanEntryConfig({type:"kanban",entry:"dist/pages/board.html"});
    expect(custom).toEqual({artifactDir:"dist/pages",entry:"board.html"});
    expect(createKanbanArtifactEntryPath(custom)).toBe("dist/pages/board.html");
  });
  it("rejects unsafe and non-HTML registered artifacts",()=>{
    for(const entry of ["../dist/index.html","C:\\dist/index.html","/index.html","pages/../index.html","node_modules/site/index.html",".git/index.html","app.js"])
      expect(()=>readKanbanEntryConfig({type:"kanban",entry})).toThrow();
    expect(()=>readKanbanEntryConfig({type:"workflow",entry:"index.html"})).toThrow();
  });

  it("validates manifest parameters", () => {
    expect(parseKanbanManifest({
      version: 1,
      params: [{ name: "columns", type: "number", defaultValue: "3" }],
    }).params).toEqual([{ name: "columns", type: "number", defaultValue: "3" }]);
  });

  it("rejects duplicate params and unsafe assets", () => {
    expect(() => parseKanbanManifest({
      version: 1,
      params: [{ name: "theme", type: "string" }, { name: "theme", type: "string" }],
    })).toThrow(/duplicate/);
    expect(isSafeKanbanAssetPath("assets/app.js")).toBe(true);
    expect(isSafeKanbanAssetPath("../.env")).toBe(false);
    expect(isSafeKanbanAssetPath("package.json")).toBe(false);
    expect(isSafeKanbanAssetPath("assets/Package.json")).toBe(false);
    expect(isSafeKanbanAssetPath("assets/Node_Modules/app.js")).toBe(false);
  });

  it("allows project-local fetches and serves build assets with browser MIME types", () => {
    const policy = createKanbanContentSecurityPolicy("nonce");
    expect(policy).toContain("connect-src 'self' data: blob:");
    expect(policy).toContain("script-src 'self' 'nonce-nonce' 'wasm-unsafe-eval'");
    expect(policy).not.toMatch(/connect-src[^;]*https?:/);
    expect(readKanbanAssetMimeType("assets/module.wasm")).toBe("application/wasm");
    expect(readKanbanAssetMimeType("assets/font.ttf?v=1")).toBe("font/ttf");
    expect(readKanbanAssetMimeType("manifest.webmanifest")).toBe("application/manifest+json; charset=utf-8");
  });

  it("converts values and injects the bridge before project scripts", () => {
    const params = createInjectedKanbanParams([
      { name: "count", type: "number" },
      { name: "done", type: "boolean" },
      { name: "title", type: "string", defaultValue: "Roadmap" },
    ], { count: "4", done: "true" });
    expect(params).toEqual({ count: 4, done: true, title: "Roadmap" });

    const html = injectKanbanBridge("<html><head></head><body><script nonce=\"stale\">render()</script></body></html>", {
      id: "default",
      name: "默认配置",
      params: { ...params, title: "<Roadmap>" },
    }, "nonce");
    expect(html.indexOf("steamHarnessKanban")).toBeLessThan(html.indexOf("render()"));
    expect(html).toContain('<script nonce="nonce">render()</script>');
    expect(html).not.toContain('nonce="stale"');
    expect(html).toContain("steamharness:kanban-ready");
    expect(html).toContain("steamHarnessKanban\",{configurable:false");
    expect(html).toContain('getValue:(key)=>call("kv.getValue",{key})');
    expect(html).toContain('const call=(operation,input={})=>request(operation,{...input,database})');
    expect(html).toContain('setValue:(key,value)=>isJsonValue(value)?call("kv.setValue",{key,value})');
    expect(html).toContain('createDocument:(input)=>call("knowledge.createDocument",input)');
    expect(html).toContain('editDocument:(documentId,input)=>call("knowledge.editDocument",{...input,documentId})');
    expect(html).toContain('readDocumentLines:(documentId,options)=>call("knowledge.readDocumentLines",{...options,documentId})');
    expect(html).toContain("Kanban bridge request timed out.");
    expect(html).toContain("pending.size>=16");
    expect(html).toContain('window.addEventListener("DOMContentLoaded",ready,{once:true})');
    expect(html).toContain("window.dispatchEvent(new CustomEvent");
    expect(html).toContain("ready();\n    return;");
    expect(html).not.toContain("frame-ancestors");
    const serializedConfiguration = html.match(/let current=(.*?);/)?.[1];
    expect(serializedConfiguration).toBeDefined();
    expect(JSON.parse(serializedConfiguration!)).toMatchObject({
      params: { title: "<Roadmap>" },
    });
  });

  it("validates bridge operations and JSON values", () => {
    expect(parseKanbanBridgeCall({
      requestId: "request-runtime-locale",
      operation: "runtime.getLocale",
      input: {},
    })).toEqual({
      requestId: "request-runtime-locale",
      operation: "runtime.getLocale",
      input: {},
    });
    expect(parseKanbanBridgeCall({
      requestId: "request-1",
      operation: "kv.setValue",
      input: { database:"data", key: "board", value: { version: 1, tasks: ["one"] } },
    })).toEqual({
      requestId: "request-1",
      operation: "kv.setValue",
      input: { database:"data", key: "board", value: { version: 1, tasks: ["one"] } },
    });
    expect(parseKanbanBridgeCall({
      requestId: "request-database",
      operation: "kv.getValue",
      input: { database:"stocks", key: "stock-database.v3:catalog" },
    })).toEqual({
      requestId: "request-database",
      operation: "kv.getValue",
      input: { database:"stocks", key: "stock-database.v3:catalog" },
    });
    expect(() => parseKanbanBridgeCall({
      requestId: "request-database-forged",
      operation: "kv.getValue",
      input: { database:"stocks", key: "catalog", projectId: "forged" },
    })).toThrow(/unsupported fields/);
    expect(() => parseKanbanBridgeCall({
      requestId: "request-2",
      operation: "kv.deleteValue",
      input: { database:"data", key: "board" },
    })).toThrow(/Unsupported/);
    expect(() => parseKanbanBridgeCall({
      requestId: "request-3",
      operation: "kv.setValue",
      input: { database:"data", key: "board", value: undefined },
    })).toThrow(/cannot be undefined/);
    expect(() => parseKanbanBridgeCall({
      requestId: "request-4",
      operation: "kv.getValue",
      input: { database:"data", key: "board", projectName: "another-project" },
    })).toThrow(/unsupported fields/);
    expect(() => parseKanbanBridgeCall({
      requestId: "request-5",
      operation: "knowledge.listDocuments",
      input: { database:"data", cursor: 12 },
    })).toThrow(/cursor.*non-empty string/);
    expect(() => parseKanbanBridgeCall({
      requestId: "request-6",
      operation: "knowledge.createDocument",
      input: { database:"data", id: "", title: "Guide", markdown: "# Guide" },
    })).toThrow(/id.*non-empty string/);
    expect(() => parseKanbanBridgeCall({
      requestId: "request-7",
      operation: "kv.getValue",
      input: { database:"data", key: "board" },
      projectName: "another-project",
    })).toThrow(/request contains unsupported fields/);
    expect(() => parseKanbanBridgeCall({
      requestId: "request-8",
      operation: "knowledge.listDocuments",
      input: { database:"data", pageSize: 101 },
    })).toThrow(/pageSize.*1 to 100/);
    expect(() => parseKanbanBridgeCall({
      requestId: "request-9",
      operation: "knowledge.searchDocuments",
      input: { database:"data", query: "roadmap", beforeLines: 51 },
    })).toThrow(/beforeLines.*0 to 50/);
    expect(() => parseKanbanBridgeCall({
      requestId: "request-10",
      operation: "knowledge.readDocumentLines",
      input: { database:"data", documentId: "guide", startLine: 10, endLine: 9 },
    })).toThrow(/line range/);
    expect(() => parseKanbanBridgeCall({
      requestId: "request-11",
      operation: "knowledge.readDocumentLines",
      input: { database:"data", documentId: "guide", startLine: 1, endLine: 1001 },
    })).toThrow(/line range/);
    expect(isKanbanJsonValue({ nested: [null, true, 3, "value"] })).toBe(true);
    expect(isKanbanJsonValue(Number.NaN)).toBe(false);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(isKanbanJsonValue(circular)).toBe(false);
  });

  it("does not expose unclassified host errors", () => {
    expect(createKanbanBridgeError(new Error("failed at /Users/private/data"))).toEqual({
      code: "KANBAN_BRIDGE_ERROR",
      message: "Kanban bridge request failed.",
    });
    expect(createKanbanBridgeError(Object.assign(new Error("failed at /private/database"), {
      code: "KANBAN_DATA_OPERATION_FAILED",
    }))).toEqual({
      code: "KANBAN_DATA_OPERATION_FAILED",
      message: "Kanban project data operation failed.",
    });
    expect(createKanbanBridgeError(Object.assign(new Error("failed at /private/database"), {
      code: "KANBAN_ARBITRARY_PRIVATE_ERROR",
    }))).toEqual({
      code: "KANBAN_BRIDGE_ERROR",
      message: "Kanban bridge request failed.",
    });
    expect(createKanbanBridgeError(Object.assign(new Error("prototype property"), {
      code: "__proto__",
    }))).toEqual({
      code: "KANBAN_BRIDGE_ERROR",
      message: "Kanban bridge request failed.",
    });
  });

  it("resolves and rejects injected page API requests only from the nonce-bound parent", async () => {
    const messageListeners: Array<(event: MessageEvent) => void> = [];
    const postedMessages: Array<Record<string, unknown>> = [];
    const parent = { postMessage: vi.fn((message: Record<string, unknown>) => postedMessages.push(message)) };
    const pageWindow = {
      parent,
      setTimeout: vi.fn(() => 1),
      clearTimeout: vi.fn(),
      addEventListener: vi.fn((type: string, listener: (event: MessageEvent) => void) => {
        if (type === "message") messageListeners.push(listener);
      }),
    } as unknown as Window & typeof globalThis;
    const script = createKanbanBridgeScript({ id: "default", name: "Default", params: {} }, "nonce")
      .replace(/^<script[^>]*>/, "")
      .replace(/<\/script>$/, "");
    new Function("window", "document", script)(pageWindow, { readyState: "complete" });

    const api = (pageWindow as unknown as { steamHarnessKanban: KanbanBrowserApi }).steamHarnessKanban;
    const data = api.databases.get("data");
    const getPromise = data.kv.getValue("board");
    const getRequest = postedMessages.at(-1)!;
    const dispatchResponse = (source: unknown, nonce: string, response: Record<string, unknown>) => {
      for (const listener of messageListeners) {
        listener({ source, data: {
          type: "steamharness:kanban-bridge-response",
          nonce,
          requestId: getRequest["requestId"],
          ...response,
        } } as unknown as MessageEvent);
      }
    };
    dispatchResponse({}, "nonce", { ok: true, value: "forged-source" });
    dispatchResponse(parent, "wrong", { ok: true, value: "forged-nonce" });
    dispatchResponse(parent, "nonce", { ok: true, value: { version: 1 } });
    await expect(getPromise).resolves.toEqual({ version: 1 });

    const databaseContext = api.databases.get("stocks");
    const relatedGetPromise = databaseContext.kv.getValue("stock-database.v3:catalog");
    const relatedGetRequest = postedMessages.at(-1)!;
    expect(relatedGetRequest).toMatchObject({
      operation: "kv.getValue",
      input: { database:"stocks", key: "stock-database.v3:catalog" },
    });
    for (const listener of messageListeners) {
      listener({ source: parent, data: {
        type: "steamharness:kanban-bridge-response",
        nonce: "nonce",
        requestId: relatedGetRequest["requestId"],
        ok: true,
        value: { schemaVersion: 3 },
      } } as unknown as MessageEvent);
    }
    await expect(relatedGetPromise).resolves.toEqual({ schemaVersion: 3 });

    const relatedSetPromise = databaseContext.kv.setValue("stock-database.v3:catalog", { schemaVersion: 4 });
    const relatedSetRequest = postedMessages.at(-1)!;
    expect(relatedSetRequest).toMatchObject({
      operation: "kv.setValue",
      input: { database:"stocks",
        key: "stock-database.v3:catalog",
        value: { schemaVersion: 4 },
      },
    });
    for (const listener of messageListeners) {
      listener({ source: parent, data: {
        type: "steamharness:kanban-bridge-response",
        nonce: "nonce",
        requestId: relatedSetRequest["requestId"],
        ok: true,
      } } as unknown as MessageEvent);
    }
    await expect(relatedSetPromise).resolves.toBeUndefined();

    const revisions: Array<{ alias: string; revision: string }> = [];
    const unsubscribe = databaseContext.subscribe((event) => revisions.push(event));
    const dispatchRevision = (source: unknown, nonce: string, alias: string, revision: string) => {
      for (const listener of messageListeners) {
        listener({ source, data: {
          type: "steamharness:kanban-database-revision",
          nonce,
          alias,
          revision,
        } } as unknown as MessageEvent);
      }
    };
    dispatchRevision({}, "nonce", "stocks", "forged-source");
    dispatchRevision(parent, "wrong", "stocks", "forged-nonce");
    dispatchRevision(parent, "nonce", "stocks", "revision-1");
    await Promise.resolve();
    expect(revisions).toEqual([{ alias: "stocks", revision: "revision-1" }]);
    dispatchRevision(parent, "nonce", "stocks", "revision-1");
    await Promise.resolve();
    expect(revisions).toHaveLength(1);
    unsubscribe();
    dispatchRevision(parent, "nonce", "stocks", "revision-2");
    await Promise.resolve();
    expect(revisions).toHaveLength(1);

    dispatchRevision(parent, "nonce", "prices", "snapshot-1");
    const snapshotListener = vi.fn();
    api.databases.get("prices").subscribe(snapshotListener);
    await Promise.resolve();
    expect(snapshotListener).toHaveBeenCalledWith({ alias: "prices", revision: "snapshot-1" });
    expect(() => api.databases.get("Invalid Alias")).toThrow(/invalid/i);

    const setPromise = data.kv.setValue("board", { version: 2 });
    const setRequest = postedMessages.at(-1)!;
    for (const listener of messageListeners) {
      listener({ source: parent, data: {
        type: "steamharness:kanban-bridge-response",
        nonce: "nonce",
        requestId: setRequest["requestId"],
        ok: false,
        error: { code: "KANBAN_DATA_OPERATION_FAILED", message: "Project data operation failed." },
      } } as unknown as MessageEvent);
    }
    await expect(setPromise).rejects.toMatchObject({
      code: "KANBAN_DATA_OPERATION_FAILED",
      message: "Kanban project data operation failed.",
    });

    const inheritedErrorPromise = data.kv.getValue("inherited-error");
    const inheritedErrorRequest = postedMessages.at(-1)!;
    for (const listener of messageListeners) {
      listener({ source: parent, data: {
        type: "steamharness:kanban-bridge-response",
        nonce: "nonce",
        requestId: inheritedErrorRequest["requestId"],
        ok: false,
        error: { code: "__proto__", message: "prototype property" },
      } } as unknown as MessageEvent);
    }
    await expect(inheritedErrorPromise).rejects.toMatchObject({
      code: "KANBAN_BRIDGE_ERROR",
      message: "Kanban bridge request failed.",
    });

    await expect(data.kv.setValue("board", (() => undefined) as never)).rejects.toMatchObject({
      code: "KANBAN_BRIDGE_INVALID_REQUEST",
      message: "The Kanban bridge request is invalid.",
    });
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    await expect(data.kv.setValue("board", circular as never)).rejects.toMatchObject({
      code: "KANBAN_BRIDGE_INVALID_REQUEST",
    });

    parent.postMessage.mockImplementationOnce(() => {
      throw new DOMException("private clone failure", "DataCloneError");
    });
    await expect(data.knowledge.listDocuments({ invalid: () => undefined })).rejects.toMatchObject({
      code: "KANBAN_BRIDGE_INVALID_REQUEST",
      message: "The Kanban bridge request is invalid.",
    });
  });

  it("injects only opaque platform file references without requiring a format hint", () => {
    const injected = createInjectedKanbanParams([
      { name: "attachment", type: "file" },
      { name: "attachments", type: "file", multiple: true },
    ], {
      attachment: JSON.stringify({
        id: "wf_file_reference",
        name: "brief.pdf",
        mimeType: "application/pdf",
        size: 10,
        kind: "file",
        storage: "server",
        createdAt: "2026-07-27T00:00:00.000Z",
        storagePath: "/private/server/files/brief.pdf",
        localAbsolutePath: "/Users/example/brief.pdf",
      }),
      attachments: JSON.stringify([{
        id: "wf_local_reference",
        name: "board.png",
        mimeType: "image/png",
        size: 20,
        storage: "local",
        storagePath: "/private/local/board.png",
      }]),
    });
    const [file] = injected.attachment as Array<Record<string, unknown>>;
    const [localFile] = injected.attachments as Array<Record<string, unknown>>;

    expect(file).toEqual({
      id: "wf_file_reference",
      name: "brief.pdf",
      mimeType: "application/pdf",
      size: 10,
      kind: "file",
      storage: "server",
      createdAt: "2026-07-27T00:00:00.000Z",
    });
    expect(file).not.toHaveProperty("storagePath");
    expect(file).not.toHaveProperty("localAbsolutePath");
    expect(localFile).toMatchObject({
      id: "wf_local_reference",
      name: "board.png",
      mimeType: "image/png",
      kind: "image",
      storage: "local",
    });
    expect(localFile).not.toHaveProperty("storagePath");
  });
});

describe("Kanban preview capability refresh", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renews one minute before expiry and ignores missing or invalid dates", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T00:00:00.000Z"));
    const refresh = vi.fn(async () => undefined);

    expect(getKanbanPreviewCapabilityRefreshDelay(undefined)).toBeUndefined();
    expect(getKanbanPreviewCapabilityRefreshDelay("invalid")).toBeUndefined();
    const cancel = scheduleKanbanPreviewCapabilityRefresh({
      expiresAt: "2026-07-28T00:15:00.000Z",
      refresh,
    });

    await vi.advanceTimersByTimeAsync(13 * 60_000 + 59_999);
    expect(refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledOnce();
    cancel();
  });

  it("retries transient failures and reports when the old capability has expired", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T00:00:00.000Z"));
    const refresh = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new Error("still offline"))
      .mockResolvedValue(undefined);
    const onFailure = vi.fn();
    const cancel = scheduleKanbanPreviewCapabilityRefresh({
      expiresAt: "2026-07-28T00:00:10.000Z",
      refresh,
      onFailure,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(onFailure).toHaveBeenLastCalledWith(expect.any(Error), { expired: false });
    await vi.advanceTimersByTimeAsync(KANBAN_PREVIEW_CAPABILITY_RETRY_MS);
    expect(onFailure).toHaveBeenLastCalledWith(expect.any(Error), { expired: true });
    await vi.advanceTimersByTimeAsync(KANBAN_PREVIEW_CAPABILITY_RETRY_MS);
    expect(refresh).toHaveBeenCalledTimes(3);
    cancel();
  });
});
