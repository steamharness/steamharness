
import { translateDynamicKey } from "@steamharness/i18n";
import type { AsyncState, DetailState, DetailTab } from "../../state";
import type { KnowledgeRepository, KnowledgeWorkspaceProps } from "@steamharness/knowledge-base";
import type { InvitationRole, KVEntryDetail, KVEntrySummary, ProjectInvitation, Summary, ApiResponse } from "../../types";
import type { KVFilters } from "../ProjectKVPage";

export interface DetailPageProps {
  project: Summary;
  detail: DetailState;
  activeTab: DetailTab;
  busy: AsyncState;
  onUpdateVisibility: (visibility: "private" | "public") => void;
  onSetProjectMember: (userId: string, role: "owner" | "maintainer" | "developer" | "guest") => void;
  onRemoveProjectMember: (userId: string) => void;
  onCreateProjectInvitation: (role: "owner" | "maintainer" | "developer" | "guest") => Promise<{
    invitation: ProjectInvitation;
    token: string;
    shareUrl: string;
  } | null>;
  onRevokeProjectInvitation: (invitationId: string) => void;
  kvPageIndex: number;
  kvPageSize: number;
  kvFilters: KVFilters;
  onKVFiltersChange: (filters: KVFilters) => void;
  onKVPageChange: (direction: "next" | "previous") => void;
  onLoadKVEntry: (entry: KVEntrySummary) => Promise<ApiResponse<KVEntryDetail>>;
  onDeleteKVEntry: (entry: KVEntrySummary) => Promise<ApiResponse<unknown>>;
  knowledgeRepository?: KnowledgeRepository;
  knowledgeRefreshToken: number;
  refreshToken?: number;
  onContentBusyChange?: (busy: boolean) => void;
  onResolveKnowledgeImageSrc?: KnowledgeWorkspaceProps["resolveImageSrc"];
  onKnowledgeDirtyChange?: (dirty: boolean) => void;
  onNavigateTab: (tab: DetailTab) => void;
  onNavigateProjectTab: (projectId: string, tab: DetailTab) => void;
  sidebarCollapsed: boolean;
  onRefresh: () => void;
}

export function getTabLabel(tab: DetailTab): string {
  const map: Record<DetailTab, string> = {
    configurations: "projectConfigurations",
    project: "detailNavOverview",
    settings: "detailNavSettings",
    members: "detailNavMembers",
    invitations: "storageInvitations",
    dependencies: "detailNavRelatedProjects",
    knowledge: "detailNavKnowledge",
    versions: "detailNavVersions",
    kv: "detailNavKv",
  };
  return translateDynamicKey(map[tab], "serverWeb");
}

export const projectMemberRoleOptions = () => ["guest","developer","maintainer","owner"].map(role=>({value:role as InvitationRole,label:translateDynamicKey(`accessRole${role[0].toUpperCase()}${role.slice(1)}`,"serverWeb")}));

// keeps detail tab management tables aligned on a fixed 20-row page size.
export const MANAGEMENT_TABLE_PAGE_SIZE = 20;
export const VERSION_PAGE_SIZE = MANAGEMENT_TABLE_PAGE_SIZE;
