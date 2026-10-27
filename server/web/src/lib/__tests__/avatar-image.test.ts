import { afterEach, describe, expect, it, vi } from "vitest";
import { cropAndCompressAvatar } from "../avatar-image";

afterEach(() => vi.restoreAllMocks());

function mockCanvas(blobs: Array<Blob | null>) {
  const context = { drawImage: vi.fn(), imageSmoothingEnabled: false, imageSmoothingQuality: "low" };
  const dimensions: number[][] = [];
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);
  const encode = vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (this: HTMLCanvasElement, callback) {
    dimensions.push([this.width, this.height]);
    callback(blobs.shift() ?? null);
  });
  return { context, encode, dimensions };
}

function image(width: number, height: number) {
  return { naturalWidth: width, naturalHeight: height } as HTMLImageElement;
}

describe("avatar cropping and compression", () => {
  it("maps a free rectangular percentage crop to original pixels and compresses at the selected aspect ratio", async () => {
    const { context, encode, dimensions } = mockCanvas([new Blob(["compressed"], { type: "image/webp" })]);
    const source = image(4000, 3000);
    const result = await cropAndCompressAvatar(source, { unit: "%", x: 25, y: 10, width: 50, height: 20 });
    expect(context.drawImage).toHaveBeenCalledWith(source, 1000, 300, 2000, 600, 0, 0, 1024, 307);
    expect(dimensions).toEqual([[1024, 307]]);
    expect(encode).toHaveBeenCalledWith(expect.any(Function), "image/webp", 0.82);
    expect(result).toBe("data:image/webp;base64,Y29tcHJlc3NlZA==");
  });

  it("preserves tiny and extreme aspect ratios without upscaling", async () => {
    const { dimensions } = mockCanvas([new Blob(["small"], { type: "image/webp" }), new Blob(["thin"], { type: "image/webp" })]);
    const full = { unit: "%", x: 0, y: 0, width: 100, height: 100 } as const;
    await cropAndCompressAvatar(image(16, 9), full);
    await cropAndCompressAvatar(image(1, 10000), full);
    expect(dimensions).toEqual([[16, 9], [1, 1024]]);
  });

  it("reduces oversized PNG fallback output until it fits the profile request", async () => {
    const { dimensions, context } = mockCanvas([
      new Blob([new Uint8Array(600 * 1024)], { type: "image/png" }),
      new Blob(["smaller"], { type: "image/png" }),
    ]);
    const source = image(2400, 1200);
    const result = await cropAndCompressAvatar(source, { unit: "%", x: 0, y: 0, width: 100, height: 100 });
    expect(dimensions).toEqual([[1024, 512], [768, 384]]);
    expect(context.drawImage).toHaveBeenLastCalledWith(source, 0, 0, 2400, 1200, 0, 0, 768, 384);
    expect(result).toMatch(/^data:image\/png;base64,/);
    expect(result.length).toBeLessThan(512 * 1024);
  });

  it("reports encoding failures and releases the canvas", async () => {
    mockCanvas([null]);
    const create = vi.spyOn(document, "createElement");
    await expect(cropAndCompressAvatar(image(800, 400), { unit: "%", x: 0, y: 0, width: 100, height: 100 })).rejects.toThrow("encoding failed");
    const canvas = create.mock.results.find(result => result.value instanceof HTMLCanvasElement)!.value;
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
  });

  it.each([
    { x: 0, y: 0, width: 0, height: 100 },
    { x: 90, y: 0, width: 20, height: 100 },
    { x: 0, y: Number.NaN, width: 100, height: 100 },
  ])("rejects invalid selections without attempting to encode: %j", async crop => {
    const { encode } = mockCanvas([]);
    await expect(cropAndCompressAvatar(image(800, 400), { unit: "%", ...crop })).rejects.toThrow("Invalid avatar crop");
    expect(encode).not.toHaveBeenCalled();
  });
});
