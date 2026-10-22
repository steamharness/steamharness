import { AlertCircle, CheckCircle2, Copy, ImagePlus, KeyRound, Languages, MonitorCog, Moon, RefreshCw, ShieldCheck, Sun, Upload, UserRound } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import { formatDateTime, i18n, useTranslation, type LocalePreference } from "@steamharness/i18n/react";
import type { SettingsTab, ThemeMode } from "../state";
import type { ApiKeyRecord, MeResult } from "../types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { IconActionButton, TableEmptyRow } from "@/components/ui/composites";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TablePanel } from "@/components/ui/table-panel";
import { TableLoadingRows } from "@/components/ui/table-loading-rows";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { ConfirmActionDialog, type ConfirmAction } from "@/components/ConfirmActionDialog";
import { cn } from "@/lib/utils";
import { getAvatarFallbackText } from "@steamharness/avatar-fallback";

interface AccountPageProps {
  tab: SettingsTab;
  me: MeResult | null;
  apiKeys: ApiKeyRecord[] | null;
  busy?: string;
  apiKeysBusy?: string;
  saveBusy?: string;
  createKeyBusy?: string;
  revokeKeyId?: string;
  notice?: string | null;
  createdToken?: string | null;
  theme: ThemeMode;
  localePreference: LocalePreference;
  onRefresh: () => void;
  onSaveProfile: (payload: { displayName: string; avatarUrl: string | null }) => void;
  onThemeChange: (theme: ThemeMode) => void;
  onLocalePreferenceChange: (preference: LocalePreference) => void;
  onCreateApiKey: (payload: { name: string; expiresAt?: string }) => void;
  onRevokeApiKey: (id: string) => void;
}

export function AccountPage({
  tab,
  me,
  apiKeys,
  busy,
  apiKeysBusy,
  saveBusy,
  createKeyBusy,
  revokeKeyId,
  notice,
  createdToken,
  theme,
  localePreference,
  onRefresh,
  onSaveProfile,
  onThemeChange,
  onLocalePreferenceChange,
  onCreateApiKey,
  onRevokeApiKey,
}: AccountPageProps) {
  const { t } = useTranslation("serverWeb");
  const [displayName, setDisplayName] = useState(me?.profile?.displayName ?? "");
  const [avatarUrl, setAvatarUrl] = useState<string | null>(me?.profile?.avatarUrl ?? null);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [apiKeyName, setApiKeyName] = useState("");
  const [apiKeyExpiresAt, setApiKeyExpiresAt] = useState("");
  const [revealedToken, setRevealedToken] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const profile = me?.profile ?? null;

  useEffect(() => {
    setDisplayName(me?.profile?.displayName ?? "");
    setAvatarUrl(me?.profile?.avatarUrl ?? null);
  }, [me?.profile?.displayName, me?.profile?.avatarUrl]);

  useEffect(() => {
    if (createdToken) {
      setRevealedToken(createdToken);
    }
  }, [createdToken]);

  const roleSummary=t((profile?.isSystemAdmin ?? me?.principal?.isSystemAdmin)?"accessSystemAdmin":"accessRegularUser");
  const permissionSummary=t("accessAccountHelp");

  const profileDirty =
    displayName.trim() !== (profile?.displayName ?? "").trim() ||
    (avatarUrl ?? null) !== (profile?.avatarUrl ?? null);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-6 p-4 lg:p-6">
      <div className="flex min-h-0 flex-1 flex-col gap-6">
        {tab === "profile" ? (
          <Card>
            <CardHeader>
              <CardTitle>{t("accountProfileTitle")}</CardTitle>
              <CardDescription>{t("accountProfileCardDescription")}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-5">
              <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                <div className="flex items-center gap-4">
                  <Button type="button" variant="ghost" className="size-[72px] shrink-0 rounded-lg p-0"
                    title={t("accountAvatarUpload")} aria-label={t("accountAvatarUpload")} onClick={() => fileInputRef.current?.click()}>
                  <Avatar className="size-[72px] rounded-lg">
                    {avatarUrl ? <AvatarImage src={avatarUrl} alt={t("accountAvatarAlt")} /> : null}
                    <AvatarFallback className="rounded-lg">
                      <span className="text-base font-semibold ">
                        {getAvatarFallbackText({
                          displayName,
                          email: profile?.email ?? me?.principal?.email,
                          userId: profile?.userId ?? me?.principal?.userId,
                        })}
                      </span>
                    </AvatarFallback>
                  </Avatar>
                  </Button>
                  <div>
                    <div className="text-sm font-medium text-foreground">{t("accountAvatarLabel")}</div>
                    <div className="mt-1 text-sm leading-6 text-muted-foreground">
                      {t("accountAvatarDescription")}
                    </div>
                    {avatarError ? <div className="mt-2 text-xs text-destructive">{avatarError}</div> : null}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif"
                    className="hidden"
                    onChange={(event) => void handleAvatarFileChange(event, { onChange: setAvatarUrl, onError: setAvatarError })}
                  />
                  <Button type="button" variant="outline" onClick={() => fileInputRef.current?.click()}>
                    <Upload data-icon="inline-start" />
                    {t("accountAvatarUpload")}
                  </Button>
                  <Button type="button" variant="outline" disabled={!avatarUrl} onClick={() => setAvatarUrl(null)}>
                    <ImagePlus data-icon="inline-start" />
                    {t("accountAvatarClear")}
                  </Button>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <SummaryPill icon={<UserRound className="size-4" />} label={t("accountEmail")} value={profile?.email ?? me?.principal?.email ?? t("accountEmailNotLoaded")} />
                <SummaryPill icon={<ShieldCheck className="size-4" />} label={t("accountRole")} value={roleSummary} />
                <SummaryPill icon={<CheckCircle2 className="size-4" />} label={t("accountStatus")} value={profile?.status ?? "unknown"} tone={profile?.status === "active" ? "success" : profile?.status === "disabled" ? "error" : "warning"} />
                <SummaryPill icon={<KeyRound className="size-4" />} label={t("accountCurrentIdentity")} value={me?.principal?.kind ?? "unknown"} />
              </div>

              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="account-display-name">{t("accountDisplayNameLabel")}</FieldLabel>
                  <Input
                    id="account-display-name"
                    value={displayName}
                    onChange={(event) => setDisplayName(event.target.value)}
                    placeholder={t("accountDisplayNamePlaceholder")}
                  />
                  <FieldDescription>{t("accountDisplayNameFieldDescription")}</FieldDescription>
                </Field>
              </FieldGroup>

              <div className="text-sm text-muted-foreground">
                <div className="font-medium text-foreground">{t("accountPermissionSummary")}</div>
                <div className="mt-1 break-words">{permissionSummary}</div>
              </div>
            </CardContent>
            <CardFooter className="justify-end">
              <Button
                onClick={() => onSaveProfile({ displayName: displayName.trim(), avatarUrl })}
                disabled={!!saveBusy || !profileDirty}
              >
                {saveBusy ? <RefreshCw data-icon="inline-start" className="animate-spin" /> : null}
                {t("accountProfileSave")}
              </Button>
            </CardFooter>
          </Card>
        ) : null}

        {tab === "appearance" ? (
          <Card>
            <CardHeader>
              <CardTitle>{t("accountAppearanceTitle")}</CardTitle>
              <CardDescription>{t("accountAppearanceDescription")}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <FieldGroup>
                <Field>
                  <ToggleGroup type="single" variant="outline" value={theme} aria-label={t("accountAppearanceTitle")}
                    onValueChange={value => { if (value) onThemeChange(value as ThemeMode); }} className="flex-wrap">
                    <ToggleGroupItem value="system"><MonitorCog />{t("accountThemeSystem")}</ToggleGroupItem>
                    <ToggleGroupItem value="light"><Sun />{t("accountThemeLight")}</ToggleGroupItem>
                    <ToggleGroupItem value="dark"><Moon />{t("accountThemeDark")}</ToggleGroupItem>
                  </ToggleGroup>
                  <FieldDescription>{t(theme === "system" ? "accountThemeSystemDescription" : theme === "light" ? "accountThemeLightDescription" : "accountThemeDarkDescription")}</FieldDescription>
                </Field>
              </FieldGroup>
            </CardContent>
          </Card>
        ) : null}

        {tab === "appearance" ? (
          <Card>
            <CardHeader>
              <CardTitle>{t("localeTitle")}</CardTitle>
              <CardDescription>{t("localeDescription")}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <FieldGroup>
                <Field>
                  <ToggleGroup type="single" variant="outline" value={localePreference} aria-label={t("localeTitle")}
                    onValueChange={value => { if (value) onLocalePreferenceChange(value as LocalePreference); }} className="flex-wrap">
                    <ToggleGroupItem value="system"><Languages />{t("localeSystem")}</ToggleGroupItem>
                    <ToggleGroupItem value="zh-CN">{t("localeZh")}</ToggleGroupItem>
                    <ToggleGroupItem value="en">{t("localeEn")}</ToggleGroupItem>
                  </ToggleGroup>
                  <FieldDescription>{t(localePreference === "system" ? "localeSystemDetail" : localePreference === "zh-CN" ? "localeZhDetail" : "localeEnDetail")}</FieldDescription>
                </Field>
              </FieldGroup>
            </CardContent>
          </Card>
        ) : null}

        {tab === "api-keys" ? (
          <Card>
            <CardHeader>
              <CardTitle>{t("accountApiKey")}</CardTitle>
              <CardDescription>{t("accountApiKeyDescription")}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="api-key-name">{t("accountApiKeyNameLabel")}</FieldLabel>
                  <Input
                    id="api-key-name"
                    value={apiKeyName}
                    onChange={(event) => setApiKeyName(event.target.value)}
                    placeholder={t("accountApiKeyNamePlaceholder")}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="api-key-expires-at">{t("accountApiKeyExpiryLabel")}</FieldLabel>
                  <Input
                    id="api-key-expires-at"
                    type="datetime-local"
                    value={apiKeyExpiresAt}
                    onChange={(event) => setApiKeyExpiresAt(event.target.value)}
                  />
                  <FieldDescription>{t("accountApiKeyExpiryFieldDescription")}</FieldDescription>
                </Field>
              </FieldGroup>

              <TablePanel className="min-w-[640px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("accountApiKeyHeaderName")}</TableHead>
                      <TableHead>{t("accountApiKeyHeaderPrefix")}</TableHead>
                      <TableHead>{t("accountApiKeyHeaderLastUsed")}</TableHead>
                      <TableHead>{t("accountApiKeyHeaderExpiry")}</TableHead>
                      <TableHead className="w-[88px] text-right">{t("accountApiKeyHeaderOperations")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {apiKeysBusy ? (
                      <TableLoadingRows colSpan={5} />
                    ) : !apiKeys || apiKeys.length === 0 ? (
                      <TableEmptyRow colSpan={5} icon={<KeyRound />} title={t("accountApiKeyEmptyTitle")} description={t("accountApiKeyEmptyDescription")} />
                    ) : (
                      apiKeys.map((apiKey) => (
                        <TableRow key={apiKey.id}>
                          <TableCell>
                            <div className="font-medium text-foreground">{apiKey.name}</div>
                            <div className="text-xs text-muted-foreground">{apiKey.source}</div>
                          </TableCell>
                          <TableCell className="font-mono text-xs">{apiKey.prefix}</TableCell>
                          <TableCell className="text-xs text-muted-foreground">{formatApiKeyDate(apiKey.lastUsedAt)}</TableCell>
                          <TableCell className="text-xs text-muted-foreground">{formatApiKeyDate(apiKey.expiresAt)}</TableCell>
                          <TableCell className="text-right">
                            <IconActionButton
                              size="icon-sm"
                              label={t("accountApiKeyRevokeLabel", { name: apiKey.name })}
                              disabled={revokeKeyId === apiKey.id || !!apiKey.revokedAt}
                              onClick={() => setConfirmAction({
                                title: t("accountApiKeyRevoke"),
                                description: t("accountApiKeyRevokeConfirmDescription"),
                                details: (
                                  <div className="flex flex-col gap-1">
                                    <span>{t("accountApiKeyRevokeDetailsName")}{apiKey.name}</span>
                                    <span>{t("accountApiKeyRevokeDetailsPrefix")}{apiKey.prefix}</span>
                                  </div>
                                ),
                                confirmLabel: t("accountApiKeyRevokeKey"),
                                tone: "destructive",
                                onConfirm: () => onRevokeApiKey(apiKey.id),
                              })}
                            >
                              {revokeKeyId === apiKey.id ? <RefreshCw data-icon="inline-start" className="animate-spin" /> : <AlertCircle data-icon="inline-start" />}
                            </IconActionButton>
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
              </TablePanel>
            </CardContent>
            <CardFooter className="justify-between gap-3">
              <div className="text-xs text-muted-foreground">
                {notice ? t("accountApiKeyCopiedPlaintext") : t("accountApiKeyTipPlaintextOnce")}
              </div>
              <Button
                onClick={() => {
                  const expiresAt = apiKeyExpiresAt.trim();
                  const name = apiKeyName.trim();
                  const normalizedExpiresAt = expiresAt ? new Date(expiresAt).toISOString() : undefined;
                  setConfirmAction({
                    title: t("accountApiKeyCreate"),
                    description: t("accountApiKeyCreateConfirmDescription"),
                    details: (
                      <div className="flex flex-col gap-1">
                        <span>{t("accountApiKeyCreateDetailsName")}{name}</span>
                        <span>{t("accountApiKeyCreateDetailsExpiry")}{normalizedExpiresAt ?? t("accountApiKeyCreateExpiryDefault")}</span>
                      </div>
                    ),
                    confirmLabel: t("accountApiKeyCreateKey"),
                    tone: "warning",
                    onConfirm: () => onCreateApiKey({
                      name,
                      expiresAt: normalizedExpiresAt,
                    }),
                  });
                }}
                disabled={!apiKeyName.trim() || !!createKeyBusy}
              >
                {createKeyBusy ? <RefreshCw data-icon="inline-start" className="animate-spin" /> : null}
                {t("accountApiKeyCreate")}
              </Button>
            </CardFooter>
          </Card>
        ) : null}

      </div>

      <Dialog open={revealedToken !== null} onOpenChange={(open) => { if (!open) setRevealedToken(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("accountApiKeyPlaintextTitle")}</DialogTitle>
            <DialogDescription>{t("accountApiKeyPlaintextDescription")}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="rounded-lg border border-border bg-muted/50 px-3 py-3 font-mono text-sm break-all">
              {revealedToken}
            </div>
            <Button
              variant="outline"
              className="w-full"
              onClick={async () => {
                if (!revealedToken) return;
                await navigator.clipboard.writeText(revealedToken);
              }}
            >
              <Copy data-icon="inline-start" />
              {t("accountApiKeyPlaintextCopy")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <ConfirmActionDialog action={confirmAction} onOpenChange={(open) => { if (!open) setConfirmAction(null); }} />
    </div>
  );
}

function SummaryPill({
  icon,
  label,
  value,
  tone = "default",
}: {
  icon: ReactNode;
  label: string;
  value: string;
  tone?: "default" | "success" | "warning" | "error";
}) {
  const badgeVariant = getSummaryBadgeVariant(tone);

  return (
    <div className="flex min-w-0 items-start gap-3">
      <span className={cn("mt-0.5 shrink-0 text-muted-foreground", getSummaryIconToneClass(tone))}>{icon}</span>
      <div className="min-w-0">
        <div className="text-sm text-muted-foreground">{label}</div>
        {badgeVariant ? (
          <Badge variant={badgeVariant} className="mt-1 max-w-full truncate">{value}</Badge>
        ) : (
          <div className="mt-1 break-words text-sm font-medium text-foreground">{value}</div>
        )}
      </div>
    </div>
  );
}

function getSummaryBadgeVariant(tone: "default" | "success" | "warning" | "error"): "secondary" | "outline" | "destructive" | null {
  if (tone === "success") return "secondary";
  if (tone === "warning") return "outline";
  if (tone === "error") return "destructive";
  return null;
}

function getSummaryIconToneClass(tone: "default" | "success" | "warning" | "error") {
  if (tone === "success") return "text-foreground";
  if (tone === "warning") return "text-muted-foreground";
  if (tone === "error") return "text-destructive";
  return undefined;
}

function formatApiKeyDate(value?: string): string {
  if (!value) return i18n.t("accountApiKeyLastUsedNotRecorded", { ns: "serverWeb" });
  return formatDateTime(value);
}

async function handleAvatarFileChange(
  event: ChangeEvent<HTMLInputElement>,
  options: {
    onChange: (value: string | null) => void;
    onError: (message: string | null) => void;
  },
) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  if (file.size > 512 * 1024) {
    options.onError(i18n.t("accountAvatarErrorTooLarge", { ns: "serverWeb" }));
    return;
  }
  try {
    const dataUrl = await readFileAsDataUrl(file);
    options.onChange(dataUrl);
    options.onError(null);
  } catch (error) {
    options.onError(error instanceof Error ? error.message : i18n.t("accountAvatarErrorReadFailed", { ns: "serverWeb" }));
  }
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const readFailedMessage = i18n.t("accountAvatarErrorReadFailed", { ns: "serverWeb" });
    reader.onerror = () => reject(new Error(readFailedMessage));
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new Error(readFailedMessage));
        return;
      }
      resolve(reader.result);
    };
    reader.readAsDataURL(file);
  });
}
