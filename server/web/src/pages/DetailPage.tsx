
import { BookOpenText, CircleAlert, Database, LayoutDashboard, Link2, Mail, Package, Settings2, Users, type LucideIcon } from "lucide-react";
import type { DetailTab } from "../state";
import type { ServerWebResourceKey } from "@workflow-code/i18n";
import { useTranslation } from "@workflow-code/i18n/react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { KVInspectorPage } from "./ProjectKVPage";
import { ProjectOverviewTab } from "./detail/ProjectOverviewTab";
import { ProjectSettingsTab } from "./detail/ProjectSettingsTab";
import { ProjectMembersTab } from "./detail/ProjectMembersTab";
import { ProjectInvitationsTab } from "./detail/ProjectInvitationsTab";
import { VersionsTab } from "./detail/VersionsTab";
import { KnowledgeTab } from "./detail/KnowledgeTab";
import { DependenciesTab } from "./detail/DependenciesTab";
import { type DetailPageProps } from "./detail/types";
import type { WorkflowSummary } from "../types";
import { cn } from "@/lib/utils";
import { getWorkflowProjectServerStorageAccess } from "@/utils/project-presentation";

export type { DetailPageProps } from "./detail/types";

export const DETAIL_NAV_GROUPS: Array<{
  id: string;
  label: ServerWebResourceKey;
  items: Array<{ tab: DetailTab; label: ServerWebResourceKey; icon: LucideIcon }>;
}> = [
  { id: "project", label: "projectSettingsProjectInfo", items: [
    { tab: "project", label: "detailNavOverview", icon: LayoutDashboard },
    { tab: "settings", label: "detailNavSettings", icon: Settings2 },
    { tab: "dependencies", label: "detailNavRelatedProjects", icon: Link2 },
    { tab: "versions", label: "detailNavVersions", icon: Package },
  ] },
  { id: "members", label: "detailNavMembers", items: [
    { tab: "members", label: "detailNavMembers", icon: Users },
    { tab: "invitations", label: "storageInvitations", icon: Mail },
  ] },
  { id: "data", label: "detailNavGroupData", items: [
    { tab: "knowledge", label: "detailNavKnowledge", icon: BookOpenText },
    { tab: "kv", label: "detailNavKv", icon: Database },
  ] },
];

export function getDetailNavGroups(
  project: Pick<WorkflowSummary, "projectType" | "canManage"> | undefined,
) {
  if (!project) return [];
  return DETAIL_NAV_GROUPS.map(group => ({ ...group,
    items: group.items.filter(item => item.tab !== "invitations" || project.canManage),
  }));
}

export function getDetailNavItems(
  project: Pick<WorkflowSummary, "projectType" | "canManage"> | undefined,
) {
  return getDetailNavGroups(project).flatMap(group => group.items);
}

export function resolveDetailTab(
  project: Pick<WorkflowSummary, "projectType" | "latest" | "canManage">,
  requestedTab: DetailTab,
): DetailTab {
  return getDetailNavItems(project).some((item) => item.tab === requestedTab)
    ? requestedTab
    : "project";
}

export function DetailPage(props: DetailPageProps) {
  const { detail, busy, onRefresh } = props;
  const activeTab = resolveDetailTab(props.project, props.activeTab);
  const storageAccess = getWorkflowProjectServerStorageAccess(props.project);

  return (
    <div className="flex h-full flex-col">
      <div className={cn("flex min-h-0 flex-1 flex-col", activeTab === "knowledge" || activeTab === "kv" ? "overflow-hidden" : "overflow-auto")}>
        {!storageAccess.allowed && (activeTab === "knowledge" || activeTab === "kv") ? (
          <ProjectStorageAccessBlocked
            mode={storageAccess.mode}
            onOpenSettings={() => props.onNavigateTab("settings")}
          />
        ) : null}
        {activeTab === "project" && <ProjectOverviewTab {...props} />}
        {activeTab === "settings" && <ProjectSettingsTab {...props} />}
        {activeTab === "members" && <ProjectMembersTab {...props} />}
        {activeTab === "invitations" && <ProjectInvitationsTab key={props.project.id} {...props} />}
        {activeTab === "dependencies" && <DependenciesTab {...props} />}
        {storageAccess.allowed && activeTab === "knowledge" && <KnowledgeTab {...props} />}
        {activeTab === "versions" && <VersionsTab {...props} />}
        {storageAccess.allowed && activeTab === "kv" && (
          <div className="flex h-full min-h-0 min-w-0 flex-col p-6">
            <KVInspectorPage
              kvPage={detail.kv}
              filters={props.kvFilters}
              loading={busy.kv ?? busy.project}
              pageIndex={props.kvPageIndex}
              pageSize={props.kvPageSize}
              onFiltersChange={props.onKVFiltersChange}
              onRefresh={onRefresh}
              onPageChange={props.onKVPageChange}
              onLoadEntry={props.onLoadKVEntry}
              onDeleteEntry={props.project.canWriteData ? props.onDeleteKVEntry : undefined}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function ProjectStorageAccessBlocked({
  mode,
  onOpenSettings,
}: {
  mode: "local" | null;
  onOpenSettings: () => void;
}) {
  const { t } = useTranslation("serverWeb");
  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <Alert variant="destructive" className="max-w-2xl p-4">
        <CircleAlert className="size-5" />
        <AlertTitle className="text-sm font-semibold">{t("projectStorageAccessBlockedTitle")}</AlertTitle>
        <AlertDescription className="mt-1 flex flex-col items-start gap-4">
          <span>
            {mode === "local"
              ? t("projectStorageAccessLocalOnlyDescription")
              : t("projectStorageAccessUndeclaredDescription")}
          </span>
          <Button type="button" size="sm" variant="outline" onClick={onOpenSettings}>
            <Settings2 data-icon="inline-start" />
            {t("projectStorageOpenSettings")}
          </Button>
        </AlertDescription>
      </Alert>
    </div>
  );
}
