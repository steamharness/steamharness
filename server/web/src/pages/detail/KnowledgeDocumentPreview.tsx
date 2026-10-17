import { useEffect, useMemo, useState } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { ImageIcon } from "lucide-react";
import { useTranslation } from "@steamharness/i18n/react";
import { countMarkdownImages, getKnowledgeMarkdownByteLength, INLINE_IMAGE_MANUAL_LOAD_LIMIT, LARGE_MARKDOWN_PREVIEW_LIMIT, type KnowledgeImageSrcResolver } from "@steamharness/knowledge-base";
import { Alert, AlertDescription, Button, Separator, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui";

export function KnowledgeDocumentPreview({ markdown, resolveImageSrc }: { markdown: string; resolveImageSrc?: KnowledgeImageSrcResolver }) {
  const { t } = useTranslation();
  const metrics = useMemo(() => ({ large: getKnowledgeMarkdownByteLength(markdown, LARGE_MARKDOWN_PREVIEW_LIMIT) > LARGE_MARKDOWN_PREVIEW_LIMIT, manualImages: countMarkdownImages(markdown) > INLINE_IMAGE_MANUAL_LOAD_LIMIT }), [markdown]);
  return (
    <div className="min-w-0 break-words text-sm leading-7">
      {metrics.large ? <pre className="whitespace-pre-wrap break-words font-mono text-xs">{markdown}</pre> : <>
        {metrics.manualImages && <Alert className="mb-4"><AlertDescription>{t("manyImagesNotice")}</AlertDescription></Alert>}
        <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={(url, key) => key === "src" && /^data:image\/(?:png|jpeg|jpg|webp|gif);base64,[a-z0-9+/=\s]+$/i.test(url) ? url : defaultUrlTransform(url)} components={{
          h1: ({ children }) => <h1 className="mb-4 text-2xl font-semibold">{children}</h1>,
          h2: ({ children }) => <h2 className="mb-3 mt-6 text-xl font-semibold">{children}</h2>,
          h3: ({ children }) => <h3 className="mb-2 mt-5 text-lg font-semibold">{children}</h3>,
          h4: ({ children }) => <h4 className="mb-2 mt-4 font-semibold">{children}</h4>,
          p: ({ children }) => <p className="mb-4">{children}</p>,
          ul: ({ children }) => <ul className="mb-4 list-disc pl-6">{children}</ul>,
          ol: ({ children }) => <ol className="mb-4 list-decimal pl-6">{children}</ol>,
          blockquote: ({ children }) => <blockquote className="my-4 border-l-2 pl-4 text-muted-foreground">{children}</blockquote>,
          pre: ({ children }) => <pre className="my-4 overflow-auto rounded-md border bg-muted p-4 font-mono text-xs">{children}</pre>,
          code: ({ children }) => <code className="break-words font-mono text-xs">{children}</code>,
          a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer" className="underline underline-offset-4">{children}</a>,
          img: ({ src, alt }) => <KnowledgeImage key={src} src={typeof src === "string" ? src : ""} alt={alt ?? ""} manual={metrics.manualImages} resolveImageSrc={resolveImageSrc} />,
          hr: () => <Separator className="my-4" />,
          table: ({ children }) => <Table className="my-4">{children}</Table>,
          thead: ({ children }) => <TableHeader>{children}</TableHeader>,
          tbody: ({ children }) => <TableBody>{children}</TableBody>,
          tr: ({ children }) => <TableRow>{children}</TableRow>,
          th: ({ children }) => <TableHead>{children}</TableHead>,
          td: ({ children }) => <TableCell className="whitespace-normal">{children}</TableCell>,
        }}>{markdown}</ReactMarkdown>
      </>}
    </div>
  );
}

function KnowledgeImage({ src, alt, manual, resolveImageSrc }: { src: string; alt: string; manual: boolean; resolveImageSrc?: KnowledgeImageSrcResolver }) {
  const { t } = useTranslation();
  const [requested, setRequested] = useState(!manual);
  const [resolved, setResolved] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (!requested || !src) return;
    let active = true;
    setResolved(undefined);
    void Promise.resolve().then(() => resolveImageSrc?.(src)).then(value => { if (active) setResolved(value === undefined ? src : value); }).catch(() => { if (active) setResolved(null); });
    return () => { active = false; };
  }, [src, requested, resolveImageSrc]);
  if (!requested) return <Button variant="outline" className="my-2 max-w-full" onClick={() => setRequested(true)}><ImageIcon data-icon="inline-start" /><span className="truncate">{alt ? t("markdownImageLoad", { name: alt }) : t("markdownImageClickToLoad")}</span></Button>;
  if (resolved === undefined) return <span role="status" className="text-muted-foreground">{t("markdownImageLoading")}</span>;
  if (!resolved) return <span className="text-muted-foreground">{alt || t("imagePreviewUnavailable")}</span>;
  return <img src={resolved} alt={alt} loading="lazy" className="my-4 h-auto max-w-full rounded-md" onError={() => setResolved(null)} />;
}
