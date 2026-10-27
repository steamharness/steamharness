import { useEffect, useRef, useState } from "react";
import { AlertCircle, RefreshCw } from "lucide-react";
import ReactCrop, { type PercentCrop } from "react-image-crop";
import "react-image-crop/dist/ReactCrop.css";
import { useTranslation } from "@steamharness/i18n/react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { cropAndCompressAvatar } from "@/lib/avatar-image";

const FULL_IMAGE: PercentCrop = { unit: "%", x: 0, y: 0, width: 100, height: 100 };

export function AvatarCropDialog({ file, onConfirm, onClose }: {
  file: File;
  onConfirm: (dataUrl: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("serverWeb");
  const { t: commonT } = useTranslation("common");
  const [source, setSource] = useState("");
  const [crop, setCrop] = useState<PercentCrop>(FULL_IMAGE);
  const [imageAspect, setImageAspect] = useState<number | null>(null);
  const ready = imageAspect !== null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const processing = useRef(false);
  const generation = useRef(0);

  useEffect(() => {
    const current = ++generation.current;
    const url = URL.createObjectURL(file);
    setSource(url);
    setCrop(FULL_IMAGE);
    setImageAspect(null);
    setError(null);
    return () => {
      if (generation.current === current) generation.current++;
      URL.revokeObjectURL(url);
    };
  }, [file]);

  async function confirmCrop() {
    if (!imageRef.current || !ready || processing.current || crop.width <= 0 || crop.height <= 0) return;
    const current = generation.current;
    processing.current = true;
    setBusy(true);
    setError(null);
    try {
      const dataUrl = await cropAndCompressAvatar(imageRef.current, crop);
      if (current === generation.current) onConfirm(dataUrl);
    } catch {
      if (current === generation.current) setError(t("accountAvatarErrorProcessFailed"));
    } finally {
      processing.current = false;
      if (current === generation.current) setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={open => { if (!open && !processing.current) onClose(); }}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-3xl" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>{t("accountAvatarCropTitle")}</DialogTitle>
          <DialogDescription>{t("accountAvatarCropDescription")}</DialogDescription>
        </DialogHeader>
        <div className="relative flex min-h-24 min-w-0 items-center justify-center" aria-busy={!ready && !error}>
          {!ready && !error ? <Skeleton className="absolute inset-0" role="status" aria-label={commonT("imagePreviewLoading")} /> : null}
          {source ? (
            <ReactCrop crop={crop} onChange={(_, percentCrop) => setCrop(percentCrop)}
              disabled={busy || !ready} ruleOfThirds keepSelection
              // Size the crop surface itself so library styles cannot override the image height.
              // Small sources also get a usable preview; export still uses their original pixels.
              style={{
                width: imageAspect ? `min(100%, ${55 * imageAspect}dvh)` : "100%",
                maxHeight: "55dvh",
                visibility: ready ? "visible" : "hidden",
              }}
              ariaLabels={{
                cropArea: t("accountAvatarCropArea"),
                nwDragHandle: t("accountAvatarCropHandleNW"), nDragHandle: t("accountAvatarCropHandleN"),
                neDragHandle: t("accountAvatarCropHandleNE"), eDragHandle: t("accountAvatarCropHandleE"),
                seDragHandle: t("accountAvatarCropHandleSE"), sDragHandle: t("accountAvatarCropHandleS"),
                swDragHandle: t("accountAvatarCropHandleSW"), wDragHandle: t("accountAvatarCropHandleW"),
              }}>
              <img ref={imageRef} src={source} alt={t("accountAvatarCropImageAlt")}
                className="block h-auto w-full"
                onLoad={event => {
                  const image = event.currentTarget;
                  if (image.naturalWidth > 0 && image.naturalHeight > 0) {
                    setImageAspect(image.naturalWidth / image.naturalHeight);
                    setError(null);
                  } else {
                    setImageAspect(null);
                    setError(t("accountAvatarErrorReadFailed"));
                  }
                }}
                onError={() => { setImageAspect(null); setError(t("accountAvatarErrorReadFailed")); }} />
            </ReactCrop>
          ) : null}
        </div>
        {error ? <Alert variant="destructive"><AlertCircle /><AlertDescription>{error}</AlertDescription></Alert> : null}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy || !ready}
            onClick={() => setCrop(FULL_IMAGE)}>{t("accountAvatarCropReset")}</Button>
          <Button type="button" variant="outline" disabled={busy} onClick={onClose}>{t("commonCancel")}</Button>
          <Button type="button" disabled={busy || !ready || crop.width <= 0 || crop.height <= 0} onClick={() => void confirmCrop()}>
            {busy ? <RefreshCw data-icon="inline-start" className="animate-spin" /> : null}
            {t(busy ? "accountAvatarProcessing" : "accountAvatarCropConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
