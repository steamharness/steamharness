import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from '@steamharness/i18n/react';
import type { DatabasePermissions } from '@steamharness/database-spaces';
import { normalizeDatabasePermissions } from '@steamharness/database-spaces';
import { apiClient } from '../api';
import { isApiSuccess, type Summary } from '../types';
import { Alert, AlertDescription, Badge, Button, Card, CardHeader, CardTitle, CardDescription, CardContent, Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, Empty, EmptyHeader, EmptyTitle, Field, FieldLabel, FieldGroup, FieldSet, FieldLegend, Input, SelectField, Skeleton, TablePanel, TableHeader, TableHead, TableRow, TableBody, TableCell, Textarea } from '@/components/ui';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { KnowledgeTableWorkspace } from './detail/KnowledgeTableWorkspace';
import { createServerKnowledgeRepository } from './detail/knowledge-repository';
import { ConfirmActionDialog, type ConfirmAction } from '@/components/ConfirmActionDialog';
const all={mode:'all' as const};
const full:DatabasePermissions={kv:{read:all,write:all},knowledge:{read:all,write:all}};
type Collection='spaces'|'requests'|'grants';
function PermissionsEditor({value,onChange,disabled}:{value:DatabasePermissions;onChange:(value:DatabasePermissions)=>void;disabled?:boolean}){
  const {t}=useTranslation('serverWeb');
  return <FieldGroup>{(['kv','knowledge'] as const).map(resource=><FieldSet key={resource}><FieldLegend>{resource==='kv'?'KV':t('detailNavKnowledge')}</FieldLegend>{(['read','write'] as const).map(operation=>{const rule=value[resource][operation];return <Field key={operation}><FieldLabel>{t(operation==='read'?'databaseRead':'databaseWrite')}</FieldLabel><SelectField value={rule.mode} disabled={disabled} options={['none','all','prefixes'].map(mode=>({value:mode,label:t(`databaseRule${mode}` as any)}))} onValueChange={mode=>onChange({...value,[resource]:{...value[resource],[operation]:mode==='prefixes'?{mode,prefixes:['']}:{mode}}})}/>{rule.mode==='prefixes'&&<Input aria-label={t('databasePrefixes')} value={rule.prefixes.join(', ')} disabled={disabled} onChange={event=>onChange({...value,[resource]:{...value[resource],[operation]:{mode:'prefixes',prefixes:event.target.value.split(',').map(item=>item.trim())}}})}/>}</Field>;})}</FieldSet>)}</FieldGroup>;
}
export function DatabaseSpacesPage({project,spaceId,onOpenSpace,onBack,onDirtyChange}:{project?:Summary;spaceId?:string;onOpenSpace?:(id:string)=>void;onBack?:()=>void;onDirtyChange?:(dirty:boolean)=>void}){
  const {t}=useTranslation('serverWeb');
  const [section,setSection]=useState<Collection>('spaces'),[page,setPage]=useState(1),[query,setQuery]=useState(''),[search,setSearch]=useState('');
  const [result,setResult]=useState<{items:any[];total:number;pageSize:number}>(),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[revision,setRevision]=useState(0);
  const [selected,setSelected]=useState(spaceId),[entryId,setEntryId]=useState(project?.defaultEntry??''),[bindings,setBindings]=useState<any[]>();
  const [consumer,setConsumer]=useState(project),[consumerId,setConsumerId]=useState(project?.id??''),[requestAlias,setRequestAlias]=useState('data');
  const [requestOpen,setRequestOpen]=useState(false),[kind,setKind]=useState<'create'|'access'>('create'),[target,setTarget]=useState('');
  const [requestPermissions,setRequestPermissions]=useState<DatabasePermissions>(full);
  const [review,setReview]=useState<any>(),[permissions,setPermissions]=useState<DatabasePermissions>(full),[reason,setReason]=useState(''),[action,setAction]=useState<ConfirmAction|null>(null);
  const epoch=useRef(0), busyRef=useRef(false), consumerEpoch=useRef(0), dataDirty=useRef(false);
  useEffect(()=>{setSelected(spaceId);},[spaceId]);
  useEffect(()=>{setEntryId(project?.defaultEntry??'');setConsumer(project);setConsumerId(project?.id??'');setRequestAlias('data');},[project?.id]);
  const updateDirty=useCallback((dirty:boolean)=>{dataDirty.current=dirty;onDirtyChange?.(dirty);},[onDirtyChange]);
  const leaveData=()=>{
    const leave=()=>{setSelected(undefined);onBack?.();setAction(null);};
    if(dataDirty.current)setAction({title:t('databaseDiscardDraft'),description:t('databaseDiscardDescription'),confirmLabel:t('commonConfirm'),tone:'warning',onConfirm:leave});else leave();
  };
  useEffect(()=>{const timer=setTimeout(()=>{setSearch(query);setPage(1);},250);return()=>clearTimeout(timer);},[query]);
  useEffect(()=>{const id=++epoch.current;setLoading(true);setError('');void apiClient.databasePage(section,page,search,project?.id).then(response=>{if(id!==epoch.current)return;if(isApiSuccess(response))setResult(response.data);else setError(response.errMessage);setLoading(false);});return()=>{epoch.current++;};},[section,page,search,revision,project?.id]);
  useEffect(()=>{let live=true;setBindings(undefined);if(project&&entryId)void apiClient.entryDatabaseBindings(project.id,entryId).then(response=>{if(!live)return;if(isApiSuccess(response))setBindings(response.data);else setError(response.errMessage);});return()=>{live=false;};},[project?.id,entryId,revision]);
  const send=async(path:string,body:unknown)=>{if(busyRef.current)return false;busyRef.current=true;setBusy(true);setError('');try{const response=await apiClient.databaseAction(path,body);if(!isApiSuccess(response))throw new Error(response.errMessage);setRevision(value=>value+1);return true;}catch(error){setError(String(error instanceof Error?error.message:error));return false;}finally{busyRef.current=false;setBusy(false);}};
  const open=(id:string)=>{setSelected(id);onOpenSpace?.(id);};
  if(selected)return <div className="flex min-h-0 flex-1 flex-col"><div className="p-4"><Button variant="outline" disabled={busy} onClick={leaveData}>{t('databaseBack')}</Button></div><SpaceData key={selected} spaceId={selected} onDirtyChange={updateDirty}/><ConfirmActionDialog action={action} onOpenChange={open=>{if(!open)setAction(null);}}/></div>;
  const requested=consumer?.entries.find(item=>item.entryId===entryId);
  return <div className="flex flex-col gap-4 p-6">
    <div className="flex flex-wrap items-center justify-between gap-3"><h1>{t('databaseSpaces')}</h1><Button disabled={busy} onClick={()=>{setConsumer(project);setConsumerId(project?.id??'');setRequestOpen(true);}}>{t('databaseRequest')}</Button><Button variant="outline" disabled={loading||busy} onClick={()=>setRevision(value=>value+1)}>{t('commonRefresh')}</Button></div>
    {error&&<Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
    {project&&<Card><CardHeader><CardTitle>{t('databaseRequirements')}</CardTitle><CardDescription>{t('databaseBindingDescription')}</CardDescription></CardHeader><CardContent className="flex flex-col gap-4"><SelectField aria-label={t('aggregateEntries')} value={entryId} options={project.entries.map(item=>({value:item.entryId,label:item.name}))} onValueChange={setEntryId}/>{!bindings?<Skeleton className="h-12"/>:bindings.map(requirement=><div key={requirement.alias} className="flex flex-wrap items-center gap-3"><strong>{requirement.alias}</strong><Badge variant="outline">{t(`databaseStatus${requirement.status}` as any)}</Badge><code>{requirement.databaseId}</code><span>{requirement.space?.name??requirement.error}</span><Button variant="outline" disabled={busy} onClick={()=>{setRequestAlias(requirement.alias);setKind('access');setTarget(requirement.databaseId);setRequestPermissions(full);setConsumer(project);setConsumerId(project.id);setRequestOpen(true);}}>{t('databaseRequest')}</Button></div>)}</CardContent></Card>}
    <Tabs value={section} onValueChange={value=>{setSection(value as Collection);setPage(1);}}><TabsList>{(['spaces','requests','grants'] as const).map(value=><TabsTrigger key={value} value={value}>{t(`databaseCollection${value}` as any)}</TabsTrigger>)}</TabsList></Tabs>
    <Input aria-label={t('databaseSearch')} placeholder={t('databaseSearch')} value={query} onChange={event=>setQuery(event.target.value)}/>
    {loading&&!result?<Skeleton className="h-40"/>:!result?.items.length?<Empty><EmptyHeader><EmptyTitle>{t('databaseEmpty')}</EmptyTitle></EmptyHeader></Empty>:<TablePanel><TableHeader><TableRow><TableHead>{t('databaseResource')}</TableHead><TableHead>{t('databaseConsumer')}</TableHead><TableHead>{t('databaseStatus')}</TableHead><TableHead>{t('databaseActions')}</TableHead></TableRow></TableHeader><TableBody>{result.items.map(item=><TableRow key={item.requestId??item.grantId??item.spaceId}><TableCell><p>{item.name??item.target?.name??item.spaceId??item.target?.spaceId}</p><code>{item.databaseId??item.spaceId??item.requestId}</code></TableCell><TableCell>{item.projectId&&<p>{item.projectId} / {item.entryId} / {item.alias}</p>}{item.ownerId}</TableCell><TableCell><Badge variant="outline">{t(`databaseStatus${item.status??(item.revokedAt?'revoked':'active')}` as any)}</Badge>{item.reason&&<p>{item.reason}</p>}</TableCell><TableCell><div className="flex flex-wrap gap-2">
      {section==='spaces'&&item.canManage&&<Button variant="outline" onClick={()=>open(item.spaceId)}>{t('databaseManageData')}</Button>}
      {section==='requests'&&item.status==='pending'&&item.canReview&&<Button disabled={busy} onClick={()=>{setReview(item);setPermissions(item.permissions);setReason('');}}>{t('databaseReview')}</Button>}
      {section==='grants'&&!item.revokedAt&&item.canManage&&<><Button disabled={busy} variant="outline" onClick={()=>{setReview({...item,narrow:true});setPermissions(item.permissions);}}>{t('databaseNarrow')}</Button>{(['revoke','rotate'] as const).map(action=><Button key={action} variant="outline" disabled={busy} onClick={()=>setAction({title:t(action==='revoke'?'databaseRevoke':'databaseRotate'),description:t(action==='revoke'?'databaseRevokeDescription':'databaseRotateDescription'),confirmLabel:t('commonSave'),tone:'warning',onConfirm:async()=>{await send(`/grants/${item.grantId}/${action}`,{});}})}>{t(action==='revoke'?'databaseRevoke':'databaseRotate')}</Button>)}</>}
    </div></TableCell></TableRow>)}</TableBody></TablePanel>}
    <div className="flex items-center gap-3"><Button variant="outline" disabled={page<=1||loading} onClick={()=>setPage(page-1)}>{t('databasePrevious')}</Button><span>{page} / {Math.max(1,Math.ceil((result?.total??0)/(result?.pageSize??20)))}</span><Button variant="outline" disabled={loading||page*(result?.pageSize??20)>=(result?.total??0)} onClick={()=>setPage(page+1)}>{t('databaseNext')}</Button></div>
    <Dialog open={requestOpen} onOpenChange={open=>{if(!busy)setRequestOpen(open);}}><DialogContent><DialogHeader><DialogTitle>{t('databaseRequest')}</DialogTitle></DialogHeader><FieldGroup>
      {!project&&<Field><FieldLabel>{t('databaseProjectId')}</FieldLabel><Input value={consumerId} disabled={busy} onChange={event=>{setConsumerId(event.target.value);setConsumer(undefined);setRequestAlias('data');}}/><Button disabled={busy} variant="outline" onClick={()=>{if(busyRef.current)return;busyRef.current=true;setBusy(true);setError('');const epoch=++consumerEpoch.current;void apiClient.getProject(consumerId).then(response=>{if(epoch!==consumerEpoch.current)return;if(isApiSuccess(response)){setConsumer(response.data);setEntryId(response.data.defaultEntry);setRequestAlias('data');}else setError(response.errMessage);}).catch(error=>{if(epoch===consumerEpoch.current)setError(String(error));}).finally(()=>{if(epoch===consumerEpoch.current){busyRef.current=false;setBusy(false);}});}}>{t('databaseLoadRequirements')}</Button></Field>}
      {consumer&&<><Field><FieldLabel>{t('aggregateEntries')}</FieldLabel><SelectField value={entryId} onValueChange={setEntryId} options={consumer.entries.map(item=>({value:item.entryId,label:item.name}))}/></Field><Field><FieldLabel>{t('databaseAlias')}</FieldLabel><Input value={requestAlias} onChange={event=>setRequestAlias(event.target.value)} disabled={busy}/></Field></>}
      <Field><FieldLabel>{t('databaseRequestKind')}</FieldLabel><SelectField value={kind} onValueChange={value=>setKind(value as 'create'|'access')} options={[{value:'create',label:t('databaseNewSpace')},{value:'access',label:t('databaseSharedSpace')}]}/></Field><Field><FieldLabel>{t(kind==='create'?'databaseSpaceName':'databaseSpaceId')}</FieldLabel><Input value={target} onChange={event=>setTarget(event.target.value)} disabled={busy}/></Field>
    </FieldGroup><PermissionsEditor value={requestPermissions} onChange={setRequestPermissions} disabled={busy}/><DialogFooter><Button disabled={busy||!requested||!requestAlias.trim()||!target.trim()} onClick={()=>{try{const requestedPermissions=normalizeDatabasePermissions(requestPermissions);if(consumer&&requested)void send('/requests',{projectId:consumer.id,entryId,alias:requestAlias,permissions:requestedPermissions,target:kind==='create'?{kind,name:target}:{kind,spaceId:target}}).then(ok=>{if(ok){setRequestOpen(false);setSection('requests');}});}catch(error){setError(String(error));}}}>{t('databaseSubmitRequest')}</Button></DialogFooter>{error&&<p role="alert">{error}</p>}</DialogContent></Dialog>
    <Dialog open={!!review} onOpenChange={open=>{if(!open&&!busy)setReview(undefined);}}><DialogContent className="max-h-[90vh] overflow-auto"><DialogHeader><DialogTitle>{t(review?.narrow?'databaseNarrow':'databaseReview')}</DialogTitle></DialogHeader><PermissionsEditor value={permissions} onChange={setPermissions} disabled={busy}/><Field><FieldLabel>{t('databaseReason')}</FieldLabel><Input value={reason} onChange={event=>setReason(event.target.value)}/></Field><DialogFooter>{!review?.narrow&&<Button variant="outline" disabled={busy} onClick={()=>void send(`/requests/${review.requestId}/review`,{approve:false,reason}).then(ok=>{if(ok)setReview(undefined);})}>{t('databaseReject')}</Button>}<Button disabled={busy} onClick={()=>{try{const approved=normalizeDatabasePermissions(permissions);void send(review.narrow?`/grants/${review.grantId}/narrow`:`/requests/${review.requestId}/review`,{approve:true,permissions:approved,reason}).then(ok=>{if(ok)setReview(undefined);});}catch(error){setError(String(error));}}}>{t(review?.narrow?'commonSave':'databaseApprove')}</Button></DialogFooter>{error&&<p role="alert">{error}</p>}</DialogContent></Dialog>
    <ConfirmActionDialog action={action} onOpenChange={open=>{if(!open)setAction(null);}}/>
  </div>;
}
function SpaceData({ spaceId, onDirtyChange }: { spaceId: string; onDirtyChange?: (value: boolean) => void }) {
  const { t } = useTranslation('serverWeb');
  const [tab, setTab] = useState('kv'), [page, setPage] = useState(1), [query, setQuery] = useState(''), [search, setSearch] = useState('');
  const [revision, setRevision] = useState(0), [error, setError] = useState(''), [loading, setLoading] = useState(false), [busy, setBusy] = useState(false);
  const [values, setValues] = useState<{ items: Array<{ key: string; namespace: string; value: unknown }>; total: number; pageSize: number }>();
  const [key, setKey] = useState(''), [value, setValue] = useState(''), [namespace, setNamespace] = useState('space'), [fileId, setFileId] = useState('');
  const [dirty, setDirty] = useState(false), [knowledgeDirty, setKnowledgeDirty] = useState(false), [confirmation, setConfirmation] = useState<ConfirmAction | null>(null);
  const busyRef = useRef(false);
  const repository = useMemo(() => createServerKnowledgeRepository(apiClient, spaceId), [spaceId]);
  useEffect(() => { const timer = setTimeout(() => { setSearch(query); setPage(1); }, 250); return () => clearTimeout(timer); }, [query]);
  useEffect(() => { onDirtyChange?.(dirty || knowledgeDirty); }, [dirty, knowledgeDirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  useEffect(() => {
    let live = true;
    if (tab !== 'kv') return;
    setLoading(true); setError('');
    void apiClient.databaseValues(spaceId, page, search).then(response => {
      if (!live) return;
      if (isApiSuccess(response)) setValues(response.data); else setError(response.errMessage);
      setLoading(false);
    });
    return () => { live = false; };
  }, [spaceId, page, search, revision, tab]);
  const run = async (operation: string, input: unknown, receive?: (data: any) => void) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError('');
    try {
      const result = await apiClient.databaseOperation(spaceId, operation, input);
      if (!isApiSuccess(result)) throw new Error(result.errMessage);
      receive?.(result.data); setRevision(value => value + 1);
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const confirmDelete = (description: string, operation: string, input: unknown) => setConfirmation({
    title: t('databaseDeleteData'), description, confirmLabel: t('commonDelete'), tone: 'destructive',
    onConfirm: () => { setConfirmation(null); void run(operation, input, () => setDirty(false)); },
  });
  const guardDraft = (change: () => void) => {
    if (dirty || knowledgeDirty) setConfirmation({ title: t('databaseDiscardDraft'), description: t('databaseDiscardDescription'), confirmLabel: t('commonConfirm'), tone: 'warning', onConfirm: () => { setConfirmation(null); change(); } });
    else change();
  };
  const selectTab = (next: string) => guardDraft(() => { setTab(next); setDirty(false); setKnowledgeDirty(false); });
  const address = { key, namespace, ...(namespace.startsWith('conversation:') ? { scope: 'conversation' } : {}) };
  const imageCache = useMemo(() => new Map<string, Promise<string>>(), [spaceId]);
  const imagesAbort = useMemo(() => new AbortController(), [spaceId]);
  useEffect(() => () => { imagesAbort.abort(); for (const pending of imageCache.values()) void pending.then(url => URL.revokeObjectURL(url), () => {}); }, [imageCache, imagesAbort]);
  const resolveImage = useCallback(async (src: string) => {
    const match = /^database:\/\/([0-9a-f-]+)\/files\/([0-9a-f-]+)$/.exec(src);
    if (!match || match[1] !== spaceId) return undefined;
    if (!imageCache.has(src)) imageCache.set(src, apiClient.fetchDatabaseFile(spaceId, match[2], imagesAbort.signal).then(blob => URL.createObjectURL(blob)).catch(error => { imageCache.delete(src); throw error; }));
    return imageCache.get(src)!;
  }, [spaceId, imageCache, imagesAbort]);
  return <div className="flex min-h-0 flex-1 flex-col gap-4 p-4">
    <code className="break-all">{spaceId}</code>
    <Tabs value={tab} onValueChange={selectTab}><TabsList><TabsTrigger value="kv">KV</TabsTrigger><TabsTrigger value="knowledge">{t('detailNavKnowledge')}</TabsTrigger><TabsTrigger value="files">{t('databaseAttachments')}</TabsTrigger></TabsList></Tabs>
    {error && <Alert variant="destructive"><AlertDescription>{error}<Button variant="outline" disabled={loading || busy} onClick={() => setRevision(value => value + 1)}>{t('commonRefresh')}</Button></AlertDescription></Alert>}
    {tab === 'knowledge' && <KnowledgeTableWorkspace repository={repository} refreshToken={revision} resolveImageSrc={resolveImage} onDirtyChange={setKnowledgeDirty} />}
    {tab === 'kv' && <>
      <Field><FieldLabel htmlFor="database-Search">{t('databaseSearch')}</FieldLabel><Input id="database-Search" value={query} onChange={event => setQuery(event.target.value)} /></Field>
      {loading && !values ? <Skeleton className="h-32" /> : values?.items.length ? <TablePanel>
        <TableHeader><TableRow><TableHead>{t('databaseKey')}</TableHead><TableHead>{t('databaseNamespace')}</TableHead><TableHead>{t('databaseValue')}</TableHead></TableRow></TableHeader>
        <TableBody>{values.items.map(item => <TableRow key={`${item.namespace}:${item.key}`}>
          <TableCell><Button variant="ghost" disabled={busy} onClick={() => guardDraft(() => { setKey(item.key); setNamespace(item.namespace); setValue(JSON.stringify(item.value, null, 2)); setDirty(false); })}>{item.key}</Button></TableCell>
          <TableCell>{item.namespace}</TableCell><TableCell><pre className="max-h-20 overflow-auto">{JSON.stringify(item.value)}</pre></TableCell>
        </TableRow>)}</TableBody>
      </TablePanel> : !loading && !error ? <Empty><EmptyHeader><EmptyTitle>{t('databaseEmpty')}</EmptyTitle></EmptyHeader></Empty> : null}
      <div className="flex gap-2"><Button variant="outline" disabled={page <= 1 || loading} onClick={() => setPage(page - 1)}>{t('databasePrevious')}</Button><Button variant="outline" disabled={loading || page * (values?.pageSize ?? 30) >= (values?.total ?? 0)} onClick={() => setPage(page + 1)}>{t('databaseNext')}</Button></div>
      <FieldGroup>
        <Field><FieldLabel htmlFor="database-Namespace">{t('databaseNamespace')}</FieldLabel><Input id="database-Namespace" value={namespace} disabled={busy} onChange={event => { setNamespace(event.target.value); setDirty(true); }} /></Field>
        <Field><FieldLabel htmlFor="database-Key">{t('databaseKey')}</FieldLabel><Input id="database-Key" value={key} disabled={busy} onChange={event => { setKey(event.target.value); setDirty(true); }} /></Field>
        <Field><FieldLabel htmlFor="database-Value">{t('databaseValue')}</FieldLabel><Textarea id="database-Value" value={value} disabled={busy} onChange={event => { setValue(event.target.value); setDirty(true); }} /></Field>
      </FieldGroup>
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy || !key} onClick={() => { try { void run('kv.setValue', { ...address, value: JSON.parse(value) }, () => setDirty(false)); } catch (failure) { setError(String(failure)); } }}>{t('commonSave')}</Button>
        <Button variant="outline" disabled={busy || !key} onClick={() => confirmDelete(`${namespace} / ${key}`, 'kv.deleteValue', address)}>{t('commonDelete')}</Button>
        <Button variant="outline" disabled={loading || busy} onClick={() => setRevision(value => value + 1)}>{t('commonRefresh')}</Button>
      </div>
    </>}
    {tab === 'files' && <FieldGroup>
      <Field><FieldLabel htmlFor="database-UploadAttachment">{t('databaseUploadAttachment')}</FieldLabel><Input id="database-UploadAttachment" type="file" disabled={busy} onChange={event => {
        const file = event.target.files?.[0]; if (!file) return;
        if (file.size > 50 * 1024 * 1024) { setError(t('databaseAttachmentSize')); return; }
        void file.arrayBuffer().then(bytes => { let binary = ''; for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte); void run('files.createFile', { name: file.name, mimeType: file.type, base64: btoa(binary) }, result => setFileId(result.id)); }).catch(error => setError(String(error)));
      }} /></Field>
      <Field><FieldLabel htmlFor="database-AttachmentId">{t('databaseAttachmentId')}</FieldLabel><Input id="database-AttachmentId" value={fileId} onChange={event => setFileId(event.target.value)} /><code className="break-all">{fileId ? `database://${spaceId}/files/${fileId}` : ''}</code></Field>
      <div className="flex flex-wrap gap-2"><Button disabled={!fileId || busy} variant="outline" onClick={() => void run('files.readFile', { fileId }, result => {
        const bytes = Uint8Array.from(atob(result.base64), char => char.charCodeAt(0));
        const url = URL.createObjectURL(new Blob([bytes], { type: result.file.mimeType })); const link = document.createElement('a'); link.href = url; link.download = result.file.name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      })}>{t('databaseDownloadAttachment')}</Button><Button disabled={!fileId || busy} variant="outline" onClick={() => confirmDelete(fileId, 'files.deleteFile', { fileId })}>{t('commonDelete')}</Button></div>
    </FieldGroup>}
    <ConfirmActionDialog action={confirmation} onOpenChange={open => { if (!open) setConfirmation(null); }} />
  </div>;
}
