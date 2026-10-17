import { Skeleton } from "@/components/ui/skeleton";
import { TableCell, TableRow } from "@/components/ui/table";
import { useTranslation } from "@workflow-code/i18n/react";
import { cn } from "@/lib/utils";

interface TableLoadingRowsProps {
  colSpan: number;
  rows?: number;
  label?: string;
  className?: string;
}

export function TableLoadingRows({
  colSpan,
  rows = 5,
  label,
  className,
}: TableLoadingRowsProps) {
  const { t } = useTranslation("serverWeb");
  const resolvedLabel = label ?? t("tableLoadingRows");
  const widths = ["w-[36%]", "w-[20%]", "w-[14%]", "w-[24%]", "w-[10%]"];

  return (
    <>
      {Array.from({ length: rows }, (_, index) => (
        <TableRow key={index} className={cn("hover:bg-transparent", className)}>
          <TableCell colSpan={colSpan} className="h-14 px-3">
            {index === 0 && <span role="progressbar" aria-label={resolvedLabel} className="sr-only" />}
            <div className="flex items-center gap-4">
              {widths.map((width, widthIndex) => (
                <Skeleton
                  key={`${index}-${widthIndex}`}
                  className={cn(
                    "h-3.5 motion-reduce:animate-none",
                    width,
                    widthIndex > 2 && "hidden sm:block",
                    widthIndex === widths.length - 1 && "ml-auto max-w-[80px]",
                  )}
                />
              ))}
            </div>
          </TableCell>
        </TableRow>
      ))}
    </>
  );
}
