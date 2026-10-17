import { useTranslation } from "@workflow-code/i18n/react";
import { translateWorkflowCodeError } from "@workflow-code/i18n";
import { ParamsForm } from "./run-workspace/form/params-form";
import { useMenuFocus, useModalFocus } from "./run-workspace/hooks/useOverlayFocus";
import type { WorkflowManagedFileReference, WorkflowParamDefinition } from "./run-workspace/types";
import { AlertCircle, Check, ChevronDown, Copy, Ellipsis, Loader2, Pencil, Plus, RefreshCw, SlidersHorizontal, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  createInjectedKanbanParams,
  sanitizeKanbanValues,
  type KanbanBridgeCall,
  type KanbanConfiguration,
  type KanbanRelatedProjectRevision,
  type KanbanPresentationMode,
} from "./index";
import { KanbanPreviewFrame } from "./KanbanPreviewFrame";
import "./styles.css";
import type { KanbanMethodRegistry, KanbanMethodTarget } from "./methods";

const EMPTY_PARAMS: WorkflowParamDefinition[] = [];

export interface KanbanWorkspaceLayout {
  configuration?: ReactNode;
  preview: ReactNode;
  mobileTrigger: ReactNode;
  drawerOpen: boolean;
  drawerBackdrop: ReactNode;
}

export interface KanbanWorkspaceProps {
  projectName: string;
  params?: WorkflowParamDefinition[];
  configurations: KanbanConfiguration[];
  activeConfigurationId?: string;
  previewUrl: string;
  previewNonce: string;
  previewValues?: Record<string, unknown>;
  presentationMode?: KanbanPresentationMode;
  loading?: boolean;
  error?: string;
  savingConfigurationId?: string;
  onRetry?: () => void;
  onSelectConfiguration: (configurationId: string) => Promise<void> | void;
  onCreateConfiguration: () => Promise<void> | void;
  onDuplicateConfiguration: (configurationId: string) => Promise<void> | void;
  onRenameConfiguration: (configurationId: string, name: string) => Promise<void> | void;
  onDeleteConfiguration: (configurationId: string) => Promise<void> | void;
  onSaveConfiguration: (
    configurationId: string,
    values: Record<string, string>,
  ) => Promise<void> | void;
  onFileUpload?: (param: WorkflowParamDefinition) => Promise<WorkflowManagedFileReference[]>;
  onOpenAttachment?: (file: WorkflowManagedFileReference, options?: { download?: boolean }) => Promise<void> | void;
  onResolveAttachmentPreview?: (file: WorkflowManagedFileReference) => Promise<string | undefined> | string | undefined;
  onBridgeRequest?: (call: KanbanBridgeCall) => Promise<unknown> | unknown;
  methodRegistry?: KanbanMethodRegistry;
  methodTarget?: KanbanMethodTarget;
  relatedProjectRevisions?: readonly KanbanRelatedProjectRevision[];
  relatedProjectWarning?: string;
  configurationHeadingAction?: ReactNode;
  /** Hosts can supply their rail chrome while configuration state stays here. */
  renderLayout?: (layout: KanbanWorkspaceLayout) => ReactNode;
}

export function KanbanWorkspace(props: KanbanWorkspaceProps) {
  const { t } = useTranslation();
  const params = props.params ?? EMPTY_PARAMS;
  const hasParams = params.length > 0;
  const active = props.configurations.find((item) => item.id === props.activeConfigurationId)
    ?? props.configurations[0];
  const [draftValues, setDraftValues] = useState<Record<string, string>>(
    active ? sanitizeKanbanValues(params, active.values) : {},
  );
  const [nameDraft, setNameDraft] = useState(active?.name ?? "");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [configurationPickerOpen, setConfigurationPickerOpen] = useState(false);
  const [configurationMenuOpen, setConfigurationMenuOpen] = useState(false);
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const [actionError, setActionError] = useState("");
  const [pendingAction, setPendingAction] = useState("");
  const uploadScopeRef = useRef("");
  const uploadPendingRef = useRef(false);
  uploadScopeRef.current = JSON.stringify([props.previewNonce, active?.id, active?.updatedAt, active?.values]);
  const [failedAction, setFailedAction] = useState<{
    key: string;
    label: string;
    action: () => Promise<void | boolean> | void | boolean;
  }>();
  const [failedSave, setFailedSave] = useState<{ configurationId: string; values: Record<string, string> }>();
  const [saveStatus, setSaveStatus] = useState<"saved" | "saving" | "error">("saved");
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const mobileTriggerRef = useRef<HTMLButtonElement | null>(null);
  const configurationPanelRef = useRef<HTMLDivElement | null>(null);
  const workspaceRef = useRef<HTMLElement | null>(null);
  const configurationPickerRef = useRef<HTMLDivElement | null>(null);
  const configurationPickerTriggerRef = useRef<HTMLButtonElement | null>(null);
  const activeConfigurationOptionRef = useRef<HTMLButtonElement | null>(null);
  const configurationMenuRef = useRef<HTMLDivElement | null>(null);
  const configurationMenuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const renameDialogRef = useRef<HTMLFormElement | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const deleteCancelRef = useRef<HTMLButtonElement | null>(null);
  const deleteDialogRef = useRef<HTMLDivElement | null>(null);
  const configurationRefs = useRef(new Map<string, HTMLButtonElement>());
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const saveVersionRef = useRef(0);
  const pendingSaveRef = useRef<{
    configurationId: string;
    values: Record<string, string>;
    version: number;
    saveConfiguration: KanbanWorkspaceProps["onSaveConfiguration"];
  } | undefined>(undefined);
  const restoreConfigurationPickerFocusRef = useRef(false);
  const configurationTransitionDisabled = pendingAction !== "" || failedSave !== undefined;

  useEffect(() => {
    setDraftValues(active ? sanitizeKanbanValues(params, active.values) : {});
    setNameDraft(active?.name ?? "");
    setSaveStatus("saved");
  }, [active?.id, active?.updatedAt, params]);

  useEffect(() => {
    void flushPendingSave(false);
    saveVersionRef.current += 1;
    setFailedSave(undefined);
    setFailedAction(undefined);
    setActionError("");
    setConfigurationPickerOpen(false);
    setConfigurationMenuOpen(false);
    setRenameDialogOpen(false);
  }, [active?.id]);

  useEffect(() => {
    if (!props.loading && !props.error) return;
    setDrawerOpen(false);
    setConfigurationPickerOpen(false);
    setConfigurationMenuOpen(false);
    setRenameDialogOpen(false);
    setDeleteConfirmOpen(false);
  }, [props.error, props.loading]);

  useEffect(() => {
    const workspace = workspaceRef.current;
    if (!drawerOpen || !workspace || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width > 760) closeDrawer();
    });
    observer.observe(workspace);
    return () => observer.disconnect();
  }, [drawerOpen]);

  useEffect(() => {
    if (configurationPickerOpen) {
      activeConfigurationOptionRef.current?.focus({ preventScroll: true });
      return;
    }
    if (restoreConfigurationPickerFocusRef.current) {
      restoreConfigurationPickerFocusRef.current = false;
      configurationPickerTriggerRef.current?.focus({ preventScroll: true });
    }
  }, [configurationPickerOpen]);

  useEffect(() => {
    if (!configurationPickerOpen && !configurationMenuOpen) return undefined;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (configurationPickerOpen && !configurationPickerRef.current?.contains(target)) {
        setConfigurationPickerOpen(false);
      }
      if (configurationMenuOpen && !configurationMenuRef.current?.contains(target)) {
        setConfigurationMenuOpen(false);
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [configurationMenuOpen, configurationPickerOpen]);

  const injectedConfiguration = useMemo(() => active ? {
    id: active.id,
    name: active.name,
    params: createInjectedKanbanParams(params, sanitizeKanbanValues(params, {
      ...draftValues,
      ...props.previewValues,
    })),
  } : undefined, [active, draftValues, params, props.previewValues]);

  useEffect(() => () => {
    void flushPendingSave(false);
  }, []);

  useModalFocus({
    active: drawerOpen,
    containerRef: configurationPanelRef,
    onClose: () => setDrawerOpen(false),
    returnFocusRef: mobileTriggerRef,
  });
  useMenuFocus({
    active: configurationMenuOpen,
    containerRef: configurationMenuRef,
    onClose: () => setConfigurationMenuOpen(false),
    returnFocusRef: configurationMenuTriggerRef,
  });
  useModalFocus({
    active: renameDialogOpen,
    containerRef: renameDialogRef,
    initialFocusRef: renameInputRef,
    onClose: () => setRenameDialogOpen(false),
    returnFocusRef: configurationMenuTriggerRef,
  });
  useModalFocus({
    active: deleteConfirmOpen,
    containerRef: deleteDialogRef,
    initialFocusRef: deleteCancelRef,
    onClose: () => setDeleteConfirmOpen(false),
    returnFocusRef: configurationMenuTriggerRef,
  });

  function queueSave(
    configurationId: string,
    values: Record<string, string>,
    saveConfiguration: KanbanWorkspaceProps["onSaveConfiguration"] = props.onSaveConfiguration,
  ) {
    const queued = saveQueueRef.current.then(() => saveConfiguration(configurationId, values));
    saveQueueRef.current = queued.then(() => undefined, () => undefined);
    return queued;
  }

  function flushPendingSave(reportFailure: boolean): Promise<boolean> {
    if (saveTimerRef.current !== undefined) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = undefined;
    }
    const pending = pendingSaveRef.current;
    pendingSaveRef.current = undefined;
    if (!pending) return Promise.resolve(true);
    if (reportFailure) setSaveStatus("saving");
    return queueSave(
      pending.configurationId,
      pending.values,
      pending.saveConfiguration,
    ).then(() => {
      if (!reportFailure || pending.version !== saveVersionRef.current) return true;
      setFailedSave(undefined);
      setActionError("");
      setSaveStatus("saved");
      return true;
    }).catch((reason) => {
      if (!reportFailure || pending.version !== saveVersionRef.current) return false;
      setFailedSave({ configurationId: pending.configurationId, values: pending.values });
      setActionError(readErrorMessage(reason));
      setSaveStatus("error");
      return false;
    });
  }

  const updateValue = (name: string, value: string) => {
    if (!active) return;
    const next = { ...draftValues, [name]: value };
    const saveVersion = saveVersionRef.current + 1;
    saveVersionRef.current = saveVersion;
    setDraftValues(next);
    setFailedSave(undefined);
    setSaveStatus("saving");
    if (saveTimerRef.current !== undefined) clearTimeout(saveTimerRef.current);
    pendingSaveRef.current = {
      configurationId: active.id,
      values: next,
      version: saveVersion,
      saveConfiguration: props.onSaveConfiguration,
    };
    saveTimerRef.current = setTimeout(() => {
      void flushPendingSave(true);
    }, 300);
  };

  const uploadFile = async (param: WorkflowParamDefinition) => {
    if (!props.onFileUpload || uploadPendingRef.current) return [];
    const scope = uploadScopeRef.current;
    uploadPendingRef.current = true;
    setPendingAction(`upload:${param.name}`);
    setActionError("");
    setFailedAction(undefined);
    try {
      const files = await props.onFileUpload(param);
      return scope === uploadScopeRef.current ? files : [];
    } catch (reason) {
      if (scope === uploadScopeRef.current) setActionError(translateWorkflowCodeError(reason));
      return [];
    } finally {
      uploadPendingRef.current = false;
      setPendingAction("");
    }
  };

  const runAction = async (
    key: string,
    action: () => Promise<void | boolean> | void | boolean,
    label: string,
  ) => {
    if (pendingAction !== "") return false;
    setPendingAction(key);
    setFailedAction(undefined);
    setActionError("");
    try {
      const result = await action();
      return result !== false;
    } catch (reason) {
      setFailedAction({ key, label, action });
      setActionError(readErrorMessage(reason));
      return false;
    } finally {
      setPendingAction("");
    }
  };

  const closeDrawer = () => {
    setConfigurationPickerOpen(false);
    setConfigurationMenuOpen(false);
    setDrawerOpen(false);
    mobileTriggerRef.current?.focus();
  };

  const selectConfiguration = async (configurationId: string) => {
    if (configurationId === active?.id) {
      restoreConfigurationPickerFocusRef.current = true;
      setConfigurationPickerOpen(false);
      return;
    }
    const selected = await runAction(
      `select:${configurationId}`,
      async () => {
        if (!await flushPendingSave(true)) return false;
        await props.onSelectConfiguration(configurationId);
      },
      t("switchConfiguration"),
    );
    if (selected) {
      restoreConfigurationPickerFocusRef.current = true;
      setConfigurationPickerOpen(false);
    }
  };

  const moveConfigurationFocus = (configurationId: string, key: string) => {
    const currentIndex = props.configurations.findIndex((item) => item.id === configurationId);
    if (currentIndex < 0) return;
    let nextIndex = currentIndex;
    if (key === "ArrowDown") nextIndex = Math.min(props.configurations.length - 1, currentIndex + 1);
    else if (key === "ArrowUp") nextIndex = Math.max(0, currentIndex - 1);
    else if (key === "Home") nextIndex = 0;
    else if (key === "End") nextIndex = props.configurations.length - 1;
    else return;
    const next = props.configurations[nextIndex];
    if (!next) return;
    configurationRefs.current.get(next.id)?.focus();
  };

  const openRenameDialog = () => {
    if (!active) return;
    setNameDraft(active.name);
    setActionError("");
    setFailedAction(undefined);
    setConfigurationMenuOpen(false);
    setRenameDialogOpen(true);
  };

  const commitName = async () => {
    if (!active || nameDraft.trim() === "") return;
    if (nameDraft.trim() === active.name) {
      setRenameDialogOpen(false);
      return;
    }
    const renamed = await runAction(
      "rename",
      () => props.onRenameConfiguration(active.id, nameDraft.trim()),
      t("rename"),
    );
    if (renamed) setRenameDialogOpen(false);
  };

  const retrySave = () => {
    if (!failedSave) return;
    void runAction("retry-save", async () => {
      setSaveStatus("saving");
      try {
        await queueSave(failedSave.configurationId, failedSave.values);
        setFailedSave(undefined);
        setActionError("");
        setSaveStatus("saved");
      } catch (reason) {
        setSaveStatus("error");
        throw reason;
      }
    }, t("save"));
  };

  if (props.loading) {
    return <KanbanStatus icon={Loader2} title={t("loadingKanban")} detail={t("loadingKanbanDetail")} spinning />;
  }
  if (props.error) {
    return <KanbanStatus icon={AlertCircle} title={t("kanbanLoadFailed")} detail={props.error} action={props.onRetry} />;
  }
  if (hasParams && !active) {
    return <KanbanStatus icon={Loader2} title={t("creatingDefaultConfiguration")} detail={t("creatingDefaultConfigurationDetail")} spinning />;
  }

  const effectiveSaveStatus = failedSave || saveStatus === "error"
    ? "error"
    : saveStatus === "saving" || props.savingConfigurationId === active?.id
      ? "saving"
      : "saved";

  const mobileTrigger = hasParams ? (
    <button
      ref={mobileTriggerRef}
      type="button"
      className="kanban-mobile-config-trigger"
      onClick={() => setDrawerOpen(true)}
      aria-expanded={drawerOpen}
      aria-controls="kanban-configuration-panel"
    >
      <SlidersHorizontal aria-hidden="true" />
      <span>{t("params")}</span>
      <strong>{active?.name ?? t("configuration")}</strong>
    </button>
  ) : null;
  const configuration = hasParams ? (
    <div
      ref={configurationPanelRef}
      id="kanban-configuration-panel"
      className="kanban-configuration-content"
    >
      <div className="kanban-configuration-heading">
        <strong title={t("paramSettings")}>{t("paramSettings")}</strong>
        <div className="kanban-configuration-heading-actions">
          <div
            className={`kanban-save-status kanban-save-status-${effectiveSaveStatus}`}
            role="status"
            aria-live="polite"
          >
            {effectiveSaveStatus === "saving" ? <Loader2 className="kanban-spin" aria-hidden="true" /> : null}
            {effectiveSaveStatus === "saved" ? <Check aria-hidden="true" /> : null}
            {effectiveSaveStatus === "error" ? <AlertCircle aria-hidden="true" /> : null}
            <span>{effectiveSaveStatus === "saving" ? t("saving") : effectiveSaveStatus === "error" ? t("saveFailed") : t("saved")}</span>
            {effectiveSaveStatus === "error" ? (
              <button type="button" disabled={pendingAction !== ""} onClick={retrySave}>{t("retry")}</button>
            ) : null}
          </div>
          {props.configurationHeadingAction}
          <button type="button" className="kanban-mobile-close" title={t("closeParams")} aria-label={t("closeParams")} onClick={closeDrawer}><X /></button>
        </div>
      </div>
      <div className="kanban-configuration-toolbar">
        <div ref={configurationPickerRef} className="kanban-configuration-picker">
          <button
            ref={configurationPickerTriggerRef}
            type="button"
            className="kanban-configuration-picker-trigger"
            aria-label={t("selectConfiguration")}
            aria-haspopup="listbox"
            aria-expanded={configurationPickerOpen}
            aria-controls="kanban-configuration-list"
            disabled={configurationTransitionDisabled}
            onClick={() => {
              setConfigurationMenuOpen(false);
              setConfigurationPickerOpen((open) => !open);
            }}
            onKeyDown={(event) => {
              if (["ArrowDown", "ArrowUp"].includes(event.key) && !configurationPickerOpen) {
                event.preventDefault();
                setConfigurationPickerOpen(true);
              }
              if (event.key === "Escape" && configurationPickerOpen) {
                event.preventDefault();
                setConfigurationPickerOpen(false);
              }
            }}
          >
            <span>{active?.name ?? t("configuration")}</span>
            {pendingAction.startsWith("select:") ? <Loader2 className="kanban-spin" aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
          </button>
          {configurationPickerOpen ? (
            <div id="kanban-configuration-list" className="kanban-configuration-list" role="listbox" aria-label={t("namedConfigurations")}>
              {props.configurations.map((configuration) => (
                <button
                  key={configuration.id}
                  ref={(element) => {
                    if (element) configurationRefs.current.set(configuration.id, element);
                    else configurationRefs.current.delete(configuration.id);
                    if (configuration.id === active?.id) activeConfigurationOptionRef.current = element;
                  }}
                  type="button"
                  role="option"
                  aria-selected={configuration.id === active?.id}
                  aria-busy={props.savingConfigurationId === configuration.id || pendingAction === `select:${configuration.id}`}
                  tabIndex={configuration.id === active?.id ? 0 : -1}
                  className="kanban-configuration-item"
                  disabled={configurationTransitionDisabled}
                  onClick={() => void selectConfiguration(configuration.id)}
                  onKeyDown={(event) => {
                    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
                      event.preventDefault();
                      moveConfigurationFocus(configuration.id, event.key);
                    } else if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      void selectConfiguration(configuration.id);
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      restoreConfigurationPickerFocusRef.current = true;
                      setConfigurationPickerOpen(false);
                    }
                  }}
                >
                  <span>{configuration.name}</span>
                  {configuration.id === active?.id ? <Check aria-label={t("currentConfiguration")} /> : null}
                  {pendingAction === `select:${configuration.id}` ? <Loader2 className="kanban-spin" aria-label={t("switching")} /> : null}
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <button
          type="button"
          className="kanban-toolbar-icon-button"
          title={t("newConfiguration")}
          aria-label={t("newConfiguration")}
          disabled={configurationTransitionDisabled}
          onClick={() => void runAction("create", props.onCreateConfiguration, t("newConfiguration"))}
        >
          {pendingAction === "create" ? <Loader2 className="kanban-spin" /> : <Plus />}
        </button>
        <div ref={configurationMenuRef} className="kanban-configuration-menu-shell">
          <button
            ref={configurationMenuTriggerRef}
            type="button"
            className="kanban-toolbar-icon-button"
            title={t("configurationActions")}
            aria-label={t("configurationActions")}
            aria-haspopup="menu"
            aria-expanded={configurationMenuOpen}
            disabled={configurationTransitionDisabled || !active}
            onClick={() => {
              setConfigurationPickerOpen(false);
              setConfigurationMenuOpen((open) => !open);
            }}
          >
            {pendingAction === "duplicate" ? <Loader2 className="kanban-spin" /> : <Ellipsis />}
          </button>
          {configurationMenuOpen && active ? (
            <div className="kanban-configuration-menu" role="menu" aria-label={t("configurationActions")}>
              <button type="button" role="menuitem" onClick={openRenameDialog}><Pencil />{t("rename")}</button>
              <button
                type="button"
                role="menuitem"
                disabled={pendingAction !== ""}
                aria-disabled={pendingAction !== ""}
                onClick={() => void (async () => {
                  const duplicated = await runAction("duplicate", () => props.onDuplicateConfiguration(active.id), t("duplicateConfiguration"));
                  if (duplicated) setConfigurationMenuOpen(false);
                })()}
              >{pendingAction === "duplicate" ? <Loader2 className="kanban-spin" /> : <Copy />}{t("duplicate")}</button>
              <button
                type="button"
                role="menuitem"
                className="kanban-menu-danger-action"
                disabled={props.configurations.length <= 1 || pendingAction !== ""}
                aria-disabled={props.configurations.length <= 1 || pendingAction !== ""}
                onClick={() => {
                  setConfigurationMenuOpen(false);
                  setActionError("");
                  setFailedAction(undefined);
                  setDeleteConfirmOpen(true);
                }}
              ><Trash2 />{t("delete")}</button>
            </div>
          ) : null}
        </div>
      </div>
      {active ? (
        <div className="kanban-configuration-editor">
          <ParamsForm
            variant="settings"
            params={params}
            values={draftValues}
            disabled={pendingAction !== ""}
            onChange={updateValue}
            onFileUpload={props.onFileUpload ? uploadFile : undefined}
            fileUploadingParam={pendingAction.startsWith("upload:") ? pendingAction.slice(7) : undefined}
            onOpenAttachment={props.onOpenAttachment}
            onResolveAttachmentPreview={props.onResolveAttachmentPreview}
            auxiliaryOpen
            hideAuxiliaryToggle
          />
        </div>
      ) : null}
      {actionError && !renameDialogOpen && !deleteConfirmOpen ? (
        <div className="kanban-inline-error" role="alert">
          <span>{actionError}</span>
          {!failedSave && failedAction ? (
            <button
              type="button"
              disabled={pendingAction !== ""}
              onClick={() => void runAction(failedAction.key, failedAction.action, failedAction.label)}
            >{t("retry")}{failedAction.label}</button>
          ) : null}
        </div>
      ) : null}
    </div>
  ) : undefined;
  const preview = (
    <KanbanPreviewFrame
      projectName={props.projectName}
      previewUrl={props.previewUrl}
      previewNonce={props.previewNonce}
      presentationMode={props.presentationMode}
      configuration={injectedConfiguration}
      onRetry={props.onRetry}
      onBridgeRequest={props.onBridgeRequest}
      methodRegistry={props.methodRegistry}
      methodTarget={props.methodTarget}
      relatedProjectRevisions={props.relatedProjectRevisions}
      relatedProjectWarning={props.relatedProjectWarning}
    />
  );
  const drawerBackdrop = drawerOpen
    ? <button type="button" className="kanban-drawer-backdrop" aria-label={t("closeParams")} onClick={closeDrawer} />
    : null;

  return (
    <section ref={workspaceRef} className="kanban-workspace" data-has-params={hasParams ? "true" : "false"}>
      {props.renderLayout ? props.renderLayout({ configuration, preview, mobileTrigger, drawerOpen, drawerBackdrop }) : (
        <div className="kanban-workspace-layout">
          {mobileTrigger}
          {configuration ? (
            <aside
              className="kanban-configuration-panel"
              data-mobile-open={drawerOpen ? "true" : "false"}
              aria-label={t("kanbanConfiguration")}
            >
              {configuration}
            </aside>
          ) : null}
          {preview}
          {drawerBackdrop}
        </div>
      )}
      {renameDialogOpen && active ? (
        <div className="kanban-confirm-backdrop">
          <form
            ref={renameDialogRef}
            className="kanban-confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="kanban-rename-configuration-title"
            onSubmit={(event) => { event.preventDefault(); void commitName(); }}
          >
            <strong id="kanban-rename-configuration-title">{t("renameConfiguration")}</strong>
            <label className="kanban-dialog-field">
              <span>{t("configurationName")}</span>
              <input ref={renameInputRef} value={nameDraft} disabled={pendingAction !== ""} onChange={(event) => setNameDraft(event.target.value)} />
            </label>
            {failedAction?.key === "rename" && actionError ? <span className="kanban-dialog-error" role="alert">{actionError}</span> : null}
            <div>
              <button type="button" disabled={pendingAction !== ""} onClick={() => setRenameDialogOpen(false)}>{t("cancel")}</button>
              <button type="submit" disabled={pendingAction !== "" || nameDraft.trim() === ""}>
                {pendingAction === "rename" ? <Loader2 className="kanban-spin" /> : <Check />}{t("save")}
              </button>
            </div>
          </form>
        </div>
      ) : null}
      {deleteConfirmOpen && active ? (
        <div className="kanban-confirm-backdrop">
          <div
            ref={deleteDialogRef}
            className="kanban-confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="kanban-delete-configuration-title"
          >
            <strong id="kanban-delete-configuration-title">{t("deleteConfigurationConfirm", { name: active.name })}</strong>
            <span>{t("deleteConfigurationWarning")}</span>
            {failedAction?.key === "delete" && actionError ? <span className="kanban-dialog-error" role="alert">{actionError}</span> : null}
            <div>
              <button ref={deleteCancelRef} type="button" disabled={pendingAction !== ""} onClick={() => setDeleteConfirmOpen(false)}>{t("cancel")}</button>
              <button
                type="button"
                className="kanban-danger-action"
                disabled={pendingAction !== ""}
                onClick={() => void (async () => {
                  const deleted = await runAction("delete", () => props.onDeleteConfiguration(active.id), t("deleteConfiguration"));
                  if (deleted) setDeleteConfirmOpen(false);
                })()}
              >{pendingAction === "delete" ? <Loader2 className="kanban-spin" /> : <Trash2 />}{t("deleteConfiguration")}</button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function KanbanStatus({ icon: Icon, title, detail, spinning, action }: {
  icon: typeof Loader2;
  title: string;
  detail: string;
  spinning?: boolean;
  action?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="kanban-status" role={action ? "alert" : "status"}>
      <Icon className={spinning ? "kanban-spin" : ""} aria-hidden="true" />
      <strong>{title}</strong>
      <span>{detail}</span>
      {action ? <button type="button" onClick={action}><RefreshCw />{t("retry")}</button> : null}
    </div>
  );
}

function readErrorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
