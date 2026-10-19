import {
  Download,
  FileText,
  Film,
  Image as ImageIcon,
  Loader2,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { formatFileSize } from "../utils/files";
import { formatImagePreviewError } from "../utils/labels";
import type { ManagedFileReference } from "../types";
import { attachmentActionButtonClassName, rwiClass } from "../styles";
import { useTranslation } from "@steamharness/i18n/react";

export function isImageFileReference(file: ManagedFileReference): boolean {
  return file.kind === "image" || file.mimeType.startsWith("image/");
}

export function isVideoFileReference(file: Pick<ManagedFileReference, "mimeType" | "name">): boolean {
  const mimeType = file.mimeType.split(";", 1)[0]!.trim().toLowerCase();
  return mimeType.startsWith("video/") || ((mimeType === "" || mimeType === "application/octet-stream") &&
    /\.(mp4|m4v|mov|avi|mkv|webm|ogv|mpeg|mpg)$/i.test(file.name));
}

function createAttachmentPreviewKey(file: ManagedFileReference): string {
  // Image thumbnail previews must survive form re-parsing while the
  // user types in another field; avoid volatile normalized fields like createdAt.
  return [
    file.id,
    file.storage,
    file.projectId ?? "",
    file.conversationId ?? "",
    file.kind,
    file.mimeType,
    file.size,
  ].join("|");
}

function ImageAttachmentButton({
  file,
  loading,
  disabled,
  onOpen,
  onResolveAttachmentPreview,
}: {
  file: ManagedFileReference;
  loading: boolean;
  disabled: boolean;
  onOpen: (trigger: HTMLButtonElement) => void;
  onResolveAttachmentPreview?: (file: ManagedFileReference) => Promise<string | undefined> | string | undefined;
}) {
  const { t } = useTranslation();
  const [previewUrl, setPreviewUrl] = useState<string>();
  const previewUrlRef = useRef<string | undefined>(undefined);
  const fileRef = useRef(file);
  const resolverRef = useRef(onResolveAttachmentPreview);
  const previewKey = createAttachmentPreviewKey(file);
  const resolverAvailable = onResolveAttachmentPreview !== undefined;
  fileRef.current = file;
  resolverRef.current = onResolveAttachmentPreview;

  useEffect(() => {
    const currentFile = fileRef.current;
    const resolver = resolverRef.current;
    let disposed = false;
    if (previewUrlRef.current?.startsWith("blob:")) {
      URL.revokeObjectURL(previewUrlRef.current);
    }
    previewUrlRef.current = undefined;
    setPreviewUrl(undefined);

    if (!resolver) return;

    void Promise.resolve(resolver(currentFile))
      .then((url) => {
        if (disposed) {
          if (url?.startsWith("blob:")) URL.revokeObjectURL(url);
          return;
        }
        previewUrlRef.current = url;
        setPreviewUrl(url);
      })
      .catch(() => {
        if (!disposed) setPreviewUrl(undefined);
      });

    return () => {
      disposed = true;
      if (previewUrlRef.current?.startsWith("blob:")) {
        URL.revokeObjectURL(previewUrlRef.current);
      }
      previewUrlRef.current = undefined;
    };
  }, [previewKey, resolverAvailable]);

  const previewLabel = t("attachmentPreview", { name: file.name });

  return (
    <button
      type="button"
      className={rwiClass("rwi-image-thumb-button")}
      disabled={disabled}
      onClick={(event) => onOpen(event.currentTarget)}
      title={previewLabel}
      aria-label={previewLabel}
    >
      {previewUrl ? <img src={previewUrl} alt={file.name} loading="lazy" /> : <ImageIcon size={16} />}
      {loading && (
        <span className={rwiClass("rwi-image-thumb-loading")} aria-hidden="true">
          <Loader2 className={rwiClass("rwi-spin")} size={14} />
        </span>
      )}
    </button>
  );
}

export function AttachmentStrip({
  attachments,
  compact = false,
  thumbnail = false,
  onRemove,
  onOpenAttachment,
  onResolveAttachmentPreview,
}: {
  attachments: ManagedFileReference[];
  compact?: boolean;
  thumbnail?: boolean;
  onRemove?: (fileId: string) => void;
  onOpenAttachment?: (file: ManagedFileReference, options?: { download?: boolean }) => Promise<void> | void;
  onResolveAttachmentPreview?: (file: ManagedFileReference) => Promise<string | undefined> | string | undefined;
}) {
  const { t } = useTranslation();
  const [loadingId, setLoadingId] = useState<string>();
  const [error, setError] = useState<string>();

  if (attachments.length === 0) return null;

  const openAttachment = async (file: ManagedFileReference, download = false) => {
    if (!onOpenAttachment) return;
    setLoadingId(file.id);
    setError(undefined);
    try {
      await onOpenAttachment(file, { download });
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : String(openError));
    } finally {
      setLoadingId(undefined);
    }
  };

  // The kanban host renders the image preview itself via
  // onResolveAttachmentPreview. We invoke it as a side effect so the host
  // can drive its own dialog; the returned URL is intentionally ignored
  // here and the host is responsible for opening, focusing, and restoring
  // focus on close.
  const openPreview = (file: ManagedFileReference) => {
    if (!onResolveAttachmentPreview) return;
    void Promise.resolve(onResolveAttachmentPreview(file)).catch(() => undefined);
  };

  return (
    <>
      <div className={rwiClass(
        "rwi-attachments",
        compact ? "rwi-attachments-compact" : undefined,
        thumbnail ? "rwi-attachments-thumbnails" : undefined,
      )}>
        {attachments.map((file) => {
          const isImage = isImageFileReference(file);
          const isVideo = isVideoFileReference(file);
          const canPreview = (isImage || isVideo) && onResolveAttachmentPreview !== undefined;
          const clickable = canPreview || onOpenAttachment !== undefined;
          const onPrimaryClick = (trigger: HTMLElement) => {
            void trigger;
            if (onOpenAttachment) {
              void openAttachment(file, false);
            } else if (canPreview) {
              openPreview(file);
            }
          };
          return (
            <div key={file.id} className={thumbnail && isImage ? rwiClass("rwi-attachment", "rwi-attachment-image") : rwiClass("rwi-attachment")}>
              {thumbnail && isImage ? (
                <ImageAttachmentButton
                  file={file}
                  loading={loadingId === file.id}
                  disabled={!clickable}
                  onOpen={onPrimaryClick}
                  onResolveAttachmentPreview={onResolveAttachmentPreview}
                />
              ) : (
                <button type="button" disabled={!clickable} onClick={(event) => onPrimaryClick(event.currentTarget)} title={file.name}>
                  {loadingId === file.id ? <Loader2 className={rwiClass("rwi-spin")} size={14} /> : isImage ? <ImageIcon size={14} /> : isVideo ? <Film size={14} /> : <FileText size={14} />}
                  <span>
                    <strong>{file.name}</strong>
                    <small>{formatFileSize(file.size)}</small>
                  </span>
                </button>
              )}
              {onOpenAttachment && (!thumbnail || isVideo) && (
                <button
                  type="button"
                  className={attachmentActionButtonClassName()}
                  onClick={() => void openAttachment(file, true)}
                  title={t("attachmentDownload")}
                  aria-label={t("attachmentDownloadName", { name: file.name })}
                >
                  <Download size={12} />
                </button>
              )}
              {onRemove && (
                <button
                  type="button"
                  className={attachmentActionButtonClassName()}
                  onClick={() => onRemove(file.id)}
                  title={t("attachmentRemove")}
                  aria-label={t("attachmentRemoveName", { name: file.name })}
                >
                  <X size={12} />
                </button>
              )}
            </div>
          );
        })}
      </div>
      {error && <div className={rwiClass("rwi-error-text")}>{formatImagePreviewError(error)}</div>}
    </>
  );
}
