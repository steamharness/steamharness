
import { useMemo, useState } from "react";
import { Bot, Boxes, Brain, Code2, Cpu, Database, FileText, FolderKanban, GitBranch, MessageCircle, Search, Workflow, Zap } from "lucide-react";
import { translateDynamicKey, useTranslation } from "@workflow-code/i18n/react";
import { i18n } from "@workflow-code/i18n";
import { matchesWorkflowProjectSearch } from "@workflow-code/project-info";
import type { ProjectCardIconName, ProjectCardMetadata, WorkflowProjectType, WorkflowSummary } from "../types";
import { getWorkflowProjectTypeDefinition, getWorkflowProjectTypeLabelKey } from "@workflow-code/project-types";
import { formatDate } from "../utils/format";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PageStats } from "@/components/ui/page-stats";
import { PaginationFooter } from "@/components/ui/pagination-footer";
import { SearchField } from "@/components/ui/search-field";
import { TableEmptyRow } from "@/components/ui/composites";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TablePanel } from "@/components/ui/table-panel";
import { TableLoadingRows } from "@/components/ui/table-loading-rows";
import { Field, FieldTitle } from "@/components/ui/field";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { UserIdentity, createUserIdentitySearchText } from "@/components/UserIdentity";
import { getWorkflowProjectDisplayName } from "@/utils/project-presentation";

// keeps the project management table aligned with the shared 20-row pager.
const PROJECT_TABLE_PAGE_SIZE = 20;

const PROJECT_CARD_ICONS = {
  workflow: Workflow,
  "message-circle": MessageCircle,
  bot: Bot,
  code: Code2,
  "git-branch": GitBranch,
  boxes: Boxes,
  zap: Zap,
  database: Database,
  "file-text": FileText,
  cpu: Cpu,
  brain: Brain,
} satisfies Partial<Record<ProjectCardIconName, typeof Workflow>>;

function getProjectCardIconComponent(icon: ProjectCardIconName) {
  // Server-side project cards use the same Workflow glyph fallback
  // as App and shared conversation surfaces.
  if (icon === "sparkles") {
    return Workflow;
  }
  return PROJECT_CARD_ICONS[icon] ?? Workflow;
}

function getProjectTypeIconComponent(projectType: WorkflowProjectType) {
  return getProjectCardIconComponent(
    getWorkflowProjectTypeDefinition(projectType).defaultIcon,
  );
}



interface ProjectListPageProps {
  projects: WorkflowSummary[];
  selectedId: string;
  loading?: string;
  onRefresh: () => void;
  onOpenDetail: (project: WorkflowSummary) => void;
}

type StatusFilter = "all" | "published" | "draft";

export function ProjectListPage({
  projects,
  selectedId,
  loading,
  onOpenDetail,
}: ProjectListPageProps) {
  const { t, i18n: serverWebI18n } = useTranslation("serverWeb");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [pageIndex, setPageIndex] = useState(0);

  const filteredProjects = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return projects.filter((p) => {
      const kindLabel = getProjectKindLabel(p.projectType);
      const uploaderText = createUserIdentitySearchText(getProjectUploaderIdentity(p));
      const matchesQuery = !needle || matchesWorkflowProjectSearch(p.name, p.projectInfo, needle) || [
        p.id,
        p.latest ?? "",
        p.projectType,
        kindLabel,
        uploaderText,
      ].some((v) => v.toLowerCase().includes(needle));
      if (!matchesQuery) return false;
      if (statusFilter === "published") return Boolean(p.latest);
      if (statusFilter === "draft") return !p.latest;

      return true;
    }).sort(compareProjectsByUpdatedAt);
  }, [projects, query, serverWebI18n.language, statusFilter]);

  const pageCount = Math.max(1, Math.ceil(filteredProjects.length / PROJECT_TABLE_PAGE_SIZE));
  const safePageIndex = Math.min(pageIndex, pageCount - 1);
  const visibleProjects = filteredProjects.slice(
    safePageIndex * PROJECT_TABLE_PAGE_SIZE,
    safePageIndex * PROJECT_TABLE_PAGE_SIZE + PROJECT_TABLE_PAGE_SIZE,
  );

  const versionCount = projects.reduce((total, project) => total + project.versions.length, 0);
  const publishedCount = projects.filter(project => project.latest).length;
  const preparingCount = projects.filter((project) => !project.latest).length;
  const summaryItems = [
    { label: t("projectListStatProjects"), value: projects.length },
    { label: t("storagePublished"), value: publishedCount },
    { label: t("storageVersions"), value: versionCount },
  ];

  const filterChips: Array<{ value: StatusFilter; label: string; count: number }> = [
    { value: "all", label: t("projectListFilterAll"), count: projects.length },
    { value: "published", label: t("storagePublished"), count: publishedCount },
    { value: "draft", label: t("storageUnpublished"), count: preparingCount },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 p-4 lg:p-6">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <div className="min-w-0 flex-1 basis-64">
          <h1 className="text-xl font-semibold text-foreground">{t("projectListTitle")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("projectListSubtitle")}</p>
        </div>
        <PageStats items={summaryItems} />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <SearchField
          icon={<Search />}
          aria-label={t("projectListSearchPlaceholder")}
          placeholder={t("projectListSearchPlaceholder")}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setPageIndex(0);
          }}
          className="w-full sm:w-72"
        />
        <Field orientation="horizontal" className="w-auto">
          <FieldTitle id="project-status-filter-label" className="sr-only">{t("projectListStatusFilterAria")}</FieldTitle>
          <ToggleGroup
            type="single"
            value={statusFilter}
            onValueChange={(value) => {
              if (!value) return;
              setStatusFilter(value as StatusFilter);
              setPageIndex(0);
            }}
            aria-labelledby="project-status-filter-label"
            variant="outline"
            size="sm"
            className="flex-wrap"
          >
            {filterChips.map((item) => (
              <ToggleGroupItem
                key={item.value}
                value={item.value}
                title={`${item.label} ${item.count}`}
              >
                {item.label} {item.count}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </Field>
        <div className="flex-1" />
        <span className="text-xs text-muted-foreground">{t("projectListVisible", { visible: filteredProjects.length, total: projects.length })}</span>
      </div>

      <TablePanel className="min-w-[1000px] table-fixed" panelClassName="min-h-64 flex-1" footer={
        <PaginationFooter
          total={filteredProjects.length}
          pageIndex={safePageIndex}
          pageSize={PROJECT_TABLE_PAGE_SIZE}
          rowsOnPage={visibleProjects.length}
          previousDisabled={!!loading || safePageIndex <= 0}
          nextDisabled={!!loading || safePageIndex >= pageCount - 1}
          onPrevious={() => setPageIndex((current) => Math.max(0, current - 1))}
          onNext={() => setPageIndex((current) => Math.min(pageCount - 1, current + 1))}
        />
      }>
          <TableHeader className="sticky top-0 bg-background">
            <TableRow>
              <TableHead className="w-[36%] px-3">{t("projectListHeaderProject")}</TableHead>
              <TableHead className="w-[12%] px-3">{i18n.t("projectType")}</TableHead>
              <TableHead className="w-[22%] px-3">{t("projectListHeaderUploader")}</TableHead>
              <TableHead className="w-[12%] px-3">{t("projectListHeaderVersion")}</TableHead>
              <TableHead className="w-[18%] px-3 text-right" aria-sort="descending">{t("projectListHeaderUpdatedAt")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableLoadingRows colSpan={5} />
            ) : filteredProjects.length === 0 ? (
              <TableEmptyRow
                colSpan={5}
                title={t("projectListEmptyTitle")}
                description={t("projectListEmptyDescription")}
                icon={<FolderKanban />}
              />
            ) : (
              visibleProjects.map((project) => (
                <ProjectRow
                  key={project.id}
                  project={project}
                  selected={project.id === selectedId}
                  onOpenDetail={onOpenDetail}
                />
              ))
            )}
          </TableBody>
      </TablePanel>
    </div>
  );
}

function compareProjectsByUpdatedAt(left: WorkflowSummary, right: WorkflowSummary): number {
  const leftUpdatedAt = Date.parse(left.updatedAt ?? "");
  const rightUpdatedAt = Date.parse(right.updatedAt ?? "");
  const leftTimestamp = Number.isFinite(leftUpdatedAt) ? leftUpdatedAt : Number.NEGATIVE_INFINITY;
  const rightTimestamp = Number.isFinite(rightUpdatedAt) ? rightUpdatedAt : Number.NEGATIVE_INFINITY;
  return rightTimestamp - leftTimestamp;
}

function ProjectRow({
  project,
  selected,
  onOpenDetail,
}: {
  project: WorkflowSummary;
  selected: boolean;
  onOpenDetail: (p: WorkflowSummary) => void;
}) {
  const { t } = useTranslation("serverWeb");
  const ProjectTypeIcon = getProjectTypeIconComponent(project.projectType);
  const displayName = getWorkflowProjectDisplayName(project, i18n.language);
  return (
    <TableRow
      onClick={() => onOpenDetail(project)}
      data-state={selected ? "selected" : undefined}
      className="cursor-pointer"
    >
      <TableCell className="px-3 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <ProjectCardIcon projectId={project.id} projectName={displayName} card={project.projectCard} />
          <div className="flex min-w-0 flex-col gap-1">
            <Button variant="link" className="h-auto min-w-0 max-w-full justify-start p-0" title={displayName}
              onClick={event => { event.stopPropagation(); onOpenDetail(project); }}><span className="truncate">{displayName}</span></Button>
            <span className="truncate font-mono text-xs text-muted-foreground" title={project.id}>{project.id}</span>
          </div>
        </div>
      </TableCell>
      <TableCell className="px-3">
        <Badge variant="outline"><ProjectTypeIcon data-icon="inline-start" />{getProjectKindLabel(project.projectType)}</Badge>
      </TableCell>
      <TableCell className="px-3">
        <ProjectUploaderSummary project={project} />
      </TableCell>
      <TableCell className="px-3">
        <Badge variant={project.latest ? "secondary" : "outline"} className="max-w-full" title={project.latest ?? undefined}>
          <span className="truncate">{project.latest ?? t("storageUnpublished")}</span>
        </Badge>
      </TableCell>
      <TableCell className="px-3 text-right text-sm text-muted-foreground tabular-nums">{formatDate(project.updatedAt)}</TableCell>

    </TableRow>
  );
}



function ProjectCardIcon({ projectId, projectName, card }: { projectId: string; projectName: string; card: ProjectCardMetadata }) {
  const { t } = useTranslation("serverWeb");
  const Icon = getProjectCardIconComponent(card.icon);

  return (
    <span
      data-testid={`project-card-icon-${projectId}`}
      className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border"
      style={{
        backgroundColor: card.iconBackgroundColor,
        color: card.iconColor ?? "#ffffff",
      }}
      aria-hidden={card.iconUrl === undefined ? true : undefined}
    >
      {card.iconUrl === undefined ? (
        <Icon className="size-4" />
      ) : (
        <img
          src={card.iconUrl}
          alt={t("projectListIconAlt", { projectName })}
          className="size-full object-cover"
          loading="lazy"
          referrerPolicy="no-referrer"
        />
      )}
    </span>
  );
}

function ProjectUploaderSummary({ project }: { project: WorkflowSummary }) {
  const { t } = useTranslation("serverWeb");
  const uploader = getProjectUploaderIdentity(project);
  if (!uploader.userId && !uploader.displayName && !uploader.email) return <span className="text-sm text-muted-foreground">—</span>;
  return (
    <UserIdentity user={uploader} fallbackLabel={t("projectListUploaderFallback")} size="sm" showUserId={false} />
  );
}

function getProjectKindLabel(kind: WorkflowProjectType): string {
  return translateDynamicKey(getWorkflowProjectTypeLabelKey(kind));
}

function getProjectUploaderIdentity(project: WorkflowSummary) {
  return {
    userId: project.createdByProfile?.userId ?? project.createdByUserId,
    displayName: project.createdByProfile?.displayName,
    email: project.createdByProfile?.email,
    avatarUrl: project.createdByProfile?.avatarUrl,
  };
}
