
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Copy, Database, Eye, Loader2, Search, Trash2 } from "lucide-react";
import { useTranslation } from "@steamharness/i18n/react";
import type { ApiResponse, WorkflowKVEntryDetail, WorkflowKVEntryPage, WorkflowKVEntrySummary, WorkflowKVEntryValueType } from "../types";
import { isApiSuccess } from "../types";
import { formatBytes, formatDate } from "../utils/format";
import { ConfirmActionDialog, type ConfirmAction } from "@/components/ConfirmActionDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { IconActionButton, TableActionCell, TableEmptyRow } from "@/components/ui/composites";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { PageStats } from "@/components/ui/page-stats";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { SearchField } from "@/components/ui/search-field";
import { SelectField } from "@/components/ui/select-field";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TablePanel } from "@/components/ui/table-panel";
import { TableLoadingRows } from "@/components/ui/table-loading-rows";
import { PaginationFooter } from "@/components/ui/pagination-footer";

export type KVFilters = {
  query: string;
  scope: "all" | "project" | "conversation";
  valueType: "all" | WorkflowKVEntryValueType;
  conversationId: string;
  runId: string;
};

const KV_DETAIL_RENDER_LIMIT_BYTES = 256 * 1024;

function buildValueTypeOptions(allLabel: string) {
  return (["all", "object", "array", "string", "number", "boolean", "null"] as const).map((v) => ({
    value: v,
    label: v === "all" ? allLabel : v,
  }));
}



function scopeBadge(scope: string): "secondary" | "outline" {
  if (scope === "project") return "secondary";
  return "outline";
}

function kvEntryKey(entry: WorkflowKVEntrySummary): string {
  return `${entry.scope}:${entry.key}:${entry.projectId}:${entry.conversationId ?? ""}`;
}

interface KVTableProps {
  entries: WorkflowKVEntrySummary[];
  loading?: string;
  selectedRowKey: string | null;
  onOpenDetail: (entry: WorkflowKVEntrySummary) => void;
  footer: ReactNode;
}

type KVEntryLoader = (entry: WorkflowKVEntrySummary) => Promise<ApiResponse<WorkflowKVEntryDetail>>;

type KVEntryDeleter = (entry: WorkflowKVEntrySummary) => Promise<ApiResponse<unknown>>;

type KVExpandedPanelState = {
  rowKey: string;
  entry: WorkflowKVEntrySummary;
  detail?: WorkflowKVEntryDetail;
  loading: boolean;
  error?: string;
};

interface KVInspectorPageProps {
  kvPage: WorkflowKVEntryPage | null;
  filters: KVFilters;
  loading?: string;
  pageIndex: number;
  pageSize: number;
  onFiltersChange: (filters: KVFilters) => void;
  onRefresh: () => void;
  onPageChange: (direction: "next" | "previous") => void;
  onLoadEntry?: KVEntryLoader;
  onDeleteEntry?: KVEntryDeleter;
}

export function KVInspectorPage({
  kvPage, filters, loading, pageIndex, pageSize, onFiltersChange, onRefresh, onPageChange, onLoadEntry, onDeleteEntry,
}: KVInspectorPageProps) {
  const { t } = useTranslation("serverWeb");
  const entries = kvPage?.items ?? [];
  const { selectedRowKey, panel, openDetail, closeDetail, loadDetail } = useKVExpansion(entries, onLoadEntry);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const deletingRef = useRef(false);

  const handleOpenDetail = useCallback((entry: WorkflowKVEntrySummary) => {
    setDeleteError(null);
    openDetail(entry);
  }, [openDetail]);

  const runDelete = useCallback(async (entry: WorkflowKVEntrySummary) => {
    if (onDeleteEntry === undefined || deletingRef.current) return;
    deletingRef.current = true;
    setDeleting(true);
    setConfirmAction((current) => (current === null ? current : { ...current, busy: true }));
    try {
      const result = await onDeleteEntry(entry);
      if (!isApiSuccess(result)) {
        setDeleteError(result.errMessage || t("projectKvDeleteFailed"));
        return;
      }
      setDeleteError(null);
      closeDetail();
      onRefresh();
    } catch (cause) {
      setDeleteError(cause instanceof Error ? cause.message : t("projectKvDeleteFailed"));
    } finally {
      deletingRef.current = false;
      setDeleting(false);
      setConfirmAction(null);
    }
  }, [closeDetail, onDeleteEntry, onRefresh, t]);

  const requestDelete = useCallback((entry: WorkflowKVEntrySummary) => {
    if (onDeleteEntry === undefined) return;
    setConfirmAction({
      title: t("projectKvDeleteConfirmTitle"),
      description: t("projectKvDeleteConfirmDescription", { key: entry.key }),
      details: (
        <div className="flex flex-col gap-1">
          <span>{t("projectKvDeleteConfirmScope")}{entry.scope}</span>
          <span>{t("projectKvDeleteConfirmKey")}{entry.key}</span>
          {entry.conversationId ? <span>{t("projectKvDeleteConfirmConversation")}{entry.conversationId}</span> : null}
        </div>
      ),
      confirmLabel: t("projectKvDeleteAction"),
      tone: "destructive",
      onConfirm: () => { void runDelete(entry); },
    });
  }, [onDeleteEntry, runDelete, t]);
  const valueTypeOptions = buildValueTypeOptions(t("projectKvValueTypeAll"));

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h2 className="text-base font-semibold">{t("detailNavKv")}</h2>
        <PageStats items={[{ label: t("projectDataStatEntries"), value: kvPage?.total ?? "-" }]} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <SearchField icon={<Search />} aria-label={t("projectKvFilterSearch")} placeholder={t("projectKvFilterSearch")} value={filters.query} onChange={(e) => onFiltersChange({ ...filters, query: e.target.value })} className="w-full sm:w-64" />
        <SelectField aria-label={t("projectKvFilterScopeAria")} className="w-[110px]" value={filters.scope} options={[{ value: "all", label: t("commonAll") }, { value: "project", label: "project" }, { value: "conversation", label: "conversation" }]} onValueChange={(value) => onFiltersChange({ ...filters, scope: value as KVFilters["scope"] })} />
        <SelectField aria-label={t("projectKvFilterValueTypeAria")} className="w-[110px]" value={filters.valueType} options={valueTypeOptions} onValueChange={(value) => onFiltersChange({ ...filters, valueType: value as KVFilters["valueType"] })} />
        <Input aria-label="conversationId" placeholder="conversationId" value={filters.conversationId} className="w-full sm:w-44" onChange={(e) => onFiltersChange({ ...filters, conversationId: e.target.value })} />
        <Input aria-label={t("projectKvFilterRunId")} placeholder={t("projectKvFilterRunId")} value={filters.runId} className="w-full sm:w-40" onChange={(e) => onFiltersChange({ ...filters, runId: e.target.value })} />
        <Button size="sm" variant="outline" disabled={!hasActiveKVFilters(filters)} onClick={() => onFiltersChange({ query: "", scope: "all", valueType: "all", conversationId: "", runId: "" })}>{t("projectKvClear")}</Button>
      </div>

      <KVTable entries={entries} loading={loading} selectedRowKey={selectedRowKey} onOpenDetail={handleOpenDetail} footer={
        <PaginationFooter
          total={kvPage?.total ?? 0}
          pageIndex={pageIndex}
          pageSize={pageSize}
          rowsOnPage={entries.length}
          previousDisabled={pageIndex <= 0 || !!loading}
          nextDisabled={!kvPage?.hasMore || !!loading}
          onPrevious={() => onPageChange("previous")}
          onNext={() => onPageChange("next")}
        />
      } />
      <KVDetailSheet
        panel={panel}
        deleteError={deleteError}
        canDelete={onDeleteEntry !== undefined}
        deleting={deleting}
        onClose={() => { if (!deletingRef.current) closeDetail(); }}
        onLoadDetail={loadDetail}
        onDelete={requestDelete}
      />
      <ConfirmActionDialog
        action={confirmAction}
        onOpenChange={(open) => { if (!open && !deletingRef.current) setConfirmAction(null); }}
      />
    </div>
  );
}

function useKVExpansion(entries: WorkflowKVEntrySummary[], onLoadEntry: KVEntryLoader | undefined) {
  const [panel, setPanel] = useState<KVExpandedPanelState | null>(null);
  const requestRef = useRef(0);

  useEffect(() => {
    setPanel((current) => {
      if (current === null) return null;
      const nextEntry = entries.find((entry) => kvEntryKey(entry) === current.rowKey);
      if (nextEntry === undefined) return null;
      if (isSameKVPanelEntry(nextEntry, current.entry)) return current;

      // KV rows refresh independently from the expanded panel; keep
      // the panel on the latest row summary and force details to be reloaded.
      return {
        ...current,
        entry: nextEntry,
        detail: hasFullKVValue(nextEntry) ? nextEntry : undefined,
        loading: false,
        error: undefined,
      };
    });
  }, [entries]);

  function openDetail(entry: WorkflowKVEntrySummary) {
    requestRef.current++;
    const rowKey = kvEntryKey(entry);
    setPanel({
      rowKey,
      entry,
      detail: hasFullKVValue(entry) ? entry : undefined,
      loading: false,
    });
  }

  function closeDetail() {
    requestRef.current++;
    setPanel(null);
  }

  function loadDetail() {
    if (panel === null || onLoadEntry === undefined || panel.loading || panel.detail !== undefined) return;
    const { rowKey, entry } = panel;
    const requestId = ++requestRef.current;
    setPanel((current) => current?.rowKey === rowKey ? { ...current, loading: true, error: undefined } : current);
    void onLoadEntry(entry)
      .then((response) => {
        if (requestId !== requestRef.current) return;
        setPanel((current) => {
          if (current?.rowKey !== rowKey || current.entry !== entry) return current;
          if (!isApiSuccess(response)) {
            return { ...current, loading: false, error: response.errMessage };
          }
          return { ...current, detail: response.data, loading: false, error: undefined };
        });
      })
      .catch((error: unknown) => {
        if (requestId !== requestRef.current) return;
        setPanel((current) => current?.rowKey === rowKey && current.entry === entry
          ? { ...current, loading: false, error: error instanceof Error ? error.message : String(error) }
          : current);
      });
  }

  return {
    selectedRowKey: panel?.rowKey ?? null,
    panel,
    openDetail,
    closeDetail,
    loadDetail,
  };
}

function KVDetailSheet({
  panel,
  deleteError,
  canDelete,
  deleting,
  onClose,
  onLoadDetail,
  onDelete,
}: {
  panel: KVExpandedPanelState | null;
  deleteError?: string | null;
  canDelete?: boolean;
  deleting?: boolean;
  onClose: () => void;
  onLoadDetail?: () => void;
  onDelete?: (entry: WorkflowKVEntrySummary) => void;
}) {
  const { t } = useTranslation("serverWeb");
  const [copied, setCopied] = useState<"key" | "json" | null>(null);
  const [copyFailed, setCopyFailed] = useState(false);
  const entry = panel?.detail ?? panel?.entry;
  const panelRowKey = panel?.rowKey;
  const panelLoading = panel?.loading === true;
  const panelError = panel?.error;
  const hasPanelDetail = panel?.detail !== undefined;
  const canRenderFullValue = panel !== null && panel !== undefined && hasPanelDetail && entry !== undefined && entry.valueSizeBytes <= KV_DETAIL_RENDER_LIMIT_BYTES;
  const canLoadFullValue = panel !== null && panel !== undefined && !hasPanelDetail && entry !== undefined && entry.valueSizeBytes <= KV_DETAIL_RENDER_LIMIT_BYTES && onLoadDetail !== undefined;
  const valueText = canRenderFullValue ? formatJSON(panel?.detail?.value) : entry?.valuePreview ?? "";
  const valueCopyLabel = canRenderFullValue ? t("projectKvCopyJson") : t("projectKvCopySummary");
  const valueCopiedLabel = canRenderFullValue ? t("projectKvCopyJsonCopied") : t("projectKvCopySummaryCopied");
  const detailTooLarge = entry !== undefined && entry.valueSizeBytes > KV_DETAIL_RENDER_LIMIT_BYTES;

  useEffect(() => {
    setCopied(null);
    setCopyFailed(false);
  }, [panelRowKey]);

  useEffect(() => {
    if (canLoadFullValue && !panelLoading && panelError === undefined) {
      onLoadDetail?.();
    }
  }, [canLoadFullValue, onLoadDetail, panelError, panelLoading, panelRowKey]);

  if (!panel || !entry) return null;

  async function copy(kind: "key" | "json", value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopyFailed(false);
      setCopied(kind);
      window.setTimeout(() => setCopied((current) => (current === kind ? null : current)), 1400);
    } catch {
      setCopied(null);
      setCopyFailed(true);
      window.setTimeout(() => setCopyFailed(false), 2400);
    }
  }

  const meta: Array<[string, string]> = [
    ["project", entry.projectId ?? entry.lastProjectId ?? t("projectKvNotRecorded")],
    ["conversation", entry.conversationId ?? entry.lastConversationId ?? t("projectKvMetaUnlinked")],
    [t("projectKvMetaLastRun"), entry.lastRunId ?? t("projectKvNotRecorded")],
    [t("projectKvHeaderUpdatedAt"), formatDate(entry.updatedAt)],
  ];

  return (
    <Sheet open={panel !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent className="w-full gap-0 sm:max-w-3xl">
        <SheetHeader className="shrink-0 pr-12">
          <SheetTitle>{t("projectKvDetailTitle")}</SheetTitle>
          <div className="flex items-start gap-2">
            <SheetDescription className="min-w-0 flex-1 break-all font-mono text-xs">{entry.key}</SheetDescription>
            <IconActionButton label={copied === "key" ? t("commonCopied") : t("projectKvCopyKey")} onClick={() => void copy("key", entry.key)}><Copy /></IconActionButton>
          </div>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Badge variant={scopeBadge(entry.scope)}>{entry.scope}</Badge>
            <Badge variant="outline">{entry.valueType}</Badge>
            <span className="text-xs text-muted-foreground">{formatBytes(entry.valueSizeBytes)}</span>
          </div>
        </SheetHeader>
        <Separator />

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4">
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {meta.map(([label, value]) => (
              <div key={label} className="min-w-0">
                <dt className="text-xs text-muted-foreground">{label}</dt>
                <dd className="break-all font-mono text-xs" title={value}>{value}</dd>
              </div>
            ))}
          </dl>
          <Separator />

          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-medium">{t("projectKvHeaderValue")}</h3>
            {canLoadFullValue && panel.error && (
              <Button size="sm" variant="outline" onClick={onLoadDetail} disabled={panel.loading}>
                {t("projectKvLoadJsonRetry")}
              </Button>
            )}
            <IconActionButton variant="outline" className="ml-auto" label={copied === "json" ? valueCopiedLabel : valueCopyLabel} disabled={panel.loading} onClick={() => void copy("json", valueText)}><Copy /></IconActionButton>
          </div>

          {deleteError && <Alert variant="destructive"><AlertDescription>{deleteError}</AlertDescription></Alert>}

          {copyFailed && <Alert variant="destructive"><AlertDescription>{t("projectKvCopyFailed")}</AlertDescription></Alert>}
          {panel.loading && (
            <span role="progressbar" aria-label={t("projectKvDetailLoadingAria")} className="inline-flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> {t("projectKvDetailLoadingText")}
            </span>
          )}
          {panel.error && <Alert variant="destructive"><AlertDescription>{panel.error}</AlertDescription></Alert>}
          {detailTooLarge && (
            <p className="text-xs text-muted-foreground">{t("projectKvDetailTooLarge")}</p>
          )}

          <pre className="min-h-64 flex-1 overflow-auto rounded-md border bg-muted p-4 font-mono text-xs whitespace-pre-wrap break-words">{valueText}</pre>
        </div>
        {canDelete && <><Separator /><SheetFooter className="shrink-0 sm:flex-row"><Button size="sm" variant="destructive" disabled={deleting} onClick={() => onDelete?.(entry)}>{deleting ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Trash2 data-icon="inline-start" />}{t("projectKvDeleteAction")}</Button></SheetFooter></>}
      </SheetContent>
    </Sheet>
  );
}

function hasFullKVValue(entry: WorkflowKVEntrySummary): entry is WorkflowKVEntryDetail {
  return "value" in entry;
}

function isSameKVPanelEntry(left: WorkflowKVEntrySummary, right: WorkflowKVEntrySummary): boolean {
  return left.scope === right.scope &&
    left.key === right.key &&
    left.projectId === right.projectId &&
    left.conversationId === right.conversationId &&
    left.valueType === right.valueType &&
    left.valueSizeBytes === right.valueSizeBytes &&
    left.valuePreview === right.valuePreview &&
    left.updatedAt === right.updatedAt &&
    left.lastProjectId === right.lastProjectId &&
    left.lastRunId === right.lastRunId &&
    left.lastConversationId === right.lastConversationId;
}

function hasActiveKVFilters(filters: KVFilters): boolean {
  return filters.query !== "" ||
    filters.scope !== "all" ||
    filters.valueType !== "all" ||
    filters.conversationId !== "" ||
    filters.runId !== "";
}

function formatJSON(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}



function KVTable({ entries, loading, selectedRowKey, onOpenDetail, footer }: KVTableProps) {
  const { t } = useTranslation("serverWeb");
  return (
    <TablePanel className="min-w-[760px] table-fixed" panelClassName="flex-1" footer={footer}>
      <TableHeader>
        <TableRow>
          <TableHead>{t("projectKvHeaderKey")}</TableHead>
          <TableHead className="w-32">{t("projectKvFilterScopeAria")}</TableHead>
          <TableHead className="w-24">{t("projectKvFilterValueTypeAria")}</TableHead>
          <TableHead className="w-32 text-right">{t("projectDataStatValueSize")}</TableHead>
          <TableHead className="w-40">{t("projectKvHeaderUpdatedAt")}</TableHead>
          <TableHead className="w-12"><span className="sr-only">{t("projectKvViewDetail")}</span></TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {loading ? (
          <TableLoadingRows colSpan={6} />
        ) : entries.length === 0 ? (
          <TableEmptyRow
            colSpan={6}
            title={t("projectKvEmptyTitle")}
            description={t("projectKvEmptyDescription")}
            icon={<Database />}
          />
        ) : (
          entries.map((entry) => {
            const rowKey = kvEntryKey(entry);
            const selected = selectedRowKey === rowKey;
            return (
              <TableRow
                key={rowKey}
                data-state={selected ? "selected" : undefined}
                className="cursor-pointer"
                onClick={() => onOpenDetail(entry)}
              >
                <TableCell><Button variant="link" className="h-auto max-w-full justify-start p-0 font-mono" title={entry.key} onClick={event => { event.stopPropagation(); onOpenDetail(entry); }}><span className="truncate">{entry.key}</span></Button></TableCell>
                <TableCell><Badge variant={scopeBadge(entry.scope)}>{entry.scope}</Badge></TableCell>
                <TableCell><Badge variant="outline">{entry.valueType}</Badge></TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">{formatBytes(entry.valueSizeBytes)}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{formatDate(entry.updatedAt)}</TableCell>
                <TableActionCell><IconActionButton label={t("projectKvViewDetail")} onClick={event => { event.stopPropagation(); onOpenDetail(entry); }}><Eye /></IconActionButton></TableActionCell>
              </TableRow>
            );
          })
        )}
      </TableBody>
    </TablePanel>
  );
}
