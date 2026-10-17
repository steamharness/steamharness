import { useState } from "react";
import { Check, CircleAlert, Copy, Loader2, Mail, Plus, Trash2 } from "lucide-react";
import { useTranslation } from "@steamharness/i18n/react";
import { formatDateTime } from "@steamharness/i18n";
import { Badge, Button, Field, FieldGroup, FieldLabel, IconActionButton, PageStats, SelectField, TablePanel, TableActionCell, TableBody, TableCell, TableEmptyRow, TableHead, TableHeader, TableRow } from "@/components/ui";
import { TableLoadingRows } from "@/components/ui/table-loading-rows";
import { ConfirmActionDialog, type ConfirmAction } from "@/components/ConfirmActionDialog";
import { CopyButton } from "./CopyButton";
import type { WorkflowInvitationRole } from "../../types";
import { PROJECT_MEMBER_ROLE_OPTIONS, type DetailPageProps } from "./types";

export function ProjectInvitationsTab({ project, detail, busy, onCreateProjectInvitation, onRevokeProjectInvitation }: DetailPageProps) {
  const { t } = useTranslation("serverWeb");
  const [role, setRole] = useState<WorkflowInvitationRole>("viewer");
  const [shareUrl, setShareUrl] = useState("");
  const [action, setAction] = useState<ConfirmAction | null>(null);
  const loading = Boolean(busy.project || busy.invitation || busy.revokeInvitationId);

  if (!project.canManage) return null;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 p-4 lg:p-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h2 className="text-base font-semibold">{t("storageInvitations")}</h2>
        <PageStats items={[{ label: t("storageInvitations"), value: detail.invitations?.length ?? "-" }]} />
      </div>
      <form onSubmit={event => {
        event.preventDefault();
        if (loading) return;
        void onCreateProjectInvitation(role).then(result => { if (result) setShareUrl(result.shareUrl); });
      }}>
        <FieldGroup className="max-w-3xl flex-row flex-wrap items-end gap-3">
          <Field className="w-40" data-disabled={loading}>
            <FieldLabel htmlFor="invitation-role">{t("storageRole")}</FieldLabel>
            <SelectField id="invitation-role" options={PROJECT_MEMBER_ROLE_OPTIONS} value={role}
              disabled={loading} onValueChange={value => setRole(value as WorkflowInvitationRole)} />
          </Field>
          <Button type="submit" disabled={loading}>
            {busy.invitation ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Plus data-icon="inline-start" />}
            {t("storageInvite")}
          </Button>
        </FieldGroup>
      </form>
      {shareUrl && <div className="flex min-w-0 items-center gap-2">
        <span className="break-all text-sm">{shareUrl}</span>
        <CopyButton value={shareUrl}>{copied => copied ? <Check /> : <Copy />}</CopyButton>
      </div>}
      <TablePanel className="min-w-[640px]" panelClassName="flex-1">
        <TableHeader><TableRow>
          <TableHead>{t("storageRole")}</TableHead>
          <TableHead>{t("storageExpiresAt")}</TableHead>
          <TableHead>{t("storageInvitationStatus")}</TableHead>
          <TableHead className="text-right">{t("dependenciesHeaderActions")}</TableHead>
        </TableRow></TableHeader>
        <TableBody>
          {!detail.invitations && !detail.loadErrors?.invitations ? <TableLoadingRows colSpan={4} />
            : detail.loadErrors?.invitations ? <TableEmptyRow colSpan={4} icon={<CircleAlert />} title={detail.loadErrors.invitations} />
            : !detail.invitations?.length ? <TableEmptyRow colSpan={4} icon={<Mail />} title={t("storageNoInvitations")} />
            : detail.invitations.map(invitation => <TableRow key={invitation.id}>
              <TableCell><Badge variant="secondary">{invitation.role}</Badge></TableCell>
              <TableCell>{formatDateTime(invitation.expiresAt)}</TableCell>
              <TableCell>{t(invitation.revokedAt ? "storageRevoked" : invitation.acceptedAt ? "storageAccepted" : Date.parse(invitation.expiresAt) <= Date.now() ? "storageExpired" : "storagePending")}</TableCell>
              <TableActionCell>{!invitation.revokedAt && !invitation.acceptedAt && <IconActionButton
                label={t("commonDelete")} disabled={loading} onClick={() => setAction({
                  title: t("commonDelete"), description: invitation.id, confirmLabel: t("commonDelete"),
                  tone: "destructive", onConfirm: () => onRevokeProjectInvitation(invitation.id),
                })}><Trash2 /></IconActionButton>}</TableActionCell>
            </TableRow>)}
        </TableBody>
      </TablePanel>
      <ConfirmActionDialog action={action} onOpenChange={open => { if (!open) setAction(null); }} />
    </div>
  );
}
