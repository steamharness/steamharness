import { type ReactNode, useMemo } from "react";
import {
  AlertCircle,
  Clock3,
  Eye,
  ScrollText,
  UserRound,
} from "lucide-react";
import { useTranslation } from "@steamharness/i18n/react";
import type { AuditFilters } from "../state";
import type { WorkflowAuditEventPage, WorkflowAuditEventRecord } from "../types";
import { formatDate, formatJson } from "../utils/format";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { IconActionButton, TableActionCell, TableEmptyRow } from "@/components/ui/composites";
import { Input } from "@/components/ui/input";
import { PaginationFooter } from "@/components/ui/pagination-footer";
import { SearchField } from "@/components/ui/search-field";
import { SelectField } from "@/components/ui/select-field";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { PageStats } from "@/components/ui/page-stats";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TablePanel } from "@/components/ui/table-panel";
import { TableLoadingRows } from "@/components/ui/table-loading-rows";
import { UserIdentity } from "@/components/UserIdentity";
import { cn } from "@/lib/utils";

interface AuditPageProps {
  auditPage: WorkflowAuditEventPage | null;
  filters: AuditFilters;
  loading?: string;
  error?: string | null;
  pageIndex: number;
  pageSize: number;
  selectedEventId: string | null;
  onFiltersChange: (filters: AuditFilters) => void;
  onRefresh: () => void;
  onPageChange: (direction: "next" | "previous") => void;
  onOpenDetail: (eventId: string | null) => void;
}

export function AuditPage({
  auditPage,
  filters,
  loading,
  error,
  pageIndex,
  pageSize,
  selectedEventId,
  onFiltersChange,
  onPageChange,
  onOpenDetail,
}: AuditPageProps) {
  const { t } = useTranslation("serverWeb");
  const outcomeOptions = [
    { value: "all", label: t("auditOutcomeOptions") },
    { value: "success", label: t("auditOutcomeSuccess") },
    { value: "failed", label: t("auditOutcomeFailed") },
    { value: "denied", label: t("auditOutcomeDenied") },
  ];
  const principalKindOptions = [
    { value: "", label: t("auditActorTypeOptions") },
    { value: "admin_key", label: "admin_key" },
    { value: "admin_session", label: "admin_session" },
    { value: "user_session", label: "user_session" },
    { value: "api_key", label: "api_key" },
    { value: "anonymous", label: "anonymous" },
    { value: "unknown", label: "unknown" },
  ];
  const items = auditPage?.items ?? [];
  const selectedEvent = useMemo(
    () => items.find((item) => item.id === selectedEventId) ?? null,
    [items, selectedEventId],
  );
  const deniedCount = items.filter((item) => item.outcome === "denied").length;
  const failedCount = items.filter((item) => item.outcome === "failed").length;
  const filtersActive = Boolean(
    filters.from ||
      filters.to ||
      filters.actorUserId ||
      filters.principalKind ||
      filters.eventType ||
      filters.resourceType ||
      filters.resourceId ||
      filters.outcome !== "all",
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 p-4 lg:p-6">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <div className="min-w-0 flex-1 basis-64">
          <h1 className="text-xl font-semibold text-foreground">{t("auditHeaderTitle")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("auditDescription")}
          </p>
        </div>
        <PageStats items={[
          { label: t("auditStatMatched"), value: auditPage?.total ?? 0 },
          { label: t("auditStatDenied"), value: deniedCount },
          { label: t("auditStatFailed"), value: failedCount },
        ]} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="datetime-local"
          aria-label={t("auditFilterStartTimeAria")}
          className="w-[220px]"
          value={filters.from}
          onChange={(event) => onFiltersChange({ ...filters, from: event.target.value })}
        />
        <Input
          type="datetime-local"
          aria-label={t("auditFilterEndTimeAria")}
          className="w-[220px]"
          value={filters.to}
          onChange={(event) => onFiltersChange({ ...filters, to: event.target.value })}
        />
        <SearchField
          placeholder={t("auditFilterActorUserId")}
          value={filters.actorUserId}
          onChange={(event) => onFiltersChange({ ...filters, actorUserId: event.target.value })}
          className="w-[180px]"
        />
        <SelectField
          aria-label={t("auditFilterPrincipalKindAria")}
          className="w-[170px]"
          value={filters.principalKind}
          options={principalKindOptions}
          onValueChange={(value) => onFiltersChange({ ...filters, principalKind: value })}
        />
        <SearchField
          placeholder={t("auditFilterEventType")}
          value={filters.eventType}
          onChange={(event) => onFiltersChange({ ...filters, eventType: event.target.value })}
          className="w-[180px]"
        />
        <SearchField
          placeholder={t("auditFilterResourceType")}
          value={filters.resourceType}
          onChange={(event) => onFiltersChange({ ...filters, resourceType: event.target.value })}
          className="w-[170px]"
        />
        <SearchField
          placeholder={t("auditFilterResourceId")}
          value={filters.resourceId}
          onChange={(event) => onFiltersChange({ ...filters, resourceId: event.target.value })}
          className="w-[180px]"
        />
        <SelectField
          aria-label={t("auditFilterOutcomeAria")}
          className="w-[140px]"
          value={filters.outcome}
          options={outcomeOptions}
          onValueChange={(value) => onFiltersChange({ ...filters, outcome: value as AuditFilters["outcome"] })}
        />
        <Button
          size="sm"
          variant="outline"
          disabled={!filtersActive || !!loading}
          onClick={() =>
            onFiltersChange({
              from: "",
              to: "",
              actorUserId: "",
              principalKind: "",
              eventType: "",
              resourceType: "",
              resourceId: "",
              outcome: "all",
            })
          }
        >
          {t("auditClear")}
        </Button>
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>{t("auditAlertTitle")}</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <TablePanel className="min-w-[1200px]" panelClassName="flex-1" footer={
        <PaginationFooter
          total={auditPage?.total ?? 0}
          pageIndex={pageIndex}
          pageSize={pageSize}
          rowsOnPage={items.length}
          previousDisabled={pageIndex <= 0 || !!loading}
          nextDisabled={!auditPage?.hasMore || !!loading}
          onPrevious={() => onPageChange("previous")}
          onNext={() => onPageChange("next")}
        />
      }>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[190px]">{t("auditHeaderTime")}</TableHead>
                <TableHead className="w-[190px]">{t("auditHeaderOperator")}</TableHead>
                <TableHead className="w-[140px]">{t("auditHeaderPrincipal")}</TableHead>
                <TableHead className="w-[220px]">{t("auditHeaderEvent")}</TableHead>
                <TableHead className="w-[190px]">{t("auditHeaderResource")}</TableHead>
                <TableHead className="w-[110px]">{t("auditHeaderOutcome")}</TableHead>
                <TableHead>{t("auditHeaderSource")}</TableHead>
                <TableHead className="w-[90px] text-right">{t("auditHeaderAction")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableLoadingRows colSpan={8} />
              ) : items.length === 0 ? (
                <TableEmptyRow colSpan={8} icon={<ScrollText />} title={t("auditEmptyTitle")} description={t("auditEmptyDescription")} />
              ) : (
                items.map((item) => (
                  <TableRow
                    key={item.id}
                    className="cursor-pointer"
                    onClick={() => onOpenDetail(item.id)}
                  >
                    <TableCell className="text-sm text-muted-foreground">{formatDate(item.createdAt)}</TableCell>
                    <TableCell>
                      <UserIdentity user={getAuditActorIdentity(item)} fallbackLabel={t("auditActorFallback")} size="sm" />
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{item.principalKind}</Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-foreground">{item.eventType}</TableCell>
                    <TableCell>
                      <div className="flex min-w-0 flex-col gap-1">
                        <span className="truncate text-sm text-foreground">{item.resourceType ?? t("auditNotSpecified")}</span>
                        <span className="truncate text-xs text-muted-foreground" title={item.resourceId}>
                          {item.resourceId ?? t("auditNoResourceId")}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <OutcomeBadge outcome={item.outcome} />
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      <div className="flex min-w-0 flex-col gap-1">
                        <span className="truncate">{item.requestIp ?? t("auditNoIp")}</span>
                        <span className="truncate" title={item.userAgent}>{item.userAgent ?? t("auditNoUa")}</span>
                      </div>
                    </TableCell>
                    <TableActionCell>
                      <IconActionButton
                        label={t("auditViewDetailAria")}
                        onClick={(event) => {
                          event.stopPropagation();
                          onOpenDetail(item.id);
                        }}
                      >
                        <Eye />
                      </IconActionButton>
                    </TableActionCell>
                  </TableRow>
                ))
              )}
            </TableBody>
      </TablePanel>

      <Sheet open={selectedEvent !== null} onOpenChange={(open) => !open && onOpenDetail(null)}>
        <SheetContent side="right" className="w-full gap-0 sm:max-w-[560px]">
          <SheetHeader className="border-b">
            <SheetTitle>{t("auditDetailTitle")}</SheetTitle>
            <SheetDescription>{t("auditDetailSheetDescription")}</SheetDescription>
          </SheetHeader>
          {selectedEvent ? (
            <div className="flex min-h-0 flex-1 flex-col overflow-auto p-4">
              <div className="grid gap-3">
                <DetailRow icon={<Clock3 className="size-4" />} label={t("auditDetailTime")} value={formatDate(selectedEvent.createdAt)} />
                <DetailRow
                  icon={<UserRound className="size-4" />}
                  label={t("auditDetailOperator")}
                  value={<UserIdentity user={getAuditActorIdentity(selectedEvent)} fallbackLabel={t("auditActorFallback")} size="sm" />}
                />
                <DetailRow label={t("auditFilterPrincipalKindAria")} value={selectedEvent.principalKind} />
                <DetailRow label={t("auditDetailEventType")} value={selectedEvent.eventType} mono />
                <DetailRow label={t("auditDetailResourceType")} value={selectedEvent.resourceType ?? t("auditNotSpecified")} />
                <DetailRow label={t("auditDetailResourceId")} value={selectedEvent.resourceId ?? t("auditNotSpecified")} mono />
                <DetailRow label={t("auditDetailOutcome")} value={<OutcomeBadge outcome={selectedEvent.outcome} />} />
                <DetailRow label={t("auditDetailIp")} value={selectedEvent.requestIp ?? t("commonNotRecorded")} />
                <DetailRow label={t("auditDetailUserAgent")} value={selectedEvent.userAgent ?? t("commonNotRecorded")} />
              </div>

              <div className="mt-4 rounded-lg border border-border bg-muted p-4">
                <div className="mb-2 text-sm font-medium text-foreground">{t("auditDetailContext")}</div>
                <pre className="overflow-x-auto whitespace-pre-wrap break-all text-xs leading-5 text-muted-foreground">
                  {formatJson(selectedEvent.context)}
                </pre>
              </div>
            </div>
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function getAuditActorIdentity(item: WorkflowAuditEventRecord) {
  return {
    userId: item.actorProfile?.userId ?? item.actorProfileId ?? item.actorUserId,
    displayName: item.actorProfile?.displayName ?? item.actorDisplayName,
    email: item.actorProfile?.email,
    avatarUrl: item.actorProfile?.avatarUrl,
  };
}

function OutcomeBadge({ outcome }: { outcome: WorkflowAuditEventRecord["outcome"] }) {
  const { t } = useTranslation("serverWeb");
  if (outcome === "success") {
    return <Badge variant="secondary">{t("auditOutcomeSuccess")}</Badge>;
  }
  if (outcome === "failed") {
    return <Badge variant="destructive">{t("auditOutcomeFailed")}</Badge>;
  }
  return <Badge variant="secondary">{t("auditOutcomeDenied")}</Badge>;
}

function DetailRow({
  label,
  value,
  icon,
  mono = false,
}: {
  label: string;
  value: ReactNode;
  icon?: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border bg-card px-3 py-2.5">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {icon}
        <span>{label}</span>
      </div>
      <div className={cn("text-sm text-foreground", mono && "font-mono")}>{value}</div>
    </div>
  );
}
