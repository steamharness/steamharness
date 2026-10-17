import type { KanbanInjectedConfiguration, KanbanJsonValue, KanbanPresentation } from "./index";

export const KANBAN_METHOD_CATALOG_MESSAGE = "workflow-code:kanban-method-catalog";
export const KANBAN_METHOD_INVOKE_MESSAGE = "workflow-code:kanban-method-invoke";
export const KANBAN_METHOD_RESULT_MESSAGE = "workflow-code:kanban-method-result";
export const KANBAN_METHOD_CANCEL_MESSAGE = "workflow-code:kanban-method-cancel";
export const KANBAN_METHOD_MAX_JSON_CHARS = 65_536;
export const KANBAN_METHOD_TIMEOUT_MS = 15_000;
const MAX_METHODS = 32;

export interface KanbanMethodDefinition {
  name: string;
  description: string;
  /** Discovery metadata. The handler validates business arguments. */
  inputSchema: { type: "object"; [key: string]: KanbanJsonValue };
  readOnly?: boolean;
}

export interface KanbanMethodContext {
  signal: AbortSignal;
  configuration: KanbanInjectedConfiguration;
  presentation: KanbanPresentation;
}

export interface KanbanBrowserMethodsApi {
  register(
    definition: KanbanMethodDefinition,
    handler: (input: Record<string, KanbanJsonValue>, context: KanbanMethodContext) => KanbanJsonValue | Promise<KanbanJsonValue>,
  ): () => void;
}

export interface KanbanMethodInvocation {
  instanceId: string;
  configurationId: string;
  method: string;
  args: Record<string, KanbanJsonValue>;
}

export interface KanbanMethodTarget {
  projectId: string;
  source: "local" | "server";
  location: "workspace" | "dock" | "card";
  cardId?: string;
}

export interface KanbanMethodState {
  ready: boolean;
  configurationId: string;
  configurationName: string;
  presentation: KanbanPresentation;
  methods: KanbanMethodDefinition[];
}

export interface KanbanMethodClient {
  instanceId: string;
  getState(): KanbanMethodState;
  invoke(call: KanbanMethodInvocation, signal?: AbortSignal): Promise<KanbanJsonValue>;
}

export interface KanbanMethodRegistry {
  register(target: KanbanMethodTarget, client: KanbanMethodClient): () => void;
  list(projectId: string, source: KanbanMethodTarget["source"]): Array<KanbanMethodTarget & KanbanMethodState & { instanceId: string }>;
  invoke(projectId: string, source: KanbanMethodTarget["source"], input: unknown, signal?: AbortSignal): Promise<KanbanJsonValue>;
}

export function createKanbanMethodRegistry(): KanbanMethodRegistry {
  const clients = new Map<string, { target: KanbanMethodTarget; client: KanbanMethodClient }>();
  return {
    register(target, client) {
      const entry = { target: { ...target }, client };
      clients.set(client.instanceId, entry);
      return () => { if (clients.get(client.instanceId) === entry) clients.delete(client.instanceId); };
    },
    list(projectId, source) {
      return [...clients.values()].filter((entry) => entry.target.projectId === projectId && entry.target.source === source)
        .map(({ target, client }) => ({ ...target, instanceId: client.instanceId, ...client.getState() }));
    },
    async invoke(projectId, source, input, signal) {
      const call = parseKanbanMethodInvocation(input);
      const entry = clients.get(call.instanceId);
      if (!entry || entry.target.projectId !== projectId || entry.target.source !== source) {
        throw methodError("KANBAN_METHOD_INSTANCE_UNAVAILABLE", "This Kanban preview instance is no longer available. List instances again.");
      }
      return entry.client.invoke(call, signal);
    },
  };
}

export function parseKanbanMethodInvocation(value: unknown): KanbanMethodInvocation {
  if (!isRecord(value) || Object.keys(value).some((key) => !["instanceId", "configurationId", "method", "args"].includes(key))) {
    throw methodError("KANBAN_METHOD_INVALID_REQUEST", "Invalid Kanban method invocation.");
  }
  if (typeof value.instanceId !== "string" || !value.instanceId || value.instanceId.length > 200
    || typeof value.configurationId !== "string" || value.configurationId.length > 200
    || typeof value.method !== "string" || !/^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/.test(value.method)
    || !isRecord(value.args)) {
    throw methodError("KANBAN_METHOD_INVALID_REQUEST", "An instanceId, configurationId, method and JSON args object are required.");
  }
  assertKanbanMethodJson(value.args);
  return value as unknown as KanbanMethodInvocation;
}

export function assertKanbanMethodJson(value: unknown): asserts value is KanbanJsonValue {
  const seen = new Set<object>();
  const visit = (node: unknown, depth: number): boolean => {
    if (depth > 32) return false;
    if (node === null || typeof node === "string" || typeof node === "boolean") return true;
    if (typeof node === "number") return Number.isFinite(node);
    if (typeof node !== "object" || seen.has(node)) return false;
    seen.add(node);
    const valid = Array.isArray(node) ? node.every((item) => visit(item, depth + 1))
      : Object.getPrototypeOf(node) === Object.prototype && Object.values(node).every((item) => visit(item, depth + 1));
    seen.delete(node);
    return valid;
  };
  if (!visit(value, 0) || JSON.stringify(value).length > KANBAN_METHOD_MAX_JSON_CHARS) {
    throw methodError("KANBAN_METHOD_INVALID_JSON", "Kanban method data must be JSON, at most 32 levels deep and 64 Ki characters.");
  }
}

export function parseKanbanMethodDefinitions(value: unknown): KanbanMethodDefinition[] {
  assertKanbanMethodJson(value);
  if (!Array.isArray(value) || value.length > MAX_METHODS) throw methodError("KANBAN_METHOD_INVALID_CATALOG", "Invalid Kanban method catalog.");
  const names = new Set<string>();
  for (const item of value) {
    if (!isRecord(item) || Object.keys(item).some((key) => !["name", "description", "inputSchema", "readOnly"].includes(key))
      || typeof item.name !== "string" || !/^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/.test(item.name) || names.has(item.name)
      || typeof item.description !== "string" || !item.description.trim() || item.description.length > 2_000
      || !isRecord(item.inputSchema) || item.inputSchema.type !== "object" || JSON.stringify(item.inputSchema).length > 8_192
      || (item.readOnly !== undefined && typeof item.readOnly !== "boolean")) {
      throw methodError("KANBAN_METHOD_INVALID_CATALOG", "Invalid Kanban method definition.");
    }
    names.add(item.name);
  }
  return JSON.parse(JSON.stringify(value)) as KanbanMethodDefinition[];
}

/** One iframe document/configuration generation, with bounded pending calls. */
export function createKanbanMethodSession(options: {
  nonce: string;
  getConfiguration(): KanbanInjectedConfiguration | undefined;
  getPresentation(): KanbanPresentation;
  postMessage(message: Record<string, unknown>): void;
  timeoutMs?: number;
}): KanbanMethodClient & { receive(message: Record<string, unknown>): void; close(): void } {
  const instanceId = globalThis.crypto.randomUUID();
  let ready = false;
  let closed = false;
  let revision = 0;
  let documentId: string | undefined;
  let methods: KanbanMethodDefinition[] = [];
  const pending = new Map<string, { finish(error?: Error, value?: KanbanJsonValue): void }>();
  const post = (message: Record<string, unknown>) => options.postMessage({ ...message, nonce: options.nonce });
  return {
    instanceId,
    getState() {
      const configuration = options.getConfiguration();
      return { ready, configurationId: configuration?.id ?? "", configurationName: configuration?.name ?? "",
        presentation: options.getPresentation(), methods: JSON.parse(JSON.stringify(methods)) as KanbanMethodDefinition[] };
    },
    async invoke(call, signal) {
      if (closed || !ready) throw methodError("KANBAN_METHOD_INSTANCE_UNAVAILABLE", "The Kanban preview is not ready or has closed.");
      if (call.configurationId !== (options.getConfiguration()?.id ?? "")) throw methodError("KANBAN_METHOD_STALE", "The Kanban configuration changed. List instances again.");
      if (!methods.some((method) => method.name === call.method)) throw methodError("KANBAN_METHOD_UNAVAILABLE", "The Kanban page has not registered this method.");
      assertKanbanMethodJson(call.args);
      if (pending.size >= 4) throw methodError("KANBAN_METHOD_BUSY", "Too many Kanban method calls are pending.");
      if (signal?.aborted) throw methodError("KANBAN_METHOD_CANCELLED", "Kanban method call was cancelled.");
      const requestId = globalThis.crypto.randomUUID();
      return new Promise<KanbanJsonValue>((resolve, reject) => {
        const cancel = (code: string, message: string) => {
          pending.get(requestId)?.finish(methodError(code, message));
          try { post({ type: KANBAN_METHOD_CANCEL_MESSAGE, requestId }); } catch { /* The frame may have closed. */ }
        };
        const onAbort = () => cancel("KANBAN_METHOD_CANCELLED", "Kanban method call was cancelled.");
        const timer = setTimeout(() => cancel("KANBAN_METHOD_TIMEOUT", "Kanban method call timed out. Its effects may already have occurred; inspect state before retrying."), options.timeoutMs ?? KANBAN_METHOD_TIMEOUT_MS);
        pending.set(requestId, {
          finish(error, value) {
            if (!pending.delete(requestId)) return;
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            if (error) reject(error); else resolve(value!);
          },
        });
        signal?.addEventListener("abort", onAbort, { once: true });
        try { post({ type: KANBAN_METHOD_INVOKE_MESSAGE, requestId, documentId, revision, configurationId: call.configurationId, method: call.method, input: call.args }); }
        catch { pending.get(requestId)?.finish(methodError("KANBAN_METHOD_INSTANCE_UNAVAILABLE", "The Kanban preview is unavailable.")); }
      });
    },
    receive(message) {
      if (closed || message.nonce !== options.nonce) return;
      if (message.type === "workflow-code:kanban-ready") {
        if (typeof message.documentId === "string" && documentId !== message.documentId) {
          for (const request of pending.values()) request.finish(methodError("KANBAN_METHOD_INSTANCE_UNAVAILABLE", "The Kanban document refreshed."));
          documentId = message.documentId;
          revision = 0;
          methods = [];
        }
        ready = true;
        return;
      }
      if (message.type === KANBAN_METHOD_CATALOG_MESSAGE) {
        if (message.documentId !== documentId) return;
        if (message.configurationId !== (options.getConfiguration()?.id ?? "") || !Number.isSafeInteger(message.revision) || (message.revision as number) < revision) return;
        try { methods = parseKanbanMethodDefinitions(message.methods); revision = message.revision as number; } catch { return; }
        return;
      }
      if (message.type !== KANBAN_METHOD_RESULT_MESSAGE || typeof message.requestId !== "string") return;
      const request = pending.get(message.requestId);
      if (!request) return;
      if (message.ok === true) {
        try { assertKanbanMethodJson(message.value); request.finish(undefined, message.value); }
        catch { request.finish(methodError("KANBAN_METHOD_INVALID_RESULT", "The Kanban method returned invalid or oversized JSON.")); }
      } else if (message.ok === false) {
        const error = isRecord(message.error) ? message.error : {};
        request.finish(methodError(typeof error.code === "string" && /^KANBAN_METHOD_[A-Z_]+$/.test(error.code) ? error.code : "KANBAN_METHOD_FAILED",
          typeof error.message === "string" ? error.message.slice(0, 2_000) : "Kanban method failed."));
      }
    },
    close() {
      closed = true;
      ready = false;
      methods = [];
      for (const [requestId, request] of pending) {
        request.finish(methodError("KANBAN_METHOD_INSTANCE_UNAVAILABLE", "The Kanban preview closed, refreshed, or changed configuration."));
        try { post({ type: KANBAN_METHOD_CANCEL_MESSAGE, requestId }); } catch { /* The document may have gone. */ }
      }
    },
  };
}

function methodError(code: string, message: string): Error { return Object.assign(new Error(message), { code }); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

export function createKanbanMethodsBridgeScript(nonce: string): string {
  const safeNonce = JSON.stringify(nonce);
  return `
const registeredMethods=new Map();
const methodDocumentId=Date.now().toString(36)+"-"+Math.random().toString(36).slice(2);
const activeMethodCalls=new Map();
const seenMethodCalls=new Set();
let methodRevision=0;
const methodPost=(message)=>window.parent.postMessage({...message,nonce:${safeNonce}},"*");
const methodDepth=(value,depth=0)=>depth<=32&&(value===null||typeof value!=="object"||Object.values(value).every((item)=>methodDepth(item,depth+1)));
const methodJson=(value)=>{try{if(!isJsonValue(value)||!methodDepth(value)||JSON.stringify(value).length>${KANBAN_METHOD_MAX_JSON_CHARS})throw invalidRequest();return JSON.parse(JSON.stringify(value));}catch{throw createError("Kanban method data must be bounded JSON.","KANBAN_METHOD_INVALID_JSON");}};
const publishKanbanMethods=()=>methodPost({type:${JSON.stringify(KANBAN_METHOD_CATALOG_MESSAGE)},documentId:methodDocumentId,configurationId:current.id,revision:++methodRevision,methods:[...registeredMethods.values()].map((entry)=>entry.definition)});
const finishMethodCall=(requestId,response)=>{
  const entry=activeMethodCalls.get(requestId);if(!entry)return;
  activeMethodCalls.delete(requestId);window.clearTimeout(entry.timer);
  methodPost({type:${JSON.stringify(KANBAN_METHOD_RESULT_MESSAGE)},requestId,...response});
};
const abortMethodCall=(requestId,code,message)=>{const entry=activeMethodCalls.get(requestId);if(!entry)return;entry.controller.abort();finishMethodCall(requestId,{ok:false,error:{code,message}});};
const resetKanbanMethods=()=>{registeredMethods.clear();for(const id of activeMethodCalls.keys())abortMethodCall(id,"KANBAN_METHOD_STALE","The Kanban configuration changed.");publishKanbanMethods();};
const methods=Object.freeze({register:(definition,handler)=>{
  const clean=methodJson(definition);
  if(!clean||typeof clean!=="object"||Array.isArray(clean)||Object.keys(clean).some((key)=>!["name","description","inputSchema","readOnly"].includes(key))||typeof clean.name!=="string"||!/^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/.test(clean.name)||typeof clean.description!=="string"||!clean.description.trim()||clean.description.length>2000||!clean.inputSchema||clean.inputSchema.type!=="object"||JSON.stringify(clean.inputSchema).length>8192||(clean.readOnly!==undefined&&typeof clean.readOnly!=="boolean")||typeof handler!=="function"||registeredMethods.has(clean.name)||registeredMethods.size>=${MAX_METHODS})throw invalidRequest();
  if(JSON.stringify([...registeredMethods.values()].map((entry)=>entry.definition).concat(clean)).length>${KANBAN_METHOD_MAX_JSON_CHARS})throw invalidRequest();
  const entry={definition:clean,handler};registeredMethods.set(clean.name,entry);publishKanbanMethods();
  return ()=>{if(registeredMethods.get(clean.name)!==entry)return;registeredMethods.delete(clean.name);for(const [id,call] of activeMethodCalls)if(call.method===clean.name)abortMethodCall(id,"KANBAN_METHOD_UNAVAILABLE","The Kanban method was unregistered.");publishKanbanMethods();};
}});
const handleKanbanMethodMessage=(data)=>{
  if(data.type===${JSON.stringify(KANBAN_METHOD_CANCEL_MESSAGE)}){if(typeof data.requestId==="string")abortMethodCall(data.requestId,"KANBAN_METHOD_CANCELLED","Kanban method call was cancelled.");return true;}
  if(data.type!==${JSON.stringify(KANBAN_METHOD_INVOKE_MESSAGE)})return false;
  const requestId=data.requestId;if(typeof requestId!=="string"||!requestId||requestId.length>200||seenMethodCalls.has(requestId))return true;
  seenMethodCalls.add(requestId);if(seenMethodCalls.size>128)seenMethodCalls.delete(seenMethodCalls.values().next().value);
  const fail=(code,message)=>methodPost({type:${JSON.stringify(KANBAN_METHOD_RESULT_MESSAGE)},requestId,ok:false,error:{code,message}});
  if(data.documentId!==methodDocumentId||data.configurationId!==current.id||data.revision!==methodRevision){fail("KANBAN_METHOD_STALE","The Kanban document, configuration or methods changed. List instances again.");return true;}
  const method=registeredMethods.get(data.method);if(!method){fail("KANBAN_METHOD_UNAVAILABLE","The Kanban method is unavailable.");return true;}
  if(activeMethodCalls.size>=4){fail("KANBAN_METHOD_BUSY","Too many Kanban method calls are pending.");return true;}
  let input;try{input=methodJson(data.input);if(!input||typeof input!=="object"||Array.isArray(input))throw invalidRequest();}catch{fail("KANBAN_METHOD_INVALID_REQUEST","Kanban method input must be a JSON object.");return true;}
  const controller=new AbortController();const timer=window.setTimeout(()=>abortMethodCall(requestId,"KANBAN_METHOD_TIMEOUT","Kanban method call timed out; inspect state before retrying."),${KANBAN_METHOD_TIMEOUT_MS});
  activeMethodCalls.set(requestId,{controller,timer,method:data.method});
  const context={signal:controller.signal,configuration:clone(),presentation:{...presentation}};
  Promise.resolve().then(()=>{if(controller.signal.aborted)throw createError("Cancelled","KANBAN_METHOD_CANCELLED");return method.handler(input,context);})
    .then((value)=>finishMethodCall(requestId,{ok:true,value:methodJson(value)}))
    .catch((error)=>finishMethodCall(requestId,{ok:false,error:{code:"KANBAN_METHOD_FAILED",message:typeof error?.message==="string"?error.message.slice(0,2000):"Kanban method failed."}}));
  return true;
};
window.addEventListener("pagehide",()=>{for(const id of activeMethodCalls.keys())abortMethodCall(id,"KANBAN_METHOD_INSTANCE_UNAVAILABLE","The Kanban page closed.");registeredMethods.clear();publishKanbanMethods();});
`;
}
