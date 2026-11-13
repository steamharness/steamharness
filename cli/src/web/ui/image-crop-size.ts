import type { ImageParamOptions } from 'steamharness';

export interface ImageSize { width: number; height: number }
export interface CropOutputSize extends ImageSize { contentWidth: number; contentHeight: number }

export function imageSizeAllowed(size: ImageSize, limits: ImageParamOptions): boolean {
  return size.width >= (limits.minWidth ?? 1) && size.height >= (limits.minHeight ?? 1)
    && size.width <= (limits.maxWidth ?? Infinity) && size.height <= (limits.maxHeight ?? Infinity);
}

/** Keep the crop's aspect ratio, fit the maximum, and pad any remaining minimum. */
export function cropOutputSize(size: ImageSize, limits: ImageParamOptions): CropOutputSize {
  if (![size.width, size.height].every(value => Number.isFinite(value) && value > 0)) throw new Error('Invalid image dimensions.');
  const minWidth = limits.minWidth ?? 1, minHeight = limits.minHeight ?? 1;
  const maxWidth = limits.maxWidth ?? Infinity, maxHeight = limits.maxHeight ?? Infinity;
  const grow = Math.max(1, minWidth / size.width, minHeight / size.height);
  const fit = Math.min(maxWidth / size.width, maxHeight / size.height);
  const scale = Math.min(grow, fit);
  const contentWidth = Math.max(1, Math.min(maxWidth, Math.round(size.width * scale)));
  const contentHeight = Math.max(1, Math.min(maxHeight, Math.round(size.height * scale)));
  return { width: Math.max(minWidth, contentWidth), height: Math.max(minHeight, contentHeight), contentWidth, contentHeight };
}

export function isImageFile(file: Pick<File, 'name' | 'type'>): boolean {
  return file.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp|avif|heic|heif|svg)$/i.test(file.name);
}

export function imageOutputType(file: Pick<File, 'name' | 'type'>, accept: readonly string[] = []): string {
  const allows = (mime: string) => !accept.length || accept.some(value => {
    value = value.toLowerCase();
    return value === mime || value === 'image/*' || value === '*/*'
      || mime === 'image/jpeg' && ['.jpg', '.jpeg'].includes(value)
      || mime === 'image/png' && value === '.png' || mime === 'image/webp' && value === '.webp';
  });
  const mime = file.type === 'image/jpeg' || /\.jpe?g$/i.test(file.name) ? 'image/jpeg' : file.type;
  return [mime, 'image/png', 'image/jpeg', 'image/webp'].find(value => ['image/png', 'image/jpeg', 'image/webp'].includes(value) && allows(value)) ?? '';
}
