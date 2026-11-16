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
  KANBAN_ENTRY_BRIDGE_REQUEST_TIMEOUT_MS,
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
    const read = { requestId: 'read', operation: 'files.readFile', input: { fileId: 'wf_ab12' } };
    expect(parseKanbanBridgeCall(read)).toEqual(read);
    expect(() => parseKanbanBridgeCall({ ...read, input: { ...read.input, projectId: 'forged' } })).toThrow(/unsupported fields/);
    expect(() => parseKanbanBridgeCall({ ...read, projectName: 'another-project' })).toThrow(/unsupported fields/);
    expect(() => parseKanbanBridgeCall({ requestId: 'unknown', operation: 'unknown.operation', input: {} })).toThrow(/Unsupported/);
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
    expect(createKanbanBridgeError(Object.assign(new Error("failed at /private/source"), {
      code: "KANBAN_DATA_OPERATION_FAILED",
    }))).toEqual({
      code: "KANBAN_DATA_OPERATION_FAILED",
      message: "Kanban project data operation failed.",
    });
    expect(createKanbanBridgeError(Object.assign(new Error("failed at /private/source"), {
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

  it("accepts only nonce-bound parent replies", async () => {
    const listeners: Array<(event: MessageEvent) => void> = [];
    const posted: Array<Record<string, unknown>> = [];
    const parent = { postMessage: vi.fn((message: Record<string, unknown>) => posted.push(message)) };
    const pageWindow = { parent, setTimeout: () => 1, clearTimeout() {}, addEventListener(type: string, listener: (event: MessageEvent) => void) { if (type === 'message') listeners.push(listener); } } as unknown as Window & { steamHarnessKanban: KanbanBrowserApi };
    new Function('window', 'document', createKanbanBridgeScript({ id: 'default', name: 'Default', params: {} }, 'nonce').replace(/^<script[^>]*>/, '').replace(/<\/script>$/, ''))(pageWindow, { readyState: 'complete' });
    const data = pageWindow.steamHarnessKanban.studio;
    const dispatch = (source: unknown, nonce: string, body: Record<string, unknown>) => listeners.forEach(listener => listener({ source, data: { nonce, ...body } } as unknown as MessageEvent));
    const pending = data.getLocalAnalysis();
    const requestId = posted.at(-1)!.requestId;
    const reply = { type: 'steamharness:kanban-bridge-response', requestId, ok: true, value: { id: 'guide' } };
    dispatch({}, 'nonce', { ...reply, value: 'forged' }); dispatch(parent, 'wrong', { ...reply, value: 'forged' }); dispatch(parent, 'nonce', reply);
    await expect(pending).resolves.toEqual({ id: 'guide' });
    for (const code of ['KANBAN_DATA_OPERATION_FAILED', '__proto__']) {
      const failure = data.getLocalAnalysis();
      dispatch(parent, 'nonce', { type: 'steamharness:kanban-bridge-response', requestId: posted.at(-1)!.requestId, ok: false, error: { code, message: '/private/secret' } });
      await expect(failure).rejects.toMatchObject({ code: code === '__proto__' ? 'KANBAN_BRIDGE_ERROR' : code });
    }
    parent.postMessage.mockImplementationOnce(() => { throw new DOMException('private clone failure', 'DataCloneError'); });
    await expect(data.getLocalAnalysis()).rejects.toMatchObject({ code: 'KANBAN_BRIDGE_INVALID_REQUEST' });
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

it('keeps slow Workflow receipts pending within a bounded deadline', async () => {
  vi.useFakeTimers();
  const listeners: Array<(event: MessageEvent) => void> = [], outgoing: any[] = [];
  const parent = { postMessage: (message: unknown) => outgoing.push(message) };
  const pageWindow = { parent, setTimeout, clearTimeout, dispatchEvent() {}, addEventListener(type: string, listener: any) { if (type === 'message') listeners.push(listener); } } as unknown as Window & { steamHarnessKanban: KanbanBrowserApi };
  const send = (data: any) => listeners.forEach(listener => listener({ source: parent, data } as unknown as MessageEvent));
  try {
    new Function('window', 'document', createKanbanBridgeScript({ id: 'one', name: 'One', params: {} }, 'nonce').replace(/^<script[^>]*>/, '').replace(/<\/script>$/, ''))(pageWindow, { readyState: 'complete' });
    let finished = false;
    const pending = pageWindow.steamHarnessKanban.entries.get('api').runEntrypoint('message-send', []).finally(() => { finished = true; });
    const request = outgoing.at(-1);
    await vi.advanceTimersByTimeAsync(16_000);
    expect(finished).toBe(false);
    send({ type: 'steamharness:kanban-bridge-response', nonce: 'nonce', requestId: request.requestId, ok: true, value: { receipt: 'persisted' } });
    await expect(pending).resolves.toEqual({ receipt: 'persisted' });
    const late = pageWindow.steamHarnessKanban.entries.get('api').runEntrypoint('state', []);
    const rejected = expect(late).rejects.toMatchObject({ code: 'KANBAN_BRIDGE_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(KANBAN_ENTRY_BRIDGE_REQUEST_TIMEOUT_MS + 1);
    await rejected;
    expect(outgoing.filter(message => message.operation === 'entries.runEntrypoint')).toHaveLength(2);
  } finally { vi.useRealTimers(); }
});

it('binds aggregate operations and streaming subscriptions to the current iframe/configuration', async () => {
  const listeners: Array<(event:MessageEvent)=>void>=[], outgoing:any[]=[];
  const parent={postMessage:(message:unknown)=>outgoing.push(message)};
  const pageWindow={parent,setTimeout:()=>1,clearTimeout(){},dispatchEvent(){},addEventListener(type:string,listener:any){if(type==='message')listeners.push(listener);}} as unknown as Window & {steamHarnessKanban:KanbanBrowserApi};
  const send=(data:any,source=parent)=>listeners.forEach(listener=>listener({source,data} as unknown as MessageEvent));
  new Function('window','document',createKanbanBridgeScript({id:'one',name:'One',params:{}},'nonce').replace(/^<script[^>]*>/,'').replace(/<\/script>$/,''))(pageWindow,{readyState:'complete'});
  const pending=pageWindow.steamHarnessKanban.entries.get('api').runEntrypoint('state',['--payload','{}']);
  const request=outgoing.at(-1);
  expect(request).toMatchObject({operation:'entries.runEntrypoint',input:{entryId:'api',entrypointId:'state',args:['--payload','{}']}});
  send({type:'steamharness:kanban-bridge-response',nonce:'nonce',requestId:request.requestId,ok:true,value:{receipt:true}});
  await expect(pending).resolves.toEqual({receipt:true});
  const receive=vi.fn(),stop=pageWindow.steamHarnessKanban.conversations.subscribe({entryId:'bot',conversationId:'private'},receive);
  const sub=outgoing.at(-1),snapshot={entryId:'bot',conversationId:'private',ownerId:'owner',revision:1};
  send({type:'steamharness:kanban-conversation',nonce:'old',subscriptionId:sub.input.subscriptionId,snapshot});
  expect(receive).not.toHaveBeenCalled();
  send({type:'steamharness:kanban-conversation',nonce:'nonce',subscriptionId:sub.input.subscriptionId,snapshot});
  await Promise.resolve();
  expect(receive).toHaveBeenCalledTimes(1);
  send({type:'steamharness:kanban-configuration',nonce:'nonce',configuration:{id:'two',name:'Two',params:{}}});
  send({type:'steamharness:kanban-conversation',nonce:'nonce',subscriptionId:sub.input.subscriptionId,snapshot});
  await Promise.resolve();
  expect(receive).toHaveBeenCalledTimes(1);stop();
  expect(()=>parseKanbanBridgeCall({requestId:'bad',operation:'entries.runEntrypoint',input:{entryId:'api',entrypointId:'state',args:[],requestId:'r',actor:{userId:'spoof'}}})).toThrow();
});
