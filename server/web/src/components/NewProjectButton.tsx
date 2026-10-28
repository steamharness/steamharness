import { useState } from "react";
import { useTranslation } from "@steamharness/i18n/react";
import {
  STEAMHARNESS_PROJECT_TYPES,
  getProjectKindLabelKey,
} from "@steamharness/project-types";
import { translateDynamicKey } from "@steamharness/i18n/react";
import { createDefaultProjectInfo } from "@steamharness/project-info";
import { apiClient } from "../api";
import { isApiSuccess } from "../types";
import { GroupSelector } from "./GroupSelector";
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  FieldGroup,
  Field,
  FieldLabel,
  Input,
  SelectField,
} from "@/components/ui";

export function NewProjectButton({
  groupId = null,
  onCreated,
}: {
  groupId?: string | null;
  onCreated: (id: string) => void;
}) {
  const { t } = useTranslation("serverWeb");
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [group, setGroup] = useState<string | null>(groupId);
  const [kind, setKind] = useState("workflow");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <>
      <Button
        onClick={() => {
          setGroup(groupId);
          setError("");
          setOpen(true);
        }}
      >
        {t("accessCreateProject")}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!busy) setOpen(next);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("accessCreateProject")}</DialogTitle>
            <DialogDescription>{t("accessRoleHelp")}</DialogDescription>
          </DialogHeader>
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (busy) return;
              setBusy(true);
              void apiClient
                .createProject({
                  name: name.trim(),
                  entries:[{entryId:"main",name:name.trim(),type:kind,root:".",entry:kind==="kanban"?"index.html":"index.ts",databases:[]}],
                  defaultEntry:"main",
                  groupId: group,
                  projectInfo: createDefaultProjectInfo(),
                })
                .then((result) => {
                  setBusy(false);
                  if (isApiSuccess(result)) {
                    setOpen(false);
                    onCreated(result.data.projectId);
                  } else setError(result.errMessage);
                });
            }}
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="new-project-name">
                  {t("projectSettingsDefaultName")}
                </FieldLabel>
                <Input
                  id="new-project-name"
                  disabled={busy}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel>{t("projectListHeaderProject")}</FieldLabel>
                <SelectField
                  aria-label={t("projectListHeaderProject")}
                  disabled={busy}
                  value={kind}
                  onValueChange={setKind}
                  options={STEAMHARNESS_PROJECT_TYPES.map((value) => ({
                    value,
                    label: translateDynamicKey(getProjectKindLabelKey(value)),
                  }))}
                />
              </Field>
              <GroupSelector value={group} onChange={setGroup} />
              {error && (
                <p role="alert" className="text-destructive">
                  {error}
                </p>
              )}
              <Button disabled={busy || !name.trim()}>
                {t("accessCreateProject")}
              </Button>
            </FieldGroup>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
