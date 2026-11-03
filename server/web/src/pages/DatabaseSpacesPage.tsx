import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from '@steamharness/i18n/react';
import { apiClient } from '../api';
import { isApiSuccess, type Summary } from '../types';
import { Alert, AlertDescription, Button, Empty, EmptyHeader, EmptyTitle, Field, FieldGroup, FieldLabel, Input, Skeleton, TablePanel, TableHeader, TableHead, TableRow, TableBody, TableCell } from '@/components/ui';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ConfirmActionDialog, type ConfirmAction } from '@/components/ConfirmActionDialog';
import { DatabaseCatalogPage } from './DatabaseCatalogPage';
import { DatabaseSpaceData } from './detail/DatabaseSpaceData';
import { RelationalTableData } from './detail/RelationalTableData';
export type ResourceKind = 'databases' | 'knowledge-bases';
/** Both resource types are Server-owned. Catalogs are paginated and filtered on the server. */
export function DatabaseSpacesPage({ project, spaceId, onOpenSpace, onBack, onDirtyChange }: { project?: Summary; spaceId?: string; onOpenSpace?: (id: string) => void; onBack?: () => void; onDirtyChange?: (dirty: boolean) => void }) {
  const { t } = useTranslation('serverWeb');
  const [kind, setKind] = useState<ResourceKind>(spaceId?.startsWith('knowledge:') ? 'knowledge-bases' : 'databases');
  const [selected, setSelected] = useState(spaceId?.replace(/^knowledge:/, '') ?? ''), [page, setPage] = useState(1), [search, setSearch] = useState('');
  const [catalog, setCatalog] = useState<{ items: any[]; total: number; pageSize: number }>(), [loading, setLoading] = useState(false), [error, setError] = useState(''), [revision, setRevision] = useState(0);
  const [name, setName] = useState(''), [busy, setBusy] = useState(false), [confirmation, setConfirmation] = useState<ConfirmAction | null>(null);
  const dirty = useRef(false), requestId = useRef(crypto.randomUUID()), mutation = useRef(false), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { setSelected(spaceId?.replace(/^knowledge:/, '') ?? ''); if (spaceId) setKind(spaceId.startsWith('knowledge:') ? 'knowledge-bases' : 'databases'); }, [spaceId]);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError('');
    void apiClient.resourceRequest(kind, `?${new URLSearchParams({ page: String(page), pageSize: '20', search })}`, undefined, 'GET', controller.signal).then(response => {
      if (!controller.signal.aborted) { if (isApiSuccess(response)) setCatalog(response.data); else { setCatalog(undefined); setError(response.errMessage); } }
    }).catch(error => { if (!controller.signal.aborted) setError(String(error)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [kind, page, search, revision]);
  const updateDirty = useCallback((value: boolean) => { dirty.current = value; onDirtyChange?.(value); }, [onDirtyChange]);
  const guard = (change: () => void) => dirty.current ? setConfirmation({ title: t('databaseDiscardDraft'), description: t('databaseDiscardDescription'), confirmLabel: t('commonConfirm'), tone: 'warning', onConfirm: () => { updateDirty(false); setConfirmation(null); change(); } }) : change();
  const open = (id: string) => guard(() => { setSelected(id); onOpenSpace?.(kind === 'knowledge-bases' ? `knowledge:${id}` : id); });
  const create = async () => {
    if (mutation.current || !name.trim()) return; mutation.current = true; setBusy(true); setError('');
    try { const response = await apiClient.resourceRequest(kind, '', { name: name.trim(), requestId: requestId.current }); if (!alive.current) return; if (!isApiSuccess(response)) throw new Error(response.errMessage); setName(''); requestId.current = crypto.randomUUID(); setRevision(value => value + 1); open(response.data.id); }
    catch (error) { if (alive.current) setError(error instanceof Error ? error.message : String(error)); }
    finally { mutation.current = false; if (alive.current) setBusy(false); }
  };
  return <div className="flex min-h-0 flex-1 flex-col gap-4 p-6">
    <Tabs value={kind} onValueChange={value => { if (busy) return; guard(() => { setKind(value as ResourceKind); setSelected(''); setCatalog(undefined); setPage(1); onBack?.(); }); }}><TabsList><TabsTrigger value="databases">{t('resourceDatabases')}</TabsTrigger><TabsTrigger value="knowledge-bases">{t('resourceKnowledgeBases')}</TabsTrigger></TabsList></Tabs>
    <p>{t('resourceOnline')}</p>
    {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
    <FieldGroup className="flex flex-wrap items-end gap-3"><Field><FieldLabel htmlFor="resource-search">{t('databaseSearch')}</FieldLabel><Input id="resource-search" value={search} onChange={event => { setSearch(event.target.value); setPage(1); }} /></Field><Field><FieldLabel htmlFor="resource-name">{t('resourceName')}</FieldLabel><Input id="resource-name" value={name} disabled={busy} onChange={event => setName(event.target.value)} /></Field><Button disabled={busy || !name.trim()} onClick={() => void create()}>{t('resourceCreate')}</Button><Button variant="outline" disabled={loading} onClick={() => setRevision(value => value + 1)}>{t('commonRefresh')}</Button></FieldGroup>
    {loading ? <Skeleton className="h-20" /> : catalog?.items.length ? <TablePanel><TableHeader><TableRow><TableHead>{t('resourceName')}</TableHead><TableHead>ID</TableHead></TableRow></TableHeader><TableBody>{catalog.items.map(resource => <TableRow key={resource.id}><TableCell><Button variant="link" onClick={() => open(resource.id)}>{resource.name}</Button></TableCell><TableCell><code>{resource.id}</code></TableCell></TableRow>)}</TableBody></TablePanel> : !error && <Empty><EmptyHeader><EmptyTitle>{t('databaseEmpty')}</EmptyTitle></EmptyHeader></Empty>}
    <div className="flex items-center gap-3"><Button variant="outline" disabled={loading || page === 1} onClick={() => setPage(page - 1)}>{t('databasePrevious')}</Button><span>{page} / {Math.max(1, Math.ceil((catalog?.total ?? 0) / 20))}</span><Button variant="outline" disabled={loading || page * 20 >= (catalog?.total ?? 0)} onClick={() => setPage(page + 1)}>{t('databaseNext')}</Button></div>
    {selected ? <div key={`${kind}:${selected}`} className="flex min-h-0 flex-1 flex-col gap-4"><code>{selected}</code><DatabaseCatalogPage kind={kind} resourceId={selected} project={project} />{kind === 'knowledge-bases' ? <DatabaseSpaceData spaceId={selected} onDirtyChange={updateDirty} /> : <RelationalTableData resourceId={selected} onDirtyChange={updateDirty} />}</div> : <Empty><EmptyHeader><EmptyTitle>{t('resourceChoose')}</EmptyTitle></EmptyHeader></Empty>}
    <ConfirmActionDialog action={confirmation} onOpenChange={open => { if (!open) setConfirmation(null); }} />
  </div>;
}
