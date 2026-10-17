import type { ComponentProps, ReactNode } from "react";
import { Table } from "@/components/ui/table";
import { cn } from "@/lib/utils";

type TablePanelProps = ComponentProps<typeof Table> & {
  panelClassName?: string;
  toolbar?: ReactNode;
  footer?: ReactNode;
};

function TablePanel({ panelClassName, className, containerClassName, containerProps, toolbar, footer, ...props }: TablePanelProps) {
  return (
    <div data-slot="table-panel" className={cn("flex min-h-0 min-w-0 flex-col overflow-hidden rounded-md border", panelClassName)}>
      {toolbar && <div className="shrink-0">{toolbar}</div>}
      <Table
        className={cn("[&_thead]:sticky [&_thead]:top-0 [&_thead]:z-10 [&_thead]:bg-background", className)}
        containerClassName={cn("min-h-0 flex-1 overflow-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring", containerClassName)}
        containerProps={{ tabIndex: 0, role: props["aria-label"] ? "region" : undefined, "aria-label": props["aria-label"], ...containerProps }}
        {...props}
      />
      {footer && <div className="shrink-0">{footer}</div>}
    </div>
  );
}

export { TablePanel, type TablePanelProps };
