import { useEffect, useRef, useState } from "react";
import {
  canManageMember,
  PROJECT_ROLES,
  type ProjectRole,
  type ResourceAccess,
  type ResourceType,
} from "@steamharness/project-access";
import { useTranslation } from "@steamharness/i18n/react";
import { apiClient } from "../api";
import {
  isApiSuccess,
  type AccessPage,
  type ProjectInvitation,
  type ProjectMember,
} from "../types";
import {
  Badge,
  Button,
  Field,
  FieldLabel,
  Input,
  SelectField,
  TableEmptyRow,
  FieldGroup,
  TablePanel,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui";
import { TableLoadingRows } from "@/components/ui/table-loading-rows";
import { PaginationFooter } from "@/components/ui/pagination-footer";
import {
  ConfirmActionDialog,
  type ConfirmAction,
} from "@/components/ConfirmActionDialog";

export function ResourceMembersPanel({
  type,
  id,
  access,
}: {
  type: ResourceType;
  id: string;
  access: ResourceAccess;
}) {
  const { t } = useTranslation("serverWeb");
  const [page, setPage] = useState(1);
  const [members, setMembers] = useState<AccessPage<ProjectMember>>();
  const [invitations, setInvitations] = useState<ProjectInvitation[]>([]);
  const [userId, setUserId] = useState("");
  const [role, setRole] = useState<ProjectRole>("guest");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [share, setShare] = useState("");
  const [revision, setRevision] = useState(0);
  const [action, setAction] = useState<ConfirmAction | null>(null);
  const request = useRef(0);
  const roleLabel = (role: ProjectRole) =>
    t(
      `accessRole${role[0].toUpperCase()}${role.slice(1)}` as "accessRoleGuest",
    );
  const roles = PROJECT_ROLES.filter(
    (role) =>
      access.capabilities.includes("manageOwners") ||
      ["guest", "developer"].includes(role),
  ).map((value) => ({ value, label: roleLabel(value) }));
  useEffect(() => {
    const serial = ++request.current;
    setBusy(true);
    void Promise.all([
      apiClient.resourceMembers(type, id, page),
      access.capabilities.includes("manageMembers")
        ? apiClient.resourceInvitations(type, id)
        : undefined,
    ]).then(([result, invites]) => {
      if (serial !== request.current) return;
      setBusy(false);
      if (isApiSuccess(result)) {
        setMembers(result.data);
        setError("");
      } else setError(result.errMessage);
      if (invites) {
        if (isApiSuccess(invites)) setInvitations(invites.data);
        else setError(invites.errMessage);
      }
    });
    return () => {
      request.current++;
    };
  }, [type, id, page, revision, access]);
  async function mutate(
    work: () => ReturnType<typeof apiClient.setResourceMember>,
  ) {
    setBusy(true);
    const result = await work();
    setBusy(false);
    if (!isApiSuccess(result)) setError(result.errMessage);
    else {
      setError("");
      setRevision((r) => r + 1);
    }
  }
  return (
    <section className="flex min-w-0 flex-col gap-4">
      <h2 className="text-base font-semibold">{t("storageMembers")}</h2>
      <p className="text-sm text-muted-foreground">{t("accessGrantHighest")}</p>
      {error && (
        <div role="alert" className="text-sm text-destructive">
          {error}
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => setRevision((v) => v + 1)}
          >
            {t("commonRetry")}
          </Button>
        </div>
      )}
      {access.capabilities.includes("manageMembers") && (
        <form
          className="flex"
          onSubmit={(event) => {
            event.preventDefault();
            void mutate(() =>
              apiClient.setResourceMember(type, id, userId.trim(), role),
            );
          }}
        >
          <FieldGroup className="flex-row flex-wrap items-end gap-3">
            <Field className="min-w-40 flex-1">
              <FieldLabel htmlFor={`${type}-member-id`}>
                {t("storageUserId")}
              </FieldLabel>
              <Input
                id={`${type}-member-id`}
                value={userId}
                onChange={(event) => setUserId(event.target.value)}
              />
            </Field>
            <Field className="w-44">
              <FieldLabel>{t("storageRole")}</FieldLabel>
              <SelectField
                aria-label={t("storageRole")}
                value={role}
                options={roles}
                onValueChange={(value) => setRole(value as ProjectRole)}
              />
            </Field>
            <Button disabled={busy || !userId.trim()}>
              {t("storageAddMember")}
            </Button>
          </FieldGroup>
        </form>
      )}
      <TablePanel
        footer={
          <PaginationFooter
            pageIndex={page - 1}
            total={members?.total ?? 0}
            rowsOnPage={members?.items.length ?? 0}
            previousDisabled={busy || page === 1}
            nextDisabled={busy || page * 20 >= (members?.total ?? 0)}
            onPrevious={() => setPage((p) => p - 1)}
            onNext={() => setPage((p) => p + 1)}
          />
        }
      >
        <TableHeader>
          <TableRow>
            <TableHead>{t("storageUserId")}</TableHead>
            <TableHead>{t("accessDirectRole")}</TableHead>
            <TableHead>{t("accessSources")}</TableHead>
            <TableHead>{t("accessEffectiveRole")}</TableHead>
            <TableHead>{t("dependenciesHeaderActions")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {!members && !error ? (
            <TableLoadingRows colSpan={5} />
          ) : members?.items.length === 0 ? (
            <TableEmptyRow colSpan={5} title={t("storageNoMembers")} />
          ) : null}
          {members?.items.map((member) => (
            <TableRow key={member.userId}>
              <TableCell>
                {member.profile?.displayName ?? member.userId}
              </TableCell>
              <TableCell>
                {canManageMember(access, {
                  ...member.access,
                  effectiveRole: member.role,
                }) && member.directRole ? (
                  <SelectField
                    aria-label={`${member.userId} ${t("accessDirectRole")}`}
                    value={member.directRole}
                    options={roles}
                    disabled={busy}
                    onValueChange={(value) =>
                      setAction({
                        title: t("storageRole"),
                        description: `${member.userId}: ${roleLabel(value as ProjectRole)}`,
                        confirmLabel: t("commonSave"),
                        tone: "warning",
                        onConfirm: () =>
                          mutate(() =>
                            apiClient.setResourceMember(
                              type,
                              id,
                              member.userId,
                              value as ProjectRole,
                            ),
                          ),
                      })
                    }
                  />
                ) : member.directRole ? (
                  roleLabel(member.directRole)
                ) : (
                  t("accessNoDirectRole")
                )}
              </TableCell>
              <TableCell>
                <div className="flex flex-col gap-1">
                  {member.access.sources
                    .filter(
                      (source) =>
                        source.type === "group" &&
                        (type !== "group" || source.id !== id),
                    )
                    .map((source) => (
                      <a
                        className="text-primary underline underline-offset-4"
                        title={t("accessInherited")}
                        key={source.id}
                        href={`/groups/${encodeURIComponent(source.id)}`}
                      >
                        {source.name ?? source.id}: {roleLabel(source.role)}
                      </a>
                    ))}
                </div>
              </TableCell>
              <TableCell>
                <Badge variant="secondary">{roleLabel(member.role)}</Badge>
              </TableCell>
              <TableCell>
                {member.directRole &&
                  canManageMember(access, {
                    ...member.access,
                    effectiveRole: member.role,
                  }) && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        setAction({
                          title: t("commonDelete"),
                          description: member.userId,
                          confirmLabel: t("commonDelete"),
                          tone: "destructive",
                          onConfirm: () =>
                            mutate(() =>
                              apiClient.setResourceMember(
                                type,
                                id,
                                member.userId,
                              ),
                            ),
                        })
                      }
                    >
                      {t("commonDelete")}
                    </Button>
                  )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </TablePanel>
      {access.capabilities.includes("manageMembers") && (
        <>
          <h3 className="text-base font-semibold">{t("storageInvitations")}</h3>
          <Button
            className="self-start"
            disabled={busy}
            onClick={() => {
              void mutate(async () => {
                const result = await apiClient.inviteResourceMember(
                  type,
                  id,
                  role,
                );
                if (isApiSuccess(result))
                  setShare(
                    `${window.location.origin}/invite/${encodeURIComponent(result.data.token)}`,
                  );
                return result;
              });
            }}
          >
            {t("storageInvite")} · {roleLabel(role)}
          </Button>
          {share && (
            <Input
              aria-label={t("storageInvitations")}
              readOnly
              value={share}
              onFocus={(event) => event.target.select()}
            />
          )}
          <TablePanel>
            <TableHeader>
              <TableRow>
                <TableHead>{t("storageRole")}</TableHead>
                <TableHead>{t("storageExpiresAt")}</TableHead>
                <TableHead>{t("storageInvitationStatus")}</TableHead>
                <TableHead>{t("dependenciesHeaderActions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invitations.map((invite) => (
                <TableRow key={invite.id}>
                  <TableCell>{roleLabel(invite.role)}</TableCell>
                  <TableCell>
                    {new Date(invite.expiresAt).toLocaleString()}
                  </TableCell>
                  <TableCell>
                    {t(
                      invite.revokedAt
                        ? "storageRevoked"
                        : invite.acceptedAt
                          ? "storageAccepted"
                          : "storagePending",
                    )}
                  </TableCell>
                  <TableCell>
                    {!invite.revokedAt &&
                      !invite.acceptedAt &&
                      (access.capabilities.includes("manageOwners") ||
                        ["guest", "developer"].includes(invite.role)) && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() => {
                            void mutate(() =>
                              apiClient.revokeResourceInvitation(
                                type,
                                id,
                                invite.id,
                              ),
                            );
                          }}
                        >
                          {t("commonDelete")}
                        </Button>
                      )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </TablePanel>
        </>
      )}
      <ConfirmActionDialog
        action={action}
        onOpenChange={(open) => {
          if (!open) setAction(null);
        }}
      />
    </section>
  );
}
