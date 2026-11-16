import { validateWorkflowCall } from './workflow';
export * from './workflow';
import type { ParamDefinition } from "./run-workspace/types";
import { createKanbanMethodsBridgeScript, type KanbanBrowserMethodsApi } from "./methods";
import { installProjectKeyboardBridge } from "./keyboard";
import { installProjectCopyBridge } from "./copy";
export * from "./methods";
export * from "./keyboard";
export * from "./copy";


export const KANBAN_MANIFEST_FILE = "kanban.json";
export const KANBAN_ENTRY_FILE = "index.html";
export const KANBAN_ARTIFACT_DIR = ".";
export const KANBAN_MANIFEST_VERSION = 1;
export const KANBAN_CONFIGURATION_CHANGE_EVENT = "steamharness:kanban-configuration-change";
export const KANBAN_PRESENTATION_CHANGE_EVENT = "steamharness:kanban-presentation-change";
export const KANBAN_PRESENTATION_MESSAGE = "steamharness:kanban-presentation";
export const KANBAN_PREVIEW_READY_MESSAGE = "steamharness:kanban-ready";
export const KANBAN_BRIDGE_REQUEST_MESSAGE = "steamharness:kanban-bridge-request";
export const KANBAN_BRIDGE_RESPONSE_MESSAGE = "steamharness:kanban-bridge-response";
export const KANBAN_BRIDGE_REQUEST_TIMEOUT_MS = 15_000;
export const KANBAN_ENTRY_BRIDGE_REQUEST_TIMEOUT_MS = 120_000;
export const KANBAN_FILE_BRIDGE_REQUEST_TIMEOUT_MS = 120_000;
export const KANBAN_BRIDGE_MAX_PENDING_REQUESTS = 16;
export const KANBAN_PREVIEW_CAPABILITY_REFRESH_LEAD_MS = 60_000;
export const KANBAN_PREVIEW_CAPABILITY_RETRY_MS = 15_000;

export type KanbanParamControl = "text" | "textarea" | "radio" | "select" | "checkboxes";

export interface KanbanParamDefinition extends Omit<ParamDefinition, "control"> {
  control?: KanbanParamControl;
}

export interface KanbanManifest {
  version: 1;
  params: KanbanParamDefinition[];
}

export type KanbanConfigurationValues = Record<string, string>;

export interface KanbanConfiguration {
  id: string;
  name: string;
  values: KanbanConfigurationValues;
  createdAt: string;
  updatedAt: string;
}

export interface KanbanInjectedConfiguration {
  id: string;
  name: string;
  params: Record<string, unknown>;
}

export type KanbanPresentationMode = "fullscreen" | "phone" | "tablet" | "card";

export interface KanbanPresentation {
  mode: KanbanPresentationMode;
}

import { assertConversationUi } from "./conversation";
import type { KanbanConversationUi, KanbanConversationMountOptions, KanbanConversationMount } from "./conversation";
export * from "./conversation";

export interface KanbanConversationViewTarget {
  entryId: string;
  conversationId: string;
  draft?: string;
  locale?: KanbanRuntimeLocale;
  ui?: KanbanConversationUi;
  submit?: { entryId: string; entrypointId: string; payload: Record<string, KanbanJsonValue> };
}

export interface KanbanBrowserApi {
  entries: { list(): Promise<{ entryId: string; name: string; type: string; status: string }[]>; get(entryId: string): { runEntrypoint(entrypointId: string, args?: readonly string[], options?: { requestId?: string }): Promise<unknown> } };
  conversations: { mount(container: HTMLElement, target: KanbanConversationViewTarget, options?: KanbanConversationMountOptions): Promise<KanbanConversationMount>; snapshot(entryId: string, conversationId: string): Promise<unknown>;
    subscribe(target: { entryId: string; conversationId: string }, listener: (snapshot: unknown) => void, onError?: (error: Error) => void): () => void };
  getConfiguration(): KanbanInjectedConfiguration;
  getPresentation(): KanbanPresentation;
  getRuntimeLocale(): Promise<KanbanRuntimeLocale>;
  studio: { getLocalAnalysis(): Promise<unknown> };
  methods: KanbanBrowserMethodsApi;
}

export type KanbanRuntimeLocale = "zh-CN" | "en";

export type KanbanJsonValue =
  | null
  | boolean
  | number
  | string
  | KanbanJsonValue[]
  | { [key: string]: KanbanJsonValue };

export type KanbanBridgeOperation =
  | "entries.list"
  | "entries.workflow"
  | "conversations.openView"
  | "conversations.viewMessage"
  | "conversations.closeView"
  | "entries.runEntrypoint"
  | "conversations.snapshot"
  | "conversations.subscribe"
  | "conversations.unsubscribe"
  | "runtime.getLocale"
  | "studio.getLocalAnalysis"
  | "files.readFile";

export interface KanbanBridgeCall {
  requestId: string;
  operation: KanbanBridgeOperation;
  input: Record<string, unknown>;
}

export interface KanbanBridgeError {
  code: string;
  message: string;
}

const KANBAN_BRIDGE_SAFE_ERRORS = {
  ENTRY_RUNTIME_UNAVAILABLE: "Open this project in a local SteamHarness CLI or Studio execution host.",
  KANBAN_BRIDGE_INVALID_REQUEST: "The Kanban bridge request is invalid.",
  KANBAN_BRIDGE_BUSY: "Too many Kanban bridge requests are pending.",
  KANBAN_BRIDGE_TIMEOUT: "Kanban bridge request timed out.",
  KANBAN_BRIDGE_UNAVAILABLE: "Kanban project data is unavailable in this host.",
  KANBAN_BRIDGE_SESSION_INVALID: "The Kanban preview session is invalid or expired.",
  KANBAN_BRIDGE_SERVER_ERROR: "Kanban project data operation failed.",
  KANBAN_DATA_OPERATION_FAILED: "Kanban project data operation failed.",
  KANBAN_FILE_UNAVAILABLE: "Kanban file is unavailable in this project.",
  KANBAN_FILE_TOO_LARGE: "Kanban files cannot exceed 50 MiB.",
} as const;

const KANBAN_BRIDGE_CALL_FIELDS = new Set(["requestId", "operation", "input"]);
const KANBAN_BRIDGE_INPUT_FIELDS: Record<KanbanBridgeOperation, readonly string[]> = {
  "entries.list": [],
  "entries.workflow": ["entryId", "action", "entrypointId", "params", "requestId", "title", "runId", "page", "fileId", "offset", "limit", "from", "to", "at", "position", "direction"],
  "conversations.openView": ["entryId", "conversationId", "viewId", "documentId", "draft", "locale", "submit", "ui"],
  "conversations.viewMessage": ["viewId", "message"],
  "conversations.closeView": ["viewId"],
  "entries.runEntrypoint": ["entryId", "entrypointId", "args", "requestId"],
  "conversations.snapshot": ["entryId", "conversationId"],
  "conversations.subscribe": ["entryId", "conversationId", "subscriptionId"],
  "conversations.unsubscribe": ["subscriptionId"],
  "runtime.getLocale": [],
  "studio.getLocalAnalysis": [],
  "files.readFile": ["fileId"],
};

export interface KanbanProjectStructure {
  projectType: "kanban";
  name: string;
  artifactDir: string;
  entry: string;
  manifest?: KanbanManifest;
}

export interface KanbanArtifactConfig {
  artifactDir: string;
  entry: string;
}

export interface KanbanPreviewCapabilityRefreshFailure {
  expired: boolean;
}

export interface KanbanPreviewCapabilityRefreshOptions {
  expiresAt?: string;
  refresh: () => Promise<void> | void;
  onFailure?: (error: unknown, state: KanbanPreviewCapabilityRefreshFailure) => void;
  now?: () => number;
}

export function getKanbanPreviewCapabilityRefreshDelay(
  expiresAt: string | undefined,
  now = Date.now(),
): number | undefined {
  if (!expiresAt) return undefined;
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs)) return undefined;
  return Math.max(0, expiresAtMs - now - KANBAN_PREVIEW_CAPABILITY_REFRESH_LEAD_MS);
}

export function scheduleKanbanPreviewCapabilityRefresh(
  options: KanbanPreviewCapabilityRefreshOptions,
): () => void {
  const now = options.now ?? Date.now;
  const initialDelay = getKanbanPreviewCapabilityRefreshDelay(options.expiresAt, now());
  if (initialDelay === undefined) return () => undefined;

  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (delay: number) => {
    timer = setTimeout(() => void attempt(), delay);
  };
  const attempt = async () => {
    try {
      await options.refresh();
    } catch (error) {
      if (cancelled) return;
      // A transient renewal failure must retry before the existing
      // capability expires instead of leaving long-lived pages with dead assets.
      schedule(KANBAN_PREVIEW_CAPABILITY_RETRY_MS);
      options.onFailure?.(error, {
        expired: options.expiresAt !== undefined && Date.parse(options.expiresAt) <= now(),
      });
    }
  };

  schedule(initialDelay);
  return () => {
    cancelled = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}

/** Derive static artifact paths from a registered Kanban entry. */
export function readKanbanEntryConfig(entry: { type: string; entry: string }): KanbanArtifactConfig {
  if (entry.type !== "kanban" || !/\.html$/i.test(entry.entry) || entry.entry.includes("\\") || entry.entry.startsWith("/") || entry.entry.split("/").some(segment => !segment || segment === "." || segment === ".." || [".git","node_modules"].includes(segment.toLowerCase()))) throw new Error("A safe registered Kanban HTML entry is required.");
  const segments = entry.entry.split("/");
  const filename = segments.pop()!;
  return { artifactDir: segments.join("/") || ".", entry: filename };
}

export function createKanbanArtifactEntryPath(config: KanbanArtifactConfig): string {
  return config.artifactDir === KANBAN_ARTIFACT_DIR
    ? config.entry
    : `${config.artifactDir}/${config.entry}`;
}

export function encodeKanbanAssetUrlPath(filePath: string): string {
  return filePath.split("/").map((part) => encodeURIComponent(part)).join("/");
}

export function readKanbanAssetMimeType(filePath: string): string {
  const normalized = filePath.split(/[?#]/, 1)[0]?.toLowerCase() ?? "";
  const extension = normalized.includes(".") ? `.${normalized.split(".").at(-1)}` : "";
  switch (extension) {
    case ".html":
    case ".htm": return "text/html; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".js":
    case ".mjs": return "text/javascript; charset=utf-8";
    case ".json":
    case ".map": return "application/json; charset=utf-8";
    case ".webmanifest": return "application/manifest+json; charset=utf-8";
    case ".svg": return "image/svg+xml";
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    case ".avif": return "image/avif";
    case ".ico": return "image/x-icon";
    case ".woff": return "font/woff";
    case ".woff2": return "font/woff2";
    case ".ttf": return "font/ttf";
    case ".otf": return "font/otf";
    case ".eot": return "application/vnd.ms-fontobject";
    case ".wasm": return "application/wasm";
    case ".mp3": return "audio/mpeg";
    case ".ogg": return "audio/ogg";
    case ".wav": return "audio/wav";
    case ".mp4": return "video/mp4";
    case ".webm": return "video/webm";
    case ".txt": return "text/plain; charset=utf-8";
    case ".xml": return "application/xml; charset=utf-8";
    case ".pdf": return "application/pdf";
    default: return "application/octet-stream";
  }
}

export function createKanbanExecutionUnsupportedMessage(projectName: string): string {
  return `Kanban project "${projectName}" is a static HTML project and does not support workflow execution.`;
}

export function parseKanbanManifest(value: unknown): KanbanManifest {
  if (!isRecord(value)) {
    throw new Error("kanban.json root must be an object.");
  }
  if (value["version"] !== KANBAN_MANIFEST_VERSION) {
    throw new Error(`kanban.json version must be ${KANBAN_MANIFEST_VERSION}.`);
  }
  const rawParams = value["params"];
  if (!Array.isArray(rawParams)) {
    throw new Error("kanban.json params must be an array.");
  }

  const names = new Set<string>();
  const params = rawParams.map((param, index) => parseParam(param, index, names));
  return { version: KANBAN_MANIFEST_VERSION, params };
}

export function parseKanbanManifestText(content: string): KanbanManifest {
  try {
    return parseKanbanManifest(JSON.parse(content) as unknown);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("kanban.json must contain valid JSON.");
    }
    throw error;
  }
}

export function createEmptyKanbanManifest(): KanbanManifest {
  return { version: KANBAN_MANIFEST_VERSION, params: [] };
}

export function createDefaultKanbanValues(
  params: ParamDefinition[],
): KanbanConfigurationValues {
  return Object.fromEntries(params.map((param) => [param.name, param.defaultValue ?? ""]));
}

export function sanitizeKanbanValues(
  params: ParamDefinition[],
  values: Record<string, unknown>,
): KanbanConfigurationValues {
  const next: KanbanConfigurationValues = {};
  for (const param of params) {
    const value = values[param.name];
    next[param.name] = typeof value === "string" ? value : param.defaultValue ?? "";
  }
  return next;
}

export function areKanbanValuesEqual(
  left: Record<string, string>,
  right: Record<string, string>,
): boolean {
  const leftKeys = Object.keys(left);
  return leftKeys.length === Object.keys(right).length &&
    leftKeys.every((key) => left[key] === right[key]);
}

export function createInjectedKanbanParams(
  params: ParamDefinition[],
  values: KanbanConfigurationValues,
): Record<string, unknown> {
  return Object.fromEntries(params.map((param) => [
    param.name,
    parseInjectedValue(param, values[param.name] ?? param.defaultValue ?? ""),
  ]));
}

export function createKanbanBridgeScript(
  configuration: KanbanInjectedConfiguration,
  nonce: string,
): string {
  const initial = JSON.stringify(configuration).replaceAll("<", "\\u003c");
  const safeNonce = JSON.stringify(nonce);
  const eventName = JSON.stringify(KANBAN_CONFIGURATION_CHANGE_EVENT);
  const readyMessage = JSON.stringify(KANBAN_PREVIEW_READY_MESSAGE);
  const requestMessage = JSON.stringify(KANBAN_BRIDGE_REQUEST_MESSAGE);
  const responseMessage = JSON.stringify(KANBAN_BRIDGE_RESPONSE_MESSAGE);
  const presentationMessage = JSON.stringify(KANBAN_PRESENTATION_MESSAGE);
  const presentationEvent = JSON.stringify(KANBAN_PRESENTATION_CHANGE_EVENT);
  const safeErrorMessages = JSON.stringify(KANBAN_BRIDGE_SAFE_ERRORS);
  return `<script nonce=${safeNonce}>(function(){
let current=${initial};
let presentation={mode:"fullscreen"};
let keyboardHost=false,editHost=false;
(${installProjectKeyboardBridge.toString()})(window,()=>keyboardHost,event=>window.parent.postMessage({type:"steamharness:kanban-keyboard",version:1,nonce:${safeNonce},event},"*"));
window.addEventListener("message",event=>{
  if(event.source===window.parent&&event.data?.nonce===${safeNonce}&&event.data.type==="steamharness:kanban-keyboard-host")keyboardHost=event.data.version===1&&event.data.enabled===true;
});
let sequence=0;
const safeErrorMessages=${safeErrorMessages};
const pending=new Map();
const conversationListeners=new Map();
const conversationViews=new Map();
const copyRequests=new Map();
let contextConversation;
window.document?.addEventListener("pointerdown",()=>{contextConversation=undefined;},true);
const copyText=text=>{
  if(typeof text!=="string"||text.length>1000000||copyRequests.size>=16)return Promise.resolve(false);
  const requestId="copy-"+Date.now().toString(36)+"-"+(++sequence);
  return new Promise(resolve=>{
    const timer=window.setTimeout(()=>{copyRequests.delete(requestId);resolve(false);},10000);
    copyRequests.set(requestId,{resolve,timer});
    window.parent.postMessage({type:"steamharness:kanban-copy",version:1,nonce:${safeNonce},requestId,text},"*");
  });
};
const contextMenu=(value,sourceFrame)=>{
  if(!editHost)return;
  const rect=sourceFrame?.getBoundingClientRect();
  window.parent.postMessage({type:"steamharness:kanban-contextmenu",version:1,nonce:${safeNonce},...value,
    x:rect?rect.left+value.x*rect.width/(sourceFrame.clientWidth||rect.width||1):value.x,
    y:rect?rect.top+value.y*rect.height/(sourceFrame.clientHeight||rect.height||1):value.y},"*");
};
const copyBridge=window.document?.addEventListener?(${installProjectCopyBridge.toString()})(window,{enabled:()=>editHost,writeText:copyText,
  contextMenu:value=>{contextConversation=undefined;contextMenu(value);},
  delegate:(command,restoreFocus,clipboardData)=>{
    const contextual=restoreFocus&&contextConversation;
    const view=[...conversationViews.values()].find(view=>view.frame===document.activeElement)||(contextual?conversationViews.get(contextConversation):undefined);
    contextConversation=undefined;
    if(!view)return !!contextual;view.deliver({type:"conversation-edit",command,restoreFocus,clipboardData});return true;
  }}):{command:()=>false,dispose:()=>{}};
const clearConversations=()=>{for(const stop of [...conversationListeners.values()].map(value=>value.stop))stop();for(const view of [...conversationViews.values()])view.stop();};
const clone=()=>JSON.parse(JSON.stringify(current));
const createError=(message,code)=>{const error=new Error(message);if(code)Object.defineProperty(error,"code",{value:code,enumerable:true});return error;};
const invalidRequest=()=>createError("The Kanban bridge request is invalid.","KANBAN_BRIDGE_INVALID_REQUEST");
const isSafeErrorCode=(code)=>typeof code==="string"&&Object.prototype.hasOwnProperty.call(safeErrorMessages,code);
const isJsonValue=(value,seen=new Set())=>{
  if(value===null||typeof value==="string"||typeof value==="boolean")return true;
  if(typeof value==="number")return Number.isFinite(value);
  if(typeof value!=="object"||seen.has(value))return false;
  seen.add(value);
  let valid=false;
  try{valid=Array.isArray(value)?value.every((item)=>isJsonValue(item,seen)):Object.getPrototypeOf(value)===Object.prototype&&Object.values(value).every((item)=>isJsonValue(item,seen));}
  catch{return false;}
  finally{seen.delete(value);}
  return valid;
};
const ready=()=>{window.parent.postMessage({type:${readyMessage},nonce:${safeNonce},documentId:methodDocumentId},"*");publishKanbanMethods();};
const request=(operation,input)=>{
  input=Object.fromEntries(Object.entries(input).filter(([,value])=>value!==undefined));
  if(!isJsonValue(input))return Promise.reject(invalidRequest());
  if(pending.size>=${KANBAN_BRIDGE_MAX_PENDING_REQUESTS})return Promise.reject(createError("Too many Kanban bridge requests are pending.","KANBAN_BRIDGE_BUSY"));
  const requestId=Date.now().toString(36)+"-"+(++sequence).toString(36);
  return new Promise((resolve,reject)=>{
    const timeout=window.setTimeout(()=>{pending.delete(requestId);reject(createError("Kanban bridge request timed out.","KANBAN_BRIDGE_TIMEOUT"));},operation.startsWith("files.")?${KANBAN_FILE_BRIDGE_REQUEST_TIMEOUT_MS}:(operation==="entries.runEntrypoint"||operation==="conversations.viewMessage")?${KANBAN_ENTRY_BRIDGE_REQUEST_TIMEOUT_MS}:${KANBAN_BRIDGE_REQUEST_TIMEOUT_MS});
    pending.set(requestId,{resolve,reject,timeout});
    try{window.parent.postMessage({type:${requestMessage},nonce:${safeNonce},requestId,operation,input},"*");}
    catch{window.clearTimeout(timeout);pending.delete(requestId);reject(invalidRequest());}
  });
};
${createKanbanMethodsBridgeScript(nonce)}
const entries=Object.freeze({list:()=>request("entries.list",{}),get:(entryId)=>Object.freeze({runEntrypoint:(entrypointId,args=[],options={})=>request("entries.runEntrypoint",{entryId,entrypointId,args,requestId:options.requestId||Date.now().toString(36)+"-operation-"+(++sequence)})})});
const workflows=Object.freeze({get:(entryId)=>Object.freeze({
 list:(options={})=>request("entries.workflow",{...options,entryId,action:"list"}),
 start:(input)=>request("entries.workflow",{...input,entryId,action:"start"}),
 page:(runId,options={})=>request("entries.workflow",{...options,entryId,runId,action:"page"}),
 timeline:(runId,options={})=>request("entries.workflow",{...options,entryId,runId,action:"timeline"}),
 stop:(runId)=>request("entries.workflow",{entryId,runId,action:"stop"}),
 readImage:async(runId,fileId)=>{const file=await request("entries.workflow",{entryId,runId,fileId,action:"file"});const bytes=Uint8Array.from(atob(file.base64),value=>value.charCodeAt(0));return {mimeType:file.mimeType,buffer:bytes.buffer};}
})});
const conversations=Object.freeze({mount:async(container,target,options={})=>{
  if(!(container instanceof HTMLElement))throw invalidRequest();
  target=JSON.parse(JSON.stringify(target));
  const viewId="view-"+Date.now().toString(36)+"-"+(++sequence),frame=document.createElement("iframe");
  frame.title=(target.locale||document.documentElement.lang)==="zh-CN"?"对话":"Conversation";frame.setAttribute("sandbox","allow-scripts");frame.style.cssText="width:100%;height:100%;border:0;display:block";
  const shell=document.createElement("div"),composer=document.createElement("div"),slots=options.slots||{};
  shell.dataset.conversationShell="";shell.style.cssText="display:flex;flex-direction:column;min-height:0;height:100%;position:relative";
  composer.style.cssText="position:relative;flex:none;min-height:0";
  let composerHeight=150,menuHeight=0;
  const layout=()=>{const custom=target.ui?.presentation==="composer";shell.dataset.presentation=custom?"composer":"conversation";
    if(slots.transcript)slots.transcript.hidden=!custom;
    composer.style.flex=custom?"none":"1";composer.style.height=custom?Math.min(composerHeight,container.clientHeight||composerHeight)+"px":"";
    frame.style.position=custom?"absolute":"static";frame.style.bottom=custom?"0":"";frame.style.zIndex=custom?"2":"";
    frame.style.height=custom?Math.min(composerHeight+menuHeight,container.clientHeight||composerHeight+menuHeight)+"px":"100%";};
  let closed=false,loaded=false;const backlog=[],submissions=new Map();
  const announce=event=>Promise.resolve().then(()=>{if(!closed)options.onSubmission?.(event);}).catch(()=>{});
  const forward=message=>{if(loaded)frame.contentWindow?.postMessage({type:"steamharness:conversation-message",viewId,message},"*");else backlog.push(message);};
  const deliver=message=>{if(closed)return;
    const pending=submissions.get(message.requestId);
    if(message.type==="sent"&&message.requestId&&message.receiptId){
      if(pending){announce({...pending,phase:"accepted",receiptId:message.receiptId,result:message.submissionResult});submissions.delete(message.requestId);}
      Promise.resolve().then(()=>{if(!closed)options.onSubmitted?.({requestId:message.requestId,receiptId:message.receiptId});}).catch(()=>{});
    }else if(message.type==="error"&&message.requestType==="send"&&pending){announce({...pending,phase:"failed",error:message.message});submissions.delete(message.requestId);}
    forward(message);
  };
  const receive=event=>{
    if(closed||event.source!==frame.contentWindow||event.data?.viewId!==viewId||event.data.type!=="steamharness:conversation-request")return;
    if(event.data.message?.type==="view-ready"){loaded=true;for(const message of backlog.splice(0))forward(message);return;}
    if(event.data.message?.type==="view-layout"){const height=event.data.message.composerHeight,menu=event.data.message.menuHeight;
      if(Number.isFinite(height)&&height>=40&&height<=2000&&Number.isFinite(menu)&&menu>=0&&menu<=360){composerHeight=height;menuHeight=menu;layout();}return;}
    if(event.data.message?.type==="copy"){
      const message=event.data.message;
      if(typeof message.requestId==="string"&&message.requestId.length<=128&&typeof message.text==="string")void copyText(message.text).then(ok=>deliver({type:"conversation-copy-result",requestId:message.requestId,ok}));
      return;
    }
    if(event.data.message?.type==="view-contextmenu"){
      const value=event.data.message;
      if(editHost&&Number.isFinite(value.x)&&Number.isFinite(value.y)&&typeof value.editable==="boolean"&&typeof value.selection==="boolean"){
        contextConversation=viewId;contextMenu({x:value.x,y:value.y,editable:value.editable,selection:value.selection},frame);
      }return;
    }
    if(event.data.message?.type==="view-message-card-action"){
      const {id,requestId}=event.data.message;
      const card=()=>target.ui?.messageCards?.find(card=>card.id===id&&card.requestId===requestId&&card.action);
      if(typeof id==="string"&&typeof requestId==="string"&&card())Promise.resolve().then(()=>{if(!closed&&card())return options.onMessageCardAction?.({id,requestId});}).catch(()=>{});
      return;
    }
    const message=JSON.parse(JSON.stringify(event.data.message));
    if(message?.type==="send"&&typeof message.requestId==="string"&&typeof message.text==="string"){
      const pending={requestId:message.requestId,text:message.text,createdAt:Date.now()};submissions.set(message.requestId,pending);announce({...pending,phase:"sending"});
    }
    request("conversations.viewMessage",{viewId,message}).then(messages=>{for(const reply of messages||[])deliver(reply);}).catch(error=>deliver({type:"error",silent:error.code==="KANBAN_BRIDGE_UNAVAILABLE",connectionError:error.code==="KANBAN_BRIDGE_UNAVAILABLE",requestType:message?.type,requestId:message?.requestId,sessionId:target.conversationId,projectUri:message?.projectUri,errorScope:message?.errorScope,message:error.message}));
  };
  const theme=()=>deliver({type:"conversation-theme",theme:document.documentElement.dataset.theme||"light"});
  const resize=typeof ResizeObserver==="function"?new ResizeObserver(layout):undefined;
  const stop=()=>{if(closed)return;closed=true;resize?.disconnect();conversationViews.delete(viewId);window.removeEventListener("message",receive);window.removeEventListener("steamharness:kanban-theme-change",theme);shell.remove();request("conversations.closeView",{viewId}).catch(()=>{});};
  stop.retry=requestId=>{if(!closed&&typeof requestId==="string")forward({type:"conversation-retry",requestId});};
  let updating=Promise.resolve();stop.update=ui=>updating=updating.catch(()=>{}).then(async()=>{if(closed)return;const messages=await request("conversations.viewMessage",{viewId,message:{type:"view-ui",ui}});if(closed)return;target.ui=JSON.parse(JSON.stringify(ui));layout();for(const message of messages||[])deliver(message);});
  const open=()=>request("conversations.openView",{locale:document.documentElement.lang==="zh-CN"?"zh-CN":"en",...target,viewId,documentId:methodDocumentId});
  const reconnect=async()=>{try{return await request("conversations.viewMessage",{viewId,message:{type:"ready"}});}catch(error){if(closed||error.code!=="KANBAN_BRIDGE_SESSION_INVALID")throw error;await open();if(closed){request("conversations.closeView",{viewId}).catch(()=>{});return [];}return request("conversations.viewMessage",{viewId,message:{type:"ready"}});}};
  conversationViews.set(viewId,{deliver,stop,reconnect,frame});window.addEventListener("message",receive);window.addEventListener("steamharness:kanban-theme-change",theme);
  try{
    const result=await open();
    if(closed)return stop;
    delete target.draft;
    frame.srcdoc=result.html.replaceAll("__STEAMHARNESS_KANBAN_NONCE__",${safeNonce});
    for(const name of ["header","transcript"]){if(slots[name] instanceof HTMLElement){slots[name].dataset.conversationSlot=name;if(name==="transcript")slots[name].style.cssText+=";flex:1;min-height:0;overflow:hidden";shell.append(slots[name]);}}
    composer.append(frame);shell.append(composer);if(slots.footer instanceof HTMLElement){slots.footer.dataset.conversationSlot="footer";shell.append(slots.footer);}container.append(shell);layout();resize?.observe(container);theme();deliver({type:"conversation-edit-host",enabled:editHost});
    return stop;
  }catch(error){stop();throw error;}
},snapshot:(entryId,conversationId)=>request("conversations.snapshot",{entryId,conversationId}),subscribe:(target,listener,onError)=>{
  if(typeof listener!=="function")throw invalidRequest();
  const subscriptionId="conversation-"+Date.now().toString(36)+"-"+(++sequence);
  let closed=false;
  const stop=()=>{if(closed)return;closed=true;conversationListeners.delete(subscriptionId);request("conversations.unsubscribe",{subscriptionId}).catch(()=>{});};
  const reconnect=()=>request("conversations.subscribe",{entryId:target.entryId,conversationId:target.conversationId,subscriptionId}).catch(error=>{if(!closed&&typeof onError==="function")onError(error);});
  conversationListeners.set(subscriptionId,{listener,stop,reconnect,entryId:target.entryId,conversationId:target.conversationId});
  reconnect();
  return stop;
}});
window.addEventListener("pagehide",clearConversations);
window.addEventListener("pagehide",()=>{copyBridge.dispose();for(const item of copyRequests.values()){window.clearTimeout(item.timer);item.resolve(false);}copyRequests.clear();});
Object.defineProperty(window,"steamHarnessKanban",{configurable:false,enumerable:true,value:Object.freeze({entries,workflows,conversations,getConfiguration:clone,getPresentation:()=>({...presentation}),getRuntimeLocale:()=>request("runtime.getLocale",{}),studio:Object.freeze({getLocalAnalysis:()=>request("studio.getLocalAnalysis",{})}),methods})});
window.addEventListener("message",function(event){
  if(event.source!==window.parent||!event.data||event.data.nonce!==${safeNonce})return;
  if(event.data.type==="steamharness:kanban-edit-host"&&event.data.version===1){editHost=event.data.enabled===true;for(const view of conversationViews.values())view.deliver({type:"conversation-edit-host",enabled:editHost});return;}
  if(event.data.type==="steamharness:kanban-edit-command"&&["copy","cut","paste","selectAll","undo","redo"].includes(event.data.command)){copyBridge.command(event.data.command,event.data.restoreFocus===true,event.data.clipboardData);return;}
  if(event.data.type==="steamharness:kanban-copy-result"&&event.data.version===1){const item=copyRequests.get(event.data.requestId);if(item){copyRequests.delete(event.data.requestId);window.clearTimeout(item.timer);item.resolve(event.data.ok===true);}return;}
  if(handleKanbanMethodMessage(event.data))return;
  if(event.data.type==="steamharness:kanban-conversation-view-connection"){
    window.dispatchEvent(new CustomEvent("steamharness:kanban-connection-change",{detail:{status:event.data.status}}));
    for(const view of conversationViews.values()){view.deliver({type:"connection",status:event.data.status==="connected"?"reconnecting":event.data.status});if(event.data.status==="connected")view.reconnect().then(messages=>{for(const message of messages||[])view.deliver(message);}).catch(error=>view.deliver({type:"error",message:error.message}));}
    if(event.data.status==="connected")for(const listener of conversationListeners.values())listener.reconnect();return;
  }
  if(event.data.type==="steamharness:kanban-conversation-view"){
    const view=conversationViews.get(event.data.viewId);if(view)for(const message of event.data.messages||[])view.deliver(message);return;
  }
  if(event.data.type==="steamharness:kanban-conversation"){
    const target=conversationListeners.get(event.data.subscriptionId);
    if(target&&event.data.snapshot?.entryId===target.entryId&&event.data.snapshot?.conversationId===target.conversationId)Promise.resolve().then(()=>{if(conversationListeners.get(event.data.subscriptionId)===target)target.listener(event.data.snapshot);}).catch(()=>{});
    return;
  }
  if(event.data.type===${presentationMessage}){
    const mode=event.data.presentation?.mode;
    if(!["fullscreen","phone","tablet","card"].includes(mode)||presentation.mode===mode)return;
    presentation={mode};
    window.dispatchEvent(new CustomEvent(${presentationEvent},{detail:{...presentation}}));
    return;
  }
  if(event.data.type==="steamharness:kanban-configuration"){
    // Hosts resend configuration after ready; identical snapshots must not acknowledge each other forever.
    if(JSON.stringify(event.data.configuration)===JSON.stringify(current))return;
    if(event.data.configuration?.id!==current.id){resetKanbanMethods();clearConversations();}
    current=event.data.configuration;
    window.dispatchEvent(new CustomEvent(${eventName},{detail:clone()}));
    ready();
    return;
  }
  if(event.data.type!==${responseMessage}||typeof event.data.requestId!=="string")return;
  const entry=pending.get(event.data.requestId);
  if(!entry)return;
  pending.delete(event.data.requestId);
  window.clearTimeout(entry.timeout);
  if(event.data.ok===true)entry.resolve(event.data.value);
  else{const code=event.data.error?.code;const safe=isSafeErrorCode(code);entry.reject(createError(safe?safeErrorMessages[code]:"Kanban bridge request failed.",safe?code:"KANBAN_BRIDGE_ERROR"));}
});
if(document.readyState==="loading")window.addEventListener("DOMContentLoaded",ready,{once:true});else ready();
})();</script>`;
}

export function parseKanbanBridgeCall(value: unknown): KanbanBridgeCall {
  if (!isRecord(value)) throw new Error("Kanban bridge request must be an object.");
  if (Object.keys(value).some((key) => !KANBAN_BRIDGE_CALL_FIELDS.has(key))) {
    throw new Error("Kanban bridge request contains unsupported fields.");
  }
  const requestId = readNonEmptyString(value["requestId"], "bridge.requestId");
  const operation = value["operation"];
  if (!isKanbanBridgeOperation(operation)) {
    throw new Error(`Unsupported Kanban bridge operation "${String(operation)}".`);
  }
  const input = value["input"];
  if (!isRecord(input)) throw new Error("Kanban bridge input must be an object.");
  validateKanbanBridgeInput(operation, input);
  return { requestId, operation, input };
}

export function createKanbanBridgeError(reason: unknown): KanbanBridgeError {
  const seen = new Set<unknown>(), causes = [reason];
  while (causes.length && seen.size < 10) {
    const cause = causes.shift();
    if (!isRecord(cause) || seen.has(cause)) continue;
    seen.add(cause);
    const code = cause["code"];
    if (
      typeof code === "string" &&
      Object.prototype.hasOwnProperty.call(KANBAN_BRIDGE_SAFE_ERRORS, code)
    ) {
      return {
        code,
        message: KANBAN_BRIDGE_SAFE_ERRORS[code as keyof typeof KANBAN_BRIDGE_SAFE_ERRORS],
      };
    }
    causes.push(cause["cause"], cause["safeCause"]);
  }
  return {
    code: "KANBAN_BRIDGE_ERROR",
    message: "Kanban bridge request failed.",
  };
}

export function isKanbanJsonValue(value: unknown, seen = new Set<object>()): value is KanbanJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => isKanbanJsonValue(item, seen))
    : Object.getPrototypeOf(value) === Object.prototype &&
      Object.values(value as Record<string, unknown>).every((item) => isKanbanJsonValue(item, seen));
  seen.delete(value);
  return valid;
}

export function injectKanbanBridge(
  html: string,
  configuration: KanbanInjectedConfiguration,
  nonce: string,
): string {
  const bridge = createKanbanBridgeScript(configuration, nonce);
  const htmlWithNoncedScripts = html.replace(/<script\b([^>]*)>/gi, (tag, attributes: string) => {
    if (/\bsrc\s*=/.test(attributes)) return tag;
    const withoutNonce = attributes.replace(/\s+nonce\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
    return `<script nonce=${JSON.stringify(nonce)}${withoutNonce}>`;
  });
  const headMatch = /<head(?:\s[^>]*)?>/i.exec(htmlWithNoncedScripts);
  if (headMatch?.index !== undefined) {
    const index = headMatch.index + headMatch[0].length;
    return `${htmlWithNoncedScripts.slice(0, index)}${bridge}${htmlWithNoncedScripts.slice(index)}`;
  }
  return `${bridge}${htmlWithNoncedScripts}`;
}

export function createKanbanContentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'self' data: blob:",
    `script-src 'self' 'nonce-${nonce}' 'wasm-unsafe-eval'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "media-src 'self' data: blob:",
    "connect-src 'self' data: blob:",
    "object-src 'none'",
    "base-uri 'self'",
  ].join("; ");
}

export function isSafeKanbanAssetPath(filePath: string): boolean {
  const normalized = filePath.replaceAll("\\", "/");
  if (normalized === "" || normalized.startsWith("/") || normalized.includes("\0")) return false;
  const parts = normalized.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return false;
  const lowerParts = parts.map((part) => part.toLowerCase());
  if (lowerParts.some((part) => (
    part.startsWith(".") ||
    part === "node_modules" ||
    part === "package.json" ||
    part === "steamharness.json" ||
    part === "steamharness.release.json" ||
    part === "structure.json" ||
    part === "kanban.json" ||
    part === "configuration.json" ||
    part === "configuration.template.json" ||
    part === "configuration-templates" ||
    part === "package-lock.json" ||
    part === "pnpm-lock.yaml" ||
    part === "yarn.lock" ||
    part === "readme.md"
  ))) return false;
  return true;
}

export function isSafeKanbanPublicAssetPath(
  filePath: string,
  entry: string = KANBAN_ENTRY_FILE,
): boolean {
  const normalized = filePath.replaceAll("\\", "/");
  return normalized === entry || isSafeKanbanAssetPath(normalized);
}

function parseParam(
  value: unknown,
  index: number,
  names: Set<string>,
): KanbanParamDefinition {
  if (!isRecord(value)) throw new Error(`kanban.json params[${index}] must be an object.`);
  const name = readNonEmptyString(value["name"], `params[${index}].name`);
  if (names.has(name)) throw new Error(`kanban.json contains duplicate param name "${name}".`);
  names.add(name);

  const type = value["type"];
  if (!isParamType(type)) throw new Error(`kanban.json params[${index}].type is unsupported.`);
  const control = value["control"];
  if (control !== undefined && !isParamControl(control)) {
    throw new Error(`kanban.json params[${index}].control is unsupported.`);
  }
  const panel = value["panel"];
  if (panel !== undefined && panel !== "main" && panel !== "auxiliary" && panel !== "quick") {
    throw new Error(`kanban.json params[${index}].panel is unsupported.`);
  }
  const options = value["options"];
  if (options !== undefined && !Array.isArray(options)) {
    throw new Error(`kanban.json params[${index}].options must be an array.`);
  }

  return {
    name,
    type,
    ...(readOptionalString(value["flag"]) === undefined ? {} : { flag: readOptionalString(value["flag"]) }),
    ...(readOptionalString(value["shortFlag"]) === undefined ? {} : { shortFlag: readOptionalString(value["shortFlag"]) }),
    ...(typeof value["required"] === "boolean" ? { required: value["required"] } : {}),
    ...(readOptionalString(value["label"]) === undefined ? {} : { label: readOptionalString(value["label"]) }),
    ...(readOptionalString(value["description"]) === undefined ? {} : { description: readOptionalString(value["description"]) }),
    ...(typeof value["defaultValue"] === "string" ? { defaultValue: value["defaultValue"] } : {}),
    ...(typeof value["multiple"] === "boolean" ? { multiple: value["multiple"] } : {}),
    ...(control === undefined ? {} : { control }),
    ...(panel === undefined ? {} : { panel }),
    ...(typeof value["resolveOnInput"] === "boolean" ? { resolveOnInput: value["resolveOnInput"] } : {}),
    ...(options === undefined ? {} : { options: options.map((option, optionIndex) => parseOption(option, index, optionIndex)) }),
    ...(Array.isArray(value["accept"]) && value["accept"].every((item) => typeof item === "string")
      ? { accept: value["accept"] as string[] }
      : {}),
    ...(value["format"] === "json" ? { format: "json" as const } : {}),
  };
}

function validateKanbanBridgeInput(
  operation: KanbanBridgeOperation,
  input: Record<string, unknown>,
): void {
  const allowedFields = new Set(KANBAN_BRIDGE_INPUT_FIELDS[operation]);
  if (Object.keys(input).some((key) => !allowedFields.has(key))) {
    throw new Error(`Kanban bridge ${operation} input contains unsupported fields.`);
  }
  switch (operation) {
    case "entries.workflow": validateWorkflowCall(input); return;
    case "entries.list": return;
    case "conversations.openView":
    case "conversations.viewMessage":
    case "conversations.closeView": {
      if (JSON.stringify(input).length > 262_144) throw new Error("Conversation view request is too large.");
      if (!/^[a-zA-Z0-9_-]{1,100}$/.test(readNonEmptyString(input.viewId, "viewId"))) throw new Error("Invalid view identity.");
      if (operation === "conversations.openView") {
        if (input.documentId !== undefined && (typeof input.documentId !== "string" || input.documentId.length > 200)) throw new Error("Invalid view document.");
        if (typeof input.entryId !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(input.entryId)) throw new Error("Invalid target entry.");
        if (readNonEmptyString(input.conversationId, "conversationId").length > 200) throw new Error("Invalid conversation identity.");
        if (input.locale !== undefined && input.locale !== "zh-CN" && input.locale !== "en") throw new Error("Invalid view locale.");
        if (input.draft !== undefined && (typeof input.draft !== "string" || input.draft.length > 100_000)) throw new Error("Invalid conversation draft.");
        if (input.ui !== undefined) assertConversationUi(input.ui);
        if (input.submit !== undefined && (!isRecord(input.submit) || Object.keys(input.submit).some(key => !["entryId", "entrypointId", "payload"].includes(key)) || typeof input.submit.entryId !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(input.submit.entryId) || typeof input.submit.entrypointId !== "string" || !/^[a-zA-Z][a-zA-Z0-9_.-]{0,99}$/.test(input.submit.entrypointId) || !isRecord(input.submit.payload) || !isKanbanJsonValue(input.submit.payload))) throw new Error("Invalid Workflow submission adapter.");
      } else if (operation === "conversations.viewMessage" && (!isRecord(input.message) || !isKanbanJsonValue(input.message))) throw new Error("Invalid conversation message.");
      return;
    }
    case "entries.runEntrypoint":
    case "conversations.snapshot":
    case "conversations.subscribe":
    case "conversations.unsubscribe": {
      if (JSON.stringify(input).length > 262_144) throw new Error('Entry request is too large.');
      if (operation !== 'conversations.unsubscribe' && (typeof input.entryId !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(input.entryId))) throw new Error('Invalid target entry.');
      if (operation === 'entries.runEntrypoint') {
        if (typeof input.entrypointId !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_.-]{0,99}$/.test(input.entrypointId)) throw new Error('Invalid Workflow operation.');
        if (!Array.isArray(input.args) || input.args.length > 256 || !input.args.every(arg => typeof arg === 'string')) throw new Error('Invalid Workflow arguments.');
        if (readNonEmptyString(input.requestId, 'requestId').length > 200) throw new Error('Invalid operation requestId.');
      } else {
        if (operation !== 'conversations.unsubscribe' && readNonEmptyString(input.conversationId, 'conversationId').length > 200) throw new Error('Invalid conversation ID.');
        if (operation !== 'conversations.snapshot' && readNonEmptyString(input.subscriptionId, 'subscriptionId').length > 100) throw new Error('Invalid subscription ID.');
      }
      return;
    }
    case "runtime.getLocale":
    case "studio.getLocalAnalysis":
      return;
    case "files.readFile":
      if (!/^(?:wf_[a-f0-9]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.test(readNonEmptyString(input["fileId"], "bridge.input.fileId"))) {
        throw new Error("Kanban file id is invalid.");
      }
      return;
  }
}

function isKanbanBridgeOperation(value: unknown): value is KanbanBridgeOperation {
  return value === 'entries.workflow' || value === 'entries.list' || value === 'conversations.openView' || value === 'conversations.viewMessage' || value === 'conversations.closeView' || value === 'entries.runEntrypoint' || value === 'conversations.snapshot' || value === 'conversations.subscribe' || value === 'conversations.unsubscribe' || value === "runtime.getLocale" ||
    value === "studio.getLocalAnalysis" ||
    value === "files.readFile";
}

function parseOption(value: unknown, paramIndex: number, optionIndex: number) {
  if (!isRecord(value)) {
    throw new Error(`kanban.json params[${paramIndex}].options[${optionIndex}] must be an object.`);
  }
  return {
    value: readNonEmptyString(value["value"], `params[${paramIndex}].options[${optionIndex}].value`),
    ...(readOptionalString(value["label"]) === undefined ? {} : { label: readOptionalString(value["label"]) }),
    ...(readOptionalString(value["description"]) === undefined ? {} : { description: readOptionalString(value["description"]) }),
  };
}

function parseInjectedValue(param: ParamDefinition, value: string): unknown {
  if (param.type === "file") {
    try {
      const parsed = JSON.parse(value) as unknown;
      const values = Array.isArray(parsed) ? parsed : [parsed];
      return values
        .map(sanitizeInjectedFileReference)
        .filter((file): file is NonNullable<typeof file> => file !== null);
    } catch {
      return [];
    }
  }
  if (param.control === "checkboxes" || param.multiple) {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
    } catch {
      return [];
    }
  }
  if (param.type === "number") {
    const parsed = Number(value);
    return value.trim() !== "" && Number.isFinite(parsed) ? parsed : null;
  }
  if (param.type === "boolean") return value === "true";
  return value;
}

function sanitizeInjectedFileReference(value: unknown) {
  if (
    !isRecord(value) ||
    typeof value["id"] !== "string" ||
    value["id"].trim() === "" ||
    (value["storage"] !== "local" && value["storage"] !== "server")
  ) {
    return null;
  }
  const mimeType = typeof value["mimeType"] === "string"
    ? value["mimeType"]
    : "application/octet-stream";
  return {
    id: value["id"],
    name: typeof value["name"] === "string" ? value["name"] : value["id"],
    mimeType,
    size: typeof value["size"] === "number" && Number.isFinite(value["size"])
      ? Math.max(0, value["size"])
      : 0,
    kind: value["kind"] === "image" || mimeType.startsWith("image/") ? "image" as const : "file" as const,
    storage: value["storage"],
    ...(typeof value["projectId"] === "string" ? { projectId: value["projectId"] } : {}),
    ...(typeof value["conversationId"] === "string" ? { conversationId: value["conversationId"] } : {}),
    ...(typeof value["createdAt"] === "string" ? { createdAt: value["createdAt"] } : {}),
  };
}

function readNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`kanban.json ${field} must be a non-empty string.`);
  return value.trim();
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function isParamType(value: unknown): value is ParamDefinition["type"] {
  return value === "string" || value === "number" || value === "boolean" || value === "positional" || value === "file";
}

function isParamControl(value: unknown): value is KanbanParamControl {
  return value === "text" || value === "textarea" || value === "radio" || value === "select" || value === "checkboxes";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
