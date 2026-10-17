export type DocumentPreviewKind = 'pdf' | 'docx' | 'pptx' | 'xlsx' | 'latex' | 'image';

export const DOCUMENT_PREVIEW_LIMIT = 50 * 1024 * 1024;
export const LATEX_PREVIEW_LIMIT = 200 * 1024;
export const DOCUMENT_PREVIEW_VIEW = 'studio.documentPreview';
export const FORMULA_PREVIEW_VIEW = 'studio.formulaPreview';

const formats: Record<string, DocumentPreviewKind> = {
  pdf: 'pdf', docx: 'docx', pptx: 'pptx', xlsx: 'xlsx', tex: 'latex', latex: 'latex',
  png: 'image', jpg: 'image', jpeg: 'image', jfif: 'image', gif: 'image', webp: 'image',
  bmp: 'image', avif: 'image', svg: 'image', ico: 'image', heic: 'image', heif: 'image',
};

export function documentPreviewKind(path: string): DocumentPreviewKind | undefined {
  return formats[/\.([^.\\/]+)$/.exec(path)?.[1].toLowerCase() ?? ''];
}

export function documentPreviewView(path: string): string {
  return documentPreviewKind(path) === 'latex' ? FORMULA_PREVIEW_VIEW : DOCUMENT_PREVIEW_VIEW;
}

export type PreviewMessage =
  | { type: 'loading'; generation: number }
  | { type: 'document'; generation: number; kind: DocumentPreviewKind; name: string; bytes: Uint8Array }
  | { type: 'error'; generation: number; error: string };

export function samePreviewBytes(previous: Uint8Array | undefined, next: Uint8Array): boolean {
  return !!previous && previous.length === next.length && next.every((value, index) => value === previous[index]);
}
