import createHeifModule, { type HeifImage } from 'libheif-js/libheif-wasm/libheif-bundle.mjs';

const scope = self as unknown as { onmessage: (event: MessageEvent<Uint8Array>) => void; postMessage(message: unknown): void };
scope.onmessage = async event => {
  let heif: Awaited<ReturnType<typeof createHeifModule>> | undefined;
  let decoder: InstanceType<NonNullable<typeof heif>['HeifDecoder']> | undefined;
  let images: HeifImage[] = [];
  try {
    heif = await createHeifModule(); decoder = new heif.HeifDecoder();
    images = decoder.decode(event.data); const image = images.find(entry => entry.is_primary()) ?? images[0];
    if (!image) { throw new Error('HEIF_NO_IMAGE'); }
    const width = image.get_width(), height = image.get_height();
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || width * height > 64_000_000) { throw new Error('HEIF_PIXEL_LIMIT'); }
    const pixels = { width, height, data: new Uint8ClampedArray(width * height * 4) };
    await new Promise<void>((resolve, reject) => image.display(pixels, result => result ? resolve() : reject(new Error('HEIF_DECODE_FAILED'))));
    const canvas = new OffscreenCanvas(width, height), context = canvas.getContext('2d');
    if (!context) { throw new Error('HEIF_DECODE_FAILED'); }
    context.putImageData(new ImageData(pixels.data, width, height), 0, 0);
    scope.postMessage({ blob: await canvas.convertToBlob({ type: image.has_alpha_channel() ? 'image/png' : 'image/jpeg', quality: 0.92 }) });
  } catch (error) { scope.postMessage({ error: error instanceof Error ? error.message : String(error) }); }
  finally { for (const image of images) { image.free(); } if (decoder?.decoder) { heif?.heif_context_free(decoder.decoder); } }
};
