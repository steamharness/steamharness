import { useEffect, useRef, useState } from "react";
import { BookOpenText, Eye, Plus, Search, X } from "lucide-react";
import { useTranslation } from "@workflow-code/i18n/react";
import { isKnowledgeSuccess, type KnowledgeRepository, type KnowledgeWorkspaceProps } from "@workflow-code/knowledge-base";
import { Alert, AlertDescription, AlertTitle, Button, IconActionButton, PaginationFooter, SearchField, TablePanel, TableActionCell, TableBody, TableCell, TableEmptyRow, TableHead, TableHeader, TableRow } from "@/components/ui";
import { PageStats } from "@/components/ui/page-stats";
import { TableLoadingRows } from "@/components/ui/table-loading-rows";
import { formatDate } from "@/utils/format";
import { KnowledgeDocumentSheet } from "./KnowledgeDocumentSheet";

const PAGE_SIZE = 20;

interface DocumentRow {
  id: string;
  title: string;
  createdAt?: string;
  updatedAt?: string;
  line?: string;
  lineNumber?: number;
}

interface DocumentPage {
  key: string;
  rows: DocumentRow[];
  total: number;
  hasMore: boolean;
  nextCursor?: string;
}

export function KnowledgeTableWorkspace({ repository, readOnly, refreshToken = 0, resolveImageSrc, onBusyChange, onDirtyChange }: KnowledgeWorkspaceProps) {
  const { t } = useTranslation();
  const { t: tServer } = useTranslation("serverWeb");
  const [query, setQuery] = useState("");
  const [location, setLocation] = useState<{ query: string; index: number; cursors: (string | undefined)[] }>({ query: "", index: 0, cursors: [undefined] });
  const [revision, setRevision] = useState(0);
  const [page, setPage] = useState<DocumentPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<{ id?: string } | null>(null);
  const [sheetBusy, setSheetBusy] = useState(false);
  const onBusyRef = useRef(onBusyChange);
  onBusyRef.current = onBusyChange;
  const cursor = location.cursors[location.index];
  const pageKey = JSON.stringify([location.query, cursor]);
  const visiblePage = page?.key === pageKey ? page : null;
  const searching = !!location.query;

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        let next: Omit<DocumentPage, "key">;
        if (location.query) {
          const result = await repository.searchDocuments({ query: location.query, pageSize: PAGE_SIZE, cursor, beforeLines: 0, afterLines: 0, signal: controller.signal });
          if (!isKnowledgeSuccess(result)) throw new Error(result.errMessage || t("knowledgeSearchFailed"));
          next = { rows: result.data.matches.map(match => ({ id: match.documentId, title: match.title, line: match.line, lineNumber: match.lineNumber })), total: result.data.totalMatches, hasMore: result.data.hasMore, nextCursor: result.data.nextCursor };
        } else {
          const result = await repository.listDocuments({ pageSize: PAGE_SIZE, cursor, signal: controller.signal });
          if (!isKnowledgeSuccess(result)) throw new Error(result.errMessage || t("knowledgeLoadFailedFallback"));
          next = { rows: result.data.items, total: result.data.total, hasMore: result.data.hasMore, nextCursor: result.data.nextCursor };
        }
        if (controller.signal.aborted) return;
        // A deletion can remove the last row of a cursor page.
        if (!next.rows.length && location.index > 0) {
          setLocation(current => ({ ...current, index: current.index - 1, cursors: current.cursors.slice(0, current.index) }));
          return;
        }
        setPage({ ...next, key: pageKey });
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : t("knowledgeLoadFailedFallback"));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [repository, location.query, location.index, cursor, pageKey, revision, refreshToken, t]);

  useEffect(() => { onBusyRef.current?.(loading || sheetBusy); }, [loading, sheetBusy]);
  useEffect(() => () => onBusyRef.current?.(false), []);

  function search(value: string) {
    setLocation({ query: value.trim(), index: 0, cursors: [undefined] });
    setRevision(current => current + 1);
  }

  const rows = visiblePage?.rows ?? [];
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col gap-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h2 className="text-base font-semibold">{tServer("detailNavKnowledge")}</h2>
        <PageStats items={[{ label: searching ? t("searchResults") : t("documentCount"), value: visiblePage?.total ?? "-" }]} />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <form className="flex w-full items-center gap-2 sm:max-w-md" onSubmit={event => { event.preventDefault(); if (!loading) search(query); }}>
          <SearchField className="min-w-0 flex-1" aria-label={t("searchKnowledgeDocument")} placeholder={t("searchDocumentPlaceholder")} value={query} onChange={event => setQuery(event.target.value)} />
          <IconActionButton variant="outline" label={t("searchKnowledgeDocument")} disabled={loading} type="submit"><Search /></IconActionButton>
          {(query || searching) && <IconActionButton label={tServer("projectKvClear")} disabled={loading} onClick={() => { setQuery(""); search(""); }}><X /></IconActionButton>}
        </form>
        {!readOnly && <Button size="sm" onClick={() => setSelection({})}><Plus data-icon="inline-start" />{t("newDocument")}</Button>}
      </div>
      {error && <Alert variant="destructive"><AlertTitle>{t("knowledgeLoadFailed")}</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
      <TablePanel className="min-w-[760px] table-fixed" panelClassName="flex-1" aria-busy={loading} aria-label={searching ? t("knowledgeSearchResults") : t("knowledgeDocumentList")} footer={
        <PaginationFooter pageIndex={location.index} pageSize={PAGE_SIZE} total={visiblePage?.total ?? 0} rowsOnPage={rows.length} previousDisabled={loading || location.index === 0} nextDisabled={loading || !visiblePage?.hasMore || !visiblePage.nextCursor} onPrevious={() => setLocation(current => ({ ...current, index: Math.max(0, current.index - 1) }))} onNext={() => { if (visiblePage?.nextCursor) setLocation(current => ({ ...current, index: current.index + 1, cursors: [...current.cursors.slice(0, current.index + 1), visiblePage.nextCursor] })); }} />
      }>
            <TableHeader><TableRow>
              <TableHead className="w-[38%]">{t("title")}</TableHead>
              {searching ? <TableHead>{t("markdown")}</TableHead> : <>
                <TableHead>ID</TableHead>
                <TableHead className="w-40">{t("createdAt")}</TableHead>
                <TableHead className="w-40">{t("updatedAt")}</TableHead>
              </>}
              <TableHead className="w-12"><span className="sr-only">{t("preview")}</span></TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {loading && !visiblePage ? <TableLoadingRows colSpan={searching ? 3 : 5} /> : !rows.length ? <TableEmptyRow colSpan={searching ? 3 : 5} icon={<BookOpenText />} title={error ? t("knowledgeLoadFailed") : searching ? t("noSearchMatches") : t("noDocuments")} /> : rows.map(row => (
                <TableRow key={JSON.stringify([row.id, row.lineNumber])} data-state={selection?.id === row.id ? "selected" : undefined} className="cursor-pointer" onClick={() => setSelection({ id: row.id })}>
                  <TableCell>
                    <Button variant="link" className="h-auto max-w-full justify-start p-0" onClick={event => { event.stopPropagation(); setSelection({ id: row.id }); }} title={row.title}><span className="truncate">{row.title}</span></Button>
                  </TableCell>
                  {searching ? <TableCell><div className="flex min-w-0 items-center gap-3"><span className="shrink-0 font-mono text-xs text-muted-foreground">L{row.lineNumber}</span><span className="truncate" title={row.line}>{row.line}</span></div></TableCell> : <>
                    <TableCell className="truncate font-mono text-xs text-muted-foreground" title={row.id}>{row.id}</TableCell>
                    <TableCell className="text-muted-foreground">{row.createdAt ? formatDate(row.createdAt) : "-"}</TableCell>
                    <TableCell className="text-muted-foreground">{row.updatedAt ? formatDate(row.updatedAt) : "-"}</TableCell>
                  </>}
                  <TableActionCell><IconActionButton label={t("preview")} onClick={event => { event.stopPropagation(); setSelection({ id: row.id }); }}><Eye /></IconActionButton></TableActionCell>
                </TableRow>
              ))}
            </TableBody>
      </TablePanel>
      {selection && <KnowledgeDocumentSheet key={JSON.stringify(selection)} documentId={selection.id} repository={repository} readOnly={readOnly} refreshToken={refreshToken} resolveImageSrc={resolveImageSrc} onClose={() => setSelection(null)} onChanged={() => setRevision(current => current + 1)} onBusyChange={setSheetBusy} onDirtyChange={onDirtyChange} />}
    </div>
  );
}
