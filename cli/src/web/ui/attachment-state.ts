import type { Attachment } from '../workflow-types';

/** Inputs used to resolve links and media in an output view. */
export function attachmentSignature(files: Attachment[]): string {
  return JSON.stringify(files.map(file => [file.id, file.previewUrl, file.path, file.url]));
}
