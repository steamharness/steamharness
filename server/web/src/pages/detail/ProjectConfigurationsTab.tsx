import { useEffect, useRef, useState } from "react";
import { ArrowRightLeftIcon, CheckIcon, CopyIcon, DownloadIcon, FileIcon, ImportIcon, MoreHorizontalIcon, PencilIcon, PlusIcon, RotateCcwIcon, Trash2Icon, UploadIcon, XIcon } from "lucide-react";
import { useTranslation } from "@steamharness/i18n/react";
import { parseConfigurationField, parseConfigurationFile, validateConfigurationFileSelection, type ProjectConfigurationFile, type ConfigurationValues, type ProjectConfigurationAction, type ProjectConfigurationField, type ProjectConfigurationState, type ProjectConfigurationExport } from "@steamharness/project-configuration";
import { apiClient } from "../../api";
import { Alert, AlertDescription, Button, Checkbox, Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, Empty, EmptyHeader, EmptyTitle, Field, FieldDescription, FieldGroup, FieldLabel, FieldSet, FieldLegend, Input, SelectField, Separator, Skeleton, Textarea } from "@/components/ui";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { DetailPageProps } from "./types";
import { formatBytes } from "../../utils/format";

function fieldValueText(field:ProjectConfigurationField, value:unknown):string {
  return value===undefined?"":field.type==="json"||field.type==="file"||field.multiple?JSON.stringify(value,null,2):String(value);
}

export function ProjectConfigurationsTab({project}: Pick<DetailPageProps,"project">) {
  const {t} = useTranslation("serverWeb");
  const [state,setState] = useState<ProjectConfigurationState>(), [latest,setLatest] = useState<ProjectConfigurationState>();
  const [values,setValues] = useState<Record<string,string>>({}), [setKeys,setSetKeys] = useState<string[]>([]);
  const [dirty,setDirty] = useState(false), dirtyRef = useRef(false), [busy,setBusy] = useState(false), [error,setError] = useState("");
  const [modal,setModal] = useState<"create"|"duplicate"|"rename"|"delete">(), [name,setName] = useState("");
  const [field,setField] = useState<Partial<ProjectConfigurationField>>(), [originalKey,setOriginalKey] = useState(""), [defaultText,setDefaultText] = useState(""), [optionsText,setOptionsText] = useState("");
  const file = useRef<HTMLInputElement>(null);
  const [loading,setLoading] = useState(true), [retry,setRetry] = useState(0);
  const [uploading,setUploading] = useState("");
  const editingRef = useRef(false), busyRef = useRef(false), latestRef = useRef<ProjectConfigurationState>(undefined);
  const scopeRef = useRef<symbol|undefined>(undefined);
  const target = project.hasDraft ? "draft" : "latest";
  const accept = (next: ProjectConfigurationState, force = false) => {
    if (latestRef.current && next.revision < latestRef.current.revision) return;
    latestRef.current=next;setLatest(next);
    if ((dirtyRef.current || editingRef.current || busyRef.current) && !force) return;
    const current=next.configurations.find(item=>item.id===next.activeConfigurationId)!;
    setState(next); setValues(Object.fromEntries(next.fields.map(field=>{
      const value=Object.hasOwn(current.values,field.name)?current.values[field.name]:field.defaultValue;
      return [field.name,fieldValueText(field,value)];
    }))); setSetKeys(Object.keys(current.values)); dirtyRef.current=false; setDirty(false);
  };
  useEffect(()=>{
    scopeRef.current=Symbol();
    let closed=false, reading=false;
    dirtyRef.current=false;editingRef.current=false;latestRef.current=undefined;busyRef.current=false;setBusy(false);
    setState(undefined);setLatest(undefined);setDirty(false);setLoading(true);setError("");setModal(undefined);setField(undefined);setUploading("");
    const load=async()=>{
      if(reading)return; reading=true;
      try {
        const result=await apiClient.projectConfigurations(project.id,{action:"get"},target);
        if(closed)return;
        if(result.errCode!==0||!result.data)throw new Error(result.errMessage);
        accept(result.data as ProjectConfigurationState);
      }catch(e){if(!closed)setError((e as Error).message);}
      finally{reading=false;if(!closed)setLoading(false);}
    };
    void load(); const poll=setInterval(()=>void load(),2000);
    return()=>{closed=true;scopeRef.current=undefined;clearInterval(poll);};
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
        typed[f.name]=f.type==="json"||f.type==="file"||f.multiple?JSON.parse(text):f.type==="number"?(text.trim()?Number(text):NaN):f.type==="boolean"?text==="true":text;
      }
      void dispatch({action:"save",id:state.activeConfigurationId,values:typed,unset:state.fields.filter(f=>!setKeys.includes(f.name)).map(f=>f.name)});
    }catch(e){setError((e as Error).message);}
  }
  async function uploadFiles(field:ProjectConfigurationField, files:File[]) {
    if(!state||busyRef.current||!files.length)return;
    const scope=scopeRef.current;
    busyRef.current=true;setBusy(true);setUploading(field.name);setError("");
    try {
      if(files.length>(field.multiple?32:1))throw new Error(t("configurationFileCount",{count:field.multiple?32:1}));
      for(const file of files)validateConfigurationFileSelection(field,{name:file.name,mimeType:file.type||"application/octet-stream",size:file.size});
      const references:ProjectConfigurationFile[]=[];
      for(const file of files) {
        const result=await apiClient.uploadProjectConfigurationFile(project.id,file);
        if(scope!==scopeRef.current)return;
        if(result.errCode!==0)throw new Error(result.errMessage);
        if(!Array.isArray(result.data)||result.data.length!==1)throw new Error(t("configurationFileInvalid"));
        const reference=parseConfigurationFile(result.data[0]);
        if(reference.projectId!==project.id||reference.size!==file.size)throw new Error(t("configurationFileInvalid"));
        validateConfigurationFileSelection(field,reference);references.push(reference);
      }
      setValues(values=>({...values,[field.name]:JSON.stringify(field.multiple?references:references[0])}));
      setSetKeys(keys=>[...new Set([...keys,field.name])]);edit();
    }catch(e){if(scope===scopeRef.current){const message=(e as Error).message;setError(message==="This file type is not accepted by the configuration field."?t("configurationFileTypeError"):message==="Invalid file or file exceeds 50 MiB."?t("configurationFileSizeError"):message);}}
    finally{if(scope===scopeRef.current){busyRef.current=false;setBusy(false);setUploading("");}}
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
    <h2>{t("projectConfigurations")}</h2>
    {error&&<Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
    {!state?<>{loading?<Skeleton className="h-10 w-full"/>:<Button variant="outline" onClick={()=>setRetry(value=>value+1)}>{t("configurationRefresh")}</Button>}</>:<>
      {dirty&&latest?.revision!==state.revision&&<Alert><AlertDescription>{t("configurationConflict")}</AlertDescription></Alert>}
      <Field>
        <FieldLabel htmlFor="configuration-profile">{t("configurationCurrent")}</FieldLabel>
        <div className="flex items-center gap-2">
          <SelectField id="configuration-profile" disabled={busy} value={state.activeConfigurationId} options={state.configurations.map(c=>({value:c.id,label:c.name}))} onValueChange={id=>{if(clean())void dispatch({action:"select",id});}} className="min-w-0 flex-1"/>
          <Button variant="ghost" size="icon" disabled={busy} title={t("configurationAction_create")} aria-label={t("configurationAction_create")} onClick={()=>open("create")}><PlusIcon/></Button>
          <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" disabled={busy} title={t("configurationActions")} aria-label={t("configurationActions")}><MoreHorizontalIcon/></Button></DropdownMenuTrigger>
            <DropdownMenuContent align="end"><DropdownMenuGroup>
              <DropdownMenuLabel>{t("configurationActions")}</DropdownMenuLabel>
              <DropdownMenuItem onSelect={()=>void dispatch({action:"duplicate",id:state.activeConfigurationId})} disabled={busy||dirty}><CopyIcon/>{t("configurationAction_duplicate")}</DropdownMenuItem>
              <DropdownMenuItem onSelect={()=>open("rename")} disabled={busy}><PencilIcon/>{t("configurationAction_rename")}</DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onSelect={()=>open("delete")} disabled={busy||state.configurations.length===1}><Trash2Icon/>{t("configurationAction_delete")}</DropdownMenuItem>
            </DropdownMenuGroup></DropdownMenuContent>
          </DropdownMenu>
          <Separator orientation="vertical" className="h-6"/>
          <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" disabled={busy} title={t("configurationTransfer")} aria-label={t("configurationTransfer")}><ArrowRightLeftIcon/></Button></DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-w-72"><DropdownMenuGroup>
              <DropdownMenuLabel>{t("configurationTransfer")}</DropdownMenuLabel>
              <DropdownMenuItem onSelect={()=>{if(clean())file.current?.click();}}><ImportIcon/>{t("configurationImport")}</DropdownMenuItem>
              <DropdownMenuSeparator/>
              <DropdownMenuItem onSelect={()=>void download(false)}><DownloadIcon/>{t("configurationExportCurrent")}</DropdownMenuItem>
              <DropdownMenuItem onSelect={()=>void download(true)}><DownloadIcon/>{t("configurationExportAll")}</DropdownMenuItem>
            </DropdownMenuGroup><DropdownMenuSeparator/><FieldDescription className="px-2 py-1.5">{t("configurationExportNotice")}</FieldDescription></DropdownMenuContent>
          </DropdownMenu>
        </div>
        <input ref={file} type="file" accept=".json,application/json" hidden onChange={event=>{const scope=scopeRef.current;const input=event.currentTarget,selected=input.files?.[0];input.value="";if(!selected)return;void(async()=>{try{if(selected.size>1024*1024)throw new Error(t("configurationTooLarge"));const document=JSON.parse(await selected.text()) as ProjectConfigurationExport;if(scope===scopeRef.current&&clean())await dispatch({action:"import",document});}catch(e){if(scope===scopeRef.current)setError((e as Error).message);}})();}}/>
      </Field>
      <Separator/>
      <div className="flex items-center justify-between gap-2"><h3>{t("configurationFields")} <span className="text-muted-foreground">{state.fields.length}</span></h3><Button variant="outline" size="sm" disabled={busy} onClick={()=>startField()}><PlusIcon data-icon="inline-start"/>{t("configurationAddField")}</Button></div>
      {!state.fields.length?<Empty><EmptyHeader><EmptyTitle>{t("configurationEmpty")}</EmptyTitle></EmptyHeader></Empty>:<FieldGroup>
        {state.fields.map(f=>{
          const set=setKeys.includes(f.name),value=values[f.name]??"",custom=state.customFields.some(c=>c.name===f.name);
          const change=(value:string)=>{setValues(values=>({...values,[f.name]:value}));setSetKeys(keys=>[...new Set([...keys,f.name])]);edit();};
          const reset=()=>{setValues(values=>({...values,[f.name]:fieldValueText(f,f.defaultValue)}));setSetKeys(keys=>keys.filter(key=>key!==f.name));edit();};
          const resetLabel=t(f.defaultValue===undefined?"configurationClearValue":"configurationRestoreDefault",{name:f.label||f.name});
          return <Field key={f.name} data-disabled={busy}>
            <div className="flex items-center gap-2"><FieldLabel htmlFor={`configuration-${f.name}`} className="min-w-0 flex-1 wrap-anywhere">{f.label||f.name}{f.required?" *":""}</FieldLabel>
              {f.type!=="file"&&<Button variant="ghost" size="icon" disabled={busy||!set} title={resetLabel} aria-label={resetLabel} onClick={reset}><RotateCcwIcon/></Button>}
              {custom&&<div className="flex gap-1"><Button variant="ghost" size="icon" disabled={busy} title={t("configurationEditField")} aria-label={t("configurationEditField")} onClick={()=>startField(f)}><PencilIcon/></Button><Button variant="ghost" size="icon" disabled={busy} title={t("configurationDeleteField")} aria-label={t("configurationDeleteField")} onClick={()=>{if(clean())void dispatch({action:"field.delete",key:f.name});}}><Trash2Icon/></Button></div>}
            </div>
            {f.type==="file"?<ConfigurationFileInput field={f} value={value} busy={busy} uploading={uploading===f.name} overridden={set} onUpload={files=>void uploadFiles(f,files)} onClear={reset}/>
            :f.options&&f.multiple?<FieldSet disabled={busy}><FieldLegend variant="label">{f.label||f.name}</FieldLegend>{f.options.map(option=>{let selected:string[]=[];try{const parsed:unknown=JSON.parse(value||"[]");if(Array.isArray(parsed))selected=parsed.filter((item):item is string=>typeof item==="string");}catch{}return <Field key={option.value} orientation="horizontal"><Checkbox id={`configuration-${f.name}-${option.value}`} checked={selected.includes(option.value)} onCheckedChange={checked=>change(JSON.stringify(checked?[...selected,option.value]:selected.filter(v=>v!==option.value)))}/><FieldLabel htmlFor={`configuration-${f.name}-${option.value}`}>{option.label||option.value}</FieldLabel></Field>;})}</FieldSet>
            :f.options?<SelectField id={`configuration-${f.name}`} disabled={busy} value={value} options={f.options.map(o=>({value:o.value,label:o.label||o.value}))} onValueChange={change}/>
            :f.type==="json"||f.multiple?<Textarea id={`configuration-${f.name}`} disabled={busy} rows={4} value={value} onChange={event=>change(event.target.value)}/>
            :f.type==="boolean"?<Checkbox id={`configuration-${f.name}`} disabled={busy} checked={value==="true"} onCheckedChange={checked=>change(String(checked))}/>
            :<Input id={`configuration-${f.name}`} disabled={busy} type={f.type==="number"?"number":f.secret?"password":"text"} step="any" value={value} onChange={event=>change(event.target.value)}/>}
            <FieldDescription>{f.description||f.name}</FieldDescription>
          </Field>;
        })}
      </FieldGroup>}
      <Separator/>
      <div className="sticky bottom-0 flex flex-wrap items-center justify-between gap-3 bg-background py-3"><p role="status" className="text-sm text-muted-foreground">{dirty?t("configurationUnsaved"):""}</p><div className="ml-auto flex items-center gap-2"><Button variant="ghost" size="icon" disabled={busy} title={t("configurationDiscard")} aria-label={t("configurationDiscard")} onClick={()=>{if(latest){accept(latest,true);setError("");}}}><RotateCcwIcon/></Button><Button disabled={busy||!dirty} onClick={save}><CheckIcon data-icon="inline-start"/>{t("configurationSave")}</Button></div></div>
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
        <Field><FieldLabel htmlFor="configuration-type">{t("configurationType")}</FieldLabel><SelectField id="configuration-type" value={field.type} options={["string","number","boolean","json","file"].map(value=>({value,label:value}))} onValueChange={type=>setField({...field,type:type as ProjectConfigurationField["type"],accept:undefined,control:undefined})}/></Field>
        {(["label","description"] as const).map(key=><Field key={key}><FieldLabel htmlFor={`field-${key}`}>{t(key==="label"?"configurationLabel":"configurationDescription")}</FieldLabel><Input id={`field-${key}`} value={field[key]??""} onChange={e=>setField({...field,[key]:e.target.value})}/></Field>)}
        <Field><FieldLabel htmlFor="field-default">{t("configurationDefault")}</FieldLabel><Textarea id="field-default" value={defaultText} onChange={e=>setDefaultText(e.target.value)}/></Field>
        {field.type==="string"&&<Field><FieldLabel htmlFor="field-options">{t("configurationOptions")}</FieldLabel><Textarea id="field-options" value={optionsText} onChange={e=>setOptionsText(e.target.value)}/></Field>}
        {field.type==="file"&&<Field><FieldLabel htmlFor="field-accept">{t("configurationFileAccept")}</FieldLabel><Textarea id="field-accept" placeholder={'image/png\nimage/jpeg\n.json'} value={field.accept?.join("\n")??""} onChange={e=>setField({...field,accept:e.target.value.split("\n")})}/></Field>}
        <FieldSet><FieldLegend>{t("configurationProperties")}</FieldLegend>{(["secret","required","multiple"] as const).map(key=><Field key={key} orientation="horizontal"><Checkbox id={`field-${key}`} checked={!!field[key]} onCheckedChange={checked=>setField({...field,[key]:!!checked})}/><FieldLabel htmlFor={`field-${key}`}>{t(`configurationProperty_${key}`)}</FieldLabel></Field>)}</FieldSet>
      </FieldGroup></FieldSet>}
      <DialogFooter><Button disabled={busy} onClick={()=>{try{const parsed=parseConfigurationField({...field,...(defaultText.trim()?{defaultValue:JSON.parse(defaultText)}:{defaultValue:undefined}),options:field?.type==="string"&&optionsText.trim()?optionsText.split("\n").filter(Boolean).map(value=>({value})):undefined,accept:field?.type==="file"?field.accept?.map(value=>value.trim()).filter(Boolean):undefined});void dispatch({action:"field.save",field:parsed,key:originalKey||undefined});}catch(e){setError((e as Error).message);}}}>{t("configurationSave")}</Button></DialogFooter>
    </DialogContent></Dialog>
  </section>;
}

function ConfigurationFileInput({field,value,busy,uploading,overridden,onUpload,onClear}:{field:ProjectConfigurationField;value:string;busy:boolean;uploading:boolean;overridden:boolean;onUpload(files:File[]):void;onClear():void}) {
  const {t}=useTranslation("serverWeb"), input=useRef<HTMLInputElement>(null);
  let references:ProjectConfigurationFile[]=[];
  try {const parsed:unknown=value?JSON.parse(value):undefined;references=(parsed===undefined?[]:field.multiple&&Array.isArray(parsed)?parsed:[parsed]).map(parseConfigurationFile);}catch{}
  return <div className="flex flex-col gap-2">
    {references.length?references.map(file=><div key={file.id} className="flex min-w-0 items-center gap-2"><FileIcon aria-hidden="true"/><span className="min-w-0 flex-1 wrap-anywhere">{file.name}</span><FieldDescription>{formatBytes(file.size)}</FieldDescription></div>):<FieldDescription>{t("configurationFileEmpty")}</FieldDescription>}
    <div className="flex items-center gap-2"><Button id={`configuration-${field.name}`} variant="outline" size="sm" disabled={busy} onClick={()=>input.current?.click()}><UploadIcon data-icon="inline-start"/>{t(uploading?"configurationFileUploading":references.length?"configurationFileReplace":"configurationFileChoose")}</Button><Button variant="ghost" size="icon" title={t("configurationFileClear")} aria-label={t("configurationFileClear")} disabled={busy||!overridden} onClick={onClear}><XIcon/></Button></div>
    <input ref={input} type="file" hidden accept={field.accept?.join(",")} multiple={!!field.multiple} disabled={busy} aria-label={t("configurationFileFor",{name:field.label||field.name})} onChange={event=>{const files=Array.from(event.currentTarget.files??[]);event.currentTarget.value="";onUpload(files);}}/>
    <FieldDescription role={uploading?"status":undefined}>{t("configurationFileStorage")}</FieldDescription>
  </div>;
}
