import { formatDateTime, i18n } from "@workflow-code/i18n";
import type { KnowledgeDocument, KnowledgeDocumentSummary, KnowledgeResult } from "./types";

export const LARGE_MARKDOWN_PREVIEW_LIMIT = 200_000;
export const INLINE_IMAGE_MANUAL_LOAD_LIMIT = 48;

/**
 * Returns a UTF-8 byte length without allocating an encoded copy of Markdown.
 * `stopAfterBytes` makes large-preview guards bounded: callers only need to
 * know that a document crossed the threshold, not its exact multi-megabyte
 * size.
 */
export function getKnowledgeMarkdownByteLength(markdown: string, stopAfterBytes = Number.POSITIVE_INFINITY): number {
  let byteLength = 0;
  for (let index = 0; index < markdown.length; index += 1) {
    const codeUnit = markdown.charCodeAt(index);
    if (codeUnit <= 0x7f) {
      byteLength += 1;
    } else if (codeUnit <= 0x7ff) {
      byteLength += 2;
    } else if (
      codeUnit >= 0xd800 &&
      codeUnit <= 0xdbff &&
      index + 1 < markdown.length &&
      markdown.charCodeAt(index + 1) >= 0xdc00 &&
      markdown.charCodeAt(index + 1) <= 0xdfff
    ) {
      byteLength += 4;
      index += 1;
    } else {
      // TextEncoder replaces isolated UTF-16 surrogates with U+FFFD, which
      // also occupies three bytes in UTF-8.
      byteLength += 3;
    }
    if (byteLength > stopAfterBytes) return byteLength;
  }
  return byteLength;
}

export function isKnowledgeSuccess<T>(result: KnowledgeResult<T>): result is KnowledgeResult<T> & { data: T } {
  return result.errCode === 0 && result.data !== undefined;
}

export function countMarkdownImages(markdown: string): number {
  // This only drives the preview's lazy-image threshold, so keep it tolerant
  // while scanning in one pass. A backtracking expression here can freeze the
  // renderer on an unfinished Markdown image pasted into a large document.
  let count = 0;
  let index = 0;

  while (index < markdown.length) {
    if (markdown[index] !== "!" || markdown[index + 1] !== "[") {
      index += 1;
      continue;
    }

    let cursor = index + 2;
    let closedAlt = false;
    while (cursor < markdown.length) {
      if (markdown[cursor] === "\\") {
        cursor += 2;
        continue;
      }
      if (markdown[cursor] === "]") {
        closedAlt = true;
        break;
      }
      cursor += 1;
    }
    if (!closedAlt || markdown[cursor + 1] !== "(") {
      index = closedAlt ? cursor + 1 : markdown.length;
      continue;
    }

    cursor += 2;
    let depth = 1;
    while (cursor < markdown.length && depth > 0) {
      if (markdown[cursor] === "\\") {
        cursor += 2;
        continue;
      }
      if (markdown[cursor] === "(") depth += 1;
      if (markdown[cursor] === ")") depth -= 1;
      cursor += 1;
    }
    if (depth === 0) count += 1;

    // An unclosed destination consumes the rest of the Markdown according to
    // the same tolerant rule as an unfinished link, so do not rescan it.
    index = depth === 0 ? cursor : markdown.length;
  }

  return count;
}

export function formatKnowledgeDate(value?: string): string {
  if (!value) return i18n.t("unknownTime");
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : formatDateTime(date);
}

export function toKnowledgeSummary(
  document: KnowledgeDocumentSummary | KnowledgeDocument,
  markdownFallback = "",
): KnowledgeDocumentSummary {
  if ("markdownPreview" in document) return document;
  return {
    id: document.id,
    title: document.title,
    markdownPreview: markdownFallback.trim().replace(/\s+/g, " ").slice(0, 240),
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
  };
}

export function toKnowledgeDocument(
  document: KnowledgeDocumentSummary | KnowledgeDocument,
  markdown: string,
): KnowledgeDocument {
  if ("markdown" in document) return document;
  return {
    id: document.id,
    title: document.title,
    markdown,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
  };
}
