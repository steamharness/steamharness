import {
  ChevronDown,
  CircleCheck,
  CircleX,
  Code2,
  ClipboardList,
  Info,
  Loader2,
  StickyNote,
  TextQuote,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import React from "react";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components, type UrlTransform } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { ImagePreviewDialog } from "../ui/attachment";
import { joinClassNames, resolveRwiClassName, rwiClass, rwiOutputItemStatusClass } from "../styles";
import { formatRunStatusLabel } from "../utils/labels";
import { chainWheelAtVerticalBoundary } from "../utils/scroll-chain";
import { useTranslation } from "@steamharness/i18n/react";

type MarkdownSegment =
  | { type: "markdown"; content: string }
  | { type: "details"; summary: string; content: string };

export type MarkdownImageSrcResolver = (
  src: string,
) => Promise<string | null | undefined> | string | null | undefined;

type MarkdownImageLoadingMode = "auto" | "manual";

const detailsOpenPattern = /^\s*<details\b[^>]*>\s*$/i;
const detailsClosePattern = /^\s*<\/details>\s*$/i;
const detailsInlinePattern = /^\s*<details\b[^>]*>\s*<summary\b[^>]*>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>\s*$/i;
const summaryLinePattern = /^\s*<summary\b[^>]*>([\s\S]*?)<\/summary>\s*$/i;
const codeFencePattern = /^\s*(`{3,}|~{3,})/;

const detailsSummaryIconPattern = /^(\[(?:i|ok|!|x|note|code|list|quote)\])(?:\s+|$)([\s\S]*)$/;
const markdownCodeLanguagePattern = /(?:^|\s)language-([^\s]+)/;
// Map icon tokens to their Lucide component. The type is explicitly
// `LucideIcon | undefined` because lookup with an unknown token (e.g.
// a stray "[unknown]") at runtime can miss the map; the previous
// `Record<string, LucideIcon>` narrowed the result to `LucideIcon`
// and tripped TS2774 ("This condition will always return true") at
// the `if (Icon)` guard.
const detailsSummaryIcons: Record<string, LucideIcon | undefined> = {
  "[i]": Info,
  "[ok]": CircleCheck,
  "[!]": TriangleAlert,
  "[x]": CircleX,
  "[note]": StickyNote,
  "[code]": Code2,
  "[list]": ClipboardList,
  "[quote]": TextQuote,
};
const safeImageDataUrlPattern = /^data:image\/(?:png|jpeg|jpg|webp|gif);base64,[a-z0-9+/=\s]+$/i;
const markdownCodeLanguageAliases: Record<string, string | undefined> = {
  cmd: "bash",
  console: "bash",
  html: "xml",
  js: "javascript",
  jsx: "javascript",
  md: "markdown",
  mdx: "markdown",
  py: "python",
  shell: "bash",
  sh: "bash",
  terminal: "bash",
  ts: "typescript",
  tsx: "typescript",
  yml: "yaml",
  zsh: "bash",
};
const markdownCodeLanguages = [
  "bash",
  "css",
  "diff",
  "javascript",
  "json",
  "markdown",
  "python",
  "sql",
  "typescript",
  "xml",
  "yaml",
] as const;

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("css", css);
hljs.registerLanguage("diff", diff);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("python", python);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("yaml", yaml);

export type OutputItemStatus = "running" | "success" | "failed";

export function OutputItemStatusBadge({ status }: { status: OutputItemStatus }) {
  // Subscribe so the status label re-renders on language change.
  useTranslation();
  const label = formatRunStatusLabel(status);
  const Icon = status === "running" ? Loader2 : status === "success" ? CircleCheck : CircleX;

  return (
    <span className={rwiOutputItemStatusClass(status)} data-slot="rwi-output-item-status" data-state={status}>
      <Icon
        className={status === "running" ? rwiClass("rwi-output-item-status-spinner") : undefined}
        size={12}
        aria-hidden="true"
      />
      <span>{label}</span>
    </span>
  );
}

// Share the icon-token resolution with OutputItemSummary so both
// markdown <details> blocks and lightweight output item rows pick the same
// lucide icon for "[i]" / "[ok]" / "[!]" / "[x]" / "[note]" / "[code]" /
// "[list]" / "[quote]" hints, whether passed in as `icon` or embedded as the
// summary prefix.
export function resolveDetailsSummaryIcon(
  icon: string | undefined,
  summary: string,
): { Icon: LucideIcon | undefined; title: string } {
  if (icon !== undefined) {
    const Icon = detailsSummaryIcons[icon];
    if (Icon) {
      return { Icon, title: summary };
    }
  }

  const match = summary.match(detailsSummaryIconPattern);
  if (!match) {
    return { Icon: undefined, title: summary };
  }

  const token = match[1] ?? "";
  const label = match[2]?.trim() || "Details";
  const Icon = detailsSummaryIcons[token];
  if (!Icon) {
    return { Icon: undefined, title: summary };
  }

  return { Icon, title: label };
}

export function DetailsSummary({
  summary,
  open,
  icon,
  status,
}: {
  summary: string;
  open: boolean;
  icon?: string;
  status?: OutputItemStatus;
}) {
  const { Icon, title } = resolveDetailsSummaryIcon(icon, summary);
  return <DetailsSummaryContent icon={Icon} open={open} title={title} status={status} />;
}

function DetailsSummaryContent({
  icon: Icon,
  open,
  status,
  title,
}: {
  icon?: LucideIcon;
  open: boolean;
  status?: OutputItemStatus;
  title: string;
}) {
  return (
    <span className={rwiClass("rwi-markdown-details-summary")}>
      <ChevronDown
        className={open ? rwiClass("rwi-markdown-details-toggle", "open") : rwiClass("rwi-markdown-details-toggle")}
        size={15}
        aria-hidden="true"
      />
      {Icon && (
        // Render standard details-output icon tokens as UI icons while keeping core/CLI Markdown text stable.
        <Icon className={rwiClass("rwi-markdown-details-icon")} size={15} aria-hidden="true" />
      )}
      <span className={rwiClass("rwi-markdown-details-title")}>
        <MarkdownRenderer content={title} />
      </span>
      {status && <OutputItemStatusBadge status={status} />}
    </span>
  );
}

function updateCodeFence(line: string, activeFence: string): string {
  const match = line.match(codeFencePattern);
  if (!match) return activeFence;
  const fence = match[1];
  if (!activeFence) return fence;
  return fence[0] === activeFence[0] && fence.length >= activeFence.length ? "" : activeFence;
}

function readDetailsBlock(lines: string[], startIndex: number): { segment: MarkdownSegment; endIndex: number } | undefined {
  const inlineMatch = lines[startIndex]?.match(detailsInlinePattern);
  if (inlineMatch) {
    return {
      segment: {
        type: "details",
        summary: inlineMatch[1]?.trim() || "Details",
        content: inlineMatch[2]?.trim() ?? "",
      },
      endIndex: startIndex,
    };
  }

  if (!detailsOpenPattern.test(lines[startIndex] ?? "")) return undefined;

  const summaryMatch = lines[startIndex + 1]?.match(summaryLinePattern);
  if (!summaryMatch) return undefined;

  const bodyLines: string[] = [];
  let bodyFence = "";
  for (let index = startIndex + 2; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!bodyFence && detailsClosePattern.test(line)) {
      return {
        segment: {
          type: "details",
          summary: summaryMatch[1]?.trim() || "Details",
          content: bodyLines.join("\n").trim(),
        },
        endIndex: index,
      };
    }
    bodyLines.push(line);
    bodyFence = updateCodeFence(line, bodyFence);
  }

  return undefined;
}

function parseMarkdownSegments(content: string): MarkdownSegment[] {
  const segments: MarkdownSegment[] = [];
  const markdownLines: string[] = [];
  const lines = content.split("\n");
  let fence = "";

  const flushMarkdown = () => {
    const markdown = markdownLines.join("\n");
    markdownLines.length = 0;
    if (markdown.trim() !== "") {
      segments.push({ type: "markdown", content: markdown });
    }
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const detailsBlock = fence ? undefined : readDetailsBlock(lines, index);
    if (detailsBlock) {
      flushMarkdown();
      segments.push(detailsBlock.segment);
      index = detailsBlock.endIndex;
      continue;
    }
    markdownLines.push(line);
    fence = updateCodeFence(line, fence);
  }

  flushMarkdown();

  return segments.length > 0 ? segments : [{ type: "markdown", content }];
}

export function MarkdownRenderer({
  content,
  resolveImageSrc,
  imageLoadingMode = "auto",
}: {
  content: string;
  resolveImageSrc?: MarkdownImageSrcResolver;
  imageLoadingMode?: MarkdownImageLoadingMode;
}) {
  const [manuallyLoadedSources, setManuallyLoadedSources] = useState<ReadonlySet<string>>(() => new Set());
  const previousManualContentRef = useRef({ content, imageLoadingMode });

  useEffect(() => {
    const previous = previousManualContentRef.current;
    if (previous.content === content && previous.imageLoadingMode === imageLoadingMode) return;
    previousManualContentRef.current = { content, imageLoadingMode };
    setManuallyLoadedSources(new Set());
  }, [content, imageLoadingMode]);

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkBreaks]}
      urlTransform={transformMarkdownUrl}
      components={{
        a: ({ children, ...props }) => <a {...props} target="_blank" rel="noreferrer">{children}</a>,
        code: MarkdownCode,
        img: ({ alt, src, node: _node, ...props }) => {
          const imageSrc = typeof src === "string" ? src : undefined;
          return (
            <MarkdownImage
              {...props}
              src={imageSrc}
              alt={alt ?? ""}
              resolveImageSrc={resolveImageSrc}
              loadingMode={imageLoadingMode}
              manualLoadRequested={imageSrc !== undefined && manuallyLoadedSources.has(imageSrc)}
              onManualLoad={imageSrc === undefined
                ? undefined
                : () => setManuallyLoadedSources((current) => {
                  if (current.has(imageSrc)) return current;
                  return new Set(current).add(imageSrc);
                })}
            />
          );
        },
        table: ({ children, ...props }) => (
          <div className={rwiClass("rwi-markdown-table-scroll")} data-slot="rwi-markdown-table-scroll">
            <table {...props}>{children}</table>
          </div>
        ),
      }}
    >
      {content}
    </ReactMarkdown>
  );
}

const MarkdownCode: Components["code"] = ({ children, className, node: _node, ...props }) => {
  const rawLanguage = className?.match(markdownCodeLanguagePattern)?.[1];
  const language = normalizeMarkdownCodeLanguage(rawLanguage);
  const code = readMarkdownCodeText(children);

  if (!language) {
    return <code {...props} className={className}>{children}</code>;
  }

  const highlightedCode = highlightMarkdownCode(code, language);
  if (!highlightedCode) {
    return <code {...props} className={className}>{children}</code>;
  }

  return (
    <code
      {...props}
      className={joinClassNames(className, "hljs", rwiClass("rwi-markdown-code-highlight"))}
      data-slot="rwi-markdown-code-block"
      data-language={language}
      dangerouslySetInnerHTML={{ __html: highlightedCode }}
    />
  );
};

function normalizeMarkdownCodeLanguage(language: string | undefined): typeof markdownCodeLanguages[number] | undefined {
  const normalized = language?.trim().toLowerCase();
  if (!normalized) return undefined;

  const resolved = markdownCodeLanguageAliases[normalized] ?? normalized;
  return markdownCodeLanguages.includes(resolved as typeof markdownCodeLanguages[number])
    ? resolved as typeof markdownCodeLanguages[number]
    : undefined;
}

function readMarkdownCodeText(node: React.ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(readMarkdownCodeText).join("");
  }
  return "";
}

function highlightMarkdownCode(code: string, language: typeof markdownCodeLanguages[number]): string | undefined {
  try {
    return hljs.highlight(code, { language, ignoreIllegals: true }).value;
  } catch {
    return undefined;
  }
}

const transformMarkdownUrl: UrlTransform = (url, key, node) => {
  // gpt-image output returns a Markdown data URL preview. Keep the
  // default link safety policy, only allow base64 image data URLs for img src,
  // and let the rendered image open the shared in-workspace preview layer.
  if (key === "src" && node.tagName === "img" && isSafeImageDataUrl(url)) {
    return url.replace(/\s+/g, "");
  }

  return defaultUrlTransform(url);
};

function isSafeImageDataUrl(url: string): boolean {
  return safeImageDataUrlPattern.test(url.trim());
}

function MarkdownImage({
  alt = "",
  src,
  resolveImageSrc,
  loadingMode = "auto",
  manualLoadRequested = false,
  onManualLoad,
  ...props
}: Omit<React.ImgHTMLAttributes<HTMLImageElement>, "alt" | "src"> & {
  alt?: string;
  src?: string;
  resolveImageSrc?: MarkdownImageSrcResolver;
  loadingMode?: MarkdownImageLoadingMode;
  manualLoadRequested?: boolean;
  onManualLoad?: () => void;
}) {
  const { t } = useTranslation();
  const [previewOpen, setPreviewOpen] = useState(false);
  const [shouldResolveSrc, setShouldResolveSrc] = useState(resolveImageSrc === undefined);
  const [resolvedImage, setResolvedImage] = useState<{
    source: string;
    src?: string;
    status: "loaded" | "failed";
  } | null>(null);
  const previewCloseRef = useRef<HTMLButtonElement | null>(null);
  const resolveAnchorRef = useRef<HTMLElement | null>(null);
  const previousImageInputRef = useRef({ src, resolveImageSrc, loadingMode });
  const previewTitle = alt.trim() || "Generated image";
  const loadedResolvedSrc = resolvedImage !== null && resolvedImage.source === src && resolvedImage.status === "loaded"
    ? resolvedImage.src
    : undefined;
  const displaySrc = resolveImageSrc
    ? loadedResolvedSrc
    : src;
  const resolveFailed = resolveImageSrc !== undefined &&
    resolvedImage !== null &&
    resolvedImage.source === src &&
    resolvedImage.status === "failed";
  const setResolveAnchor = useCallback((node: HTMLElement | null) => {
    resolveAnchorRef.current = node;
  }, []);

  useEffect(() => {
    const previous = previousImageInputRef.current;
    if (
      previous.src === src &&
      previous.resolveImageSrc === resolveImageSrc &&
      previous.loadingMode === loadingMode
    ) {
      return;
    }
    previousImageInputRef.current = { src, resolveImageSrc, loadingMode };
    setShouldResolveSrc(resolveImageSrc === undefined);
    setResolvedImage(null);
  }, [loadingMode, resolveImageSrc, src]);

  useEffect(() => {
    if (!src || resolveImageSrc === undefined) return undefined;
    if (loadingMode === "manual" && !manualLoadRequested) {
      setShouldResolveSrc(false);
      return undefined;
    }
    if (typeof IntersectionObserver === "undefined") {
      setShouldResolveSrc(true);
      return undefined;
    }

    const anchor = resolveAnchorRef.current;
    if (!anchor) {
      setShouldResolveSrc(true);
      return undefined;
    }

    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setShouldResolveSrc(true);
        observer.disconnect();
      }
    }, { rootMargin: "360px" });
    observer.observe(anchor);
    return () => observer.disconnect();
  }, [loadingMode, manualLoadRequested, resolveImageSrc, src]);

  useEffect(() => {
    if (!src || resolveImageSrc === undefined || !shouldResolveSrc) return undefined;

    let cancelled = false;
    Promise.resolve(resolveImageSrc(src)).then((nextSrc) => {
      if (cancelled) return;
      setResolvedImage(nextSrc === null
        ? { source: src, status: "failed" }
        : { source: src, src: nextSrc ?? src, status: "loaded" });
    }).catch(() => {
      if (!cancelled) setResolvedImage({ source: src, status: "failed" });
    });

    return () => {
      cancelled = true;
    };
  }, [resolveImageSrc, shouldResolveSrc, src]);

  if (src && loadingMode === "manual" && !manualLoadRequested) {
    return (
      <button
        ref={setResolveAnchor}
        type="button"
        className={rwiClass("rwi-markdown-image-manual")}
        onClick={() => {
          // Large knowledge documents can contain hundreds of screenshots. Keep
          // preview scrolling stable by resolving each image only on demand.
          onManualLoad?.();
          setShouldResolveSrc(true);
        }}
        title={t("markdownImageLoad", { name: previewTitle })}
        aria-label={t("markdownImageLoad", { name: previewTitle })}
      >
        <span className={rwiClass("rwi-markdown-image-manual-copy")}>
          <span className={rwiClass("rwi-markdown-image-manual-title")}>{previewTitle}</span>
          <span className={rwiClass("rwi-markdown-image-manual-hint")}>{t("markdownImageClickToLoad")}</span>
        </span>
      </button>
    );
  }

  if (src && resolveImageSrc !== undefined && !displaySrc) {
    return (
      <span
        ref={setResolveAnchor}
        className={resolveFailed
          ? rwiClass("rwi-markdown-image-placeholder", "failed")
          : rwiClass("rwi-markdown-image-placeholder")}
        role="status"
        aria-label={resolveFailed
          ? t("markdownImageUnavailableName", { name: previewTitle })
          : t("markdownImageLoadingName", { name: previewTitle })}
      >
        {resolveFailed ? t("markdownImageUnavailable") : t("markdownImageLoading")}
      </span>
    );
  }

  const image = (
    <img
      {...props}
      src={displaySrc}
      alt={alt}
      className={rwiClass("rwi-markdown-image")}
      data-slot="rwi-markdown-image"
      loading="lazy"
    />
  );

  if (!displaySrc) return image;

  return (
    <>
      <button
        ref={setResolveAnchor}
        type="button"
        className={rwiClass("rwi-markdown-image-button")}
        onClick={() => setPreviewOpen(true)}
        title={t("attachmentPreview", { name: previewTitle })}
        aria-label={t("attachmentPreview", { name: previewTitle })}
      >
        {image}
      </button>
      {previewOpen && (
        <ImagePreviewDialog
          title={previewTitle}
          src={displaySrc}
          alt={alt}
          closeButtonRef={previewCloseRef}
          onClose={() => setPreviewOpen(false)}
          returnFocusRef={resolveAnchorRef}
        />
      )}
    </>
  );
}

export function MarkdownBody({
  className,
  content,
  dataSlot,
  resolveImageSrc,
  imageLoadingMode = "auto",
}: {
  className?: string;
  content: string;
  dataSlot?: string;
  resolveImageSrc?: MarkdownImageSrcResolver;
  imageLoadingMode?: MarkdownImageLoadingMode;
}) {
  return (
    <div
      className={joinClassNames(
        rwiClass("rwi-markdown"),
        resolveRwiClassName(className),
      )}
      data-slot={dataSlot}
    >
      <MarkdownRenderer
        content={content}
        resolveImageSrc={resolveImageSrc}
        imageLoadingMode={imageLoadingMode}
      />
    </div>
  );
}

function MarkdownDetailsBlock({
  summary,
  content,
  resolveImageSrc,
  imageLoadingMode,
}: {
  summary: string;
  content: string;
  resolveImageSrc?: MarkdownImageSrcResolver;
  imageLoadingMode?: MarkdownImageLoadingMode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <details
      className={rwiClass("rwi-markdown-details")}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <DetailsSummary summary={summary} open={open} />
      </summary>
      {open && (
        <div className={rwiClass("rwi-markdown-details-body")} onWheel={chainWheelAtVerticalBoundary}>
          <div className={rwiClass("rwi-markdown-details-content")}>
            <MarkdownBody
              content={content}
              resolveImageSrc={resolveImageSrc}
              imageLoadingMode={imageLoadingMode}
            />
          </div>
        </div>
      )}
    </details>
  );
}

export function MarkdownContent({
  content,
  resolveImageSrc,
  imageLoadingMode = "auto",
}: {
  content: string;
  resolveImageSrc?: MarkdownImageSrcResolver;
  imageLoadingMode?: MarkdownImageLoadingMode;
}) {
  const segments = parseMarkdownSegments(content);

  return (
    <div className={rwiClass("rwi-markdown", "rwi-run-markdown-output")}>
      {segments.map((segment, index) => (
        segment.type === "details" ? (
          // Details output stays collapsed during live streaming; the
          // body is mounted only after the user expands it, avoiding large tool
          // JSON from stretching the conversation before the final report lands.
          <MarkdownDetailsBlock
            key={`${index}-details`}
            summary={segment.summary}
            content={segment.content}
            resolveImageSrc={resolveImageSrc}
            imageLoadingMode={imageLoadingMode}
          />
        ) : (
          <MarkdownRenderer
            key={`${index}-markdown`}
            content={segment.content}
            resolveImageSrc={resolveImageSrc}
            imageLoadingMode={imageLoadingMode}
          />
        )
      ))}
    </div>
  );
}
