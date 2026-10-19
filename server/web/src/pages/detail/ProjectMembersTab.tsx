import { useState } from "react";
import { CircleAlert, Plus, Trash2, Users } from "lucide-react";
import { useTranslation } from "@steamharness/i18n/react";
import { formatDateTime } from "@steamharness/i18n";
import { Badge, Button, Field, FieldGroup, FieldLabel, IconActionButton, Input, PageStats, SelectField, TablePanel, TableActionCell, TableBody, TableCell, TableEmptyRow, TableHead, TableHeader, TableRow } from "@/components/ui";
import { TableLoadingRows } from "@/components/ui/table-loading-rows";
import { UserIdentity } from "@/components/UserIdentity";
import { ConfirmActionDialog, type ConfirmAction } from "@/components/ConfirmActionDialog";
import type { InvitationRole } from "../../types";
import { PROJECT_MEMBER_ROLE_OPTIONS, type DetailPageProps } from "./types";

export function ProjectMembersTab({ project, detail, busy, onSetProjectMember, onRemoveProjectMember }: DetailPageProps) {
  const { t } = useTranslation("serverWeb");
  const [userId, setUserId] = useState("");
  const [role, setRole] = useState<InvitationRole>("viewer");
  const [action, setAction] = useState<ConfirmAction | null>(null);
  const loading = Boolean(busy.project);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 p-4 lg:p-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h2 className="text-base font-semibold">{t("storageMembers")}</h2>
        <PageStats items={[{ label: t("storageMembers"), value: detail.members?.length ?? "-" }]} />
      </div>
      {project.canManage && <FieldGroup className="max-w-3xl">
        <div className="flex flex-wrap items-end gap-3">
          <Field className="min-w-40 flex-1"><FieldLabel htmlFor="member-id">{t("storageUserId")}</FieldLabel><Input id="member-id" value={userId} onChange={event => setUserId(event.target.value)} /></Field>
          <Field className="w-40"><FieldLabel htmlFor="member-role">{t("storageRole")}</FieldLabel><SelectField id="member-role" options={PROJECT_MEMBER_ROLE_OPTIONS} value={role} onValueChange={value => setRole(value as InvitationRole)} /></Field>
          <Button disabled={loading || !userId.trim()} onClick={() => onSetProjectMember(userId.trim(), role)}><Plus data-icon="inline-start" />{t("storageAddMember")}</Button>
        </div>
      </FieldGroup>}
      <TablePanel className="min-w-[680px]" panelClassName="flex-1">
        <TableHeader><TableRow><TableHead>{t("storageUserId")}</TableHead><TableHead className="w-44">{t("storageRole")}</TableHead><TableHead>{t("storageCreatedAt")}</TableHead><TableHead className="text-right">{t("dependenciesHeaderActions")}</TableHead></TableRow></TableHeader>
        <TableBody>{busy.project && !detail.members ? <TableLoadingRows colSpan={4} /> : detail.loadErrors?.members ? <TableEmptyRow colSpan={4} icon={<CircleAlert />} title={detail.loadErrors.members} /> : !detail.members?.length ? <TableEmptyRow colSpan={4} icon={<Users />} title={t("storageNoMembers")} /> : detail.members.map(member => <TableRow key={member.userId}>
          <TableCell><UserIdentity user={{userId: member.userId, ...member.profile}} /></TableCell>
          <TableCell>{member.role === "owner" || !project.canManage ? <Badge variant="secondary">{member.role}</Badge> : <SelectField size="sm" aria-label={`${member.userId} ${t("storageRole")}`} options={PROJECT_MEMBER_ROLE_OPTIONS} value={member.role} disabled={loading} onValueChange={value => setAction({title: t("storageRole"), description: `${member.userId}: ${value}`, confirmLabel: t("commonSave"), tone: "warning", onConfirm: () => onSetProjectMember(member.userId, value as InvitationRole)})} />}</TableCell>
          <TableCell>{formatDateTime(member.createdAt)}</TableCell>
          <TableActionCell>{member.role !== "owner" && project.canManage && <IconActionButton label={t("commonDelete")} disabled={loading} onClick={() => setAction({title: t("commonDelete"), description: member.userId, confirmLabel: t("commonDelete"), tone: "destructive", onConfirm: () => onRemoveProjectMember(member.userId)})}><Trash2 /></IconActionButton>}</TableActionCell>
        </TableRow>)}</TableBody>
      </TablePanel>
      <ConfirmActionDialog action={action} onOpenChange={open => { if (!open) setAction(null); }} />
    </div>
  );
}
