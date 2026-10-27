import { Link, MailPlus, Pencil, RefreshCw, ShieldCheck, UserCheck, UserCog, UserRound, UserX } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "@steamharness/i18n/react";
import { formatDateTime, i18n } from "@steamharness/i18n";
import type { AdminUserSummary, UserInvitationResult } from "../types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { FilePickerField, SemanticBadge, TableActionCell, TableEmptyRow } from "@/components/ui/composites";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet, FieldTitle } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { PaginationFooter } from "@/components/ui/pagination-footer";
import { SearchField } from "@/components/ui/search-field";
import { SelectField } from "@/components/ui/select-field";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TablePanel } from "@/components/ui/table-panel";
import { TableLoadingRows } from "@/components/ui/table-loading-rows";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ConfirmActionDialog, type ConfirmAction } from "@/components/ConfirmActionDialog";
import { UserIdentity } from "@/components/UserIdentity";
import { cn } from "@/lib/utils";
import { getAvatarFallbackText } from "@steamharness/avatar-fallback";
import { AvatarCropDialog } from "@/components/AvatarCropDialog";
import { avatarFileFromDataUrl } from "@/lib/avatar-image";

interface UsersPageProps {
  users: AdminUserSummary[] | null;
  loading?: string;
  inviteBusy?: string;
  updateBusyUserId?: string;
  invitationResult?: UserInvitationResult | null;
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  initialSearch?: string;
  initialStatus?: string;
  onSearch: (query: string, status: string) => void;
  onPageChange: (page: number) => void;
  onRefresh: () => void;
  onInvite: (payload: { email: string; displayName?: string }) => void;
  onUpdateUser: (user: AdminUserSummary, patch: { email?: string; displayName?: string; disabled?: boolean; avatarUrl?: string | null }) => void;
  onUpdateAdministrator: (user: AdminUserSummary, isSystemAdmin: boolean) => void;
  onUpdateAvatar: (user: AdminUserSummary, file: File) => void;
  onFetchInviteLink: (userId: string) => Promise<string | null>;
}

export function UsersPage({
  users,
  loading,
  inviteBusy,
  updateBusyUserId,
  invitationResult,
  total,
  page,
  pageSize: _pageSize,
  totalPages,
  initialSearch = "",
  initialStatus = "",
  onSearch,
  onPageChange,
  onInvite,
  onUpdateUser,
  onUpdateAdministrator,
  onUpdateAvatar,
  onFetchInviteLink,
}: UsersPageProps) {
  const { t } = useTranslation("serverWeb");
  const statusOptions = [
    { value: "", label: t("usersStatusAll") },
    { value: "active", label: "active" },
    { value: "disabled", label: "disabled" },
    { value: "invited", label: "invited" },
  ];
  const [search, setSearch] = useState(initialSearch);
  const [status, setStatus] = useState(initialStatus);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteDisplayName, setInviteDisplayName] = useState("");
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [selectedAdmin,setSelectedAdmin]=useState(false);
  const [managementTab, setManagementTab] = useState("profile");
  const [editEmail, setEditEmail] = useState("");
  const [editDisplayName, setEditDisplayName] = useState("");
  const [selectedAvatarFile, setSelectedAvatarFile] = useState<File | null>(null);
  const [avatarFileToCrop, setAvatarFileToCrop] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState("");
  const [inviteLoadingUserId, setInviteLoadingUserId] = useState<string | null>(null);
  const [copiedLinkUserId, setCopiedLinkUserId] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const searchRef = useRef(search);
  searchRef.current = search;
  const statusRef = useRef(status);
  statusRef.current = status;

  const activeUser = (users ?? []).find((u) => u.userId === selectedUserId) ?? null;
  const editingBusy = !!activeUser && updateBusyUserId === activeUser.userId;

  useEffect(() => () => {
    clearTimeout(debounceRef.current);
    clearTimeout(copiedTimerRef.current);
  }, []);

  const handleSearchChange = useCallback((value: string) => {
    setSearch(value);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      onSearch(value.trim(), statusRef.current);
    }, 300);
  }, [onSearch]);

  const handleStatusChange = useCallback((event: { target: { value: string } }) => {
    const nextStatus = event.target.value;
    if (nextStatus === status) return;
    setStatus(nextStatus);
    onSearch(searchRef.current.trim(), nextStatus);
  }, [status, onSearch]);

  const handleInviteSubmit = useCallback(() => {
    onInvite({ email: inviteEmail.trim(), displayName: inviteDisplayName.trim() || undefined });
  }, [inviteEmail, inviteDisplayName, onInvite]);

  const handleFetchInviteLink = useCallback(async (userId: string) => {
    setInviteLoadingUserId(userId);
    const link = await onFetchInviteLink(userId);
    setInviteLoadingUserId(null);
    if (link) {
      await navigator.clipboard.writeText(link).catch(() => {});
      clearTimeout(copiedTimerRef.current);
      setCopiedLinkUserId(userId);
      copiedTimerRef.current = setTimeout(() => setCopiedLinkUserId(null), 2000);
    }
  }, [onFetchInviteLink]);

  const openManagementDialog = useCallback((user: AdminUserSummary) => {
    setSelectedUserId(user.userId);
    setManagementTab("profile");
    setSelectedAdmin(user.isSystemAdmin);
    setEditEmail(user.email);
    setEditDisplayName(user.displayName);
    setSelectedAvatarFile(null);
    setAvatarFileToCrop(null);
    setAvatarPreview(user.avatarUrl ?? "");
  }, []);

  const closeManagementDialog = useCallback(() => {
    setSelectedUserId(null);
    setManagementTab("profile");
    setSelectedAdmin(false);
    setEditEmail("");
    setEditDisplayName("");
    setSelectedAvatarFile(null);
    setAvatarFileToCrop(null);
    setAvatarPreview("");
  }, []);

  useEffect(() => {
    if (selectedUserId && users && !users.some((user) => user.userId === selectedUserId)) {
      closeManagementDialog();
    }
  }, [selectedUserId, users, closeManagementDialog]);

  const handleEditSubmit = useCallback(() => {
    if (!activeUser) return;
    const nextEmail = editEmail.trim();
    const nextDisplayName = editDisplayName.trim();
    const patch: { email?: string; displayName?: string; avatarUrl?: null } = {};
    if (nextEmail && nextEmail !== activeUser.email) patch.email = nextEmail;
    if (nextDisplayName && nextDisplayName !== activeUser.displayName) patch.displayName = nextDisplayName;
    if (avatarPreview === "" && !!activeUser.avatarUrl) patch.avatarUrl = null;
    const hasProfileChange = Object.keys(patch).length > 0;
    if (!selectedAvatarFile && !hasProfileChange) return;
    if (selectedAvatarFile) onUpdateAvatar(activeUser, selectedAvatarFile);
    if (hasProfileChange) onUpdateUser(activeUser, patch);
    setSelectedAvatarFile(null);
  }, [activeUser, editEmail, editDisplayName, avatarPreview, selectedAvatarFile, onUpdateAvatar, onUpdateUser]);

  const items = useMemo(() => users ?? [], [users]);
  const isLoading = !!loading;
  const isEmpty = !isLoading && items.length === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 p-4 lg:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-foreground">{t("usersTitle")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("usersSubtitle")}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => setInviteDialogOpen(true)}>
            <MailPlus data-icon="inline-start" />{t("usersInvite")}
          </Button>
        </div>
      </div>

      <TablePanel className="min-w-[960px]" panelClassName="flex-1" toolbar={
        <div className="flex flex-wrap items-center gap-2 border-b px-3 py-3">
          <SearchField
            icon={<UserRound className="size-4" />}
            placeholder={t("usersSearchPlaceholder")}
            value={search}
            onChange={(event) => handleSearchChange(event.target.value)}
            className="w-[280px]"
          />
          <SelectField value={status} onChange={handleStatusChange} options={statusOptions} className="w-[140px]" />
        </div>
      } footer={!isEmpty && !isLoading ? (
        <PaginationFooter
          pageIndex={page - 1}
          total={total}
          rowsOnPage={items.length}
          previousDisabled={isLoading || page <= 1}
          nextDisabled={isLoading || page >= totalPages}
          onPrevious={page > 1 ? () => onPageChange(page - 1) : undefined}
          onNext={page < totalPages ? () => onPageChange(page + 1) : undefined}
        />
      ) : null}>
            <TableHeader>
              <TableRow>
                <TableHead>{t("usersHeaderUser")}</TableHead>
                <TableHead>{t("usersHeaderRoles")}</TableHead>
                <TableHead>{t("usersHeaderStatus")}</TableHead>
                <TableHead>{t("usersHeaderLastSignIn")}</TableHead>
                <TableHead className="w-[108px] text-right">{t("usersHeaderActions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableLoadingRows colSpan={5} />
              ) : isEmpty ? (
                <TableEmptyRow
                  colSpan={5}
                  title={t("usersEmptyTitle")}
                  description={t("usersEmptyDescription")}
                  icon={<ShieldCheck />}
                  emptyClassName="min-h-[220px]"
                />
              ) : (
                items.map((user) => (
                  <TableRow key={user.userId}>
                    <TableCell>
                      <UserIdentity user={user} fallbackLabel={t("usersUnrecordedUser")} size="sm" />
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{t(user.isSystemAdmin?"accessSystemAdmin":"accessRegularUser")}</TableCell>
                    <TableCell>
                      <SemanticBadge tone={user.status === "active" ? "success" : user.status === "disabled" ? "danger" : "warning"}>{user.status}</SemanticBadge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{formatLastSignIn(user.lastSignInAt)}</TableCell>
                    <TableActionCell>
                      <Button
                        size="sm"
                        variant="outline"
                        aria-label={t("usersManageAria", { displayName: user.displayName })}
                        disabled={updateBusyUserId === user.userId}
                        onClick={() => openManagementDialog(user)}
                      >
                        {updateBusyUserId === user.userId
                          ? <RefreshCw data-icon="inline-start" className="animate-spin" />
                          : <UserCog data-icon="inline-start" />}
                        {t("usersManage")}
                      </Button>
                    </TableActionCell>
                  </TableRow>
                ))
              )}
            </TableBody>
      </TablePanel>

      <Dialog open={inviteDialogOpen} onOpenChange={setInviteDialogOpen}>
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle>{t("usersInvite")}</DialogTitle>
            <DialogDescription>{t("usersInviteDescription")}</DialogDescription>
          </DialogHeader>
          <FieldGroup className="gap-4">
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="invite-email">{t("usersInviteEmailLabel")}</FieldLabel>
                <Input id="invite-email" value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} placeholder={t("usersInviteEmailPlaceholder")} />
              </Field>
              <Field>
                <FieldLabel htmlFor="invite-display-name">{t("usersInviteDisplayNameLabel")}</FieldLabel>
                <Input id="invite-display-name" value={inviteDisplayName} onChange={(event) => setInviteDisplayName(event.target.value)} placeholder={t("usersInviteDisplayNamePlaceholder")} />
              </Field>
            </FieldGroup>
            <div className="flex justify-end gap-3">
              <Button variant="outline" onClick={() => setInviteDialogOpen(false)} disabled={!!inviteBusy}>{t("commonCancel")}</Button>
              <Button
                disabled={!inviteEmail.trim() || !!inviteBusy}
                onClick={() => setConfirmAction({
                  title: t("usersInviteConfirmTitle"),
                  description: t("usersInviteConfirmDescription"),
                  details: (
                    <div className="flex flex-col gap-1">
                      <span>{t("usersInviteConfirmDetailsEmail")}{inviteEmail.trim()}</span>
                      <span>{t("usersInviteConfirmDetailsDisplayName")}{inviteDisplayName.trim() || t("usersInviteConfirmDetailsNotFilled")}</span>
                    </div>
                  ),
                  confirmLabel: t("usersInviteConfirmSend"),
                  tone: "warning",
                  onConfirm: handleInviteSubmit,
                })}
              >
                {inviteBusy ? <RefreshCw data-icon="inline-start" className="animate-spin" /> : null}{t("usersInviteConfirmSend")}
              </Button>
            </div>
          </FieldGroup>
        </DialogContent>
      </Dialog>

      <Dialog
        open={activeUser !== null}
        onOpenChange={(open) => {
          if (!open && !editingBusy) closeManagementDialog();
        }}
      >
        <DialogContent className="flex max-h-[min(90vh,900px)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(94vw,920px)]">
          {activeUser ? (
            <>
              <DialogHeader className="gap-3 border-b border-border px-5 pb-4 pt-5 pr-14">
                <div>
                  <DialogTitle>{t("usersManageTitle", { displayName: activeUser.displayName })}</DialogTitle>
                  <DialogDescription>{t("usersManageUserId", { userId: activeUser.userId })}</DialogDescription>
                </div>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <UserIdentity user={activeUser} fallbackLabel={t("usersUnrecordedUser")} size="md" className="min-w-0 flex-1" />
                  <div className="flex flex-wrap items-center gap-1.5">
                    <SemanticBadge tone={activeUser.status === "active" ? "success" : activeUser.status === "disabled" ? "danger" : "warning"}>{activeUser.status}</SemanticBadge>
                  </div>
                </div>
              </DialogHeader>

              <Tabs value={managementTab} onValueChange={setManagementTab} className="min-h-0 flex-1 flex-col gap-0">
                <TabsList variant="line" className="w-full shrink-0 justify-start overflow-x-auto rounded-none border-b border-border px-5 py-2">
                  <TabsTrigger value="profile"><Pencil data-icon="inline-start" />{t("usersEditProfileTab")}</TabsTrigger>
                  <TabsTrigger value="administrator"><ShieldCheck data-icon="inline-start" />{t("accessSystemAdmin")}</TabsTrigger>
                  <TabsTrigger value="account"><UserCog data-icon="inline-start" />{t("usersAccountStatus")}</TabsTrigger>
                </TabsList>

                <TabsContent value="profile" className="min-h-0 overflow-y-auto px-5 py-5">
                  <FieldGroup className="gap-5">
                    <FieldGroup className="grid gap-4 md:grid-cols-2">
                      <Field>
                        <FieldLabel htmlFor="edit-user-email">{t("usersEditEmailLabel")}</FieldLabel>
                        <Input id="edit-user-email" type="email" value={editEmail} onChange={(event) => setEditEmail(event.target.value)} placeholder={t("usersEditEmailPlaceholder")} disabled={editingBusy} />
                      </Field>
                      <Field>
                        <FieldLabel htmlFor="edit-user-display-name">{t("usersEditDisplayNameLabel")}</FieldLabel>
                        <Input id="edit-user-display-name" value={editDisplayName} onChange={(event) => setEditDisplayName(event.target.value)} placeholder={t("usersEditDisplayNamePlaceholder")} disabled={editingBusy} />
                      </Field>
                    </FieldGroup>
                    <FilePickerField
                      id="edit-user-avatar-file"
                      label={t("usersEditAvatarLabel")}
                      chooseLabel={t("usersEditAvatarChoose")}
                      accept="image/png,image/jpeg,image/gif,image/webp"
                      disabled={editingBusy}
                      preview={{
                        src: avatarPreview,
                        fallback: getAvatarFallbackText({ displayName: editDisplayName || activeUser.displayName, email: activeUser.email, userId: activeUser.userId }),
                      }}
                      description={t("usersEditAvatarDescription")}
                      onFileChange={(file, event) => {
                        event.currentTarget.value = "";
                        if (file) setAvatarFileToCrop(file);
                      }}
                      actions={selectedAvatarFile ? (
                        <Button variant="outline" size="sm" disabled={editingBusy} className="shrink-0"
                          onClick={() => { setSelectedAvatarFile(null); setAvatarPreview(activeUser.avatarUrl ?? ""); }}>
                          {t("usersEditAvatarRevert")}
                        </Button>
                      ) : activeUser.avatarUrl ? (
                        <Button variant="outline" size="sm" disabled={editingBusy} className="shrink-0" onClick={() => setAvatarPreview("")}>{t("usersClearAvatar")}</Button>
                      ) : null}
                    />
                    <div className="flex justify-end">
                      <Button
                        onClick={handleEditSubmit}
                        disabled={editingBusy || (!editEmail.trim() && !editDisplayName.trim() && !selectedAvatarFile && avatarPreview === (activeUser.avatarUrl ?? ""))}
                      >
                        {editingBusy ? <RefreshCw data-icon="inline-start" className="animate-spin" /> : null}
                        {t("accountProfileSave")}
                      </Button>
                    </div>
                  </FieldGroup>
                </TabsContent>

                <TabsContent value="administrator" className="p-5">
                  <FieldGroup><Field orientation="horizontal"><Checkbox id="system-administrator" checked={selectedAdmin} disabled={editingBusy} onCheckedChange={value=>setSelectedAdmin(value===true)}/><FieldLabel htmlFor="system-administrator">{t("accessSystemAdmin")}</FieldLabel></Field>
                    <FieldDescription>{t("accessAccountHelp")}</FieldDescription>
                    <Button disabled={editingBusy} onClick={()=>setConfirmAction({title:t("accessSystemAdmin"),description:activeUser.displayName,confirmLabel:t("commonSave"),tone:"warning",onConfirm:()=>onUpdateAdministrator(activeUser,selectedAdmin)})}>{t("commonSave")}</Button>
                  </FieldGroup>
                </TabsContent>

                <TabsContent value="account" className="min-h-0 overflow-y-auto px-5 py-5">
                  <FieldGroup className="gap-5">
                    {activeUser.status === "invited" ? (
                      <Field orientation="horizontal" className="flex-col items-stretch rounded-lg border border-border px-4 py-3 sm:flex-row sm:items-center">
                        <FieldContent>
                          <FieldTitle>{t("usersFetchInviteLinkTitle")}</FieldTitle>
                          <FieldDescription>{t("usersFetchInviteLinkDescription")}</FieldDescription>
                        </FieldContent>
                        <Button
                          variant="outline"
                          disabled={inviteLoadingUserId === activeUser.userId}
                          onClick={() => void handleFetchInviteLink(activeUser.userId)}
                        >
                          {inviteLoadingUserId === activeUser.userId ? <RefreshCw data-icon="inline-start" className="animate-spin" /> : <Link data-icon="inline-start" />}
                          {copiedLinkUserId === activeUser.userId ? t("usersCopiedInviteLink") : t("usersCopyInviteLink")}
                        </Button>
                      </Field>
                    ) : null}
                    <Field orientation="horizontal" className="flex-col items-stretch rounded-lg border border-border px-4 py-3 sm:flex-row sm:items-center">
                      <FieldContent>
                        <FieldTitle>{activeUser.status === "disabled" ? t("usersEnableAccountTitle") : t("usersDisableAccountTitle")}</FieldTitle>
                        <FieldDescription>
                          {activeUser.status === "disabled"
                            ? t("usersEnableAccountDescription")
                            : t("usersDisableAccountDescription")}
                        </FieldDescription>
                      </FieldContent>
                      <Button
                        variant={activeUser.status === "disabled" ? "default" : "destructive"}
                        disabled={editingBusy}
                        onClick={() => {
                          const willDisable = activeUser.status !== "disabled";
                          setConfirmAction({
                            title: willDisable ? t("usersDisableUserConfirm") : t("usersEnableUserConfirm"),
                            description: willDisable
                              ? t("usersDisableUserConfirmDescription")
                              : t("usersEnableUserConfirmDescription"),
                            details: <UserIdentity user={activeUser} fallbackLabel={t("usersUnrecordedUser")} size="sm" />,
                            confirmLabel: willDisable ? t("usersDisableUserConfirm") : t("usersEnableUserConfirm"),
                            tone: willDisable ? "destructive" : "warning",
                            onConfirm: () => onUpdateUser(activeUser, { disabled: willDisable }),
                          });
                        }}
                      >
                        {editingBusy ? <RefreshCw data-icon="inline-start" className="animate-spin" /> : activeUser.status === "disabled" ? <UserCheck data-icon="inline-start" /> : <UserX data-icon="inline-start" />}
                        {activeUser.status === "disabled" ? t("usersEnableUserConfirm") : t("usersDisableUserConfirm")}
                      </Button>
                    </Field>
                  </FieldGroup>
                </TabsContent>
              </Tabs>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
      {avatarFileToCrop ? <AvatarCropDialog file={avatarFileToCrop} onClose={() => setAvatarFileToCrop(null)}
        onConfirm={dataUrl => {
          setSelectedAvatarFile(avatarFileFromDataUrl(dataUrl));
          setAvatarPreview(dataUrl);
          setAvatarFileToCrop(null);
        }} /> : null}
      <ConfirmActionDialog action={confirmAction} onOpenChange={(open) => { if (!open) setConfirmAction(null); }} />
    </div>
  );
}

function formatLastSignIn(value?: string) {
  if (!value) return i18n.t("usersLastSignInNotLogged", { ns: "serverWeb" });
  return formatDateTime(value);
}
