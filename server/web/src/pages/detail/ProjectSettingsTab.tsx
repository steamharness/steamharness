import { useState, type ReactNode } from "react";
import { ArrowUpRight, BookOpenText, Check, Copy, Database, Link2, Users } from "lucide-react";
import { formatDateTime } from "@steamharness/i18n";
import { translateDynamicKey, useTranslation } from "@steamharness/i18n/react";
import { getWorkflowProjectTypeLabelKey } from "@steamharness/project-types";
import {
  Badge, Card, CardAction, CardContent, CardHeader, CardTitle,
  Field, FieldContent, FieldDescription, FieldGroup, FieldLabel, IconActionButton, PageStats, Switch,
  TablePanel, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui";
import { ConfirmActionDialog, type ConfirmAction } from "@/components/ConfirmActionDialog";
import { UserIdentity } from "@/components/UserIdentity";
import {
  getWorkflowProjectDisplayName,
  getWorkflowProjectServerStorageAccess,
  listWorkflowProjectDeclarationLabels,
} from "@/utils/project-presentation";
import { CopyButton } from "./CopyButton";
import type { DetailPageProps } from "./types";

export function ProjectSettingsTab({ project, busy, onUpdateVisibility, onNavigateTab }: DetailPageProps) {
  const { t, i18n } = useTranslation("serverWeb");
  const [action, setAction] = useState<ConfirmAction | null>(null);
  const loading = Boolean(busy.project);
  const isPublic = project.visibility === "public";
  const storageAccess = getWorkflowProjectServerStorageAccess(project);
  const storageMode = project.projectInfo.dataStorage?.mode;
  const storageModeLabel = storageMode === "both" ? t("projectStorageModeBoth")
    : storageMode === "server" ? t("projectStorageModeServer")
    : storageMode === "local" ? t("projectStorageModeLocal")
    : t("projectStorageModeUndeclared");
  const allowedLocationsLabel = storageMode === "both" ? t("projectStorageAllowedBoth")
    : storageMode === "server" ? t("projectStorageAllowedServer")
    : storageMode === "local" ? t("projectStorageAllowedLocal")
    : t("projectStorageAllowedNone");
  const declarations = listWorkflowProjectDeclarationLabels(project);
  const localizedNames = Object.entries(project.projectInfo.localizedNames);
  const entries = [
    { tab: "members", label: t("projectSettingsMembersEntry"), icon: Users },
    { tab: "dependencies", label: t("detailNavRelatedProjects"), icon: Link2 },
    { tab: "kv", label: t("projectSettingsKvEntry"), icon: Database, disabled: !storageAccess.allowed },
    { tab: "knowledge", label: t("projectSettingsKnowledgeEntry"), icon: BookOpenText, disabled: !storageAccess.allowed },
  ] as const;

  function permissionBadge(allowed: boolean | undefined) {
    return <Badge variant={allowed ? "secondary" : "outline"}>{t(allowed ? "projectStorageServerAccessAllowed" : "projectStorageServerAccessBlocked")}</Badge>;
  }

  return (
    <div className="@container flex min-w-0 flex-col gap-4 p-4 lg:p-6">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <div className="min-w-0 flex-1 basis-64">
          <h1 className="text-xl font-semibold">{t("detailNavSettings")}</h1>
          <p className="mt-1 break-words text-sm text-muted-foreground">{getWorkflowProjectDisplayName(project, i18n.language)}</p>
        </div>
        <PageStats items={[
          { label: t("storageVersions"), value: project.versions.length },
          { label: t("detailNavRelatedProjects"), value: project.projectInfo.relatedProjects.length },
        ]} />
      </div>

      <div className="grid min-w-0 grid-cols-1 gap-4 @3xl:grid-cols-2">
        <Card className="h-full min-w-0">
          <CardHeader className="min-h-10"><CardTitle>{t("projectSettingsProjectInfo")}</CardTitle></CardHeader>
          <CardContent>
            <dl className="grid min-w-0 grid-cols-1 gap-4 text-sm sm:grid-cols-2">
              <div className="min-w-0 sm:col-span-2">
                <dt className="text-muted-foreground">{t("projectSettingsBaselineProjectId")}</dt>
                <dd className="mt-1 flex min-w-0 items-center gap-2">
                  <span className="min-w-0 break-all font-mono">{project.id}</span>
                  <CopyButton value={project.id}>{copied => copied ? <Check /> : <Copy />}</CopyButton>
                </dd>
              </div>
              <SettingsDetail label={t("projectSettingsDefaultName")}>{project.name}</SettingsDetail>
              <SettingsDetail label={i18n.t("projectType")}>
                <Badge variant="secondary">{translateDynamicKey(getWorkflowProjectTypeLabelKey(project.projectType))}</Badge>
              </SettingsDetail>
              <div className="min-w-0 sm:col-span-2">
                <dt className="text-muted-foreground">{t("projectSettingsLocalizedNames")}</dt>
                <dd className="mt-2">
                  {localizedNames.length ? <TablePanel>
                    <TableHeader><TableRow><TableHead>{t("localeTitle")}</TableHead><TableHead>{t("projectSettingsLocalizedNames")}</TableHead></TableRow></TableHeader>
                    <TableBody>{localizedNames.map(([locale, name]) => (
                      <TableRow key={locale}><TableCell><Badge variant="outline">{locale}</Badge></TableCell><TableCell className="whitespace-normal break-words">{name}</TableCell></TableRow>
                    ))}</TableBody>
                  </TablePanel> : t("projectSettingsUnspecifiedName")}
                </dd>
              </div>
              <div className="min-w-0 sm:col-span-2">
                <dt className="text-muted-foreground">{t("projectSettingsDeclarations")}</dt>
                <dd className="mt-1 flex flex-wrap gap-2">
                  {declarations.length ? declarations.map(declaration => (
                    <Badge key={declaration.id} variant="outline">{declaration.labelKey ? translateDynamicKey(declaration.labelKey) : declaration.id}</Badge>
                  )) : t("projectSettingsNoDeclarations")}
                </dd>
              </div>
              <div className="min-w-0 sm:col-span-2">
                <dt className="text-muted-foreground">{t("projectCreator")}</dt>
                <dd className="mt-2"><UserIdentity user={{ userId: project.createdByUserId, ...project.createdByProfile }} showUserId={false} /></dd>
              </div>
            </dl>
          </CardContent>
        </Card>

        <Card className="h-full min-w-0">
          <CardHeader className="min-h-10">
            <CardTitle>{t("projectSettingsAccessPolicy")}</CardTitle>
            <CardAction><Badge variant={isPublic ? "secondary" : "outline"}>{t(isPublic ? "projectSettingsVisibilityBadgePublic" : "projectSettingsVisibilityBadgePrivate")}</Badge></CardAction>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            <FieldGroup>
              <Field orientation="horizontal" data-disabled={loading || !project.canManage}>
                <FieldContent className="min-w-0">
                  <FieldLabel htmlFor="project-public">{t("storagePublicProject")}</FieldLabel>
                  <FieldDescription>{t("storagePublicProjectDescription")}</FieldDescription>
                </FieldContent>
                <Switch id="project-public" checked={isPublic} disabled={loading || !project.canManage} onCheckedChange={checked => setAction({
                  title: t(checked ? "projectSettingsSetPublicConfirm" : "projectSettingsSetPrivateConfirm"),
                  description: t(checked ? "projectSettingsSetPublicConfirmDescription" : "projectSettingsSetPrivateConfirmDescription"),
                  details: <span className="break-words">{getWorkflowProjectDisplayName(project, i18n.language)}</span>,
                  confirmLabel: t("commonSave"), tone: "warning",
                  onConfirm: () => onUpdateVisibility(checked ? "public" : "private"),
                })} />
              </Field>
            </FieldGroup>
            <p className="text-sm text-muted-foreground">{t(isPublic ? "projectSettingsPublicDescription" : "projectSettingsPrivateDescription")}</p>
            <dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2">
              <SettingsDetail label={t("projectSettingsMembersManage")}>{permissionBadge(project.canManage)}</SettingsDetail>
              <SettingsDetail label={t("dependenciesHeaderSourcePermission")}>{permissionBadge(project.sourceDownload?.allowed)}</SettingsDetail>
            </dl>
          </CardContent>
        </Card>

        <Card className="h-full min-w-0">
          <CardHeader className="min-h-10"><CardTitle>{t("projectStorageDeclarationTitle")}</CardTitle></CardHeader>
          <CardContent className="flex flex-col gap-4">
            <dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2">
              <SettingsDetail label={t("projectStorageModeLabel")}><Badge variant="secondary">{storageModeLabel}</Badge></SettingsDetail>
              <SettingsDetail label={t("projectStorageAllowedLocations")}>{allowedLocationsLabel}</SettingsDetail>
              <SettingsDetail label={t("projectStorageServerAccess")}>{permissionBadge(storageAccess.allowed)}</SettingsDetail>
              <SettingsDetail label={t("relatedProjectsWrite")}>{permissionBadge(storageAccess.allowed && project.canWriteData)}</SettingsDetail>
            </dl>
            <p className="text-sm text-muted-foreground">{storageAccess.allowed
              ? t("projectStorageServerAccessAllowedDescription")
              : storageAccess.mode === "local" ? t("projectStorageAccessLocalOnlyDescription") : t("projectStorageAccessUndeclaredDescription")}</p>
          </CardContent>
        </Card>

        <Card className="h-full min-w-0">
          <CardHeader className="min-h-10">
            <CardTitle>{t("storageVersions")}</CardTitle>
            <CardAction><IconActionButton label={t("detailNavVersions")} onClick={() => onNavigateTab("versions")}><ArrowUpRight /></IconActionButton></CardAction>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-wrap gap-2">
              <Badge variant={project.latest ? "secondary" : "outline"}>{t(project.latest ? "storagePublished" : "storageUnpublished")}</Badge>
              {project.hasDraft && <Badge variant="outline">{t("projectSettingsHasDraft")}</Badge>}
            </div>
            <dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2">
              <SettingsDetail label={t("projectSettingsBaselineLatest")}><span className="font-mono">{project.latest ?? t("projectSettingsBaselineNoLatest")}</span></SettingsDetail>
              <SettingsDetail label={t("projectSettingsBaselineNextVersion")}><span className="font-mono">{project.nextVersion}</span></SettingsDetail>
              <SettingsDetail label={t("storageCreatedAt")}>{project.createdAt ? formatDateTime(project.createdAt) : t("commonNotRecorded")}</SettingsDetail>
              <SettingsDetail label={t("storageUpdatedAt")}>{project.updatedAt ? formatDateTime(project.updatedAt) : t("commonNotRecorded")}</SettingsDetail>
            </dl>
          </CardContent>
        </Card>

        <Card className="h-full min-w-0 @3xl:col-span-2">
          <CardHeader className="min-h-10"><CardTitle>{t("projectSettingsConfigEntries")}</CardTitle></CardHeader>
          <CardContent>
            <TablePanel>
              <TableHeader><TableRow><TableHead>{t("projectSettingsConfigEntries")}</TableHead><TableHead className="text-right">{t("dependenciesHeaderActions")}</TableHead></TableRow></TableHeader>
              <TableBody>
              {entries.map(entry => (
                <TableRow key={entry.tab}>
                  <TableCell><span className="flex items-center gap-2"><entry.icon aria-hidden="true" className="size-4" />{entry.label}</span></TableCell>
                  <TableCell><div className="flex justify-end"><IconActionButton label={entry.label} disabled={"disabled" in entry && entry.disabled} onClick={() => onNavigateTab(entry.tab)}><ArrowUpRight /></IconActionButton></div></TableCell>
                </TableRow>
              ))}
              </TableBody>
            </TablePanel>
          </CardContent>
        </Card>
      </div>
      <ConfirmActionDialog action={action} onOpenChange={open => { if (!open) setAction(null); }} />
    </div>
  );
}

function SettingsDetail({ label, children }: { label: string; children: ReactNode }) {
  return <div className="min-w-0"><dt className="text-muted-foreground">{label}</dt><dd className="mt-1 break-words">{children}</dd></div>;
}
