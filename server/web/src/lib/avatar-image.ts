import type { PercentCrop } from "react-image-crop";

// Keep the encoded draft comfortably below the profile API's JSON body limit.
const TARGET_BYTES = 384 * 1024;
const INITIAL_LONG_EDGE = 1024;

export async function cropAndCompressAvatar(image: HTMLImageElement, crop: PercentCrop): Promise<string> {
  const sourceX = image.naturalWidth * crop.x / 100;
  const sourceY = image.naturalHeight * crop.y / 100;
  const sourceWidth = image.naturalWidth * crop.width / 100;
  const sourceHeight = image.naturalHeight * crop.height / 100;
  if (![sourceX, sourceY, sourceWidth, sourceHeight].every(Number.isFinite)
    || sourceX < 0 || sourceY < 0 || sourceWidth <= 0 || sourceHeight <= 0
    || crop.x + crop.width > 100 || crop.y + crop.height > 100) {
    throw new Error("Invalid avatar crop.");
  }

  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Image processing is unavailable.");
  let scale = Math.min(1, INITIAL_LONG_EDGE / Math.max(sourceWidth, sourceHeight));
  try {
    while (true) {
      canvas.width = Math.max(1, Math.round(sourceWidth * scale));
      canvas.height = Math.max(1, Math.round(sourceHeight * scale));
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height);
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
