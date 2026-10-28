import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from '@steamharness/i18n/react';
import { Plus, RefreshCw, Save, Trash2 } from 'lucide-react';
import { apiClient } from '../../api';
import { isApiSuccess } from '../../types';
import { Alert, AlertDescription, Button, Empty, EmptyHeader, EmptyTitle, Field, FieldLabel, FieldGroup, Input, Skeleton, Textarea } from '@/components/ui';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { KnowledgeTableWorkspace } from './KnowledgeTableWorkspace';
import { createServerKnowledgeRepository } from './knowledge-repository';
import { ConfirmActionDialog, type ConfirmAction } from '@/components/ConfirmActionDialog';
export function DatabaseSpaceData({ spaceId, onDirtyChange }: { spaceId: string; onDirtyChange?: (value: boolean) => void }) {
  const { t } = useTranslation('serverWeb');
  const [tab, setTab] = useState('kv'), [page, setPage] = useState(1), [query, setQuery] = useState(''), [search, setSearch] = useState('');
  const [revision, setRevision] = useState(0), [error, setError] = useState(''), [loading, setLoading] = useState(false), [busy, setBusy] = useState(false);
  const [values, setValues] = useState<{ items: Array<{ key: string; namespace: string; value: unknown }>; total: number; pageSize: number }>();
  const [key, setKey] = useState(''), [value, setValue] = useState(''), [namespace, setNamespace] = useState('space'), [fileId, setFileId] = useState('');
  const [selected, setSelected] = useState(false), [creating, setCreating] = useState(false);
  const [dirty, setDirty] = useState(false), [knowledgeDirty, setKnowledgeDirty] = useState(false), [confirmation, setConfirmation] = useState<ConfirmAction | null>(null);
  const busyRef = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
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
    }).catch(failure => { if (live) setError(failure instanceof Error ? failure.message : String(failure)); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [spaceId, page, search, revision, tab]);
  const run = async (operation: string, input: unknown | (() => Promise<unknown>), receive?: (data: any) => void) => {
    if (!alive.current || busyRef.current) return;
    busyRef.current = true; setBusy(true); setError('');
    try {
      const body = typeof input === 'function' ? await input() : input;
      if (!alive.current) return;
      const result = await apiClient.databaseOperation(spaceId, operation, body);
      if (!alive.current) return;
      if (!isApiSuccess(result)) throw new Error(result.errMessage);
      receive?.(result.data); setRevision(value => value + 1);
    } catch (failure) { if (alive.current) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { busyRef.current = false; if (alive.current) setBusy(false); }
  };
  const confirmDelete = (description: string, operation: string, input: unknown) => setConfirmation({
    title: t('databaseDeleteData'), description, confirmLabel: t('commonDelete'), tone: 'destructive',
    onConfirm: () => { setConfirmation(null); void run(operation, input, () => { setDirty(false); if (operation === 'kv.deleteValue') setSelected(false); }); },
  });
  const guardDraft = (change: () => void) => {
    if (busyRef.current) return;
    if (dirty || knowledgeDirty) setConfirmation({ title: t('databaseDiscardDraft'), description: t('databaseDiscardDescription'), confirmLabel: t('commonConfirm'), tone: 'warning', onConfirm: () => { setConfirmation(null); change(); } });
    else change();
  };
  const selectTab = (next: string) => { if (next !== tab) guardDraft(() => { setTab(next); setSelected(false); setCreating(false); setDirty(false); setKnowledgeDirty(false); }); };
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
  return <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 p-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><Tabs value={tab} onValueChange={selectTab}><TabsList><TabsTrigger value="kv">KV</TabsTrigger><TabsTrigger value="knowledge">{t('detailNavKnowledge')}</TabsTrigger><TabsTrigger value="files">{t('databaseAttachments')}</TabsTrigger></TabsList></Tabs><code className="break-all text-xs text-muted-foreground">{spaceId}</code></div>
    {error && <Alert variant="destructive"><AlertDescription>{error}<Button variant="outline" disabled={loading || busy} onClick={() => setRevision(value => value + 1)}>{t('commonRefresh')}</Button></AlertDescription></Alert>}
    {tab === 'knowledge' && <KnowledgeTableWorkspace repository={repository} refreshToken={revision} resolveImageSrc={resolveImage} onDirtyChange={setKnowledgeDirty} />}
    {tab === 'kv' && <>
      <div className="flex items-center gap-2"><Input aria-label={t('databaseSearch')} placeholder={t('databaseSearch')} value={query} onChange={event => setQuery(event.target.value)} />
        <Button variant="ghost" size="icon" aria-label={t('databaseNewKey')} title={t('databaseNewKey')} disabled={busy} onClick={() => guardDraft(() => { setKey(''); setNamespace('space'); setValue('{}'); setCreating(true); setSelected(true); setDirty(false); })}><Plus /></Button>
        <Button variant="ghost" size="icon" aria-label={t('commonRefresh')} title={t('commonRefresh')} disabled={loading || busy} onClick={() => setRevision(value => value + 1)}><RefreshCw /></Button>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-auto rounded-md border md:grid-cols-[minmax(12rem,2fr)_minmax(0,3fr)]">
        <div className="flex min-h-48 min-w-0 flex-col border-b md:border-r md:border-b-0">
          <nav className="flex min-h-0 flex-1 flex-col gap-1 overflow-auto p-2" aria-label={t('databaseKeys')} aria-busy={loading}>
            {loading && !values ? <Skeleton className="h-32" /> : values?.items.length ? values.items.map(item => <Button key={`${item.namespace}:${item.key}`} variant={selected && !creating && key === item.key && namespace === item.namespace ? 'secondary' : 'ghost'} className="h-auto justify-start py-2" disabled={busy} aria-label={item.key} title={`${item.namespace} / ${item.key}`} onClick={() => guardDraft(() => { setKey(item.key); setNamespace(item.namespace); setValue(JSON.stringify(item.value, null, 2)); setCreating(false); setSelected(true); setDirty(false); })}>
              <span className="flex min-w-0 flex-col items-start gap-1"><span className="truncate">{item.key}</span><span className="text-xs text-muted-foreground">{item.namespace}</span><code className="max-w-full truncate text-xs text-muted-foreground">{JSON.stringify(item.value)}</code></span>
            </Button>) : !loading && !error ? <Empty><EmptyHeader><EmptyTitle>{t('databaseEmpty')}</EmptyTitle></EmptyHeader></Empty> : null}
          </nav>
          <div className="flex items-center justify-between gap-2 p-2"><Button variant="ghost" disabled={page <= 1 || loading} onClick={() => setPage(page - 1)}>{t('databasePrevious')}</Button><span className="text-xs text-muted-foreground">{page} / {Math.max(1, Math.ceil((values?.total ?? 0) / (values?.pageSize ?? 30)))}</span><Button variant="ghost" disabled={loading || page * (values?.pageSize ?? 30) >= (values?.total ?? 0)} onClick={() => setPage(page + 1)}>{t('databaseNext')}</Button></div>
        </div>
        {selected ? <div className="flex min-w-0 flex-col gap-3 overflow-auto p-4">
          <div className="flex items-center gap-2"><strong className="flex-1 truncate">{creating ? t('databaseNewKey') : key}</strong>
            <Button size="icon" variant="ghost" aria-label={t('commonSave')} title={t('commonSave')} disabled={busy || !key} onClick={() => { try { void run('kv.setValue', { ...address, value: JSON.parse(value), ...(creating ? { create: true } : {}) }, () => { setDirty(false); setCreating(false); }); } catch (failure) { setError(String(failure)); } }}><Save /></Button>
            <Button size="icon" variant="ghost" aria-label={t('commonDelete')} title={t('commonDelete')} disabled={busy || creating || !key} onClick={() => confirmDelete(`${namespace} / ${key}`, 'kv.deleteValue', address)}><Trash2 /></Button>
          </div>
          <FieldGroup>
            <Field><FieldLabel htmlFor="database-Namespace">{t('databaseNamespace')}</FieldLabel><Input id="database-Namespace" value={namespace} readOnly={!creating} disabled={busy} onChange={event => { setNamespace(event.target.value); setDirty(true); }} /></Field>
            <Field><FieldLabel htmlFor="database-Key">{t('databaseKey')}</FieldLabel><Input id="database-Key" value={key} readOnly={!creating} disabled={busy} onChange={event => { setKey(event.target.value); setDirty(true); }} /></Field>
            <Field><FieldLabel htmlFor="database-Value">{t('databaseValue')}</FieldLabel><Textarea id="database-Value" className="min-h-60" value={value} disabled={busy} onChange={event => { setValue(event.target.value); setDirty(true); }} /></Field>
          </FieldGroup>
        </div> : <Empty className="min-h-48"><EmptyHeader><EmptyTitle>{t('databaseSelectKey')}</EmptyTitle></EmptyHeader></Empty>}
      </div>
    </>}
    {tab === 'files' && <FieldGroup>
      <Field><FieldLabel htmlFor="database-UploadAttachment">{t('databaseUploadAttachment')}</FieldLabel><Input id="database-UploadAttachment" type="file" disabled={busy} onChange={event => {
        const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
        if (file.size > 50 * 1024 * 1024) { setError(t('databaseAttachmentSize')); return; }
        void run('files.createFile', async () => {
          const bytes = await file.arrayBuffer(); let binary = ''; for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
          return { name: file.name, mimeType: file.type, base64: btoa(binary) };
        }, result => setFileId(result.id));
      }} /></Field>
      <Field><FieldLabel htmlFor="database-AttachmentId">{t('databaseAttachmentId')}</FieldLabel><Input id="database-AttachmentId" value={fileId} disabled={busy} onChange={event => setFileId(event.target.value)} /><code className="break-all">{fileId ? `database://${spaceId}/files/${fileId}` : ''}</code></Field>
      <div className="flex flex-wrap gap-2"><Button disabled={!fileId || busy} variant="outline" onClick={() => void run('files.readFile', { fileId }, result => {
        const bytes = Uint8Array.from(atob(result.base64), char => char.charCodeAt(0));
        const url = URL.createObjectURL(new Blob([bytes], { type: result.file.mimeType })); const link = document.createElement('a'); link.href = url; link.download = result.file.name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      })}>{t('databaseDownloadAttachment')}</Button><Button disabled={!fileId || busy} variant="outline" onClick={() => confirmDelete(fileId, 'files.deleteFile', { fileId })}>{t('commonDelete')}</Button></div>
    </FieldGroup>}
    <ConfirmActionDialog action={confirmation} onOpenChange={open => { if (!open) setConfirmation(null); }} />
  </div>;
}
