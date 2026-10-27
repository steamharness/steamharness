import { centerCrop, makeAspectCrop, type PercentCrop } from "react-image-crop";

export const AVATAR_ASPECT_RATIO = 1;

export function createAvatarCrop(width: number, height: number): PercentCrop {
  return centerCrop(makeAspectCrop({ unit: "%", width: 100 }, AVATAR_ASPECT_RATIO, width, height), width, height);
}

export function avatarFileFromDataUrl(dataUrl: string): File {
  const match = /^data:(image\/(?:webp|png));base64,(.+)$/.exec(dataUrl);
  if (!match) throw new Error("Invalid compressed avatar.");
  const bytes = Uint8Array.from(atob(match[2]), char => char.charCodeAt(0));
  return new File([bytes], `avatar.${match[1] === "image/webp" ? "webp" : "png"}`, { type: match[1] });
}

// Keep the encoded draft comfortably below the profile API's JSON body limit.
const TARGET_BYTES = 384 * 1024;
const INITIAL_LONG_EDGE = 1024;

export async function cropAndCompressAvatar(image: HTMLImageElement, crop: PercentCrop): Promise<string> {
  let sourceX = image.naturalWidth * crop.x / 100;
  let sourceY = image.naturalHeight * crop.y / 100;
  const sourceWidth = image.naturalWidth * crop.width / 100;
  const sourceHeight = image.naturalHeight * crop.height / 100;
  if (![sourceX, sourceY, sourceWidth, sourceHeight].every(Number.isFinite)
    || sourceX < 0 || sourceY < 0 || sourceWidth <= 0 || sourceHeight <= 0
    || crop.x + crop.width > 100 + 1e-6 || crop.y + crop.height > 100 + 1e-6) {
    throw new Error("Invalid avatar crop.");
  }
  // Keep an exact square in source pixels even when percentage coordinates round.
  const sourceSide = Math.min(sourceWidth, sourceHeight);
  sourceX += (sourceWidth - sourceSide) / 2;
  sourceY += (sourceHeight - sourceSide) / 2;

  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Image processing is unavailable.");
  let scale = Math.min(1, INITIAL_LONG_EDGE / sourceSide);
  try {
    while (true) {
      canvas.width = canvas.height = Math.max(1, Math.round(sourceSide * scale));
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.drawImage(image, sourceX, sourceY, sourceSide, sourceSide, 0, 0, canvas.width, canvas.height);
      // Browsers without WebP encoding fall back to PNG, retaining transparency.
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(value => value ? resolve(value) : reject(new Error("Avatar encoding failed.")), "image/webp", 0.82);
      });
      if (blob.size <= TARGET_BYTES) return await readBlobAsDataUrl(blob);
      if (canvas.width === 1 && canvas.height === 1) throw new Error("Avatar compression failed.");
      scale *= 0.75;
    }
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

function readBlobAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reader.onabort = () => reject(new Error("Avatar reading failed."));
    reader.onload = () => typeof reader.result === "string"
      ? resolve(reader.result)
      : reject(new Error("Avatar reading failed."));
    reader.readAsDataURL(blob);
  });
}
