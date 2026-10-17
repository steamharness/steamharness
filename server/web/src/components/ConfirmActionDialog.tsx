import { Loader2, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "@steamharness/i18n/react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export type ConfirmActionTone = "destructive" | "warning" | "default";

export type ConfirmAction = {
  title: string;
  description: ReactNode;
  details?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: ConfirmActionTone;
  busy?: boolean;
  onConfirm: () => void;
};

type ConfirmActionDialogProps = {
  action: ConfirmAction | null;
  onOpenChange: (open: boolean) => void;
};

export function ConfirmActionDialog({ action, onOpenChange }: ConfirmActionDialogProps) {
  const { t } = useTranslation("serverWeb");
  const tone = action?.tone ?? "destructive";

  return (
    <AlertDialog open={action !== null} onOpenChange={onOpenChange}>
      {action ? (
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia>
              <TriangleAlert />
            </AlertDialogMedia>
            <AlertDialogTitle>{action.title}</AlertDialogTitle>
            <AlertDialogDescription>{action.description}</AlertDialogDescription>
          </AlertDialogHeader>
          {action.details ? (
            <div className="rounded-lg border border-border bg-muted/50 px-3 py-2 text-xs leading-5 text-muted-foreground">
              {action.details}
            </div>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={action.busy}>{action.cancelLabel ?? t("confirmActionCancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant={tone === "destructive" ? "destructive" : "default"}
              disabled={action.busy}
              onClick={(event) => {
                if (action.busy) {
                  event.preventDefault();
                  return;
                }
                action.onConfirm();
              }}
            >
              {action.busy ? <Loader2 data-icon="inline-start" className="animate-spin" /> : null}
              {action.confirmLabel ?? t("confirmActionConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      ) : null}
    </AlertDialog>
  );
}
