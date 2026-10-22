import { useId, useRef, useState } from "react";
import { ChevronRightIcon, EyeIcon, MoreHorizontalIcon, PlusIcon, RefreshCwIcon, SaveIcon, Trash2Icon } from "lucide-react";
import { useTranslation } from "@steamharness/i18n/react";
import { configurationSnapshot, createPublicationDraft, freezeConfigurationTemplate, configurationRule, type ConfigurationPublicationDraft, type ProjectConfigurationState, type ProjectConfigurationField } from "@steamharness/project-configuration";
import { Alert, AlertDescription, Button, Checkbox, Collapsible, CollapsibleContent, CollapsibleTrigger, Field, FieldDescription, FieldGroup, FieldLabel, FieldSet, FieldLegend, SelectField, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Textarea } from "@/components/ui";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";

const ruleKeys = ["publish", "includeValue", "editable"] as const;

export function ConfigurationPublicationEditor({ state, busy, onSave }: { state: ProjectConfigurationState; busy: boolean; onSave(draft: ConfigurationPublicationDraft): Promise<boolean | undefined> }) {
  const { t } = useTranslation("serverWeb");
  const id = useId();
  const [draft, setDraft] = useState(() => structuredClone(state.publication ?? createPublicationDraft(state)));
  const initial = useRef(draft), [error, setError] = useState(""), [preview, setPreview] = useState("");
  const update = (next: ConfigurationPublicationDraft) => { setDraft(next); setPreview(""); };
  const editField = (index: number, field: ProjectConfigurationField) => update({ ...draft, fields: draft.fields.map((old, i) => i === index ? field : old) });
  const available = [...state.configurations, ...draft.configurations.filter(profile => !state.configurations.some(c => c.id === profile.id))];

  function showPreview() {
    try {
      setError("");
      setPreview(JSON.stringify(freezeConfigurationTemplate(draft, { projectId: "preview", projectVersion: "preview", sourceHash: "0".repeat(64) }), null, 2));
    } catch (error) { setError((error as Error).message); }
  }

  return <FieldGroup className="gap-4">
    <FieldDescription>{t("configurationPublicationHelp")}</FieldDescription>
    {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
    {state.publication && state.publication.revision !== initial.current.revision && <Alert><AlertDescription>{t("configurationConflict")}</AlertDescription></Alert>}
    <FieldGroup className="gap-4 md:flex-row md:items-end">
      <FieldSet disabled={busy} className="min-w-0 flex-1 gap-3">
        <FieldLegend variant="label">{t("configurationPublishedProfiles")}</FieldLegend>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {available.map(profile => <Field key={profile.id} orientation="horizontal" className="w-auto">
            <Checkbox id={`${id}-profile-${profile.id}`} disabled={busy} checked={draft.configurations.some(c => c.id === profile.id)} onCheckedChange={checked => {
              const configurations = checked
                ? [...draft.configurations, { id: profile.id, name: profile.name, values: state.configurations.some(c => c.id === profile.id) ? configurationSnapshot(state, profile.id, false).values : profile.values }]
                : draft.configurations.filter(c => c.id !== profile.id);
              update({ ...draft, configurations, defaultConfigurationId: configurations.some(c => c.id === draft.defaultConfigurationId) ? draft.defaultConfigurationId : configurations[0]?.id ?? "" });
            }} />
            <FieldLabel htmlFor={`${id}-profile-${profile.id}`}>{profile.name}</FieldLabel>
          </Field>)}
        </div>
      </FieldSet>
      <Field className="md:w-64">
        <FieldLabel htmlFor={`${id}-default`}>{t("configurationPublishedDefault")}</FieldLabel>
        <SelectField id={`${id}-default`} disabled={busy || !draft.configurations.length} value={draft.defaultConfigurationId} options={draft.configurations.map(c => ({ value: c.id, label: c.name }))} onValueChange={defaultConfigurationId => update({ ...draft, defaultConfigurationId })} />
      </Field>
      <DropdownMenu>
        <DropdownMenuTrigger asChild><Button variant="outline" size="icon" disabled={busy} aria-label={t("configurationActions")} title={t("configurationActions")}><MoreHorizontalIcon /></Button></DropdownMenuTrigger>
        <DropdownMenuContent align="end"><DropdownMenuGroup>
          <DropdownMenuItem disabled={busy} onSelect={() => update({ ...draft, configurationRevision: state.revision, configurations: draft.configurations.map(profile => ({ ...profile, values: state.configurations.some(c => c.id === profile.id) ? configurationSnapshot(state, profile.id, false).values : profile.values })) })}>
            <RefreshCwIcon data-icon="inline-start" />{t("configurationRefreshPublishedValues")}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={busy} onSelect={() => update({ ...draft, fields: state.fields.map(field => ({ ...field, sharing: draft.fields.find(old => old.name === field.name)?.sharing ?? field.sharing, paths: draft.fields.find(old => old.name === field.name)?.paths ?? field.paths })) })}>
            <RefreshCwIcon data-icon="inline-start" />{t("configurationRefreshPublishedFields")}
          </DropdownMenuItem>
        </DropdownMenuGroup></DropdownMenuContent>
      </DropdownMenu>
    </FieldGroup>
    <Table aria-label={t("configurationPublication")} className="min-w-[36rem]">
      <TableHeader><TableRow>
        <TableHead scope="col">{t("configurationFields")}</TableHead>
        {ruleKeys.map(key => <TableHead key={key} scope="col" className="text-center">{t(`configurationRule_${key}`)}</TableHead>)}
      </TableRow></TableHeader>
      {draft.fields.map((field, index) => <Collapsible key={field.name} asChild><TableBody>
        <TableRow>
          <TableCell className="whitespace-normal">
            <div className="flex items-center gap-2">
              {field.type === "json" && <CollapsibleTrigger asChild><Button variant="ghost" size="icon-sm" className="group shrink-0" disabled={busy} aria-label={`${field.label || field.name}: ${t("configurationJsonPointer")}`} title={t("configurationJsonPointer")}><ChevronRightIcon className="transition-transform group-data-[state=open]:rotate-90" /></Button></CollapsibleTrigger>}
              <span id={`${id}-field-${index}`}>{field.label || field.name}</span>
            </div>
          </TableCell>
          {ruleKeys.map(key => <TableCell key={key}>
            <Field orientation="horizontal" className="justify-center">
              <Checkbox id={`${id}-${index}-${key}`} aria-describedby={`${id}-field-${index}`} disabled={busy} checked={configurationRule(field)[key]} onCheckedChange={checked => editField(index, { ...field, sharing: { ...field.sharing, [key]: !!checked } })} />
              <FieldLabel className="sr-only" htmlFor={`${id}-${index}-${key}`}>{t(`configurationRule_${key}`)}</FieldLabel>
            </Field>
          </TableCell>)}
        </TableRow>
        {field.type === "json" && <CollapsibleContent asChild><TableRow><TableCell colSpan={4} className="whitespace-normal"><JsonPathRules field={field} onChange={field => editField(index, field)} disabled={busy} /></TableCell></TableRow></CollapsibleContent>}
      </TableBody></Collapsible>)}
    </Table>
    <div className="flex flex-wrap items-center justify-end gap-2">
      <Button variant="outline" size="icon" disabled={busy} aria-label={t("configurationRecipientPreview")} title={t("configurationRecipientPreview")} onClick={showPreview}><EyeIcon /></Button>
      <Button disabled={busy} onClick={() => {
        try {
          freezeConfigurationTemplate(draft, { projectId: "preview", projectVersion: "preview", sourceHash: "0".repeat(64) });
          setError("");
          void onSave(draft).then(saved => { if (saved) { const next = { ...draft, revision: draft.revision + 1 }; initial.current = next; setDraft(next); } });
        } catch (error) { setError((error as Error).message); }
      }}><SaveIcon data-icon="inline-start" />{t("configurationSavePublication")}</Button>
    </div>
    {preview && <Field><FieldLabel htmlFor={`${id}-preview`}>{t("configurationRecipientPreview")}</FieldLabel><Textarea id={`${id}-preview`} rows={12} readOnly value={preview} /></Field>}
  </FieldGroup>;
}

function JsonPathRules({ field, onChange, disabled }: { field: ProjectConfigurationField; onChange(field: ProjectConfigurationField): void; disabled: boolean }) {
  const { t } = useTranslation("serverWeb"), [pointer, setPointer] = useState("");
  const id = useId();
  return <FieldGroup className="gap-3">
    {!!Object.keys(field.paths ?? {}).length && <Table aria-label={`${field.label || field.name}: ${t("configurationJsonPointer")}`}>
      <TableHeader><TableRow>
        <TableHead scope="col">{t("configurationJsonPointer")}</TableHead>
        {ruleKeys.map(key => <TableHead key={key} scope="col">{t(`configurationRule_${key}`)}</TableHead>)}
        <TableHead scope="col"><span className="sr-only">{t("configurationActions")}</span></TableHead>
      </TableRow></TableHeader>
      <TableBody>{Object.entries(field.paths ?? {}).map(([path, rule]) => <TableRow key={path}>
        <TableCell>{path}</TableCell>
        {ruleKeys.map(key => <TableCell key={key}><SelectField size="sm" disabled={disabled} aria-label={`${path}: ${t(`configurationRule_${key}`)}`} value={rule[key] === undefined ? "inherit" : String(rule[key])} options={[{ value: "inherit", label: t("configurationInherit") }, { value: "true", label: t("configurationYes") }, { value: "false", label: t("configurationNo") }]} onValueChange={value => {
          const next = { ...rule };
          if (value === "inherit") delete next[key]; else next[key] = value === "true";
          onChange({ ...field, paths: { ...field.paths, [path]: next } });
        }} /></TableCell>)}
        <TableCell><Button variant="ghost" size="icon-sm" disabled={disabled} aria-label={`${t("configurationDeletePath")}: ${path}`} title={t("configurationDeletePath")} onClick={() => { const paths = { ...field.paths }; delete paths[path]; onChange({ ...field, paths }); }}><Trash2Icon /></Button></TableCell>
      </TableRow>)}</TableBody>
    </Table>}
    <Field>
      <FieldLabel className="sr-only" htmlFor={id}>{t("configurationJsonPointer")}</FieldLabel>
      <InputGroup>
        <InputGroupInput id={id} disabled={disabled} value={pointer} placeholder="/connection/host" onChange={event => setPointer(event.target.value)} />
        <InputGroupAddon align="inline-end"><InputGroupButton size="icon-xs" disabled={disabled || !pointer.startsWith("/")} aria-label={t("configurationAddPath")} title={t("configurationAddPath")} onClick={() => { onChange({ ...field, paths: { ...field.paths, [pointer]: {} } }); setPointer(""); }}><PlusIcon /></InputGroupButton></InputGroupAddon>
      </InputGroup>
    </Field>
  </FieldGroup>;
}
