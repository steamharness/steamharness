import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { translateDynamicKey, useTranslation } from "@steamharness/i18n/react";
import type {
  ProjectKVAccessRule,
  RelatedProjectKVGrant,
} from "@steamharness/project-info";
import { getProjectKindLabelKey } from "@steamharness/project-types";
import {
  Check,
  ChevronsUpDown,
  ExternalLink,
  KeyRound,
  Link2,
  Loader2,
  Pencil,
  Plus,
  ShieldCheck,
  ShieldX,
  Trash2,
  Workflow,
} from "lucide-react";
import { apiClient } from "../../api";
import {
  isApiSuccess,
  type ProjectDependencyStatusResult,
  type ProjectSourceAccessSummary,
  type RelatedProjectListResult,
  type RelatedProjectStatus,
} from "../../types";
import { ConfirmActionDialog, type ConfirmAction } from "@/components/ConfirmActionDialog";
import { UserIdentity } from "@/components/UserIdentity";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { IconActionButton, TableActionCell, TableEmptyRow } from "@/components/ui/composites";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldSet, FieldLegend } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SelectField } from "@/components/ui/select-field";
import { TableLoadingRows } from "@/components/ui/table-loading-rows";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TablePanel } from "@/components/ui/table-panel";
import { PaginationFooter } from "@/components/ui/pagination-footer";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { formatDate } from "../../utils/format";
import type { DetailPageProps } from "./types";

type Props = Pick<DetailPageProps, "project" | "detail" | "onNavigateProjectTab" | "refreshToken" | "onContentBusyChange">;
type AccessMode = ProjectKVAccessRule["mode"];

interface GrantDraft {
  readMode: AccessMode;
  readPrefixes: string;
  writeMode: AccessMode;
  writePrefixes: string;
}

interface RelationDraft {
  alias: string;
  targetProjectId: string;
  targetAlias: string;
  grantToRelatedProject: GrantDraft;
  targetGrantToRelatedProject: GrantDraft;
}

type SearchableProjectOption = { value: string; label: string };

const DEFAULT_GRANT_DRAFT: GrantDraft = {
  readMode: "all",
  readPrefixes: "",
  writeMode: "none",
  writePrefixes: "",
};

function SearchableProjectSelect({
  id,
  value,
  projectId,
  excludedIds,
  placeholder,
  disabled,
  invalid,
  onValueChange,
}: {
  id: string;
  value: string;
  projectId: string;
  excludedIds: string[];
  placeholder: string;
  disabled?: boolean;
  invalid?: boolean;
  onValueChange: (value: string) => void;
}) {
  const { t } = useTranslation("serverWeb");
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<{items: SearchableProjectOption[]; total: number}>({items: [], total: 0});
  const [selected, setSelected] = useState<SearchableProjectOption>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!open) return;
    let current = true;
    setLoading(true);
    const timer = setTimeout(() => {
      void apiClient.listProjects({q: query, page}).then(response => {
        if (!current) return;
        if (!isApiSuccess(response)) throw new Error(response.errMessage);
        const items = response.data.items.map(item => ({value: item.id, label: `${item.name} - ${translateDynamicKey(getProjectKindLabelKey(item.projectType))}`}));
        setResult({items, total: response.data.total});
        setError("");
      }).catch(cause => { if (current) setError(cause instanceof Error ? cause.message : t("relatedProjectsLoadFailed")); })
        .finally(() => { if (current) setLoading(false); });
    }, 200);
    return () => { current = false; clearTimeout(timer); };
  }, [open, query, page, revision, t]);
  const options = result.items.filter(item => item.value !== projectId && !excludedIds.includes(item.value));
  const selectedLabel = result.items.find(item => item.value === value)?.label ?? (selected?.value === value ? selected.label : value || placeholder);

  return (
    <DropdownMenu
      modal={false}
      open={open}
      onOpenChange={(nextOpen) => {
        if (disabled) return;
        setOpen(nextOpen);
        if (!nextOpen) {setQuery(""); setPage(1);}
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          id={id}
          type="button"
          role="combobox"
          variant="outline"
          aria-label={t("relatedProjectsTargetProjectAria")}
          aria-expanded={open}
          aria-invalid={invalid}
          disabled={disabled}
          className="w-full justify-between font-normal"
        >
          <span className={cn("min-w-0 truncate text-left", !value && "text-muted-foreground")}>
            {selectedLabel}
          </span>
          <ChevronsUpDown data-icon="inline-end" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel className="p-1">
          <Input
            autoFocus
            type="search"

            aria-label={t("relatedProjectsSearchAria")}
            placeholder={t("relatedProjectsSearchPlaceholder")}
            value={query}
            onChange={(event) => { setQuery(event.target.value); setPage(1); }}
            onKeyDown={(event) => {
              if (event.key !== "ArrowDown" && event.key !== "Escape") event.stopPropagation();
            }}
          />
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {error ? <div role="alert" className="p-2 text-sm text-destructive">{error}<Button variant="outline" size="sm" onClick={() => setRevision(value => value + 1)}>{t("commonRetry")}</Button></div> : loading ? <div role="status" className="p-2 text-sm">{t("loginLoading")}</div> : options.length === 0 ? (
          <div role="status" className="px-2 py-6 text-center text-sm text-muted-foreground">
            {t("relatedProjectsNoMatches")}
          </div>
        ) : (
          <DropdownMenuGroup>
            <DropdownMenuRadioGroup
              value={value}
              onValueChange={(nextValue) => {
                setSelected(result.items.find(item => item.value === nextValue));
                onValueChange(nextValue);
                setOpen(false);
                setQuery("");
              }}
            >
              {options.map((option) => (
                <DropdownMenuRadioItem key={option.value} value={option.value}>
                  {option.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
        )}
        <PaginationFooter pageIndex={page-1} total={result.total} rowsOnPage={result.items.length}
          previousDisabled={loading || page===1} nextDisabled={loading || page*20>=result.total}
          onPrevious={() => setPage(page => page-1)} onNext={() => setPage(page => page+1)} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AccessRuleEditor({
  id,
  label,
  mode,
  prefixes,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  mode: AccessMode;
  prefixes: string;
  disabled: boolean;
  onChange: (value: { mode: AccessMode; prefixes: string }) => void;
}) {
  const { t } = useTranslation("serverWeb");
  return (
    <Field>
      <FieldLabel htmlFor={`${id}-mode`}>{label}</FieldLabel>
      <SelectField
        id={`${id}-mode`}
        value={mode}
        disabled={disabled}
        options={[
          { value: "none", label: t("relatedProjectsAccessNone") },
          { value: "all", label: t("relatedProjectsAccessAll") },
          { value: "prefixes", label: t("relatedProjectsAccessPrefixes") },
        ]}
        onValueChange={(value) => onChange({ mode: value as AccessMode, prefixes })}
      />
      {mode === "prefixes" ? (
        <Textarea
          value={prefixes}
          rows={3}
          disabled={disabled}
          aria-label={t("relatedProjectsPrefixesAria", { label })}
          placeholder={"inventory.v1:\nreports.v1:"}
          onChange={(event) => onChange({ mode, prefixes: event.target.value })}
        />
      ) : null}
      <FieldDescription>{t("relatedProjectsPrefixesDescription")}</FieldDescription>
    </Field>
  );
}

function GrantSummary({ grant }: { grant: RelatedProjectKVGrant | undefined }) {
  const { t } = useTranslation("serverWeb");
  if (grant === undefined) {
    return <span className="text-xs text-muted-foreground">{t("relatedProjectsAwaitingConfirmation")}</span>;
  }
  const labels = {
    none: t("relatedProjectsAccessNone"),
    all: t("relatedProjectsAccessAll"),
    prefixes: (count: number) => t("relatedProjectsPrefixCount", { count }),
  };
  return (
    <div className="flex flex-wrap gap-1">
      <Badge variant="secondary">{t("relatedProjectsReadShort")}: {formatRule(grant.read, labels)}</Badge>
      <Badge variant="outline">{t("relatedProjectsWriteShort")}: {formatRule(grant.write, labels)}</Badge>
    </div>
  );
}

export function DependenciesTab({ project, detail, onNavigateProjectTab, refreshToken, onContentBusyChange }: Props) {
  const { t } = useTranslation("serverWeb");
  const [target, setTarget] = useState(project.latest ? "latest" : "draft");
  const [relations, setRelations] = useState<RelatedProjectListResult | null>(null);
  const [dependencyStatus, setDependencyStatus] = useState<ProjectDependencyStatusResult | null>(null);
  const [sourceAccess, setSourceAccess] = useState<ProjectSourceAccessSummary | null>(null);
  const [loadError, setLoadError] = useState("");
  const [dependencyError, setDependencyError] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState("");
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingAlias, setEditingAlias] = useState<string | null>(null);
  const [draft, setDraft] = useState<RelationDraft>(createEmptyRelationDraft());
  const [formError, setFormError] = useState("");
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  const loadRequestIdRef = useRef(0);

  useEffect(() => setTarget(project.latest ? "latest" : "draft"), [project.id, project.latest]);
  useEffect(() => closeEditor(), [project.id]);

  const load = useCallback(async () => {
    const requestId = ++loadRequestIdRef.current;
    setLoading(true);
    setLoadError("");
    setDependencyError("");
    try {
      const [relationsResponse, accessResponse, dependenciesResponse] = await Promise.all([
        apiClient.listRelatedProjects(project.id),
        project.access?.capabilities.includes("manageSettings") ? apiClient.listSourceAccessRequests(project.id) : undefined,
        project.projectType === "kanban"
          ? apiClient.getProjectDependencies(project.id, target)
          : undefined,
      ]);
      if (loadRequestIdRef.current !== requestId) return;
      if (!isApiSuccess(relationsResponse)) throw new Error(relationsResponse.errMessage);
      if (accessResponse && !isApiSuccess(accessResponse)) throw new Error(accessResponse.errMessage);
      setRelations(relationsResponse.data);
      setSourceAccess(accessResponse?.data ?? null);
      if (dependenciesResponse !== undefined) {
        if (isApiSuccess(dependenciesResponse)) setDependencyStatus(dependenciesResponse.data);
        else {
          setDependencyStatus(null);
          setDependencyError(dependenciesResponse.errMessage || t("dependenciesLoadStatusFailed"));
        }
      } else {
        setDependencyStatus(null);
      }
    } catch (error) {
      if (loadRequestIdRef.current !== requestId) return;
      setRelations(null);
      setSourceAccess(null);
      setDependencyStatus(null);
      setLoadError(error instanceof Error && error.message ? error.message : t("relatedProjectsLoadFailed"));
    } finally {
      if (loadRequestIdRef.current === requestId) setLoading(false);
    }
  }, [project.id, project.projectType, project.access?.capabilities.includes("manageSettings"), t, target]);

  useEffect(() => {
    void load();
    return () => { loadRequestIdRef.current += 1; };
  }, [load, refreshToken]);

  const contentBusy = loading || saving !== "";
  useEffect(() => {
    onContentBusyChange?.(contentBusy);
    return () => onContentBusyChange?.(false);
  }, [contentBusy, onContentBusyChange]);

  const targetOptions = useMemo(() => {
    const values = new Set<string>();
    if (project.hasDraft) values.add("draft");
    if (project.latest) values.add("latest");
    for (const version of detail.versions?.versions ?? []) values.add(version.version);
    return [...values].map((value) => ({
      value,
      label: value === "latest" ? `latest (${project.latest})` : value,
    }));
  }, [detail.versions?.versions, project.hasDraft, project.latest]);

  const relatedProjectIds = (relations?.relatedProjects ?? []).map(item => item.relation.projectId);
  const pendingRequests = sourceAccess?.requests.filter((request) => request.status === "pending") ?? [];
  const incompleteSources = dependencyStatus?.dependencies.filter((item) => (
    item.projectAvailable && item.relationshipConfirmed && !item.dataInitialized
  )) ?? [];

  function openCreateEditor() {
    setEditingAlias(null);
    setDraft(createEmptyRelationDraft());
    setFormError("");
    setEditorOpen(true);
  }

  function openEditEditor(status: RelatedProjectStatus) {
    setEditingAlias(status.relation.alias);
    setDraft({
      alias: status.relation.alias,
      targetProjectId: status.relation.projectId,
      targetAlias: status.reciprocalAlias ?? "",
      grantToRelatedProject: grantToDraft(status.relation.grantToRelatedProject),
      targetGrantToRelatedProject: grantToDraft(status.grantFromRelatedProject ?? defaultGrant()),
    });
    setFormError("");
    setEditorOpen(true);
  }

  function closeEditor() {
    setEditorOpen(false);
    setEditingAlias(null);
    setDraft(createEmptyRelationDraft());
    setFormError("");
  }

  async function saveRelation() {
    if (saving || !project.access?.capabilities.includes("manageSettings")) return;
    const alias = draft.alias.trim();
    const targetAlias = draft.targetAlias.trim();
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(alias) || !/^[a-z][a-z0-9_-]{0,63}$/.test(targetAlias)) {
      setFormError(t("relatedProjectsAliasInvalid"));
      return;
    }
    if (!draft.targetProjectId || draft.targetProjectId === project.id) {
      setFormError(t("relatedProjectsTargetRequired"));
      return;
    }
    let grantToRelatedProject: RelatedProjectKVGrant;
    let targetGrantToRelatedProject: RelatedProjectKVGrant;
    try {
      grantToRelatedProject = draftToGrant(draft.grantToRelatedProject);
      targetGrantToRelatedProject = draftToGrant(draft.targetGrantToRelatedProject);
    } catch {
      setFormError(t("relatedProjectsPrefixesRequired"));
      return;
    }
    setSaving("relation");
    setFormError("");
    try {
      const response = await apiClient.setRelatedProject(project.id, alias, {
        targetProjectId: draft.targetProjectId,
        targetAlias,
        grantToRelatedProject,
        targetGrantToRelatedProject,
      });
      if (!isApiSuccess(response)) {
        setFormError(response.errMessage || t("relatedProjectsSaveFailed"));
        return;
      }
      closeEditor();
      await load();
    } catch {
      setFormError(t("relatedProjectsSaveFailed"));
    } finally {
      setSaving("");
    }
  }

  async function resolveRequest(requestId: string, status: "approved" | "rejected") {
    const savingKey = `request:${requestId}:${status}`;
    setSaving(savingKey);
    const response = await apiClient.resolveSourceAccessRequest(project.id, requestId, status);
    setSaving("");
    if (!isApiSuccess(response)) setLoadError(response.errMessage || t("dependenciesUpdateSourceRequestFailed"));
    else await load();
  }

  return (
    <div className="min-w-0 flex-1 overflow-auto p-6">
      <div className="flex w-full min-w-0 flex-col gap-6">
        <div>
          <h2 className="text-sm font-semibold text-foreground">{t("detailNavRelatedProjects")}</h2>
          <p className="text-xs text-muted-foreground">{t("relatedProjectsPageDescription")}</p>
        </div>

        <section className="flex min-w-0 flex-col gap-3">
          <header className="flex flex-wrap items-center justify-between gap-3">
            <div><h3 className="text-base font-semibold">{t("relatedProjectsCardTitle")}</h3><p className="text-sm text-muted-foreground">{t("relatedProjectsCardDescription")}</p></div>
            {project.access?.capabilities.includes("manageSettings") ? <IconActionButton size="icon" variant="outline" label={t("relatedProjectsAdd")} disabled={loading || saving !== ""} onClick={openCreateEditor}><Plus /></IconActionButton> : null}
          </header>
          <div className="flex min-w-0 flex-col gap-4">
            {loadError ? (
              <Alert variant="destructive"><AlertTitle>{t("relatedProjectsUnavailableTitle")}</AlertTitle><AlertDescription>{loadError}</AlertDescription></Alert>
            ) : (
                <TablePanel className="min-w-[880px]">
                  <TableHeader><TableRow><TableHead>{t("relatedProjectsHeaderAlias")}</TableHead><TableHead>{t("relatedProjectsHeaderProject")}</TableHead><TableHead>{t("relatedProjectsHeaderStatus")}</TableHead><TableHead>{t("relatedProjectsHeaderOutbound")}</TableHead><TableHead>{t("relatedProjectsHeaderInbound")}</TableHead><TableHead className="text-right">{t("dependenciesHeaderActions")}</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {loading && relations === null ? <TableLoadingRows colSpan={6} /> : (relations?.relatedProjects.length ?? 0) === 0 ? (
                      <TableEmptyRow colSpan={6} title={t("relatedProjectsEmptyTitle")} description={t("relatedProjectsEmptyDescription")} icon={<Link2 />} />
                    ) : relations!.relatedProjects.map((status) => {
                      const targetName = status.projectName ?? t("relatedProjectsProjectUnavailable");
                      return (
                        <TableRow key={status.relation.alias}>
                          <TableCell><code className="text-xs">{status.relation.alias}</code></TableCell>
                          <TableCell><div className="flex flex-col gap-1"><span className="font-medium">{targetName}</span><code className="text-xs text-muted-foreground">{status.relation.projectId}</code></div></TableCell>
                          <TableCell><Badge variant={status.confirmed ? "secondary" : "outline"}>{status.confirmed ? t("relatedProjectsConfirmed") : t("relatedProjectsPending")}</Badge></TableCell>
                          <TableCell><GrantSummary grant={status.relation.grantToRelatedProject} /></TableCell>
                          <TableCell><GrantSummary grant={status.grantFromRelatedProject} /></TableCell>
                          <TableActionCell contentClassName="gap-2">
                            {project.access?.capabilities.includes("manageSettings") ? <IconActionButton disabled={saving !== ""} label={t("relatedProjectsEdit", { name: targetName })} onClick={() => openEditEditor(status)}><Pencil /></IconActionButton> : null}
                            {status.projectName ? <IconActionButton label={t("relatedProjectsOpen", { name: targetName })} onClick={() => onNavigateProjectTab(status.relation.projectId, "project")}><Workflow /></IconActionButton> : null}
                            {project.access?.capabilities.includes("manageSettings") ? <IconActionButton danger disabled={saving !== ""} label={t("relatedProjectsRemove", { name: targetName })} onClick={() => setConfirmAction({ title: t("relatedProjectsRemoveConfirmTitle"), description: t("relatedProjectsRemoveConfirmDescription"), details: <span>{targetName}</span>, confirmLabel: t("relatedProjectsRemoveConfirmLabel"), tone: "destructive", onConfirm: async () => { setSaving(`remove:${status.relation.alias}`); const response = await apiClient.removeRelatedProject(project.id, status.relation.alias); setSaving(""); if (!isApiSuccess(response)) setLoadError(response.errMessage); else await load(); } })}><Trash2 /></IconActionButton> : null}
                          </TableActionCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </TablePanel>
            )}
          </div>
        </section>

        {project.projectType === "kanban" ? (
          <section className="flex min-w-0 flex-col gap-3">
            <header className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="text-base font-semibold">{t("dependenciesVersionCardTitle")}</h3><p className="text-sm text-muted-foreground">{t("dependenciesVersionCardDescription")}</p></div><SelectField aria-label={t("dependenciesTargetVersionAria")} className="w-[200px]" value={target} options={targetOptions} onValueChange={setTarget} /></header>
            <div className="flex min-w-0 flex-col gap-3">
              {dependencyError ? (
                <Alert variant="destructive"><AlertTitle>{t("dependenciesStatusUnavailableTitle")}</AlertTitle><AlertDescription>{dependencyError}</AlertDescription></Alert>
              ) : (
                  <TablePanel className="min-w-[1080px]">
                    <TableHeader><TableRow><TableHead>{t("relatedProjectsHeaderAlias")}</TableHead><TableHead>{t("dependenciesHeaderProject")}</TableHead><TableHead>{t("dependenciesHeaderDelivery")}</TableHead><TableHead>{t("dependenciesHeaderExactVersion")}</TableHead><TableHead>{t("relatedProjectsHeaderStatus")}</TableHead><TableHead>{t("dependenciesHeaderSourcePermission")}</TableHead><TableHead>{t("dependenciesHeaderServerData")}</TableHead><TableHead className="text-right">{t("dependenciesHeaderActions")}</TableHead></TableRow></TableHeader>
                    <TableBody>
                      {loading && dependencyStatus === null ? <TableLoadingRows colSpan={8} /> : (dependencyStatus?.dependencies.length ?? 0) === 0 ? <TableEmptyRow colSpan={8} title={t("dependenciesEmptyTitle")} description={t("dependenciesEmptyDescription")} icon={<Link2 />} /> : dependencyStatus!.dependencies.map((item) => (
                        <TableRow key={item.dependency.alias}>
                          <TableCell><code className="text-xs">{item.dependency.alias}</code></TableCell>
                          <TableCell><span className="font-medium">{item.projectName ?? item.dependency.projectId}</span></TableCell>
                          <TableCell><Badge variant={item.dependency.delivery === "included" ? "secondary" : "secondary"}>{item.dependency.delivery === "included" ? t("dependenciesDeliveryIncluded") : t("dependenciesDeliveryExternal")}</Badge></TableCell>
                          <TableCell className="font-mono text-xs">{item.dependency.version ?? t("dependenciesVersionUnlocked")}</TableCell>
                          <TableCell><Badge variant={item.relationshipConfirmed ? "secondary" : "outline"}>{item.relationshipConfirmed ? t("relatedProjectsConfirmed") : t("relatedProjectsPending")}</Badge></TableCell>
                          <TableCell><Badge variant={item.sourceDownloadAllowed ? "secondary" : "secondary"}>{item.sourceDownloadAllowed ? t("dependenciesSourceDownloadable") : t("dependenciesSourceRequestRequired")}</Badge></TableCell>
                          <TableCell><Badge variant={item.dataInitialized ? "secondary" : "outline"}>{item.dataInitialized ? t("dependenciesDataInitialized") : t("dependenciesDataUninitialized")}</Badge></TableCell>
                          <TableActionCell>{item.requestUrl ? <IconActionButton asChild label={t("dependenciesRequestSourceAccessLabel")}><a href={item.requestUrl}><ExternalLink /></a></IconActionButton> : null}{item.projectAvailable ? <IconActionButton label={t("dependenciesOpenSourceProject")} onClick={() => onNavigateProjectTab(item.dependency.projectId, "project")}><Workflow /></IconActionButton> : null}</TableActionCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </TablePanel>
              )}
              {dependencyStatus && !dependencyStatus.publishable ? <Alert variant="destructive"><AlertTitle>{t("dependenciesNotReadyTitle")}</AlertTitle><AlertDescription>{t("dependenciesNotReadyDescription")}</AlertDescription></Alert> : null}
              {incompleteSources.length > 0 ? <Alert><AlertTitle>{t("dependenciesServerDataUninitializedTitle")}</AlertTitle><AlertDescription>{t("dependenciesServerDataUninitializedDescription")}</AlertDescription></Alert> : null}
            </div>
          </section>
        ) : null}

        {project.access?.capabilities.includes("manageSettings") ? <section className="flex min-w-0 flex-col gap-3">
          <header><h3 className="text-base font-semibold">{t("dependenciesSourceRequestsTitle")}</h3><p className="text-sm text-muted-foreground">{t("dependenciesSourceRequestsDescription")}</p></header>
          <div className="flex min-w-0 flex-col gap-4">
            {loading && sourceAccess === null ? <TablePanel><TableBody><TableLoadingRows colSpan={4} /></TableBody></TablePanel> : loadError ? null : (
              <>
                <TablePanel className="min-w-[760px]"><TableHeader><TableRow><TableHead>{t("dependenciesHeaderRequester")}</TableHead><TableHead>{t("dependenciesHeaderReason")}</TableHead><TableHead>{t("dependenciesHeaderSubmittedAt")}</TableHead><TableHead className="text-right">{t("dependenciesHeaderActions")}</TableHead></TableRow></TableHeader><TableBody>{pendingRequests.length === 0 ? <TableEmptyRow colSpan={4} title={t("dependenciesNoPendingRequestsTitle")} description={t("dependenciesNoPendingRequestsDescription")} icon={<KeyRound />} /> : pendingRequests.map((request) => <TableRow key={request.id}><TableCell><UserIdentity user={{ userId: request.requesterUserId }} size="sm" showEmail={false} /></TableCell><TableCell className="max-w-[420px] whitespace-pre-wrap text-sm">{request.reason}</TableCell><TableCell className="text-xs text-muted-foreground">{formatDate(request.createdAt)}</TableCell><TableActionCell contentClassName="gap-2"><Button size="sm" variant="outline" disabled={saving !== ""} onClick={() => void resolveRequest(request.id, "rejected")}>{saving === `request:${request.id}:rejected` ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <ShieldX data-icon="inline-start" />}{t("dependenciesRejectRequest")}</Button><Button size="sm" disabled={saving !== ""} onClick={() => void resolveRequest(request.id, "approved")}>{saving === `request:${request.id}:approved` ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Check data-icon="inline-start" />}{t("dependenciesApproveRequest")}</Button></TableActionCell></TableRow>)}</TableBody></TablePanel>
              </>
            )}
          </div>
        </section> : null}
      </div>

      <Dialog open={editorOpen} onOpenChange={(open) => { if (!open && saving !== "relation") closeEditor(); }}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[760px]" showCloseButton={saving !== "relation"}>
          <DialogHeader><DialogTitle>{editingAlias ? t("relatedProjectsEditTitle") : t("relatedProjectsAddTitle")}</DialogTitle><DialogDescription>{t("relatedProjectsEditorDescription")}</DialogDescription></DialogHeader>
          <form id="related-project-editor" onSubmit={(event) => { event.preventDefault(); void saveRelation(); }}>
            <FieldGroup>
              <Field><FieldLabel htmlFor="related-project-target">{t("relatedProjectsTargetProject")}</FieldLabel><SearchableProjectSelect id="related-project-target" value={draft.targetProjectId} projectId={project.id} excludedIds={editingAlias ? [] : relatedProjectIds} placeholder={t("relatedProjectsTargetPlaceholder")} disabled={saving === "relation" || editingAlias !== null} invalid={formError !== "" && !draft.targetProjectId} onValueChange={(targetProjectId) => setDraft((current) => ({ ...current, targetProjectId }))} /></Field>
              <div className="grid gap-4 md:grid-cols-2"><Field><FieldLabel htmlFor="related-project-alias">{t("relatedProjectsAlias")}</FieldLabel><Input id="related-project-alias" value={draft.alias} disabled={saving === "relation" || editingAlias !== null} onChange={(event) => setDraft((current) => ({ ...current, alias: event.target.value }))} /><FieldDescription>{t("relatedProjectsAliasDescription")}</FieldDescription></Field><Field><FieldLabel htmlFor="related-project-target-alias">{t("relatedProjectsTargetAlias")}</FieldLabel><Input id="related-project-target-alias" value={draft.targetAlias} disabled={saving === "relation"} onChange={(event) => setDraft((current) => ({ ...current, targetAlias: event.target.value }))} /><FieldDescription>{t("relatedProjectsTargetAliasDescription")}</FieldDescription></Field></div>
              <div className="grid gap-5 md:grid-cols-2">
                <FieldSet><FieldLegend>{t("relatedProjectsGrantOutboundTitle")}</FieldLegend><FieldDescription>{t("relatedProjectsGrantOutboundDescription")}</FieldDescription><AccessRuleEditor id="outbound-read" label={t("relatedProjectsRead")} mode={draft.grantToRelatedProject.readMode} prefixes={draft.grantToRelatedProject.readPrefixes} disabled={saving === "relation"} onChange={(value) => setDraft((current) => ({ ...current, grantToRelatedProject: { ...current.grantToRelatedProject, readMode: value.mode, readPrefixes: value.prefixes } }))} /><AccessRuleEditor id="outbound-write" label={t("relatedProjectsWrite")} mode={draft.grantToRelatedProject.writeMode} prefixes={draft.grantToRelatedProject.writePrefixes} disabled={saving === "relation"} onChange={(value) => setDraft((current) => ({ ...current, grantToRelatedProject: { ...current.grantToRelatedProject, writeMode: value.mode, writePrefixes: value.prefixes } }))} /></FieldSet>
                <FieldSet><FieldLegend>{t("relatedProjectsGrantInboundTitle")}</FieldLegend><FieldDescription>{t("relatedProjectsGrantInboundDescription")}</FieldDescription><AccessRuleEditor id="inbound-read" label={t("relatedProjectsRead")} mode={draft.targetGrantToRelatedProject.readMode} prefixes={draft.targetGrantToRelatedProject.readPrefixes} disabled={saving === "relation"} onChange={(value) => setDraft((current) => ({ ...current, targetGrantToRelatedProject: { ...current.targetGrantToRelatedProject, readMode: value.mode, readPrefixes: value.prefixes } }))} /><AccessRuleEditor id="inbound-write" label={t("relatedProjectsWrite")} mode={draft.targetGrantToRelatedProject.writeMode} prefixes={draft.targetGrantToRelatedProject.writePrefixes} disabled={saving === "relation"} onChange={(value) => setDraft((current) => ({ ...current, targetGrantToRelatedProject: { ...current.targetGrantToRelatedProject, writeMode: value.mode, writePrefixes: value.prefixes } }))} /></FieldSet>
              </div>
              {formError ? <FieldError>{formError}</FieldError> : null}
            </FieldGroup>
          </form>
          <DialogFooter><Button type="button" variant="outline" disabled={saving === "relation"} onClick={closeEditor}>{t("commonCancel")}</Button><Button type="submit" form="related-project-editor" disabled={saving === "relation"}>{saving === "relation" ? <Loader2 data-icon="inline-start" className="animate-spin" /> : null}{t("relatedProjectsSave")}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmActionDialog action={confirmAction} onOpenChange={(open) => { if (!open) setConfirmAction(null); }} />
    </div>
  );
}

function createEmptyRelationDraft(): RelationDraft {
  return { alias: "", targetProjectId: "", targetAlias: "", grantToRelatedProject: { ...DEFAULT_GRANT_DRAFT }, targetGrantToRelatedProject: { ...DEFAULT_GRANT_DRAFT } };
}

function defaultGrant(): RelatedProjectKVGrant {
  return { read: { mode: "all" }, write: { mode: "none" } };
}

function grantToDraft(grant: RelatedProjectKVGrant): GrantDraft {
  return { readMode: grant.read.mode, readPrefixes: grant.read.mode === "prefixes" ? grant.read.prefixes.join("\n") : "", writeMode: grant.write.mode, writePrefixes: grant.write.mode === "prefixes" ? grant.write.prefixes.join("\n") : "" };
}

function draftToGrant(draft: GrantDraft): RelatedProjectKVGrant {
  return { read: draftToRule(draft.readMode, draft.readPrefixes), write: draftToRule(draft.writeMode, draft.writePrefixes) };
}

function draftToRule(mode: AccessMode, rawPrefixes: string): ProjectKVAccessRule {
  if (mode !== "prefixes") return { mode };
  const prefixes = [...new Set(rawPrefixes.split(/\r?\n/).map((value) => value.trim()).filter(Boolean))];
  if (prefixes.length === 0) throw new Error("prefixes are required");
  return { mode, prefixes };
}

function formatRule(
  rule: ProjectKVAccessRule,
  labels: { none: string; all: string; prefixes: (count: number) => string },
): string {
  if (rule.mode === "none") return labels.none;
  if (rule.mode === "all") return labels.all;
  return labels.prefixes(rule.prefixes.length);
}
