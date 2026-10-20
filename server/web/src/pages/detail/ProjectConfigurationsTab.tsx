import { useEffect, useRef, useState } from "react";
import { useTranslation } from "@steamharness/i18n/react";
import { parseConfigurationField, type ConfigurationValues, type ProjectConfigurationAction, type ProjectConfigurationField, type ProjectConfigurationState, type ProjectConfigurationExport } from "@steamharness/project-configuration";
import { apiClient } from "../../api";
import { Alert, AlertDescription, Button, Checkbox, Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, Empty, EmptyHeader, EmptyTitle, Field, FieldDescription, FieldGroup, FieldLabel, FieldSet, FieldLegend, Input, SelectField, Skeleton, Textarea } from "@/components/ui";
import type { DetailPageProps } from "./types";

export function ProjectConfigurationsTab({project}: Pick<DetailPageProps,"project">) {
  const {t} = useTranslation("serverWeb");
  const [state,setState] = useState<ProjectConfigurationState>(), [latest,setLatest] = useState<ProjectConfigurationState>();
  const [values,setValues] = useState<Record<string,string>>({}), [setKeys,setSetKeys] = useState<string[]>([]);
  const [dirty,setDirty] = useState(false), dirtyRef = useRef(false), [busy,setBusy] = useState(false), [error,setError] = useState("");
  const [modal,setModal] = useState<"create"|"duplicate"|"rename"|"delete">(), [name,setName] = useState("");
  const [field,setField] = useState<Partial<ProjectConfigurationField>>(), [originalKey,setOriginalKey] = useState(""), [defaultText,setDefaultText] = useState(""), [optionsText,setOptionsText] = useState("");
  const file = useRef<HTMLInputElement>(null);
  const [loading,setLoading] = useState(true), [retry,setRetry] = useState(0);
  const editingRef = useRef(false), busyRef = useRef(false), latestRef = useRef<ProjectConfigurationState>(undefined);
  const scopeRef = useRef("");
  const target = project.hasDraft ? "draft" : "latest";
  const accept = (next: ProjectConfigurationState, force = false) => {
    if (latestRef.current && next.revision < latestRef.current.revision) return;
    latestRef.current=next;setLatest(next);
    if ((dirtyRef.current || editingRef.current) && !force) return;
    const current=next.configurations.find(item=>item.id===next.activeConfigurationId)!;
    setState(next); setValues(Object.fromEntries(next.fields.map(field=>{
      const value=Object.hasOwn(current.values,field.name)?current.values[field.name]:field.defaultValue;
      return [field.name,value===undefined?"":field.type==="json"||field.multiple?JSON.stringify(value,null,2):String(value)];
    }))); setSetKeys(Object.keys(current.values)); dirtyRef.current=false; setDirty(false);
  };
  useEffect(()=>{
    const scope=`${project.id}:${target}`;
    scopeRef.current=scope;
    let closed=false, reading=false;
    dirtyRef.current=false;editingRef.current=false;latestRef.current=undefined;busyRef.current=false;setBusy(false);
    setState(undefined);setLatest(undefined);setDirty(false);setLoading(true);setError("");setModal(undefined);setField(undefined);
    const load=async()=>{
      if(reading)return; reading=true;
      try {
        const result=await apiClient.projectConfigurations(project.id,{action:"get"},target);
        if(closed)return;
        if(result.errCode!==0||!result.data)throw new Error(result.errMessage);
        accept(result.data as ProjectConfigurationState);
        if(!dirtyRef.current&&!editingRef.current)setError("");
      }catch(e){if(!closed)setError((e as Error).message);}
      finally{reading=false;if(!closed)setLoading(false);}
    };
    void load(); const poll=setInterval(()=>void load(),2000);
    return()=>{closed=true;scopeRef.current="";clearInterval(poll);};
  },[project.id,target,retry]);
  const edit=()=>{dirtyRef.current=true;setDirty(true);};
  const clean=()=>{if(dirtyRef.current){setError(t("configurationDraftFirst"));return false;}return true;};
  async function dispatch(call:ProjectConfigurationAction) {
    if(!state||busyRef.current)return;
    const scope=scopeRef.current;
    busyRef.current=true;setBusy(true);setError("");
    try {
      const result=await apiClient.projectConfigurations(project.id,{...call,revision:state.revision},target);
      if(scope!==scopeRef.current)return;
      if(result.errCode!==0||!result.data)throw new Error(result.errMessage);
      editingRef.current=false;accept(result.data as ProjectConfigurationState,true);setModal(undefined);setField(undefined);
    } catch(e) {if(scope===scopeRef.current)setError((e as Error).message);} finally {if(scope===scopeRef.current){busyRef.current=false;setBusy(false);}}
  }
  function save() {
    if(!state)return;
    try {
      const typed: ConfigurationValues = {};
      for(const f of state.fields) if(setKeys.includes(f.name)) {
        const text=values[f.name]??"";
        typed[f.name]=f.type==="json"||f.multiple?JSON.parse(text):f.type==="number"?(text.trim()?Number(text):NaN):f.type==="boolean"?text==="true":text;
      }
      void dispatch({action:"save",id:state.activeConfigurationId,values:typed,unset:state.fields.filter(f=>!setKeys.includes(f.name)).map(f=>f.name)});
    }catch(e){setError((e as Error).message);}
  }
  async function download(all:boolean) {
    if(!state||busyRef.current||!clean())return;
    const scope=scopeRef.current;
    busyRef.current=true;setBusy(true);setError("");
    try {
      const result=await apiClient.projectConfigurations(project.id,{action:"export",id:all?undefined:state.activeConfigurationId},target);
      if(scope!==scopeRef.current)return;
      if(result.errCode!==0)throw new Error(result.errMessage);
      const url=URL.createObjectURL(new Blob([JSON.stringify(result.data,null,2)],{type:"application/json"}));
      const link=document.createElement("a");link.href=url;link.download="project-configurations.json";link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    }catch(e){if(scope===scopeRef.current)setError((e as Error).message);}finally{if(scope===scopeRef.current){busyRef.current=false;setBusy(false);}}
  }
  const startField=(value?:ProjectConfigurationField)=>{if(!clean())return;editingRef.current=true;setError("");setOriginalKey(value?.name??"");setField(value??{name:"",type:"string"});setDefaultText(value?.defaultValue===undefined?"":JSON.stringify(value.defaultValue));setOptionsText(value?.options?.map(o=>o.value).join("\n")??"");};
  const open=(action:"create"|"duplicate"|"rename"|"delete")=>{if(!clean())return;editingRef.current=true;setError("");setName(action==="rename"?state!.configurations.find(c=>c.id===state!.activeConfigurationId)!.name:"");setModal(action);};
  return <section className="flex flex-col gap-6 p-6">
    <div><h2>{t("projectConfigurations")}</h2><p className="text-sm text-muted-foreground">{t("configurationExportNotice")}</p></div>
    {error&&<Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
    {!state?<>{loading?<Skeleton className="h-10 w-full"/>:<Button variant="outline" onClick={()=>setRetry(value=>value+1)}>{t("configurationRefresh")}</Button>}</>:<>
      {dirty&&latest?.revision!==state.revision&&<Alert><AlertDescription>{t("configurationConflict")}</AlertDescription></Alert>}
      <div className="flex flex-wrap items-center gap-2">
        <SelectField aria-label={t("configurationCurrent")} disabled={busy} value={state.activeConfigurationId} options={state.configurations.map(c=>({value:c.id,label:c.name}))} onValueChange={id=>{if(clean())void dispatch({action:"select",id});}} className="w-auto"/>
        {(["create","duplicate","rename","delete"] as const).map(action=><Button key={action} variant="outline" disabled={busy||action==="delete"&&state.configurations.length===1} onClick={()=>open(action)}>{t(`configurationAction_${action}`)}</Button>)}
        <Button variant="outline" disabled={busy} onClick={()=>startField()}>{t("configurationAddField")}</Button>
        <Button variant="outline" disabled={busy} onClick={()=>void download(false)}>{t("configurationExportCurrent")}</Button><Button variant="outline" disabled={busy} onClick={()=>void download(true)}>{t("configurationExportAll")}</Button>
        <Button variant="outline" disabled={busy} onClick={()=>{if(clean())file.current?.click();}}>{t("configurationImport")}</Button>
        <input ref={file} type="file" accept=".json,application/json" hidden onChange={event=>{const scope=scopeRef.current;const input=event.currentTarget,selected=input.files?.[0];input.value="";if(!selected)return;void(async()=>{try{if(selected.size>1024*1024)throw new Error(t("configurationTooLarge"));const document=JSON.parse(await selected.text()) as ProjectConfigurationExport;if(scope===scopeRef.current&&clean())await dispatch({action:"import",document});}catch(e){if(scope===scopeRef.current)setError((e as Error).message);}})();}}/>
      </div>
      {!state.fields.length?<Empty><EmptyHeader><EmptyTitle>{t("configurationEmpty")}</EmptyTitle></EmptyHeader></Empty>:<FieldGroup>
        {state.fields.map(f=>{
          const set=setKeys.includes(f.name),value=values[f.name]??"",custom=state.customFields.some(c=>c.name===f.name);
          const change=(value:string)=>{setValues(values=>({...values,[f.name]:value}));edit();};
          return <Field key={f.name} data-disabled={busy}>
            <div className="flex items-center gap-2"><Checkbox aria-label={`${t("configurationSetValue")}: ${f.label||f.name}`} checked={set} disabled={busy} onCheckedChange={checked=>{setSetKeys(keys=>checked?[...keys,f.name]:keys.filter(k=>k!==f.name));edit();}}/><FieldLabel htmlFor={`configuration-${f.name}`}>{f.label||f.name}{f.required?" *":""}</FieldLabel></div>
            {f.options&&f.multiple?<FieldSet disabled={busy||!set}><FieldLegend variant="label">{f.label||f.name}</FieldLegend>{f.options.map(option=>{let selected:string[]=[];try{selected=JSON.parse(value||"[]");}catch{}return <Field key={option.value} orientation="horizontal"><Checkbox id={`configuration-${f.name}-${option.value}`} checked={selected.includes(option.value)} onCheckedChange={checked=>change(JSON.stringify(checked?[...selected,option.value]:selected.filter(v=>v!==option.value)))}/><FieldLabel htmlFor={`configuration-${f.name}-${option.value}`}>{option.label||option.value}</FieldLabel></Field>;})}</FieldSet>
            :f.options?<SelectField id={`configuration-${f.name}`} disabled={busy||!set} value={value} options={f.options.map(o=>({value:o.value,label:o.label||o.value}))} onValueChange={change}/>
            :f.type==="json"||f.multiple?<Textarea id={`configuration-${f.name}`} disabled={busy||!set} rows={4} value={value} onChange={event=>change(event.target.value)}/>
            :f.type==="boolean"?<Checkbox id={`configuration-${f.name}`} disabled={busy||!set} checked={value==="true"} onCheckedChange={checked=>change(String(checked))}/>
            :<Input id={`configuration-${f.name}`} disabled={busy||!set} type={f.type==="number"?"number":f.secret?"password":"text"} step="any" value={value} onChange={event=>change(event.target.value)}/>}
            <FieldDescription>{f.description||f.name}</FieldDescription>
            {custom&&<div className="flex gap-2"><Button variant="ghost" disabled={busy} onClick={()=>startField(f)}>{t("configurationEditField")}</Button><Button variant="ghost" disabled={busy} onClick={()=>{if(clean())void dispatch({action:"field.delete",key:f.name});}}>{t("configurationDeleteField")}</Button></div>}
          </Field>;
        })}
      </FieldGroup>}
      <div className="flex gap-2"><Button disabled={busy||!dirty} onClick={save}>{t("configurationSave")}</Button><Button variant="outline" disabled={busy} onClick={()=>{if(latest){accept(latest,true);setError("");}}}>{t("configurationDiscard")}</Button></div>
    </>}
    <Dialog open={!!modal} onOpenChange={open=>{if(!open&&!busy){editingRef.current=false;setModal(undefined);if(latest)accept(latest);}}}><DialogContent><DialogHeader><DialogTitle>{modal?t(`configurationAction_${modal}`):""}</DialogTitle></DialogHeader>
      {error&&<Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      {(modal==="create"||modal==="rename")&&<FieldGroup><Field><FieldLabel htmlFor="configuration-name">{t("configurationName")}</FieldLabel><Input id="configuration-name" disabled={busy} value={name} onChange={e=>setName(e.target.value)}/></Field></FieldGroup>}
      <DialogFooter><Button disabled={busy} onClick={()=>void dispatch({action:modal!,id:state?.activeConfigurationId,...(modal==="create"||modal==="rename"?{name}:{})})}>{t("configurationConfirm")}</Button></DialogFooter>
    </DialogContent></Dialog>
    <Dialog open={!!field} onOpenChange={open=>{if(!open&&!busy){editingRef.current=false;setField(undefined);if(latest)accept(latest);}}}><DialogContent className="max-h-[90dvh] overflow-y-auto"><DialogHeader><DialogTitle>{t("configurationEditField")}</DialogTitle></DialogHeader>
      {error&&<Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      {field&&<FieldSet disabled={busy}><FieldGroup>
        <Field><FieldLabel htmlFor="configuration-key">{t("configurationKey")}</FieldLabel><Input id="configuration-key" value={field.name??""} onChange={e=>setField({...field,name:e.target.value})}/></Field>
        <Field><FieldLabel htmlFor="configuration-type">{t("configurationType")}</FieldLabel><SelectField id="configuration-type" value={field.type} options={["string","number","boolean","json"].map(value=>({value,label:value}))} onValueChange={type=>setField({...field,type:type as ProjectConfigurationField["type"]})}/></Field>
        {(["label","description"] as const).map(key=><Field key={key}><FieldLabel htmlFor={`field-${key}`}>{t(key==="label"?"configurationLabel":"configurationDescription")}</FieldLabel><Input id={`field-${key}`} value={field[key]??""} onChange={e=>setField({...field,[key]:e.target.value})}/></Field>)}
        <Field><FieldLabel htmlFor="field-default">{t("configurationDefault")}</FieldLabel><Textarea id="field-default" value={defaultText} onChange={e=>setDefaultText(e.target.value)}/></Field>
        <Field><FieldLabel htmlFor="field-options">{t("configurationOptions")}</FieldLabel><Textarea id="field-options" value={optionsText} onChange={e=>setOptionsText(e.target.value)}/></Field>
        <FieldSet><FieldLegend>{t("configurationProperties")}</FieldLegend>{(["secret","required","multiple"] as const).map(key=><Field key={key} orientation="horizontal"><Checkbox id={`field-${key}`} checked={!!field[key]} onCheckedChange={checked=>setField({...field,[key]:!!checked})}/><FieldLabel htmlFor={`field-${key}`}>{t(`configurationProperty_${key}`)}</FieldLabel></Field>)}</FieldSet>
      </FieldGroup></FieldSet>}
      <DialogFooter><Button disabled={busy} onClick={()=>{try{const parsed=parseConfigurationField({...field,...(defaultText.trim()?{defaultValue:JSON.parse(defaultText)}:{defaultValue:undefined}),options:optionsText.trim()?optionsText.split("\n").filter(Boolean).map(value=>({value})):undefined});void dispatch({action:"field.save",field:parsed,key:originalKey||undefined});}catch(e){setError((e as Error).message);}}}>{t("configurationSave")}</Button></DialogFooter>
    </DialogContent></Dialog>
  </section>;
}
