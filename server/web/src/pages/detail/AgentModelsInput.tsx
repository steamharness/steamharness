import { useEffect, useId, useState } from "react";
import { ArrowUpIcon, PencilIcon, PlusIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { useTranslation } from "@steamharness/i18n/react";
import { AGENT_MODEL_PROTOCOLS, parseAgentModelCatalog, parseAgentModels, type AgentModelCatalogEntry, type AgentModelProtocol, type ConfiguredAgentModel } from "@steamharness/project-configuration";
import { apiClient } from "../../api";
import { Alert, AlertDescription, Badge, Button, Empty, EmptyHeader, EmptyTitle, Field, FieldDescription, FieldGroup, FieldLabel, Input, SelectField, Skeleton, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

type ModelDraft = { id?: string; name: string; source: "system" | "third-party"; credentialId: string; model: string; apiKind: AgentModelProtocol; baseUrl: string; apiKey: string };
const blank = (source: ModelDraft["source"]): ModelDraft => ({ source, name: "", model: "", credentialId: "", apiKind: "openai-completions", baseUrl: "", apiKey: "" });

export function AgentModelsInput({ value, disabled, onChange, onDraftChange }: {
  value: string; disabled: boolean; onChange(value: string): void; onDraftChange(dirty: boolean): void;
}) {
  const { t } = useTranslation("serverWeb"), id = useId();
  const models = parseAgentModels(value ? JSON.parse(value) : []);
  const [source, setSource] = useState<ModelDraft["source"]>("system");
  const [draft, setDraft] = useState<ModelDraft>(), [draftDirty, setDraftDirty] = useState(false);
  const [catalog, setCatalog] = useState<AgentModelCatalogEntry[]>(), [catalogError, setCatalogError] = useState("");
  const [loading, setLoading] = useState(false), [retry, setRetry] = useState(0), [error, setError] = useState("");
  const systemOpen = !!draft && source === "system";
  useEffect(() => {
    if (!systemOpen) return;
    const controller = new AbortController(); setLoading(true); setCatalog(undefined); setCatalogError("");
    void apiClient.systemAiModelCatalog(controller.signal).then(result => {
      if (controller.signal.aborted) return;
      if (result.errCode !== 0) throw new Error(result.errCode === 404 ? t("configurationAiUnavailable") : result.errMessage);
      setCatalog(parseAgentModelCatalog(result.data));
    }).catch(error => { if (!controller.signal.aborted) setCatalogError((error as Error).message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [systemOpen, retry, t]);
  const guard = () => { if (draftDirty) { setError(t("configurationAiFinishDraft")); return false; } return true; };
  const open = (entry?: ConfiguredAgentModel, selectedSource = source) => {
    if (!guard()) return;
    const next = { ...blank(entry?.source ?? selectedSource), ...entry };
    setSource(next.source); setDraft(next); setDraftDirty(false); onDraftChange(false); setError("");
  };
  const edit = (patch: Partial<ModelDraft>) => { setDraft(draft => draft && { ...draft, ...patch }); setDraftDirty(true); onDraftChange(true); setError(""); };
  const change = (next: ConfiguredAgentModel[]) => { onChange(JSON.stringify(parseAgentModels(next))); setError(""); };
  const apply = () => {
    if (!draft) return;
    try {
      const common = { id: draft.id ?? crypto.randomUUID(), name: draft.name.trim() || draft.model.trim(), model: draft.model.trim() };
      const entry = draft.source === "system" ? { ...common, source: draft.source, credentialId: draft.credentialId } : { ...common, source: draft.source, apiKind: draft.apiKind, baseUrl: draft.baseUrl, apiKey: draft.apiKey };
      const index = models.findIndex(model => model.id === draft.id), next = [...models];
      if (index < 0) next.push(entry); else next[index] = entry;
      change(next); setDraft(undefined); setDraftDirty(false); onDraftChange(false);
    } catch { setError(t("configurationAiInvalid")); }
  };
  return <div className="flex flex-col gap-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <ToggleGroup type="single" variant="outline" size="sm" value={source} disabled={disabled} aria-label={t("configurationAiSource")}>
        <ToggleGroupItem value="system" onClick={() => open(undefined, "system")}>{t("configurationAiSystem")}</ToggleGroupItem>
        <ToggleGroupItem value="third-party" onClick={() => open(undefined, "third-party")}>{t("configurationAiThirdParty")}</ToggleGroupItem>
      </ToggleGroup>
      <Button variant="ghost" size="icon" disabled={disabled} title={t("configurationAiAdd")} aria-label={t("configurationAiAdd")} onClick={() => open()}><PlusIcon/></Button>
    </div>
    {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
    {draft && <FieldGroup className="grid gap-4 md:grid-cols-2">
      <Field><FieldLabel htmlFor={`${id}-name`}>{t("configurationAiName")}</FieldLabel><Input id={`${id}-name`} autoFocus disabled={disabled} value={draft.name} onChange={event => edit({name:event.target.value})}/></Field>
      {source === "system" ? <>
        <Field><FieldLabel htmlFor={`${id}-subscription`}>{t("configurationAiSubscription")}</FieldLabel><SelectField id={`${id}-subscription`} disabled={disabled || loading} value={draft.credentialId} onValueChange={value => { const credential = catalog?.find(entry => entry.id === value); edit({credentialId:value,model:credential?.models[0]?.id ?? ""}); }} options={[
          {value:"",label:t("configurationAiSelectSubscription")},...(catalog??[]).map(entry=>({value:entry.id,label:entry.name})),
          ...(draft.credentialId&&!catalog?.some(entry=>entry.id===draft.credentialId)?[{value:draft.credentialId,label:draft.credentialId}]:[]),
        ]}/></Field>
        <Field><FieldLabel htmlFor={`${id}-model`}>{t("configurationAiModelId")}</FieldLabel><SelectField id={`${id}-model`} disabled={disabled || loading || !draft.credentialId} value={draft.model} onValueChange={value => edit({model:value})} options={[
          {value:"",label:t("configurationAiSelectModel")},...(catalog?.find(entry=>entry.id===draft.credentialId)?.models??[]).map(model=>({value:model.id,label:model.name})),
          ...(draft.model&&!catalog?.find(entry=>entry.id===draft.credentialId)?.models.some(model=>model.id===draft.model)?[{value:draft.model,label:draft.model}]:[]),
        ]}/></Field>
        <div className="flex flex-wrap items-center gap-2 md:col-span-2">
          {loading ? <Skeleton className="h-8 w-full"/> : <>
            {catalogError && <Alert variant="destructive"><AlertDescription>{catalogError}</AlertDescription></Alert>}
            {catalog && !catalog.length && <FieldDescription>{t("configurationAiNoSubscription")} <a href="/settings/ai" target="_blank" rel="noopener noreferrer">{t("configurationAiManageSubscriptions")}</a></FieldDescription>}
            <Button variant="ghost" size="icon" disabled={disabled} title={t("configurationAiRefresh")} aria-label={t("configurationAiRefresh")} onClick={()=>setRetry(value=>value+1)}><RefreshCwIcon/></Button>
          </>}
        </div>
      </> : <>
        <Field><FieldLabel htmlFor={`${id}-protocol`}>{t("configurationAiProtocol")}</FieldLabel><SelectField id={`${id}-protocol`} disabled={disabled} value={draft.apiKind} onValueChange={value=>edit({apiKind:value as AgentModelProtocol})} options={AGENT_MODEL_PROTOCOLS.map(protocol=>({value:protocol,label:protocol}))}/></Field>
        <Field><FieldLabel htmlFor={`${id}-url`}>Base URL</FieldLabel><Input id={`${id}-url`} type="url" disabled={disabled} value={draft.baseUrl} onChange={event=>edit({baseUrl:event.target.value})}/></Field>
        <Field><FieldLabel htmlFor={`${id}-model`}>{t("configurationAiModelId")}</FieldLabel><Input id={`${id}-model`} disabled={disabled} value={draft.model} onChange={event=>edit({model:event.target.value})}/></Field>
        <Field className="md:col-span-2"><FieldLabel htmlFor={`${id}-key`}>API Key</FieldLabel><Input id={`${id}-key`} type="password" autoComplete="new-password" disabled={disabled} value={draft.apiKey} onChange={event=>edit({apiKey:event.target.value})}/></Field>
      </>}
      <div className="flex justify-end gap-2 md:col-span-2"><Button variant="outline" size="sm" disabled={disabled} onClick={()=>{setDraft(undefined);setDraftDirty(false);onDraftChange(false);setError("");}}>{t("cancel",{ns:"common"})}</Button><Button size="sm" disabled={disabled || source === "system" && (loading || !draft.credentialId || !draft.model)} onClick={apply}>{t("configurationAiApply")}</Button></div>
    </FieldGroup>}
    {!models.length ? <Empty><EmptyHeader><EmptyTitle>{t("configurationAiEmpty")}</EmptyTitle></EmptyHeader></Empty> : <Table aria-label={t("configurationAiModels")}>
      <TableHeader><TableRow><TableHead>{t("configurationAiName")}</TableHead><TableHead>{t("configurationAiSource")}</TableHead><TableHead className="text-right">{t("configurationActions")}</TableHead></TableRow></TableHeader>
      <TableBody>{models.map((model,index)=><TableRow key={model.id}>
        <TableCell className="whitespace-normal"><div className="flex flex-wrap items-center gap-2"><span>{model.name}</span>{index===0&&<Badge variant="secondary">{t("configurationAiDefault")}</Badge>}</div><FieldDescription className="wrap-anywhere">{model.model}</FieldDescription></TableCell>
        <TableCell>{t(model.source==="system"?"configurationAiSystem":"configurationAiThirdParty")}</TableCell>
        <TableCell><div className="flex justify-end gap-1">
          {index>0&&<Button variant="ghost" size="icon" disabled={disabled} title={t("configurationAiSetDefault")} aria-label={`${t("configurationAiSetDefault")}: ${model.name}`} onClick={()=>{if(guard())change([model,...models.filter(entry=>entry.id!==model.id)]);}}><ArrowUpIcon/></Button>}
          <Button variant="ghost" size="icon" disabled={disabled} title={t("configurationAiEdit")} aria-label={`${t("configurationAiEdit")}: ${model.name}`} onClick={()=>open(model)}><PencilIcon/></Button>
          <Button variant="ghost" size="icon" disabled={disabled} title={t("configurationAiDelete")} aria-label={`${t("configurationAiDelete")}: ${model.name}`} onClick={()=>{if(guard()){change(models.filter(entry=>entry.id!==model.id));if(draft?.id===model.id)setDraft(undefined);}}}><Trash2Icon/></Button>
        </div></TableCell>
      </TableRow>)}</TableBody>
    </Table>}
    <FieldDescription>{t("configurationAiDefaultHelp")}</FieldDescription>
  </div>;
}
