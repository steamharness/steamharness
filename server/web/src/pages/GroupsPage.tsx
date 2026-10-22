import { useEffect, useRef, useState } from "react";
import { useTranslation } from "@steamharness/i18n/react";
import { apiClient } from "../api";
import {
  isApiSuccess,
  type AccessPage,
  type ProjectGroup,
  type Summary,
} from "../types";
import { ResourceMembersPanel } from "@/components/ResourceMembersPanel";
import { GroupSelector } from "@/components/GroupSelector";
import { NewProjectButton } from "@/components/NewProjectButton";
import {
  Button,
  FieldGroup,
  Field,
  FieldLabel,
  Input,
  TableEmptyRow,
  TablePanel,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui";
import { PaginationFooter } from "@/components/ui/pagination-footer";
import {
  ConfirmActionDialog,
  type ConfirmAction,
} from "@/components/ConfirmActionDialog";

export function GroupsPage({
  id,
  onOpenGroup,
  onOpenProject,
}: {
  id?: string;
  onOpenGroup: (id?: string) => void;
  onOpenProject: (id: string) => void;
}) {
  const { t } = useTranslation("serverWeb");
  const [groups, setGroups] = useState<AccessPage<ProjectGroup>>();
  const [group, setGroup] = useState<ProjectGroup>();
  const [projects, setProjects] = useState<AccessPage<Summary>>();
  const [page, setPage] = useState(1);
  const [projectPage, setProjectPage] = useState(1);
  const [query, setQuery] = useState("");
  const [ancestors, setAncestors] = useState<ProjectGroup[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [newName, setNewName] = useState("");
  const [parent, setParent] = useState<string | null>(null);
  const [action, setAction] = useState<ConfirmAction | null>(null);
  const request = useRef(0);
  const initialized = useRef("");
  useEffect(() => {
    setPage(1);
    setProjectPage(1);
    setQuery("");
    setGroup(undefined);
    setNewName("");
  }, [id]);
  useEffect(() => {
    const serial = ++request.current;
    const timer = setTimeout(() => {
      setBusy(true);
      void Promise.all([
        apiClient.listGroups({ parentId: id ?? null, page, q: query }),
        id ? apiClient.getGroup(id) : undefined,
        id
          ? apiClient.listProjects({ groupId: id, page: projectPage })
          : undefined,
      ]).then(async ([children, current, projectList]) => {
        if (serial !== request.current) return;
        setBusy(false);
        setError("");
        if (isApiSuccess(children)) setGroups(children.data);
        else setError(children.errMessage);
        if (current) {
          if (isApiSuccess(current)) {
            setGroup(current.data);
            if (initialized.current !== `${id}:${revision}`) {
              initialized.current = `${id}:${revision}`;
              setName(current.data.name);
              setDescription(current.data.description);
              setParent(current.data.parentId);
            }
            const chain: ProjectGroup[] = [];
            let parentId = current.data.parentId;
            while (parentId && chain.length < 100) {
              const response = await apiClient.getGroup(parentId);
              if (!isApiSuccess(response)) break;
              chain.unshift(response.data);
              parentId = response.data.parentId;
            }
            if (serial === request.current) setAncestors(chain);
          } else setError(current.errMessage);
        } else setAncestors([]);
        if (projectList) {
          if (isApiSuccess(projectList)) setProjects(projectList.data);
          else setError(projectList.errMessage);
        }
      });
    }, 200);
    return () => {
      request.current++;
      clearTimeout(timer);
    };
  }, [id, page, projectPage, query, revision]);
  async function mutate(
    work: () => Promise<import("../types").ApiResponse<unknown>>,
  ) {
    setBusy(true);
    const result = await work();
    setBusy(false);
    if (!isApiSuccess(result)) setError(result.errMessage);
    else {
      setError("");
      setRevision((v) => v + 1);
    }
  }
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-6 p-4 lg:p-6">
      <nav
        aria-label={t("accessGroups")}
        className="flex flex-wrap items-center gap-2 text-sm"
      >
        <Button variant="link" onClick={() => onOpenGroup()}>
          {t("accessGroups")}
        </Button>
        {ancestors.map((g) => (
          <Button key={g.id} variant="link" onClick={() => onOpenGroup(g.id)}>
            / {g.name}
          </Button>
        ))}
        {group && <span>/ {group.name}</span>}
      </nav>
      <h1 className="text-xl font-semibold">
        {group?.name ?? t("accessGroups")}
      </h1>
      {busy && (
        <p role="status" className="text-sm text-muted-foreground">
          {t("loginLoading")}
        </p>
      )}
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
      {group && (
        <>
          <p className="text-sm text-muted-foreground">{group.description}</p>
          <p className="text-sm text-muted-foreground">{t("accessRoleHelp")}</p>
        </>
      )}
      {(!id || group?.access.capabilities.includes("createSubgroup")) && (
        <form
          className="flex max-w-2xl items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void mutate(async () => {
              const result = await apiClient.saveGroup(undefined, {
                name: newName,
                parentId: id ?? null,
              });
              if (isApiSuccess(result)) setNewName("");
              return result;
            });
          }}
        >
          <FieldGroup className="flex-row items-end">
            <Field className="flex-1">
              <FieldLabel htmlFor="new-group-name">
                {t("accessGroupName")}
              </FieldLabel>
              <Input
                id="new-group-name"
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
              />
            </Field>
            <Button disabled={busy || !newName.trim()}>
              {t("accessNewGroup")}
            </Button>
          </FieldGroup>
        </form>
      )}
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold">
          {id ? t("accessSubgroups") : t("accessGroups")}
        </h2>
        <Input
          className="max-w-72"
          aria-label={t("accessSearchGroups")}
          placeholder={t("accessSearchGroups")}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setPage(1);
          }}
        />
      </div>
      <TablePanel
        footer={
          <PaginationFooter
            pageIndex={page - 1}
            total={groups?.total ?? 0}
            rowsOnPage={groups?.items.length ?? 0}
            onPrevious={() => setPage((p) => p - 1)}
            onNext={() => setPage((p) => p + 1)}
            previousDisabled={busy || page === 1}
            nextDisabled={busy || page * 20 >= (groups?.total ?? 0)}
          />
        }
      >
        <TableHeader>
          <TableRow>
            <TableHead>{t("accessGroupName")}</TableHead>
            <TableHead>{t("accessDescription")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {groups?.items.length === 0 && (
            <TableEmptyRow colSpan={2} title={t("accessEmptyGroups")} />
          )}
          {groups?.items.map((g) => (
            <TableRow key={g.id}>
              <TableCell>
                <Button variant="link" onClick={() => onOpenGroup(g.id)}>
                  {g.name}
                </Button>
              </TableCell>
              <TableCell>{g.description}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </TablePanel>
      {id && group && (
        <>
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold">{t("navProjects")}</h2>
            {group.access.capabilities.includes("createProject") && (
              <NewProjectButton groupId={id} onCreated={onOpenProject} />
            )}
          </div>
          <TablePanel
            footer={
              <PaginationFooter
                pageIndex={projectPage - 1}
                total={projects?.total ?? 0}
                rowsOnPage={projects?.items.length ?? 0}
                onPrevious={() => setProjectPage((p) => p - 1)}
                onNext={() => setProjectPage((p) => p + 1)}
                previousDisabled={busy || projectPage === 1}
                nextDisabled={
                  busy || projectPage * 20 >= (projects?.total ?? 0)
                }
              />
            }
          >
            <TableHeader>
              <TableRow>
                <TableHead>{t("projectListHeaderProject")}</TableHead>
                <TableHead>{t("storageVersions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {projects?.items.length === 0 && (
                <TableEmptyRow colSpan={2} title={t("projectListEmptyTitle")} />
              )}
              {projects?.items.map((project) => (
                <TableRow key={project.id}>
                  <TableCell>
                    <Button
                      variant="link"
                      onClick={() => onOpenProject(project.id)}
                    >
                      {project.name}
                    </Button>
                  </TableCell>
                  <TableCell>{project.latest ?? "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </TablePanel>
          {group.access.capabilities.includes("manageSettings") && (
            <form
              className="flex max-w-2xl flex-col gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                void mutate(() =>
                  apiClient.saveGroup(id, { name, description }),
                );
              }}
            >
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="edit-group-name">
                    {t("accessGroupName")}
                  </FieldLabel>
                  <Input
                    id="edit-group-name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="edit-group-description">
                    {t("accessDescription")}
                  </FieldLabel>
                  <Input
                    id="edit-group-description"
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                  />
                </Field>
                <Button className="self-start" disabled={busy || !name.trim()}>
                  {t("commonSave")}
                </Button>
              </FieldGroup>
            </form>
          )}
          {group.access.capabilities.includes("transfer") && (
            <div className="flex max-w-2xl flex-col gap-3">
              <GroupSelector
                label={t("accessParent")}
                value={parent}
                onChange={setParent}
                ownerOnly
              />
              <Button
                className="self-start"
                disabled={busy || parent === group.parentId}
                variant="outline"
                onClick={() =>
                  setAction({
                    title: t("accessTransfer"),
                    description: group.name,
                    confirmLabel: t("commonSave"),
                    tone: "warning",
                    onConfirm: () =>
                      mutate(() =>
                        apiClient.saveGroup(id, { parentId: parent }),
                      ),
                  })
                }
              >
                {t("accessTransfer")}
              </Button>
              <Button
                className="self-start"
                variant="destructive"
                disabled={busy}
                onClick={() =>
                  setAction({
                    title: t("accessDeleteGroup"),
                    description: group.name,
                    confirmLabel: t("commonDelete"),
                    tone: "destructive",
                    onConfirm: () =>
                      mutate(async () => {
                        const result = await apiClient.deleteGroup(id);
                        if (isApiSuccess(result))
                          onOpenGroup(group.parentId ?? undefined);
                        return result;
                      }),
                  })
                }
              >
                {t("accessDeleteGroup")}
              </Button>
            </div>
          )}
          {group.access.capabilities.includes("read") && (
            <ResourceMembersPanel
              key={id}
              type="group"
              id={id}
              access={group.access}
            />
          )}
        </>
      )}
      <ConfirmActionDialog
        action={action}
        onOpenChange={(open) => {
          if (!open) setAction(null);
        }}
      />
    </div>
  );
}
