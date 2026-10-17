import {
  ChevronDown,
  ChevronUp,
  Clipboard,
  Film,
  Image as ImageIcon,
  Loader2,
  Paperclip,
  SlidersHorizontal,
  X,
} from "lucide-react";
import React from "react";
import { createPortal } from "react-dom";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, RefObject } from "react";
import { mergeFileReferences, parseFileParamReferences, serializeFileParamReferences } from "../utils/files";
import { isMultiParam, readMultiParamValues, resolveParamDefinition, writeMultiParamValues } from "../utils/params";
import type { WorkflowManagedFileReference, WorkflowParamDefinition, WorkflowParamOption, WorkflowParamStatePatch } from "../types";
import { AttachmentStrip, isImageFileReference, isVideoFileReference } from "../ui/attachment";
import { SecondaryButton } from "../ui/buttons";
import { resolveRwiClassName, rwiClass } from "../styles";
import { useModalFocus } from "../hooks/useOverlayFocus";
import { useTranslation } from "@steamharness/i18n/react";

export function ParamsForm({
  className,
  variant = "default",
  params,
  states,
  values,
  disabled,
  onChange,
  onFileUpload,
  onUploadFileObjects,
  onAddClipboardImage,
  onOpenAttachment,
  onResolveAttachmentPreview,
  fileUploadingParam,
  clipboardImageParam,
  onAuxiliaryOpenChange,
  auxiliaryToggleDisabled,
  auxiliaryOpen: controlledAuxiliaryOpen,
  auxiliaryPopoverAnchorRef,
  auxiliaryPresentation = "inline",
  hideAuxiliaryToggle = false,
  showValidationErrors = true,
  onSubmitRequest,
}: {
  className?: string;
  variant?: "default" | "settings";
  params?: WorkflowParamDefinition[];
  states?: Record<string, WorkflowParamStatePatch>;
  values?: Record<string, string>;
  disabled?: boolean;
  onChange: (paramName: string, value: string) => void;
  onFileUpload?: (param: WorkflowParamDefinition) => Promise<WorkflowManagedFileReference[]>;
  onUploadFileObjects?: import("../types").WorkflowFileObjectsUploader;
  onAddClipboardImage?: (param: WorkflowParamDefinition) => Promise<WorkflowManagedFileReference[]>;
  onOpenAttachment?: (file: WorkflowManagedFileReference, options?: { download?: boolean }) => Promise<void> | void;
  onResolveAttachmentPreview?: (file: WorkflowManagedFileReference) => Promise<string | undefined> | string | undefined;
  fileUploadingParam?: string;
  clipboardImageParam?: string;
  onAuxiliaryOpenChange?: (open: boolean) => void;
  auxiliaryToggleDisabled?: boolean;
  auxiliaryOpen?: boolean;
  auxiliaryPopoverAnchorRef?: RefObject<HTMLElement | null>;
  auxiliaryPresentation?: "inline" | "popover";
  hideAuxiliaryToggle?: boolean;
  showValidationErrors?: boolean;
  onSubmitRequest?: () => void;
}) {
  const { t } = useTranslation();
  const [uncontrolledAuxiliaryOpen, setUncontrolledAuxiliaryOpen] = useState(false);
  const [auxiliaryPopoverStyle, setAuxiliaryPopoverStyle] = useState<CSSProperties>();
  const auxiliaryToggleRef = useRef<HTMLButtonElement | null>(null);
  const auxiliaryPopoverRef = useRef<HTMLDivElement | null>(null);
  const auxiliaryPopoverCloseRef = useRef<HTMLButtonElement | null>(null);
  const auxiliaryAnchorRef = auxiliaryPopoverAnchorRef ?? auxiliaryToggleRef;
  const auxiliaryOpen = controlledAuxiliaryOpen ?? uncontrolledAuxiliaryOpen;
  const safeParams = (Array.isArray(params) ? params : [])
    .filter((param) => states?.[param.name]?.visible !== false)
    .map((param) => resolveParamDefinition(param, states?.[param.name]));
  const safeValues = values ?? {};
  const mainParams = safeParams.filter((param) => param.panel !== "auxiliary" && param.panel !== "quick");
  const auxiliaryParams = safeParams.filter((param) => param.panel === "auxiliary");
  const showAuxiliaryPopover = auxiliaryPresentation === "popover";
  // lets conversation composers render the advanced trigger in the
  // footer so single-field forms do not reserve empty space inside the form.
  const paramsFormClassName = rwiClass(
    "rwi-params-form",
    showAuxiliaryPopover && !hideAuxiliaryToggle ? "compact-aux" : undefined,
    variant === "settings" ? "settings" : undefined,
  );
  const resolvedClassName = [paramsFormClassName, resolveRwiClassName(className)].filter(Boolean).join(" ");
  const setAuxiliaryOpenState = useCallback((open: boolean) => {
    if (controlledAuxiliaryOpen === undefined) {
      setUncontrolledAuxiliaryOpen(open);
    }
    onAuxiliaryOpenChange?.(open);
  }, [controlledAuxiliaryOpen, onAuxiliaryOpenChange]);
  const handleAuxiliaryToggle = useCallback(() => {
    setAuxiliaryOpenState(!auxiliaryOpen);
  }, [auxiliaryOpen, setAuxiliaryOpenState]);
  const closeAuxiliaryPopover = useCallback(() => {
    setAuxiliaryOpenState(false);
  }, [setAuxiliaryOpenState]);
  useModalFocus({
    active: auxiliaryOpen && showAuxiliaryPopover,
    containerRef: auxiliaryPopoverRef,
    initialFocusRef: auxiliaryPopoverCloseRef,
    onClose: closeAuxiliaryPopover,
    returnFocusRef: auxiliaryAnchorRef,
    trapFocus: false,
  });
  const updateAuxiliaryPopoverPosition = useCallback(() => {
    if (!auxiliaryOpen || !showAuxiliaryPopover) {
      setAuxiliaryPopoverStyle(undefined);
      return;
    }

    const anchor = auxiliaryAnchorRef.current;
    if (!anchor || typeof window === "undefined") {
      setAuxiliaryPopoverStyle(undefined);
      return;
    }

    const rect = anchor.getBoundingClientRect();
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 1024;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 768;
    const edgePadding = 12;
    const gap = 8;
    const panelWidth = Math.min(336, Math.max(240, viewportWidth - edgePadding * 2));
    const left = Math.min(
      Math.max(edgePadding, rect.left),
      Math.max(edgePadding, viewportWidth - panelWidth - edgePadding),
    );
    const spaceAbove = rect.top - edgePadding - gap;
    const spaceBelow = viewportHeight - rect.bottom - edgePadding - gap;
    const placeAbove = spaceAbove >= 180 || spaceAbove >= spaceBelow;
    const maxHeight = Math.max(160, Math.min(320, placeAbove ? spaceAbove : spaceBelow));

    // Advanced options must escape composer overflow. The panel is
    // portaled to body and pinned to the trigger's viewport rect.
    setAuxiliaryPopoverStyle(placeAbove
      ? {
          left,
          bottom: Math.max(edgePadding, viewportHeight - rect.top + gap),
          width: panelWidth,
          maxHeight,
        }
      : {
          left,
          top: Math.min(viewportHeight - edgePadding - maxHeight, rect.bottom + gap),
          width: panelWidth,
          maxHeight,
        });
  }, [auxiliaryAnchorRef, auxiliaryOpen, showAuxiliaryPopover]);
  useEffect(() => {
    if (!auxiliaryOpen || !showAuxiliaryPopover) return undefined;

    updateAuxiliaryPopoverPosition();
    window.addEventListener("resize", updateAuxiliaryPopoverPosition);
    window.addEventListener("scroll", updateAuxiliaryPopoverPosition, true);
    return () => {
      window.removeEventListener("resize", updateAuxiliaryPopoverPosition);
      window.removeEventListener("scroll", updateAuxiliaryPopoverPosition, true);
    };
  }, [auxiliaryOpen, showAuxiliaryPopover, updateAuxiliaryPopoverPosition]);
  useEffect(() => {
    if (!auxiliaryOpen || !showAuxiliaryPopover) return undefined;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        auxiliaryPopoverRef.current?.contains(target) ||
        auxiliaryAnchorRef.current?.contains(target) ||
        (target instanceof Element && target.closest(
          '[data-slot="rwi-date-popover"], [data-slot="rwi-calendar-wheel-popover"]',
        ))
      ) return;
      closeAuxiliaryPopover();
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [auxiliaryAnchorRef, auxiliaryOpen, closeAuxiliaryPopover, showAuxiliaryPopover]);
  const handleKeyDownCapture = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (onSubmitRequest === undefined || !shouldSubmitParamsFormOnEnter(event)) {
      return;
    }

    event.preventDefault();
    onSubmitRequest();
  }, [onSubmitRequest]);

  return (
    <div className={resolvedClassName} onKeyDownCapture={handleKeyDownCapture}>
      {mainParams.map((param) => (
        <ParamField
          key={param.name}
          param={param}
          value={safeValues[param.name] ?? ""}
          disabled={disabled || states?.[param.name]?.disabled === true}
          onChange={(value) => onChange(param.name, value)}
          onFileUpload={onFileUpload}
          onUploadFileObjects={onUploadFileObjects}
          onAddClipboardImage={onAddClipboardImage}
          onOpenAttachment={onOpenAttachment}
          onResolveAttachmentPreview={onResolveAttachmentPreview}
          fileUploading={fileUploadingParam === param.name}
          clipboardImageLoading={clipboardImageParam === param.name}
          variant={variant}
          showValidationErrors={showValidationErrors}
        />
      ))}
      {auxiliaryParams.length > 0 && showAuxiliaryPopover ? (
        <div className={auxiliaryOpen ? rwiClass("rwi-aux-popover", "open") : rwiClass("rwi-aux-popover")}>
          {!hideAuxiliaryToggle && (
            <button
              ref={auxiliaryToggleRef}
              type="button"
              className={rwiClass("rwi-aux-popover-toggle")}
              // Conversation advanced options stay as a compact local
              // control instead of taking over the composer form area.
              disabled={auxiliaryToggleDisabled}
              onClick={handleAuxiliaryToggle}
              aria-expanded={auxiliaryOpen}
              aria-label={t("advancedOptions")}
              title={t("advancedOptions")}
            >
              <SlidersHorizontal size={13} />
              <small>{auxiliaryParams.length}</small>
            </button>
          )}
          {auxiliaryOpen && typeof document !== "undefined" && createPortal(
            <div
              ref={auxiliaryPopoverRef}
              className={rwiClass("rwi-aux-popover-panel")}
              role="dialog"
              aria-modal="false"
              aria-label={t("advancedOptions")}
              tabIndex={-1}
              style={auxiliaryPopoverStyle ?? { visibility: "hidden" }}
            >
              <div className={rwiClass("rwi-aux-popover-header")}>
                <strong>{t("advancedOptions")}</strong>
                <button
                  ref={auxiliaryPopoverCloseRef}
                  type="button"
                  onClick={closeAuxiliaryPopover}
                  aria-label={t("closeAdvancedOptions")}
                  title={t("closeAdvancedOptions")}
                >
                  <X size={12} />
                </button>
              </div>
              <div className={rwiClass("rwi-aux-fields")}>
                {auxiliaryParams.map((param) => (
                  <ParamField
                    key={param.name}
                    param={param}
                    value={safeValues[param.name] ?? ""}
                    disabled={disabled || states?.[param.name]?.disabled === true}
                    onChange={(value) => onChange(param.name, value)}
                    onFileUpload={onFileUpload}
                    onUploadFileObjects={onUploadFileObjects}
                    onAddClipboardImage={onAddClipboardImage}
                    onOpenAttachment={onOpenAttachment}
                    onResolveAttachmentPreview={onResolveAttachmentPreview}
                    fileUploading={fileUploadingParam === param.name}
                    clipboardImageLoading={clipboardImageParam === param.name}
                    variant={variant}
                    showValidationErrors={showValidationErrors}
                  />
                ))}
              </div>
            </div>,
            document.body,
          )}
        </div>
      ) : auxiliaryParams.length > 0 ? (
        <div className={auxiliaryOpen ? rwiClass("rwi-aux-panel", "open") : rwiClass("rwi-aux-panel")}>
          <button
            type="button"
            className={rwiClass("rwi-aux-toggle")}
            // Keep the secondary panel toggle usable while field
            // controls are disabled during an active conversation run.
            disabled={auxiliaryToggleDisabled}
            onClick={handleAuxiliaryToggle}
            aria-expanded={auxiliaryOpen}
          >
            <ChevronDown size={13} />
            <span>{t("advancedOptions")}</span>
            <small>{auxiliaryParams.length}</small>
          </button>
          {auxiliaryOpen && (
            <div className={rwiClass("rwi-aux-fields")}>
              {auxiliaryParams.map((param) => (
                <ParamField
                  key={param.name}
                  param={param}
                  value={safeValues[param.name] ?? ""}
                  disabled={disabled || states?.[param.name]?.disabled === true}
                  onChange={(value) => onChange(param.name, value)}
                  onFileUpload={onFileUpload}
                  onUploadFileObjects={onUploadFileObjects}
                  onAddClipboardImage={onAddClipboardImage}
                  onOpenAttachment={onOpenAttachment}
                  onResolveAttachmentPreview={onResolveAttachmentPreview}
                  fileUploading={fileUploadingParam === param.name}
                  clipboardImageLoading={clipboardImageParam === param.name}
                  variant={variant}
                  showValidationErrors={showValidationErrors}
                />
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function shouldSubmitParamsFormOnEnter(event: React.KeyboardEvent<HTMLDivElement>): boolean {
  if (
    event.key !== "Enter" ||
    event.shiftKey ||
    event.altKey ||
    event.nativeEvent.isComposing
  ) {
    return false;
  }

  const target = event.target;
  if (target instanceof HTMLTextAreaElement) {
    // textarea prompt fields keep plain Enter as newline; command/control Enter sends.
    return event.metaKey || event.ctrlKey;
  }

  if (!(target instanceof HTMLInputElement)) {
    return false;
  }

  return !event.metaKey &&
    !event.ctrlKey &&
    (target.type === "text" ||
    target.type === "number" ||
    target.type === "search" ||
    target.type === "email" ||
    target.type === "url" ||
    target.type === "tel");
}

function ParamField({
  param,
  value,
  disabled,
  onChange,
  onFileUpload,
  onUploadFileObjects,
  onAddClipboardImage,
  onOpenAttachment,
  onResolveAttachmentPreview,
  fileUploading = false,
  clipboardImageLoading = false,
  variant = "default",
  showValidationErrors = true,
}: {
  param: WorkflowParamDefinition;
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  onFileUpload?: (param: WorkflowParamDefinition) => Promise<WorkflowManagedFileReference[]>;
  onUploadFileObjects?: import("../types").WorkflowFileObjectsUploader;
  onAddClipboardImage?: (param: WorkflowParamDefinition) => Promise<WorkflowManagedFileReference[]>;
  onOpenAttachment?: (file: WorkflowManagedFileReference, options?: { download?: boolean }) => Promise<void> | void;
  onResolveAttachmentPreview?: (file: WorkflowManagedFileReference) => Promise<string | undefined> | string | undefined;
  fileUploading?: boolean;
  clipboardImageLoading?: boolean;
  variant?: "default" | "settings";
  showValidationErrors?: boolean;
}) {
  const { t } = useTranslation();
  const id = `param-${param.name}`;
  const fallbackPlaceholder = param.flag
    ? `${param.flag}${param.shortFlag ? ` / ${param.shortFlag}` : ""}`
    : param.name;
  const placeholder = param.description?.trim() || fallbackPlaceholder;
  const fileRefs = param.type === "file" ? parseFileParamReferences(value) : [];
  const imageRefs = fileRefs.filter(isImageFileReference);
  // Image file params are visual attachments in the App composer;
  // keep the JSON refs in args while hiding them from the editable surface.
  const isImageFileParam = param.type === "file" && (
    param.accept?.some((accept) => /^(image\/|\.(png|jpe?g|gif|webp|svg)$)/i.test(accept.trim())) === true ||
    param.name.toLowerCase().includes("image") ||
    imageRefs.length > 0
  );
  const isVideoFileParam = param.type === "file" && (
    param.accept?.some((accept) => /^(video\/|\.(mp4|m4v|mov|avi|mkv|webm|ogv|mpeg|mpg)$)/i.test(accept.trim())) === true ||
    fileRefs.some(isVideoFileReference)
  );
  const uploadLabel = isVideoFileParam ? t(isImageFileParam ? "uploadImageVideo" : "uploadVideo") : t("uploadImage");
  const canUploadFile = param.type === "file" && onFileUpload !== undefined;
  const canAddClipboardImage = isImageFileParam && onAddClipboardImage !== undefined;
  const hasOptions = (param.options?.length ?? 0) > 0;
  const optionControl = resolveOptionControl(param);
  const hasOptionDefinition = param.options !== undefined ||
    param.control === "select" || param.control === "radio" || param.control === "checkboxes";

  const handleFileUpload = useCallback(() => {
    if (!canUploadFile || fileUploading || disabled) return;

    void onFileUpload(param).then((refs) => {
      if (refs.length === 0) return;
      const nextRefs = param.multiple === false ? refs.slice(0, 1) : mergeFileReferences(fileRefs, refs);
      onChange(serializeFileParamReferences(nextRefs));
    });
  }, [canUploadFile, disabled, fileRefs, fileUploading, onChange, onFileUpload, param]);

  const handleAddClipboardImage = useCallback(() => {
    if (!canAddClipboardImage || clipboardImageLoading || disabled) return;

    void onAddClipboardImage(param).then((refs) => {
      if (refs.length === 0) return;
      const nextRefs = param.multiple === false ? refs.slice(0, 1) : mergeFileReferences(fileRefs, refs);
      onChange(serializeFileParamReferences(nextRefs));
    });
  }, [canAddClipboardImage, clipboardImageLoading, disabled, fileRefs, onAddClipboardImage, onChange, param]);

  const handleRemoveFile = useCallback((fileId: string) => {
    onChange(serializeFileParamReferences(fileRefs.filter((ref) => ref.id !== fileId)));
  }, [fileRefs, onChange]);

  const fieldLabel = param.label ?? param.name;
  const showRequiredMarker = param.required === true;
  const fieldLabelId = `${id}-label`;
  const isOptionGroup = hasOptions && (optionControl === "radio" || optionControl === "checkboxes");

  return (
    <div className={rwiClass("rwi-param-field")}>
      <label id={fieldLabelId} htmlFor={isOptionGroup ? undefined : id} title={param.description}>{showRequiredMarker ? `${fieldLabel} *` : fieldLabel}</label>
      <div className={rwiClass("rwi-param-control")}>
        {param.type === "boolean" ? (
          <div className={rwiClass("rwi-switch-line")}>
            <label className={disabled ? rwiClass("rwi-switch-control", "disabled") : rwiClass("rwi-switch-control")} htmlFor={id}>
              <input
                id={id}
                type="checkbox"
                checked={value === "true"}
                disabled={disabled}
                onChange={(event) => onChange(event.target.checked ? "true" : "false")}
              />
              <span className={rwiClass("rwi-switch-track")} aria-hidden="true">
                <span className={rwiClass("rwi-switch-thumb")} />
              </span>
            </label>
            {/* Show the boolean's on / off state as "是" / "否"
                so a user looking at a single confirmation toggle does not
                have to parse the internal flag or the on/off direction of
                the switch on their own. The flag hint stays after the
                state for debugging but is dimmed via the existing
                .rwi-switch-line styles. */}
            <span className={value === "true" ? rwiClass("rwi-switch-state", "on") : rwiClass("rwi-switch-state")}>
              {value === "true" ? t("booleanYes") : t("booleanNo")}
            </span>
            <span className={rwiClass("rwi-switch-flag")}>{param.flag ? `${param.flag}${param.shortFlag ? ` / ${param.shortFlag}` : ""}` : param.name}</span>
          </div>
        ) : hasOptionDefinition && !hasOptions ? (
          <span className={rwiClass("rwi-param-empty")} role="status">{t("noOptions")}</span>
        ) : hasOptions && optionControl === "checkboxes" ? (
          <CheckboxOptions
            id={id}
            paramName={param.name}
            options={param.options ?? []}
            value={value}
            disabled={disabled}
            onChange={onChange}
            labelId={fieldLabelId}
          />
        ) : hasOptions && optionControl === "radio" ? (
          <RadioOptions
            id={id}
            paramName={param.name}
            options={param.options ?? []}
            value={value}
            disabled={disabled}
            onChange={onChange}
            labelId={fieldLabelId}
            segmented={variant === "settings"
              && (param.options?.length ?? 0) >= 2
              && (param.options?.length ?? 0) <= 7
              && param.options?.every((option) => !option.description) === true}
          />
        ) : hasOptions && optionControl === "select" ? (
          <select
            id={id}
            value={value}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value)}
            className={rwiClass("rwi-input", "rwi-select")}
          >
            {!param.required && <option value="">{t("notSet")}</option>}
            {(param.options ?? []).map((option) => (
              <option key={option.value} value={option.value}>
                {option.label ?? option.value}
              </option>
            ))}
          </select>
        ) : param.type === "file" && (isImageFileParam || isVideoFileParam) ? (
          <div className={rwiClass("rwi-file-field", "rwi-image-file-field")}>
            <div className={rwiClass("rwi-image-picker-row")}>
              <SecondaryButton disabled={!canUploadFile || fileUploading || disabled} onClick={handleFileUpload} title={uploadLabel}>
                {fileUploading ? <Loader2 className={rwiClass("rwi-spin")} size={14} /> : isVideoFileParam ? <Film size={14} /> : <ImageIcon size={14} />}
                {uploadLabel}
              </SecondaryButton>
              {isImageFileParam && (
              <SecondaryButton disabled={!canAddClipboardImage || clipboardImageLoading || disabled} onClick={handleAddClipboardImage} title={t("addClipboardImage")}>
                {clipboardImageLoading ? <Loader2 className={rwiClass("rwi-spin")} size={14} /> : <Clipboard size={14} />}
                {t("addClipboardImage")}
              </SecondaryButton>
              )}
              {fileRefs.length > 0 && (
                <span className={rwiClass("rwi-image-count")}>{t(isVideoFileParam ? "selectedCount" : "imageCount", { count: fileRefs.length })}</span>
              )}
            </div>
            {fileRefs.length > 0 && (
              <AttachmentStrip
                attachments={fileRefs}
                compact
                thumbnail
                onRemove={handleRemoveFile}
                onOpenAttachment={onOpenAttachment}
                onResolveAttachmentPreview={onResolveAttachmentPreview}
              />
            )}
          </div>
        ) : param.type === "file" ? (
          <div className={rwiClass("rwi-file-field")}>
            <div className={rwiClass("rwi-file-row")}>
              <input
                id={id}
                type="text"
                value={value}
                disabled={disabled}
                onChange={(event) => onChange(event.target.value)}
                placeholder={placeholder}
                className={rwiClass("rwi-input", "rwi-mono")}
              />
              <SecondaryButton disabled={!canUploadFile || fileUploading || disabled} onClick={handleFileUpload} title={t("uploadFile")}>
                {fileUploading ? <Loader2 className={rwiClass("rwi-spin")} size={14} /> : <Paperclip size={14} />}
                {t("upload")}
              </SecondaryButton>
            </div>
            {fileRefs.length > 0 && (
              <AttachmentStrip
                attachments={fileRefs}
                compact
                onRemove={handleRemoveFile}
                onOpenAttachment={onOpenAttachment}
                onResolveAttachmentPreview={onResolveAttachmentPreview}
              />
            )}
          </div>
        ) : param.type === "number" ? (
          <NumberStepper
            id={id}
            value={value}
            disabled={disabled}
            onChange={onChange}
            placeholder={placeholder}
          />
        ) : param.control === "textarea" ? (
          <textarea
            id={id}
            value={value}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value)}
            placeholder={placeholder}
            className={rwiClass("rwi-input", "rwi-param-textarea", "rwi-mono")}
          />
        ) : (
          <input
            id={id}
            type="text"
            value={value}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value)}
            placeholder={placeholder}
            className={rwiClass("rwi-input", "rwi-mono")}
          />
        )}
      </div>
    </div>
  );
}

function NumberStepper({
  id,
  value,
  disabled,
  onChange,
  placeholder,
}: {
  id: string;
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  const { t } = useTranslation();
  const stepValue = useCallback((direction: 1 | -1) => {
    const current = Number(value);
    const base = Number.isFinite(current) ? current : 0;
    onChange(String(base + direction));
  }, [onChange, value]);

  return (
    <div className={disabled ? rwiClass("rwi-number-stepper", "disabled") : rwiClass("rwi-number-stepper")}>
      <input
        id={id}
        type="number"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className={rwiClass("rwi-input", "rwi-mono")}
      />
      <div className={rwiClass("rwi-number-stepper-actions")}>
        <button
          type="button"
          disabled={disabled}
          onClick={() => stepValue(1)}
          aria-label={t("increaseValue")}
          title={t("increaseValue")}
        >
          <ChevronUp size={12} />
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => stepValue(-1)}
          aria-label={t("decreaseValue")}
          title={t("decreaseValue")}
        >
          <ChevronDown size={12} />
        </button>
      </div>
    </div>
  );
}

function resolveOptionControl(param: WorkflowParamDefinition): "radio" | "select" | "checkboxes" | "text" | "textarea" {
  if (param.control === "checkboxes" || isMultiParam(param)) {
    return "checkboxes";
  }

  if (param.control === "radio" || param.control === "select" || param.control === "text" || param.control === "textarea") {
    return param.control;
  }

  return (param.options?.length ?? 0) <= 4 ? "radio" : "select";
}

function RadioOptions({
  id,
  paramName,
  options,
  value,
  disabled,
  onChange,
  labelId,
  segmented = false,
}: {
  id: string;
  paramName: string;
  options: WorkflowParamOption[];
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  labelId: string;
  segmented?: boolean;
}) {
  return (
    <div
      className={rwiClass("rwi-option-list", "radio", segmented ? "segmented" : undefined)}
      role="radiogroup"
      aria-labelledby={labelId}
    >
      {options.map((option, index) => (
        <label key={option.value} className={rwiClass("rwi-option-item")}>
          <input
            id={index === 0 ? id : undefined}
            type="radio"
            name={paramName}
            value={option.value}
            checked={value === option.value}
            disabled={disabled}
            onChange={() => onChange(option.value)}
          />
          <OptionLabel option={option} />
        </label>
      ))}
    </div>
  );
}

function CheckboxOptions({
  id,
  paramName,
  options,
  value,
  disabled,
  onChange,
  labelId,
}: {
  id: string;
  paramName: string;
  options: WorkflowParamOption[];
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  labelId: string;
}) {
  const selected = new Set(readMultiParamValues(value));

  return (
    <div className={rwiClass("rwi-option-list", "checkboxes")} role="group" aria-labelledby={labelId}>
      {options.map((option, index) => (
        <label key={option.value} className={rwiClass("rwi-option-item")}>
          <input
            id={index === 0 ? id : undefined}
            type="checkbox"
            name={`${paramName}-${option.value}`}
            value={option.value}
            checked={selected.has(option.value)}
            disabled={disabled}
            onChange={(event) => {
              const next = new Set(selected);
              if (event.target.checked) next.add(option.value);
              else next.delete(option.value);
              onChange(writeMultiParamValues(options
                .map((item) => item.value)
                .filter((item) => next.has(item))));
            }}
          />
          <OptionLabel option={option} />
        </label>
      ))}
    </div>
  );
}

function OptionLabel({ option }: { option: WorkflowParamOption }) {
  const color = resolveOptionColor(option.value);
  return (
    <span className={rwiClass("rwi-option-copy")}>
      {color ? (
        <span className={rwiClass("rwi-option-label-line")}>
          <span
            aria-hidden="true"
            data-slot="rwi-option-color-swatch"
            className={rwiClass("rwi-option-color-swatch")}
            style={{ "--rwi-option-color": color } as CSSProperties}
          />
          <strong>{option.label ?? option.value}</strong>
        </span>
      ) : (
        <strong>{option.label ?? option.value}</strong>
      )}
      {option.description && <small>{option.description}</small>}
    </span>
  );
}

function resolveOptionColor(value: string): string | undefined {
  const normalized = value.trim();
  return /^#[\da-f]{6}$/i.test(normalized) ? normalized : undefined;
}
