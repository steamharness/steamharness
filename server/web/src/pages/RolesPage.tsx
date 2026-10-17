import { PlusCircle, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { translateDynamicKeyWithFallback, useTranslation } from "@steamharness/i18n/react";

function permissionLabelKey(key: string): string {
  return `permission_${key.replace(/\./g, "_")}_label`;
}

function permissionDescriptionKey(key: string): string {
  return `permission_${key.replace(/\./g, "_")}_description`;
}
import type { WorkflowPermissionGroup, WorkflowRoleRecord } from "../types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { IconActionButton, TableEmptyRow } from "@/components/ui/composites";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TablePanel } from "@/components/ui/table-panel";
import { TableLoadingRows } from "@/components/ui/table-loading-rows";
import { Textarea } from "@/components/ui/textarea";
import { ConfirmActionDialog, type ConfirmAction } from "@/components/ConfirmActionDialog";

interface RolesPageProps {
  roles: WorkflowRoleRecord[] | null;
  groups: WorkflowPermissionGroup[] | null;
  loading?: string;
  saveBusy?: string;
  deleteRoleId?: string;
  onRefresh: () => void;
  onCreateRole: (payload: { name: string; description?: string; permissions: string[] }) => void;
  onUpdateRole: (role: WorkflowRoleRecord, payload: { name?: string; description?: string; permissions?: string[] }) => void;
  onDeleteRole: (role: WorkflowRoleRecord) => void;
}

export function RolesPage({
  roles,
  groups,
  loading,
  saveBusy,
  deleteRoleId,
  onCreateRole,
  onUpdateRole,
  onDeleteRole,
}: RolesPageProps) {
  const { t } = useTranslation("serverWeb");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingRole, setEditingRole] = useState<WorkflowRoleRecord | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [permissions, setPermissions] = useState<string[]>([]);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);

  const groupedPermissions = useMemo(() => groups ?? [], [groups]);

  function openCreateDialog() {
    setEditingRole(null);
    setName("");
    setDescription("");
    setPermissions([]);
    setDialogOpen(true);
  }

  function openEditDialog(role: WorkflowRoleRecord) {
    setEditingRole(role);
    setName(role.name);
    setDescription(role.description);
    setPermissions(role.permissions);
    setDialogOpen(true);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 p-4 lg:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-foreground">{t("rolesTitle")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("rolesDescription")}</p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" onClick={openCreateDialog}>
            <PlusCircle data-icon="inline-start" />
            {t("rolesCreate")}
          </Button>
        </div>
      </div>

      <TablePanel className="min-w-[640px]" panelClassName="flex-1">
            <TableHeader>
              <TableRow>
                <TableHead>{t("rolesHeaderRole")}</TableHead>
                <TableHead>{t("rolesHeaderPermissionCount")}</TableHead>
                <TableHead>{t("rolesHeaderDescription")}</TableHead>
                <TableHead className="w-[136px] text-right">{t("rolesHeaderOperations")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableLoadingRows colSpan={4} />
              ) : !roles || roles.length === 0 ? (
                <TableEmptyRow colSpan={4} icon={<ShieldCheck />} title={t("rolesEmptyTitle")} description={t("rolesEmptyDescription")} />
              ) : (
                roles.map((role) => (
                  <TableRow key={role.id}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-foreground">{role.name}</span>
                        {role.builtin ? <Badge variant="secondary">{t("rolesBuiltin")}</Badge> : null}
                        {role.protected ? <Badge variant="outline">{t("rolesProtectedBadge")}</Badge> : null}
                      </div>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{role.permissions.length}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {role.builtin && role.id
                        ? translateDynamicKeyWithFallback(`role_${role.id}_description`, "permissions", role.description)
                        : role.description || t("rolesNoDescription")}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={role.protected}
                          onClick={() => openEditDialog(role)}
                        >
                          {t("commonEdit")}
                        </Button>
                        <IconActionButton
                          size="icon-sm"
                          label={t("rolesDeleteLabel", { name: role.name })}
                          disabled={role.protected || deleteRoleId === role.id}
                          onClick={() => setConfirmAction({
                            title: t("rolesConfirmDeleteTitle"),
                            description: t("rolesConfirmDeleteDescription"),
                            details: (
                              <div className="flex flex-col gap-1">
                                <span>{t("rolesConfirmDeleteDetailsName")}{role.name}</span>
                                <span>{t("rolesConfirmDeleteDetailsPermissions")}{role.permissions.length}</span>
                              </div>
                            ),
                            confirmLabel: t("rolesConfirmDeleteTitle"),
                            tone: "destructive",
                            onConfirm: () => onDeleteRole(role),
                          })}
                        >
                          {deleteRoleId === role.id ? <RefreshCw data-icon="inline-start" className="animate-spin" /> : <Trash2 data-icon="inline-start" />}
                        </IconActionButton>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
      </TablePanel>

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) {
            setEditingRole(null);
            setName("");
            setDescription("");
            setPermissions([]);
          }
        }}
      >
        <DialogContent className="flex max-h-[min(88vh,880px)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(92vw,820px)]">
          <DialogHeader className="gap-1 border-b border-border px-5 pb-4 pt-5 pr-14">
            <DialogTitle>
              {editingRole ? t("rolesEditTitle") : t("rolesCreateTitle")}
            </DialogTitle>
            <DialogDescription>{t("rolesDialogDescription")}</DialogDescription>
          </DialogHeader>
          <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-auto px-5 py-4">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="outline">
                {editingRole ? t("rolesModeEdit") : t("rolesModeNew")}
              </Badge>
              <span>{t("rolesPermissionSelected", { count: permissions.length })}</span>
              {editingRole?.protected ? (
                <span className="text-muted-foreground">{t("rolesProtectedCannotEdit")}</span>
              ) : null}
            </div>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="role-name">{t("rolesNameLabel")}</FieldLabel>
                <Input id="role-name" value={name} onChange={(event) => setName(event.target.value)} placeholder={t("rolesNamePlaceholder")} disabled={editingRole?.protected} />
              </Field>
              <Field>
                <FieldLabel htmlFor="role-description">{t("rolesRoleDescriptionLabel")}</FieldLabel>
                <Textarea
                  id="role-description"
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder={t("rolesRoleDescriptionPlaceholder")}
                  rows={2}
                  disabled={editingRole?.protected}
                />
                {editingRole?.protected ? <FieldDescription>{t("rolesProtectedDescription")}</FieldDescription> : null}
              </Field>
            </FieldGroup>
            <FieldSet className="gap-3">
              <FieldLegend variant="label" className="mb-0 flex items-center justify-between gap-3 text-sm font-semibold text-foreground">
                <span>{t("rolesPermissionGroups")}</span>
                <span className="text-xs font-normal text-muted-foreground">{t("rolesGroupCount", { count: groupedPermissions.length })}</span>
              </FieldLegend>
              <FieldGroup data-slot="checkbox-group" className="gap-4">
                {groupedPermissions.map((group) => {
                  const groupKeys = group.permissions.map((permission) => permission.key);
                  const selectedInGroup = groupKeys.filter((key) => permissions.includes(key)).length;
                  const allSelected = selectedInGroup === groupKeys.length;
                  const partialSelected = selectedInGroup > 0 && !allSelected;
                  const groupKeySet = new Set<string>(groupKeys);
                  const groupCheckboxId = `permission-group-${group.id}`;
                  return (
                    <TablePanel key={group.id} className="min-w-[560px]" aria-label={translateDynamicKeyWithFallback(`group_${group.id}`, "permissions", group.label)}>
                      <TableHeader><TableRow><TableHead>
                        <div className="flex items-center justify-between gap-3">
                        <Field orientation="horizontal" data-disabled={editingRole?.protected ? true : undefined} className="min-w-0 flex-1">
                          <Checkbox
                            id={groupCheckboxId}
                            checked={partialSelected ? "indeterminate" : allSelected}
                            disabled={editingRole?.protected}
                            onCheckedChange={(checked) => {
                              setPermissions((current) => {
                                if (checked === true) {
                                  return [...new Set([...current, ...groupKeys])];
                                }
                                return current.filter((item) => !groupKeySet.has(item));
                              });
                            }}
                            aria-label={t("rolesGroupToggleAria", { label: translateDynamicKeyWithFallback(`group_${group.id}`, "permissions", group.label) })}
                          />
                          <FieldContent className="min-w-0">
                            <FieldLabel htmlFor={groupCheckboxId} className="truncate text-sm font-semibold text-foreground">
                              {translateDynamicKeyWithFallback(`group_${group.id}`, "permissions", group.label)}
                            </FieldLabel>
                          </FieldContent>
                        </Field>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {selectedInGroup}/{groupKeys.length}
                        </span>
                        </div>
                      </TableHead><TableHead>{t("rolesHeaderDescription")}</TableHead></TableRow></TableHeader>
                      <TableBody>
                        {group.permissions.map((permission) => {
                          const checked = permissions.includes(permission.key);
                          const permissionCheckboxId = `permission-${group.id}-${permission.key}`;
                          return (
                            <TableRow key={permission.key} data-state={checked ? "selected" : undefined}>
                              <TableCell>
                              <Field orientation="horizontal" data-disabled={editingRole?.protected ? true : undefined}>
                                <Checkbox
                                  id={permissionCheckboxId}
                                  checked={checked}
                                  disabled={editingRole?.protected}
                                  onCheckedChange={(nextChecked) => {
                                    setPermissions((current) => {
                                      if (nextChecked === true) return [...new Set([...current, permission.key])];
                                      return current.filter((item) => item !== permission.key);
                                    });
                                  }}
                                />
                                <FieldLabel htmlFor={permissionCheckboxId}>{translateDynamicKeyWithFallback(permissionLabelKey(permission.key), "permissions", permission.label)}</FieldLabel>
                              </Field>
                              </TableCell>
                              <TableCell className="whitespace-normal text-muted-foreground">{translateDynamicKeyWithFallback(permissionDescriptionKey(permission.key), "permissions", permission.description)}</TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </TablePanel>
                  );
                })}
              </FieldGroup>
            </FieldSet>
          </div>
          <DialogFooter className="border-t border-border bg-card px-5 py-3">
            <Button
              variant="outline"
              onClick={() => {
                setDialogOpen(false);
                setEditingRole(null);
                setName("");
                setDescription("");
                setPermissions([]);
              }}
            >
              {t("commonCancel")}
            </Button>
            <Button
              disabled={!name.trim() || !!saveBusy || !!editingRole?.protected}
              onClick={() => {
                const payload = {
                  name: name.trim(),
                  description: description.trim() || undefined,
                  permissions,
                };
                setConfirmAction({
                  title: editingRole ? t("rolesSaveConfirmTitleEdit") : t("rolesSaveConfirmTitleCreate"),
                  description: editingRole
                    ? t("rolesSaveConfirmEditDescription")
                    : t("rolesSaveConfirmCreateDescription"),
                  details: (
                    <div className="flex flex-col gap-1">
                      <span>{t("rolesSaveConfirmDetailsName")}{payload.name}</span>
                      <span>{t("rolesSaveConfirmDetailsPermissions")}{payload.permissions.length}</span>
                    </div>
                  ),
                  confirmLabel: editingRole ? t("rolesSave") : t("rolesSaveConfirmTitleCreate"),
                  tone: "warning",
                  onConfirm: () => {
                    if (editingRole) {
                      onUpdateRole(editingRole, payload);
                      return;
                    }
                    onCreateRole(payload);
                  },
                });
              }}
            >
              {saveBusy ? <RefreshCw data-icon="inline-start" className="animate-spin" /> : null}
              {t("rolesSave")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmActionDialog action={confirmAction} onOpenChange={(open) => { if (!open) setConfirmAction(null); }} />
    </div>
  );
}
