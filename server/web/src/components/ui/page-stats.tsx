import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface PageStat {
  label: string;
  value: ReactNode;
}

export interface PageStatsProps extends ComponentProps<"dl"> {
  items: readonly PageStat[];
}

export function PageStats({ items, className, ...props }: PageStatsProps) {
  return (
    <dl className={cn("order-last flex w-full flex-wrap items-center gap-x-6 gap-y-2 md:order-none md:w-auto", className)} {...props}>
      {items.map(item => (
        <div key={item.label} className="flex min-w-0 items-baseline gap-2">
          <dt className="text-xs text-muted-foreground">{item.label}</dt>
          <dd className="min-w-0 break-words text-lg font-semibold tabular-nums">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
