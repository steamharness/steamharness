import type { WorkflowParamDefinition } from "./run-workspace/types";
import { createKanbanMethodsBridgeScript, type KanbanBrowserMethodsApi } from "./methods";
import {
  WORKFLOW_RELATED_PROJECT_ALIAS_PATTERN,
  WORKFLOW_RELATED_PROJECT_KEY_LIMIT,
  type WorkflowRelatedProject,
} from "../project-info/index";

export * from "./revision-stream";
export * from "./methods";


export const KANBAN_MANIFEST_FILE = "kanban.json";
export const KANBAN_ENTRY_FILE = "index.html";
export const KANBAN_ARTIFACT_DIR = ".";
export const KANBAN_MANIFEST_VERSION = 1;
export const KANBAN_CONFIGURATION_CHANGE_EVENT = "workflow-code:kanban-configuration-change";
export const KANBAN_PRESENTATION_CHANGE_EVENT = "workflow-code:kanban-presentation-change";
export const KANBAN_PRESENTATION_MESSAGE = "workflow-code:kanban-presentation";
export const KANBAN_PREVIEW_READY_MESSAGE = "workflow-code:kanban-ready";
export const KANBAN_BRIDGE_REQUEST_MESSAGE = "workflow-code:kanban-bridge-request";
export const KANBAN_BRIDGE_RESPONSE_MESSAGE = "workflow-code:kanban-bridge-response";
export const KANBAN_RELATED_PROJECT_REVISION_MESSAGE = "workflow-code:kanban-related-project-revision";
export const KANBAN_BRIDGE_REQUEST_TIMEOUT_MS = 15_000;
export const KANBAN_FILE_BRIDGE_REQUEST_TIMEOUT_MS = 120_000;
export const KANBAN_FILE_MAX_BYTES = 50 * 1024 * 1024;
export const KANBAN_BRIDGE_MAX_PENDING_REQUESTS = 16;
export const KANBAN_PREVIEW_CAPABILITY_REFRESH_LEAD_MS = 60_000;
export const KANBAN_PREVIEW_CAPABILITY_RETRY_MS = 15_000;

export type KanbanParamControl = "text" | "textarea" | "radio" | "select" | "checkboxes";

export interface KanbanParamDefinition extends Omit<WorkflowParamDefinition, "control"> {
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

export interface KanbanBrowserRelatedProjectKvApi {
  getValue(key: string): Promise<unknown>;
  setValue(key: string, value: KanbanJsonValue): Promise<void>;
  subscribe(
    listener: (event: KanbanRelatedProjectRevision) => void,
  ): () => void;
}

export interface KanbanRelatedProjectRevision {
  alias: string;
  revision: string;
}

export interface KanbanFileReference {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind: "image" | "file";
  storage: "server";
  workflowId?: string;
  createdAt: string;
  url?: string;
}

export interface KanbanBrowserApi {
  getConfiguration(): KanbanInjectedConfiguration;
  getPresentation(): KanbanPresentation;
  getRuntimeLocale(): Promise<KanbanRuntimeLocale>;
  studio: { getLocalAnalysis(): Promise<unknown> };
  methods: KanbanBrowserMethodsApi;
  kv: {
    getValue(key: string): Promise<unknown>;
    setValue(key: string, value: KanbanJsonValue): Promise<void>;
  };
  files: {
    createFile(input: {
      name: string;
      mimeType?: string;
      buffer: Blob | ArrayBuffer | Uint8Array;
    }): Promise<KanbanFileReference>;
    readFile(fileId: string): Promise<{ file: KanbanFileReference; buffer: ArrayBuffer }>;
    deleteFile(fileId: string): Promise<boolean>;
  };
  relatedProjects: {
    get(alias: string): {
      kv: KanbanBrowserRelatedProjectKvApi;
    };
  };
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
  | "runtime.getLocale"
  | "studio.getLocalAnalysis"
  | "files.createFile"
  | "files.readFile"
  | "files.deleteFile"
  | "kv.getValue"
  | "kv.setValue"
  | "relatedProject.kv.getValue"
  | "relatedProject.kv.setValue"
  | "knowledge.listDocuments"
  | "knowledge.getDocument"
  | "knowledge.createDocument"
  | "knowledge.editDocument"
  | "knowledge.deleteDocument"
  | "knowledge.searchDocuments"
  | "knowledge.readDocumentLines";

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
  KANBAN_BRIDGE_INVALID_REQUEST: "The Kanban bridge request is invalid.",
  KANBAN_BRIDGE_BUSY: "Too many Kanban bridge requests are pending.",
  KANBAN_BRIDGE_TIMEOUT: "Kanban bridge request timed out.",
  KANBAN_BRIDGE_UNAVAILABLE: "Kanban project data is unavailable in this host.",
  KANBAN_BRIDGE_SESSION_INVALID: "The Kanban preview session is invalid or expired.",
  KANBAN_BRIDGE_SERVER_ERROR: "Kanban project data operation failed.",
  KANBAN_DATA_OPERATION_FAILED: "Kanban project data operation failed.",
  KANBAN_RELATED_PROJECT_UNAVAILABLE: "Kanban related project is unavailable.",
  KANBAN_FILE_UNAVAILABLE: "Kanban file is unavailable in this project.",
  KANBAN_FILE_TOO_LARGE: "Kanban files cannot exceed 50 MiB.",
} as const;

const KANBAN_BRIDGE_CALL_FIELDS = new Set(["requestId", "operation", "input"]);
const MAX_KNOWLEDGE_DOCUMENT_PAGE_SIZE = 100;
const MAX_KNOWLEDGE_SEARCH_PAGE_SIZE = 1_000;
const MAX_KNOWLEDGE_CONTEXT_LINES = 50;
const MAX_KNOWLEDGE_LINE_RANGE = 1_000;

const KANBAN_BRIDGE_INPUT_FIELDS: Record<KanbanBridgeOperation, readonly string[]> = {
  "runtime.getLocale": [],
  "studio.getLocalAnalysis": [],
  "files.createFile": ["name", "mimeType", "base64"],
  "files.readFile": ["fileId"],
  "files.deleteFile": ["fileId"],
  "kv.getValue": ["key"],
  "kv.setValue": ["key", "value"],
  "relatedProject.kv.getValue": ["alias", "key"],
  "relatedProject.kv.setValue": ["alias", "key", "value"],
  "knowledge.listDocuments": ["pageSize", "cursor"],
  "knowledge.getDocument": ["documentId"],
  "knowledge.createDocument": ["id", "title", "markdown"],
  "knowledge.editDocument": ["documentId", "title", "markdown"],
  "knowledge.deleteDocument": ["documentId"],
  "knowledge.searchDocuments": [
    "query",
    "documentId",
    "beforeLines",
    "afterLines",
    "maxMatches",
    "pageSize",
    "cursor",
  ],
  "knowledge.readDocumentLines": ["documentId", "startLine", "endLine"],
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

export function readPackageProjectType(value: unknown): "kanban" | undefined {
  if (!isRecord(value)) return undefined;
  const workflowCode = value["workflowCode"];
  if (!isRecord(workflowCode)) return undefined;
  return workflowCode["projectType"] === "kanban" ? "kanban" : undefined;
}

export function isKanbanPackage(value: unknown): boolean {
  return readPackageProjectType(value) === "kanban";
}

export function readKanbanArtifactConfig(value: unknown): KanbanArtifactConfig {
  if (!isRecord(value)) {
    throw new Error("package.json root must be an object.");
  }
  const workflowCode = value["workflowCode"];
  if (!isRecord(workflowCode)) {
    throw new Error("package.json workflowCode must be an object for a Kanban project.");
  }
  const rawConfig = workflowCode["kanban"];
  if (rawConfig !== undefined && !isRecord(rawConfig)) {
    throw new Error("package.json workflowCode.kanban must be an object.");
  }
  if (rawConfig?.["dataSources"] !== undefined) {
    throw new Error(
      "package.json workflowCode.kanban.dataSources was removed; declare workflowCode.projectInfo.relatedProjects instead.",
    );
  }
  return {
    artifactDir: readKanbanRelativePath(
      rawConfig?.["artifactDir"],
      "workflowCode.kanban.artifactDir",
      KANBAN_ARTIFACT_DIR,
      true,
    ),
    entry: readKanbanRelativePath(
      rawConfig?.["entry"],
      "workflowCode.kanban.entry",
      KANBAN_ENTRY_FILE,
      false,
    ),
  };
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
  params: WorkflowParamDefinition[],
): KanbanConfigurationValues {
  return Object.fromEntries(params.map((param) => [param.name, param.defaultValue ?? ""]));
}

export function sanitizeKanbanValues(
  params: WorkflowParamDefinition[],
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
  params: WorkflowParamDefinition[],
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
  const revisionMessage = JSON.stringify(KANBAN_RELATED_PROJECT_REVISION_MESSAGE);
  const presentationMessage = JSON.stringify(KANBAN_PRESENTATION_MESSAGE);
  const presentationEvent = JSON.stringify(KANBAN_PRESENTATION_CHANGE_EVENT);
  const safeErrorMessages = JSON.stringify(KANBAN_BRIDGE_SAFE_ERRORS);
  return `<script nonce=${safeNonce}>(function(){
let current=${initial};
let presentation={mode:"fullscreen"};
let sequence=0;
const safeErrorMessages=${safeErrorMessages};
const pending=new Map();
const relatedProjectRevisions=new Map();
const relatedProjectRevisionListeners=new Map();
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
  if(pending.size>=${KANBAN_BRIDGE_MAX_PENDING_REQUESTS})return Promise.reject(createError("Too many Kanban bridge requests are pending.","KANBAN_BRIDGE_BUSY"));
  const requestId=Date.now().toString(36)+"-"+(++sequence).toString(36);
  return new Promise((resolve,reject)=>{
    const timeout=window.setTimeout(()=>{pending.delete(requestId);reject(createError("Kanban bridge request timed out.","KANBAN_BRIDGE_TIMEOUT"));},operation.startsWith("files.")?${KANBAN_FILE_BRIDGE_REQUEST_TIMEOUT_MS}:${KANBAN_BRIDGE_REQUEST_TIMEOUT_MS});
    pending.set(requestId,{resolve,reject,timeout});
    try{window.parent.postMessage({type:${requestMessage},nonce:${safeNonce},requestId,operation,input},"*");}
    catch{window.clearTimeout(timeout);pending.delete(requestId);reject(invalidRequest());}
  });
};
const kv=Object.freeze({
  getValue:(key)=>request("kv.getValue",{key}),
  setValue:(key,value)=>isJsonValue(value)?request("kv.setValue",{key,value}).then(()=>undefined):Promise.reject(invalidRequest())
});
const files=Object.freeze({
  createFile:async(input)=>{
    if(!input||typeof input.name!=="string")throw invalidRequest();
    const source=input.buffer;
    if(!(source instanceof Blob)&&!(source instanceof ArrayBuffer)&&!(source instanceof Uint8Array))throw invalidRequest();
    if((source instanceof Blob?source.size:source.byteLength)>${KANBAN_FILE_MAX_BYTES})throw createError(safeErrorMessages.KANBAN_FILE_TOO_LARGE,"KANBAN_FILE_TOO_LARGE");
    const bytes=source instanceof Blob?new Uint8Array(await source.arrayBuffer()):source instanceof ArrayBuffer?new Uint8Array(source):source;
    let binary="";
    for(let offset=0;offset<bytes.length;offset+=32768)binary+=String.fromCharCode(...bytes.subarray(offset,offset+32768));
    return request("files.createFile",{name:input.name,mimeType:input.mimeType||(source instanceof Blob?source.type:undefined)||undefined,base64:btoa(binary)});
  },
  readFile:(fileId)=>request("files.readFile",{fileId}).then(({file,base64})=>({file,buffer:Uint8Array.from(atob(base64),(char)=>char.charCodeAt(0)).buffer})),
  deleteFile:(fileId)=>request("files.deleteFile",{fileId})
});
const subscribeToRelatedProject=(alias,listener)=>{
  if(typeof listener!=="function")throw invalidRequest();
  let listeners=relatedProjectRevisionListeners.get(alias);
  if(!listeners){listeners=new Set();relatedProjectRevisionListeners.set(alias,listeners);}
  listeners.add(listener);
  if(relatedProjectRevisions.has(alias)){const revision=relatedProjectRevisions.get(alias);Promise.resolve().then(()=>{if(listeners.has(listener))listener({alias,revision});}).catch(()=>{});}
  return ()=>{listeners.delete(listener);if(listeners.size===0)relatedProjectRevisionListeners.delete(alias);};
};
const relatedProjectContexts=new Map();
const relatedProjects=Object.freeze({
  get:(alias)=>{
    if(typeof alias!=="string"||!${WORKFLOW_RELATED_PROJECT_ALIAS_PATTERN.toString()}.test(alias))throw invalidRequest();
    if(relatedProjectContexts.has(alias))return relatedProjectContexts.get(alias);
    const context=Object.freeze({kv:Object.freeze({
      getValue:(key)=>request("relatedProject.kv.getValue",{alias,key}),
      setValue:(key,value)=>isJsonValue(value)?request("relatedProject.kv.setValue",{alias,key,value}).then(()=>undefined):Promise.reject(invalidRequest()),
      subscribe:(listener)=>subscribeToRelatedProject(alias,listener)
    })});
    relatedProjectContexts.set(alias,context);
    return context;
  }
});
const knowledge=Object.freeze({
  listDocuments:(options={})=>request("knowledge.listDocuments",options),
  getDocument:(documentId)=>request("knowledge.getDocument",{documentId}),
  createDocument:(input)=>request("knowledge.createDocument",input),
  editDocument:(documentId,input)=>request("knowledge.editDocument",{...input,documentId}),
  deleteDocument:(documentId)=>request("knowledge.deleteDocument",{documentId}),
  searchDocuments:(options)=>request("knowledge.searchDocuments",options),
  readDocumentLines:(documentId,options)=>request("knowledge.readDocumentLines",{...options,documentId})
});
${createKanbanMethodsBridgeScript(nonce)}
Object.defineProperty(window,"workflowCodeKanban",{configurable:false,enumerable:true,value:Object.freeze({getConfiguration:clone,getPresentation:()=>({...presentation}),getRuntimeLocale:()=>request("runtime.getLocale",{}),studio:Object.freeze({getLocalAnalysis:()=>request("studio.getLocalAnalysis",{})}),kv,files,relatedProjects,knowledge,methods})});
window.addEventListener("message",function(event){
  if(event.source!==window.parent||!event.data||event.data.nonce!==${safeNonce})return;
  if(handleKanbanMethodMessage(event.data))return;
  if(event.data.type===${presentationMessage}){
    const mode=event.data.presentation?.mode;
    if(!["fullscreen","phone","tablet","card"].includes(mode)||presentation.mode===mode)return;
    presentation={mode};
    window.dispatchEvent(new CustomEvent(${presentationEvent},{detail:{...presentation}}));
    return;
  }
  if(event.data.type==="workflow-code:kanban-configuration"){
    if(event.data.configuration?.id!==current.id)resetKanbanMethods();
    current=event.data.configuration;
    window.dispatchEvent(new CustomEvent(${eventName},{detail:clone()}));
    ready();
    return;
  }
  if(event.data.type===${revisionMessage}){
    const alias=event.data.alias;
    const revision=event.data.revision;
    if(typeof alias!=="string"||!${WORKFLOW_RELATED_PROJECT_ALIAS_PATTERN.toString()}.test(alias)||typeof revision!=="string"||revision.length===0||revision.length>512)return;
    if(relatedProjectRevisions.get(alias)===revision)return;
    relatedProjectRevisions.set(alias,revision);
    const listeners=relatedProjectRevisionListeners.get(alias);
    if(listeners)for(const listener of [...listeners])Promise.resolve().then(()=>listener({alias,revision})).catch(()=>{});
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
  if (isRecord(reason)) {
    const code = reason["code"];
    if (
      typeof code === "string" &&
      Object.prototype.hasOwnProperty.call(KANBAN_BRIDGE_SAFE_ERRORS, code)
    ) {
      return {
        code,
        message: KANBAN_BRIDGE_SAFE_ERRORS[code as keyof typeof KANBAN_BRIDGE_SAFE_ERRORS],
      };
    }
  }
  return {
    code: "KANBAN_BRIDGE_ERROR",
    message: "Kanban bridge request failed.",
  };
}

export function resolveKanbanRelatedProject(
  relatedProjects: readonly WorkflowRelatedProject[],
  alias: string,
  key: string,
): WorkflowRelatedProject {
  const relatedProject = relatedProjects.find((item) => item.alias === alias);
  if (
    relatedProject === undefined ||
    key.trim() === "" ||
    key.length > WORKFLOW_RELATED_PROJECT_KEY_LIMIT
  ) {
    throw Object.assign(new Error("Kanban related project is unavailable."), {
      code: "KANBAN_RELATED_PROJECT_UNAVAILABLE",
    });
  }
  return relatedProject;
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
    part === "kanban.json" ||
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

function readKanbanRelativePath(
  value: unknown,
  field: string,
  fallback: string,
  allowDot: boolean,
): string {
  const raw = value === undefined ? fallback : value;
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error(`package.json ${field} must be a non-empty string.`);
  }
  const normalized = raw.trim().replaceAll("\\", "/").replace(/\/+$/, "");
  if (allowDot && normalized === ".") return normalized;
  if (
    normalized === "" ||
    normalized === "." ||
    normalized.startsWith("/") ||
    normalized.startsWith("//") ||
    /^[a-zA-Z]:/.test(normalized) ||
    normalized.includes("\0") ||
    normalized.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`package.json ${field} must be a safe project-relative path.`);
  }
  const reservedDirectory = normalized.split("/").find((part) => (
    [".git", ".hg", ".svn", "node_modules"].includes(part.toLowerCase())
  ));
  if (reservedDirectory !== undefined) {
    throw new Error(
      `package.json ${field} must not use reserved directory ${JSON.stringify(reservedDirectory)}.`,
    );
  }
  if (!allowDot && !/\.html?$/i.test(normalized)) {
    throw new Error(`package.json ${field} must point to an HTML file.`);
  }
  return normalized;
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
    case "runtime.getLocale":
    case "studio.getLocalAnalysis":
      return;
    case "files.createFile": {
      const name = readNonEmptyString(input["name"], "bridge.input.name");
      if (name.length > 255 || /[\\/\\\\\0]/.test(name)) {
        throw new Error("Kanban file name must be a plain file name.");
      }
      const mimeType = readOptionalNonEmptyString(input["mimeType"], "bridge.input.mimeType");
      if (mimeType !== undefined && !/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(mimeType)) {
        throw new Error("Kanban file MIME type is invalid.");
      }
      const base64 = readRequiredString(input["base64"], "bridge.input.base64");
      if (base64.length > Math.ceil(KANBAN_FILE_MAX_BYTES / 3) * 4) {
        throw Object.assign(new Error(KANBAN_BRIDGE_SAFE_ERRORS.KANBAN_FILE_TOO_LARGE), { code: "KANBAN_FILE_TOO_LARGE" });
      }
      if (base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
        throw new Error("Kanban file content must be base64 encoded.");
      }
      const size = base64.length / 4 * 3 - (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0);
      if (size > KANBAN_FILE_MAX_BYTES) {
        throw Object.assign(new Error(KANBAN_BRIDGE_SAFE_ERRORS.KANBAN_FILE_TOO_LARGE), { code: "KANBAN_FILE_TOO_LARGE" });
      }
      return;
    }
    case "files.readFile":
    case "files.deleteFile":
      if (!/^wf_[a-f0-9]+$/.test(readNonEmptyString(input["fileId"], "bridge.input.fileId"))) {
        throw new Error("Kanban file id is invalid.");
      }
      return;
    case "kv.getValue":
      readNonEmptyString(input["key"], "bridge.input.key");
      return;
    case "kv.setValue":
      readNonEmptyString(input["key"], "bridge.input.key");
      if (input["value"] === undefined || !isKanbanJsonValue(input["value"])) {
        throw new Error("Kanban bridge KV value must be JSON-serializable and cannot be undefined.");
      }
      return;
    case "relatedProject.kv.getValue":
    case "relatedProject.kv.setValue": {
      const alias = readNonEmptyString(input["alias"], "bridge.input.alias");
      if (!WORKFLOW_RELATED_PROJECT_ALIAS_PATTERN.test(alias)) {
        throw new Error("Kanban bridge related-project alias is invalid.");
      }
      const key = readNonEmptyString(input["key"], "bridge.input.key");
      if (key.length > WORKFLOW_RELATED_PROJECT_KEY_LIMIT) {
        throw new Error("Kanban bridge related-project key is too long.");
      }
      if (
        operation === "relatedProject.kv.setValue" &&
        (input["value"] === undefined || !isKanbanJsonValue(input["value"]))
      ) {
        throw new Error(
          "Kanban bridge related-project KV value must be JSON-serializable and cannot be undefined.",
        );
      }
      return;
    }
    case "knowledge.listDocuments":
      readOptionalIntegerInRange(
        input["pageSize"],
        "bridge.input.pageSize",
        1,
        MAX_KNOWLEDGE_DOCUMENT_PAGE_SIZE,
      );
      readOptionalNonEmptyString(input["cursor"], "bridge.input.cursor");
      return;
    case "knowledge.getDocument":
    case "knowledge.deleteDocument":
      readNonEmptyString(input["documentId"], "bridge.input.documentId");
      return;
    case "knowledge.createDocument":
      readOptionalNonEmptyString(input["id"], "bridge.input.id");
      readNonEmptyString(input["title"], "bridge.input.title");
      readRequiredString(input["markdown"], "bridge.input.markdown");
      return;
    case "knowledge.editDocument":
      readNonEmptyString(input["documentId"], "bridge.input.documentId");
      if (input["title"] === undefined && input["markdown"] === undefined) {
        throw new Error("Kanban bridge knowledge edit requires title or markdown.");
      }
      readOptionalStringValue(input["title"], "bridge.input.title");
      readOptionalStringValue(input["markdown"], "bridge.input.markdown");
      return;
    case "knowledge.searchDocuments":
      readNonEmptyString(input["query"], "bridge.input.query");
      readOptionalNonEmptyString(input["documentId"], "bridge.input.documentId");
      readOptionalIntegerInRange(
        input["beforeLines"],
        "bridge.input.beforeLines",
        0,
        MAX_KNOWLEDGE_CONTEXT_LINES,
      );
      readOptionalIntegerInRange(
        input["afterLines"],
        "bridge.input.afterLines",
        0,
        MAX_KNOWLEDGE_CONTEXT_LINES,
      );
      readOptionalIntegerInRange(
        input["maxMatches"],
        "bridge.input.maxMatches",
        1,
        MAX_KNOWLEDGE_SEARCH_PAGE_SIZE,
      );
      readOptionalIntegerInRange(
        input["pageSize"],
        "bridge.input.pageSize",
        1,
        MAX_KNOWLEDGE_SEARCH_PAGE_SIZE,
      );
      readOptionalNonEmptyString(input["cursor"], "bridge.input.cursor");
      return;
    case "knowledge.readDocumentLines":
      readNonEmptyString(input["documentId"], "bridge.input.documentId");
      const startLine = readPositiveInteger(input["startLine"], "bridge.input.startLine");
      const endLine = readPositiveInteger(input["endLine"], "bridge.input.endLine");
      if (endLine < startLine || endLine - startLine + 1 > MAX_KNOWLEDGE_LINE_RANGE) {
        throw new Error("Kanban bridge knowledge line range is invalid or too large.");
      }
  }
}

function isKanbanBridgeOperation(value: unknown): value is KanbanBridgeOperation {
  return value === "runtime.getLocale" ||
    value === "studio.getLocalAnalysis" ||
    value === "files.createFile" ||
    value === "files.readFile" ||
    value === "files.deleteFile" ||
    value === "kv.getValue" ||
    value === "kv.setValue" ||
    value === "relatedProject.kv.getValue" ||
    value === "relatedProject.kv.setValue" ||
    value === "knowledge.listDocuments" ||
    value === "knowledge.getDocument" ||
    value === "knowledge.createDocument" ||
    value === "knowledge.editDocument" ||
    value === "knowledge.deleteDocument" ||
    value === "knowledge.searchDocuments" ||
    value === "knowledge.readDocumentLines";
}

function readRequiredString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`Kanban ${field} must be a string.`);
  return value;
}

function readOptionalStringValue(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return readRequiredString(value, field);
}

function readOptionalNonEmptyString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return readNonEmptyString(value, field);
}

function readOptionalIntegerInRange(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`Kanban ${field} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value as number;
}

function readPositiveInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new Error(`Kanban ${field} must be a positive integer.`);
  }
  return value as number;
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

function parseInjectedValue(param: WorkflowParamDefinition, value: string): unknown {
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
    ...(typeof value["workflowId"] === "string" ? { workflowId: value["workflowId"] } : {}),
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

function isParamType(value: unknown): value is WorkflowParamDefinition["type"] {
  return value === "string" || value === "number" || value === "boolean" || value === "positional" || value === "file";
}

function isParamControl(value: unknown): value is KanbanParamControl {
  return value === "text" || value === "textarea" || value === "radio" || value === "select" || value === "checkboxes";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
