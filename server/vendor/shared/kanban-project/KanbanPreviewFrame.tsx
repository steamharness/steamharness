import { i18n } from "@steamharness/i18n";
import { useTranslation } from "@steamharness/i18n/react";
import { AlertCircle, Loader2, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  createKanbanBridgeError,
  KANBAN_BRIDGE_MAX_PENDING_REQUESTS,
  KANBAN_BRIDGE_REQUEST_MESSAGE,
  KANBAN_BRIDGE_REQUEST_TIMEOUT_MS,
  KANBAN_BRIDGE_RESPONSE_MESSAGE,
  KANBAN_DATABASE_REVISION_MESSAGE,
  KANBAN_PREVIEW_READY_MESSAGE,
  KANBAN_PRESENTATION_MESSAGE,
  parseKanbanBridgeCall,
  type KanbanBridgeCall,
  type KanbanDatabaseRevision,
  type KanbanPresentationMode,
} from "./index";
import "./styles.css";
import { createKanbanMethodSession, type KanbanMethodRegistry, type KanbanMethodTarget } from "./methods";

const REQUEST_FIELDS = new Set(["type", "nonce", "requestId", "operation", "input"]);

export interface KanbanPreviewFrameProps {
  projectName: string;
  previewUrl: string;
  previewNonce: string;
  configuration?: { id: string; name: string; params: Record<string, unknown> };
  onRetry?: () => void;
  onBridgeRequest?: (call: KanbanBridgeCall) => Promise<unknown> | unknown;
  databaseRevisions?: readonly KanbanDatabaseRevision[];
  databaseWarning?: string;
  compact?: boolean;
  presentationMode?: KanbanPresentationMode;
  methodRegistry?: KanbanMethodRegistry;
  methodTarget?: KanbanMethodTarget;
}

export function KanbanPreviewFrame(props: KanbanPreviewFrameProps) {
  const { t } = useTranslation();
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const bridgeHandlerRef = useRef(props.onBridgeRequest);
  bridgeHandlerRef.current = props.onBridgeRequest;
  const presentationMode = props.presentationMode ?? (props.compact ? "card" : "fullscreen");
  const presentationModeRef = useRef(presentationMode);
  presentationModeRef.current = presentationMode;
  const generationRef = useRef(0);
  const pendingRef = useRef(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const configurationRef = useRef(props.configuration);
  configurationRef.current = props.configuration;

  const postConfiguration = () => {
    if (!props.configuration) return;
    iframeRef.current?.contentWindow?.postMessage({
      type: "steamharness:kanban-configuration",
      nonce: props.previewNonce,
      configuration: props.configuration,
    }, "*");
  };
  const postPresentation = () => {
    iframeRef.current?.contentWindow?.postMessage({
      type: KANBAN_PRESENTATION_MESSAGE,
      nonce: props.previewNonce,
      presentation: { mode: presentationModeRef.current },
    }, "*");
  };
  const postRevisions = () => {
    const target = iframeRef.current?.contentWindow;
    if (!target) return;
    for (const revision of props.databaseRevisions ?? []) {
      target.postMessage({
        type: KANBAN_DATABASE_REVISION_MESSAGE,
        nonce: props.previewNonce,
        alias: revision.alias,
        revision: revision.revision,
      }, "*");
    }
  };

  useEffect(postConfiguration, [props.configuration, props.previewNonce]);
  useEffect(postPresentation, [presentationMode, props.previewNonce]);
  useEffect(postRevisions, [props.previewNonce, props.previewUrl, props.databaseRevisions, version]);

  useEffect(() => {
    const generation = ++generationRef.current;
    pendingRef.current = 0;
    const timeouts = new Set<number>();
    setLoading(true);
    setError("");
    const methodSession = createKanbanMethodSession({
      nonce: props.previewNonce,
      getConfiguration: () => configurationRef.current,
      getPresentation: () => ({ mode: presentationModeRef.current }),
      postMessage: (message) => iframeRef.current?.contentWindow?.postMessage(message, "*"),
    });
    const unregisterMethods = props.methodTarget && props.methodRegistry?.register(props.methodTarget, methodSession);
    const readyTimeout = window.setTimeout(() => {
      setLoading(false);
      setError(i18n.t("kanbanPreviewInitFailed"));
    }, 10_000);
    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow || !isRecord(event.data)
        || event.data.nonce !== props.previewNonce) return;
      methodSession.receive(event.data);
      if (event.data.type === KANBAN_PREVIEW_READY_MESSAGE) {
        window.clearTimeout(readyTimeout);
        setLoading(false);
        setError("");
        postPresentation();
        return;
      }
      if (event.data.type !== KANBAN_BRIDGE_REQUEST_MESSAGE) return;
      const source = event.source as WindowProxy;
      const requestId = typeof event.data.requestId === "string" ? event.data.requestId : "";
      const respond = (response: Record<string, unknown>) => {
        if (generationRef.current !== generation || source !== iframeRef.current?.contentWindow) return;
        source.postMessage({
          type: KANBAN_BRIDGE_RESPONSE_MESSAGE,
          nonce: props.previewNonce,
          requestId,
          ...response,
        }, "*");
      };
      if (pendingRef.current >= KANBAN_BRIDGE_MAX_PENDING_REQUESTS) {
        respond({ ok: false, error: { code: "KANBAN_BRIDGE_BUSY", message: i18n.t("kanbanBridgeBusy") } });
        return;
      }
      let call: KanbanBridgeCall;
      try {
        if (Object.keys(event.data).some((key) => !REQUEST_FIELDS.has(key))) {
          throw new Error(i18n.t("kanbanBridgeUnsupportedFields"));
        }
        call = parseKanbanBridgeCall({
          requestId: event.data.requestId,
          operation: event.data.operation,
          input: event.data.input,
        });
      } catch {
        respond({ ok: false, error: { code: "KANBAN_BRIDGE_INVALID_REQUEST", message: i18n.t("kanbanBridgeInvalidRequest") } });
        return;
      }
      const handler = bridgeHandlerRef.current;
      if (!handler) {
        respond({ ok: false, error: { code: "KANBAN_BRIDGE_UNAVAILABLE", message: i18n.t("kanbanBridgeUnavailable") } });
        return;
      }
      pendingRef.current += 1;
      let settled = false;
      const finish = (response: Record<string, unknown>) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(requestTimeout);
        timeouts.delete(requestTimeout);
        if (generationRef.current === generation) pendingRef.current = Math.max(0, pendingRef.current - 1);
        respond(response);
      };
      const requestTimeout = window.setTimeout(() => finish({
        ok: false,
        error: { code: "KANBAN_BRIDGE_TIMEOUT", message: i18n.t("kanbanBridgeTimedOut") },
      }), KANBAN_BRIDGE_REQUEST_TIMEOUT_MS);
      timeouts.add(requestTimeout);
      void Promise.resolve().then(() => handler(call))
        .then((value) => finish({ ok: true, value }))
        .catch((reason) => finish({ ok: false, error: createKanbanBridgeError(reason) }));
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.clearTimeout(readyTimeout);
      for (const timeout of timeouts) window.clearTimeout(timeout);
      window.removeEventListener("message", onMessage);
      unregisterMethods?.();
      methodSession.close();
      if (generationRef.current === generation) {
        generationRef.current += 1;
        pendingRef.current = 0;
      }
    };
  }, [props.previewNonce, props.previewUrl, version, props.configuration?.id, props.methodRegistry,
    props.methodTarget?.projectId, props.methodTarget?.source, props.methodTarget?.location, props.methodTarget?.cardId]);

  return (
    <div className="kanban-preview" data-loading={loading ? "true" : "false"} data-compact={props.compact ? "true" : undefined}>
      {props.databaseWarning ? (
        <div className="kanban-database-warning" role="status">
          <AlertCircle aria-hidden="true" /><span>{props.databaseWarning}</span>
        </div>
      ) : null}
      {loading ? <div className="kanban-preview-loading"><Loader2 className="kanban-spin" />{t("loadingHtml")}</div> : null}
      {error ? (
        <div className="kanban-preview-error" role="alert">
          <AlertCircle /><span>{error}</span>
          <button type="button" onClick={() => {
            setError("");
            setLoading(true);
            if (props.onRetry) props.onRetry();
            else setVersion((current) => current + 1);
          }}><RefreshCw />{t("retry")}</button>
        </div>
      ) : null}
      <iframe
        key={`${props.previewUrl}:${version}`}
        ref={iframeRef}
        title={t("kanbanPreviewTitle", { name: props.projectName })}
        src={props.previewUrl}
        sandbox="allow-scripts"
        onLoad={() => { postPresentation(); postConfiguration(); postRevisions(); }}
        onError={() => { setLoading(false); setError(t("htmlPreviewLoadFailed")); }}
      />
    </div>
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
