import { useEffect, useState } from "react";
import { useTranslation } from "@steamharness/i18n/react";
import { apiClient } from "../api";
import { isApiSuccess, type Summary } from "../types";
import { GroupSelector } from "./GroupSelector";
import { Button } from "@/components/ui";
import { ConfirmActionDialog, type ConfirmAction } from "./ConfirmActionDialog";
export function ProjectOwnership({
  project,
  onRefresh,
}: {
  project: Summary;
  onRefresh: () => void;
}) {
  const { t } = useTranslation("serverWeb");
  const [group, setGroup] = useState<string | null>(project.groupId ?? null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [action, setAction] = useState<ConfirmAction | null>(null);
  useEffect(
    () => setGroup(project.groupId ?? null),
    [project.id, project.groupId],
  );
  if (!project.access?.capabilities.includes("transfer")) return null;
  return (
    <div className="flex max-w-2xl flex-col gap-3">
      <GroupSelector value={group} onChange={setGroup} ownerOnly />
      <Button
        className="self-start"
        variant="outline"
        disabled={busy || group === (project.groupId ?? null)}
        onClick={() =>
          setAction({
            title: t("accessTransfer"),
            description: project.name,
            confirmLabel: t("commonSave"),
            tone: "warning",
            onConfirm: async () => {
              setBusy(true);
              const result = await apiClient.transferProject(project.id, group);
              setBusy(false);
              if (!isApiSuccess(result)) setError(result.errMessage);
              else onRefresh();
            },
          })
        }
      >
        {t("accessTransfer")}
      </Button>
      <Button
        className="self-start"
        variant="destructive"
        disabled={busy}
        onClick={() =>
          setAction({
            title: t("accessDeleteProject"),
            description: project.name,
            confirmLabel: t("commonDelete"),
            tone: "destructive",
            onConfirm: async () => {
              setBusy(true);
              const result = await apiClient.deleteProject(project.id);
              setBusy(false);
              if (!isApiSuccess(result)) setError(result.errMessage);
              else window.location.assign("/projects");
            },
          })
        }
      >
        {t("accessDeleteProject")}
      </Button>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <ConfirmActionDialog
        action={action}
        onOpenChange={(open) => {
          if (!open) setAction(null);
        }}
      />
    </div>
  );
}
