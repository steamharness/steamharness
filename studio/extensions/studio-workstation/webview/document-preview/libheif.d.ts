declare module 'libheif-js/libheif-wasm/libheif-bundle.mjs' {
  export interface HeifPixels { width: number; height: number; data: Uint8ClampedArray<ArrayBuffer> }
  export interface HeifImage {
    get_width(): number;
    get_height(): number;
    is_primary(): boolean;
    has_alpha_channel(): boolean;
    display(pixels: HeifPixels, callback: (result: HeifPixels | null) => void): void;
    free(): void;
  }
  export interface HeifModule {
    HeifDecoder: new () => { decoder: number | null; decode(bytes: Uint8Array): HeifImage[] };
    heif_context_free(context: number): void;
  }
  export default function createHeifModule(): Promise<HeifModule>;
}
