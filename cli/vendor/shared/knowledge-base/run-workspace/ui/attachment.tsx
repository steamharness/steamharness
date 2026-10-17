import {
  Image as ImageIcon,
  Loader2,
  RotateCcw,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import React from "react";
import { createPortal } from "react-dom";
import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { TransformComponent, TransformWrapper, type ReactZoomPanPinchRef } from "react-zoom-pan-pinch";
import { useModalFocus } from "../hooks/useOverlayFocus";
import { formatImagePreviewError } from "../utils/labels";
import { rwiClass } from "../styles";
import { useTranslation } from "@steamharness/i18n/react";

const imagePreviewMinScale = 0.5;
const imagePreviewMaxScale = 4;
const imagePreviewScaleStep = 0.25;
const imagePreviewSmoothScaleStep = Math.log(1 + imagePreviewScaleStep);
const isImagePreviewZoomModifierActive = (keys: string[]) => keys.includes("Meta") || keys.includes("Control");

export function ImagePreviewDialog({
  alt,
  closeButtonRef,
  error,
  loading = false,
  onClose,
  returnFocusRef,
  src,
  subtitle,
  title,
}: {
  alt: string;
  closeButtonRef: RefObject<HTMLButtonElement | null>;
  error?: string;
  loading?: boolean;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
  src?: string;
  subtitle?: string;
  title: string;
}) {
  const { t } = useTranslation();
  const [scale, setScale] = useState(1);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const transformRef = useRef<ReactZoomPanPinchRef | null>(null);
  useModalFocus({
    containerRef: dialogRef,
    initialFocusRef: closeButtonRef,
    onClose,
    returnFocusRef,
  });
  const handleTransformInit = useCallback((ref: ReactZoomPanPinchRef) => {
    transformRef.current = ref;
    setScale(ref.state.scale);
  }, []);
  const handleTransform = useCallback((_ref: ReactZoomPanPinchRef, state: { scale: number }) => {
    setScale(state.scale);
  }, []);
  const zoomOut = useCallback(() => {
    transformRef.current?.zoomOut(imagePreviewSmoothScaleStep, 0);
  }, []);
  const zoomIn = useCallback(() => {
    transformRef.current?.zoomIn(imagePreviewSmoothScaleStep, 0);
  }, []);
  const resetZoom = useCallback(() => {
    transformRef.current?.resetTransform(0);
  }, []);
  const canZoomOut = scale > imagePreviewMinScale;
  const canZoomIn = scale < imagePreviewMaxScale;

  useEffect(() => {
    if (!src || loading) return undefined;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        zoomIn();
      } else if (event.key === "-") {
        event.preventDefault();
        zoomOut();
      } else if (event.key === "0") {
        event.preventDefault();
        resetZoom();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [loading, resetZoom, src, zoomIn, zoomOut]);

  const dialog = (
    <div
      className={rwiClass("rwi-image-preview-layer")}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        ref={dialogRef}
        className={rwiClass("rwi-image-preview-dialog")}
        role="dialog"
        aria-modal="true"
        aria-label={t("attachmentPreview", { name: title })}
        tabIndex={-1}
      >
        <div className={rwiClass("rwi-image-preview-head")}>
          <div className={rwiClass("rwi-image-preview-title")}>
            <strong>{title}</strong>
            {subtitle && <span>{subtitle}</span>}
          </div>
          <div className={rwiClass("rwi-image-preview-actions")} role="toolbar" aria-label={t("imageZoomControls")}>
            <button
              type="button"
              className={rwiClass("rwi-image-preview-tool")}
              onClick={() => zoomOut()}
              disabled={!src || loading || !canZoomOut}
              title={t("imagePreviewZoomOut")}
              aria-label={t("imagePreviewZoomOut")}
            >
              <ZoomOut size={14} />
            </button>
            <span className={rwiClass("rwi-image-preview-scale")} aria-label={t("imageZoomScale", { percent: Math.round(scale * 100) })}>
              {Math.round(scale * 100)}%
            </span>
            <button
              type="button"
              className={rwiClass("rwi-image-preview-tool")}
              onClick={() => zoomIn()}
              disabled={!src || loading || !canZoomIn}
              title={t("imagePreviewZoomIn")}
              aria-label={t("imagePreviewZoomIn")}
            >
              <ZoomIn size={14} />
            </button>
            <button
              type="button"
              className={rwiClass("rwi-image-preview-tool")}
              onClick={() => resetZoom()}
              disabled={!src || loading || scale === 1}
              title={t("imagePreviewResetZoom")}
              aria-label={t("imagePreviewResetZoom")}
            >
              <RotateCcw size={14} />
            </button>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            className={rwiClass("rwi-image-preview-close")}
            onClick={onClose}
            title={t("imagePreviewClose")}
            aria-label={t("imagePreviewClose")}
          >
            <X size={14} />
          </button>
        </div>
        <div
          className={src && !loading ? rwiClass("rwi-image-preview-stage") : rwiClass("rwi-image-preview-stage", "status")}
          data-slot="rwi-image-preview-stage"
        >
          {loading ? (
            <div className={rwiClass("rwi-image-preview-status")}>
              <Loader2 className={rwiClass("rwi-spin")} size={18} />
              <span>{t("imagePreviewLoading")}</span>
            </div>
          ) : src ? (
            // gpt-image data URL previews use a mature transform
            // engine so pointer-anchored wheel/pinch zoom and drag pan stay consistent.
            <TransformWrapper
              ref={transformRef}
              initialScale={1}
              minScale={imagePreviewMinScale}
              maxScale={imagePreviewMaxScale}
              centerOnInit
              centerZoomedOut
              wheel={{ activationKeys: isImagePreviewZoomModifierActive, step: imagePreviewScaleStep / 90 }}
              panning={{ disabled: scale <= 1, allowLeftClickPan: true, allowMiddleClickPan: false, allowRightClickPan: false }}
              trackPadPanning={{ disabled: scale <= 1 }}
              pinch={{ step: 5, allowPanning: true }}
              doubleClick={{ mode: "toggle", step: imagePreviewSmoothScaleStep, animationTime: 140 }}
              velocityAnimation={{ disabled: true }}
              zoomAnimation={{ animationTime: 120, animationType: "easeOut" }}
              onInit={handleTransformInit}
              onTransform={handleTransform}
            >
              <TransformComponent
                wrapperClass={scale > 1
                  ? rwiClass("rwi-image-preview-transform", "zoomed")
                  : rwiClass("rwi-image-preview-transform")}
                contentClass={rwiClass("rwi-image-preview-transform-content")}
              >
                <img
                  src={src}
                  alt={alt}
                  data-zoomed={scale === 1 ? undefined : "true"}
                />
              </TransformComponent>
            </TransformWrapper>
          ) : (
            <div className={rwiClass("rwi-image-preview-status", "error")}>
              <ImageIcon size={18} />
              <span>{formatImagePreviewError(error)}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );

  return typeof document === "undefined" ? dialog : createPortal(dialog, document.body);
}
