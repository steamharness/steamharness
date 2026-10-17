"use client"

import * as React from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useTranslation } from "@workflow-code/i18n/react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type PaginationFooterProps = {
  pageIndex: number;
  pageSize?: number;
  total: number;
  rowsOnPage: number;
  onPrevious?: () => void;
  onNext?: () => void;
  previousDisabled?: boolean;
  nextDisabled?: boolean;
  className?: string;
  label?: string;
};

const DEFAULT_PAGE_SIZE = 20;

// keeps server/web management tables on one shared Chinese 20-row pager.
function PaginationFooter({
  pageIndex,
  pageSize = DEFAULT_PAGE_SIZE,
  total,
  rowsOnPage,
  onPrevious,
  onNext,
  previousDisabled,
  nextDisabled,
  className,
  label,
}: PaginationFooterProps) {
  const { t } = useTranslation("serverWeb");
  const normalizedTotal = Math.max(0, total);
  const safePageIndex = Math.max(0, pageIndex);
  const start = normalizedTotal === 0 || rowsOnPage === 0 ? 0 : safePageIndex * pageSize + 1;
  const end = normalizedTotal === 0 || rowsOnPage === 0 ? 0 : Math.min(normalizedTotal, safePageIndex * pageSize + rowsOnPage);
  const pageCount = Math.max(1, Math.ceil(normalizedTotal / pageSize));
  const hasPrevious = safePageIndex > 0;
  const hasNext = safePageIndex + 1 < pageCount || safePageIndex * pageSize + rowsOnPage < normalizedTotal;
  const resolvedLabel = label ?? t("paginationFooter");
  const previousLabel = t("paginationPrevious");
  const nextLabel = t("paginationNext");

  return (
    <div
      aria-label={resolvedLabel}
      className={cn(
        "flex flex-wrap items-center justify-end gap-3 border-t border-border px-3 py-2 text-[13px] text-muted-foreground",
        className,
      )}
    >
      <span>{t("paginationRowsPerPage")}</span>
      <span>{pageSize}</span>
      <span>{t("paginationRange", { start, end, total: normalizedTotal })}</span>
      {pageCount > 1 && <Badge variant="outline">{Math.min(safePageIndex + 1, pageCount)} / {pageCount}</Badge>}
      <div className="flex items-center gap-1">
        <Button
          size="sm"
          variant="ghost"
          disabled={previousDisabled ?? !hasPrevious}
          onClick={onPrevious}
          aria-label={t("paginationPreviousAria")}
          title={previousLabel}
        >
          <ChevronLeft data-icon="inline-start" />
          {previousLabel}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={nextDisabled ?? !hasNext}
          onClick={onNext}
          aria-label={t("paginationNextAria")}
          title={nextLabel}
        >
          {nextLabel}
          <ChevronRight data-icon="inline-end" />
        </Button>
      </div>
    </div>
  );
}

export { DEFAULT_PAGE_SIZE, PaginationFooter, type PaginationFooterProps };
