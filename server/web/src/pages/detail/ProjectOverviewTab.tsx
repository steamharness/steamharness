import type { ReactNode } from "react";
import { ArrowUpRight, BookOpenText, CircleAlert, Database, Download, Link2, Package, RefreshCw, Settings2, Users, type LucideIcon } from "lucide-react";
import { translateDynamicKey, useTranslation } from "@workflow-code/i18n/react";
import { formatDateTime } from "@workflow-code/i18n";
import { getWorkflowProjectTypeLabelKey } from "@workflow-code/project-types";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { IconActionButton } from "@/components/ui/composites";
import { Empty, EmptyDescription, EmptyHeader } from "@/components/ui/empty";
import { PageStats } from "@/components/ui/page-stats";
import { Skeleton } from "@/components/ui/skeleton";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TablePanel } from "@/components/ui/table-panel";
import { UserIdentity } from "@/components/UserIdentity";
import { ProjectVersionShareButton } from "@/components/ProjectVersionShareButton";
import { projectSourceArchivePath } from "@/utils/routes";
import { getWorkflowProjectDisplayName, getWorkflowProjectServerStorageAccess } from "@/utils/project-presentation";
import { formatBytes } from "@/utils/format";
import type { DetailPageProps } from "./types";

export function ProjectOverviewTab({ project, detail, busy, onNavigateTab, onRefresh }: DetailPageProps) {
  const { t, i18n } = useTranslation("serverWeb");
  const { t: tCommon } = useTranslation("common");
  const loading = Boolean(busy.project);
  const versions = [...(detail.versions?.versions ?? [])].reverse();
  const latestVersion = versions.find(version => version.version === project.latest);
  const storageAccess = getWorkflowProjectServerStorageAccess(project);
  const storageMode = project.projectInfo.dataStorage?.mode;
  const storageModeLabel = storageMode === "both" ? t("projectStorageModeBoth")
    : storageMode === "server" ? t("projectStorageModeServer")
    : storageMode === "local" ? t("projectStorageModeLocal")
    : t("projectStorageModeUndeclared");
  const relations = project.projectInfo.relatedProjects;
  const kv = detail.dataSummary?.kv;
  const knowledge = detail.dataSummary?.knowledge;
  const formatCount = (value: number | undefined) => value === undefined ? "-" : value.toLocaleString(i18n.language);
  const storageBlockedMessage = storageAccess.mode === "local"
    ? t("projectStorageAccessLocalOnlyDescription")
    : t("projectStorageAccessUndeclaredDescription");

  return (
    <div className="@container flex min-w-0 flex-col gap-4 p-4 lg:p-6">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <div className="flex min-w-0 flex-1 basis-64 flex-wrap items-center gap-3">
          <h1 className="min-w-0 max-w-full text-xl font-semibold break-words">{getWorkflowProjectDisplayName(project, i18n.language)}</h1>
          <Badge variant="secondary">{translateDynamicKey(getWorkflowProjectTypeLabelKey(project.projectType))}</Badge>
          <Badge variant="outline">{project.latest ?? t("storageUnpublished")}</Badge>
          {project.projectInfo.declarations.includes("multilingual") && (
            <Badge variant="outline">{t("projectDeclarationMultilingual")}</Badge>
          )}
        </div>
        <PageStats items={[
          { label: t("storageVersions"), value: project.versions.length },
          { label: t("storageMembers"), value: loading ? <Skeleton className="h-6 w-8" /> : detail.members?.length ?? "-" },
          { label: t("detailNavRelatedProjects"), value: relations.length },
          { label: tCommon("knowledgeDocuments"), value: loading && storageAccess.allowed ? <Skeleton className="h-6 w-8" /> : storageAccess.allowed ? formatCount(knowledge?.documentCount) : "-" },
          { label: t("detailNavKv"), value: loading && storageAccess.allowed ? <Skeleton className="h-6 w-8" /> : storageAccess.allowed ? formatCount(kv?.entryCount) : "-" },
        ]} />
      </div>

      <div className="grid min-w-0 grid-cols-1 gap-4 @3xl:grid-cols-2">
          <OverviewSection title={t("storageVersions")} icon={Package} count={project.versions.length} onOpen={() => onNavigateTab("versions")}>
            <OverviewContent loading={loading} error={detail.loadErrors?.versions} empty={versions.length === 0} emptyMessage={t("storageNoVersions")} onRetry={onRefresh}>
              {latestVersion && <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <Badge variant="outline">latest · {latestVersion.version}</Badge>
                <div className="flex items-center gap-2">
                  <ProjectVersionShareButton id={project.id} version={latestVersion.version} disabled={!project.sourceDownload?.allowed} />
                  <Button variant="outline" size="sm" disabled={!project.sourceDownload?.allowed} onClick={() => window.location.assign(projectSourceArchivePath(project.id, latestVersion.version))}><Download data-icon="inline-start" />{t("storageDownload")}</Button>
                </div>
              </div>}
              {latestVersion?.releaseLog && (
                <dl className="mb-4 text-sm">
                  <dt className="text-muted-foreground">{t("storageReleaseLog")} · {latestVersion.version}</dt>
                  <dd className="mt-1 line-clamp-4 whitespace-pre-wrap break-words">{latestVersion.releaseLog}</dd>
                </dl>
              )}
              <TablePanel className="min-w-[600px] table-fixed">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[24%]">{t("storageVersion")}</TableHead>
                    <TableHead className="w-[16%] text-right">{t("storageDownloadCount")}</TableHead>
                    <TableHead className="w-[30%]">{t("storagePublishedAt")}</TableHead>
                    <TableHead className="w-[30%]">{t("projectListHeaderUploader")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {versions.slice(0, 5).map(version => (
                    <TableRow key={version.version}>
                      <TableCell>
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                          <span className="truncate font-mono" title={version.version}>{version.version}</span>
                          {version.latest && <Badge variant="secondary">latest</Badge>}
                        </div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{formatCount(version.downloadCount)}</TableCell>
                      <TableCell className="text-muted-foreground">{version.createdAt ? formatDateTime(version.createdAt) : "-"}</TableCell>
                      <TableCell className="py-3"><UserIdentity user={{ userId: version.createdByUserId, ...version.createdByProfile }} showUserId={false} /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </TablePanel>
            </OverviewContent>
          </OverviewSection>

          <OverviewSection title={t("projectSettingsProjectInfo")} icon={Settings2} onOpen={() => onNavigateTab("settings")}>
            <dl className="grid min-w-0 grid-cols-1 gap-4 text-sm sm:grid-cols-2">
              <div className="min-w-0 sm:col-span-2"><dt className="text-muted-foreground">ID</dt><dd className="mt-1 break-all font-mono">{project.id}</dd></div>
              <div><dt className="text-muted-foreground">{t("projectSettingsAccessPolicy")}</dt><dd className="mt-1"><Badge variant="outline">{t(project.visibility === "public" ? "projectSettingsVisibilityBadgePublic" : "projectSettingsVisibilityBadgePrivate")}</Badge></dd></div>
              <div><dt className="text-muted-foreground">{t("projectStorageModeLabel")}</dt><dd className="mt-1">{storageModeLabel}</dd></div>
              <div className="min-w-0 sm:col-span-2"><dt className="text-muted-foreground">{t("projectCreator")}</dt><dd className="mt-2"><UserIdentity user={{ userId: project.createdByUserId, ...project.createdByProfile }} showUserId={false} /></dd></div>
              <div><dt className="text-muted-foreground">{t("storageCreatedAt")}</dt><dd className="mt-1 break-words">{project.createdAt ? formatDateTime(project.createdAt) : "-"}</dd></div>
              <div><dt className="text-muted-foreground">{t("storageUpdatedAt")}</dt><dd className="mt-1 break-words">{project.updatedAt ? formatDateTime(project.updatedAt) : "-"}</dd></div>
            </dl>
          </OverviewSection>

          <OverviewSection title={t("detailNavKv")} icon={Database} onOpen={() => onNavigateTab("kv")}>
            <OverviewContent loading={loading && storageAccess.allowed} error={detail.loadErrors?.dataSummary} empty={!storageAccess.allowed} emptyMessage={storageBlockedMessage} onRetry={onRefresh}>
              <DataSummaryMetrics updatedAt={kv?.updatedAt} items={[
                { label: t("projectDataStatEntries"), value: formatCount(kv?.entryCount) },
                { label: t("projectDataStatValueSize"), value: kv ? formatBytes(kv.valueSizeBytes) : "-" },
                { label: t("projectDataStatProjectEntries"), value: formatCount(kv?.projectEntryCount) },
                { label: t("projectDataStatConversationEntries"), value: formatCount(kv?.conversationEntryCount) },
                { label: t("projectDataStatTextCharacters"), value: formatCount(kv?.textCharacterCount) },
              ]} />
            </OverviewContent>
          </OverviewSection>

          <OverviewSection title={t("detailNavKnowledge")} icon={BookOpenText} onOpen={() => onNavigateTab("knowledge")}>
            <OverviewContent loading={loading && storageAccess.allowed} error={detail.loadErrors?.dataSummary} empty={!storageAccess.allowed} emptyMessage={storageBlockedMessage} onRetry={onRefresh}>
              <DataSummaryMetrics updatedAt={knowledge?.updatedAt} items={[
                { label: tCommon("documentCount"), value: formatCount(knowledge?.documentCount) },
                { label: t("projectDataStatMarkdownSize"), value: knowledge ? formatBytes(knowledge.markdownSizeBytes) : "-" },
                { label: tCommon("markdownCharacterCount"), value: formatCount(knowledge?.characterCount) },
                { label: tCommon("markdownLineCount"), value: formatCount(knowledge?.lineCount) },
                { label: t("projectDataStatAverageCharacters"), value: knowledge ? formatCount(knowledge.documentCount ? Math.round(knowledge.characterCount / knowledge.documentCount) : 0) : "-" },
              ]} />
            </OverviewContent>
          </OverviewSection>

          <OverviewSection title={t("storageMembers")} icon={Users} count={detail.members?.length} onOpen={() => onNavigateTab("members")}>
            <OverviewContent loading={loading} error={detail.loadErrors?.members} empty={!detail.members?.length} emptyMessage={t("storageNoMembers")} onRetry={onRefresh}>
              <TablePanel className="min-w-[460px]">
                <TableHeader><TableRow><TableHead>{t("storageUserId")}</TableHead><TableHead>{t("storageRole")}</TableHead><TableHead>{t("storageCreatedAt")}</TableHead></TableRow></TableHeader>
                <TableBody>
                {detail.members?.slice(0, 5).map(member => (
                  <TableRow key={member.userId}>
                    <TableCell><UserIdentity user={{ userId: member.userId, ...member.profile }} showUserId={false} /></TableCell>
                    <TableCell><Badge variant="secondary">{member.role}</Badge></TableCell>
                    <TableCell>{formatDateTime(member.createdAt)}</TableCell>
                  </TableRow>
                ))}
                </TableBody>
              </TablePanel>
            </OverviewContent>
          </OverviewSection>

          <OverviewSection title={t("detailNavRelatedProjects")} icon={Link2} count={relations.length} onOpen={() => onNavigateTab("dependencies")}>
            <OverviewContent loading={false} empty={relations.length === 0} emptyMessage={t("relatedProjectsEmptyTitle")} onRetry={onRefresh}>
              <TablePanel className="min-w-[460px]">
                <TableHeader><TableRow><TableHead>{t("relatedProjectsHeaderAlias")}</TableHead><TableHead>{t("dependenciesHeaderProject")}</TableHead><TableHead>{t("storageVersion")}</TableHead></TableRow></TableHeader>
                <TableBody>
                {relations.slice(0, 5).map(relation => {
                  const lockedVersion = latestVersion?.dependencies.find(dependency => dependency.alias === relation.alias && dependency.projectId === relation.projectId)?.version;
                  return (
                    <TableRow key={relation.alias}>
                      <TableCell className="font-mono">{relation.alias}</TableCell>
                      <TableCell className="max-w-52 truncate font-mono" title={relation.projectId}>{relation.projectId}</TableCell>
                      <TableCell>{lockedVersion ? <Badge variant="outline">{lockedVersion}</Badge> : "-"}</TableCell>
                    </TableRow>
                  );
                })}
                </TableBody>
              </TablePanel>
            </OverviewContent>
          </OverviewSection>
      </div>
    </div>
  );
}

function OverviewSection({ title, icon: Icon, count, onOpen, children }: {
  title: string;
  icon: LucideIcon;
  count?: number;
  onOpen: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation("serverWeb");
  return (
    <Card role="region" aria-label={title} className="h-full min-w-0">
      <CardHeader className="min-h-10 min-w-0">
        <CardTitle role="heading" aria-level={2} className="flex min-w-0 items-center gap-2">
          <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 break-words">{title}</span>
        </CardTitle>
        <CardAction className="flex items-center gap-2">
          {count !== undefined && <Badge variant="secondary">{count}</Badge>}
          <IconActionButton label={`${title}: ${t("commonMore")}`} onClick={onOpen}><ArrowUpRight /></IconActionButton>
        </CardAction>
      </CardHeader>
      <CardContent className="min-w-0 flex-1">{children}</CardContent>
    </Card>
  );
}

function DataSummaryMetrics({ items, updatedAt }: {
  items: Array<{ label: string; value: ReactNode }>;
  updatedAt: string | null | undefined;
}) {
  const { t } = useTranslation("serverWeb");
  return (
    <dl className="grid min-w-0 grid-cols-2 gap-4">
      {items.map(item => (
        <div key={item.label} className="min-w-0">
          <dt className="text-xs text-muted-foreground">{item.label}</dt>
          <dd className="mt-1 break-words text-lg font-semibold tabular-nums">{item.value}</dd>
        </div>
      ))}
      <div className="col-span-2 min-w-0">
        <dt className="text-xs text-muted-foreground">{t("storageUpdatedAt")}</dt>
        <dd className="mt-1 break-words text-sm tabular-nums">{updatedAt ? formatDateTime(updatedAt) : t("commonNotRecorded")}</dd>
      </div>
    </dl>
  );
}

function OverviewContent({ loading, error, empty, emptyMessage, onRetry, children }: {
  loading: boolean;
  error?: string;
  empty: boolean;
  emptyMessage: string;
  onRetry: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation("serverWeb");
  if (loading) {
    return <div aria-busy="true" className="flex flex-col gap-3 py-3"><Skeleton className="h-5 w-3/4" /><Skeleton className="h-5 w-full" /><Skeleton className="h-5 w-1/2" /></div>;
  }
  if (error) {
    return (
      <Alert variant="destructive">
        <CircleAlert />
        <AlertDescription>
          <p className="break-words">{error}</p>
          <Button variant="outline" size="sm" onClick={onRetry}><RefreshCw data-icon="inline-start" />{t("commonRetry")}</Button>
        </AlertDescription>
      </Alert>
    );
  }
  if (empty) {
    return <Empty className="min-h-28 p-4 md:p-4"><EmptyHeader><EmptyDescription>{emptyMessage}</EmptyDescription></EmptyHeader></Empty>;
  }
  return children;
}
