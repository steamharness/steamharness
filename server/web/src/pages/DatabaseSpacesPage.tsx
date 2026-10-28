import { useCallback, useEffect, useRef, useState } from 'react';
import { BookOpen, Database, KeyRound, Plus, RefreshCw, ShieldCheck, X } from 'lucide-react';
import { useTranslation } from '@steamharness/i18n/react';
import { apiClient } from '../api';
import { isApiSuccess, type Summary } from '../types';
import { Alert, AlertDescription, Button, Empty, EmptyHeader, EmptyTitle, Input, SelectField, Skeleton } from '@/components/ui';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ConfirmActionDialog, type ConfirmAction } from '@/components/ConfirmActionDialog';
import { DatabaseCatalogPage } from './DatabaseCatalogPage';
import { DatabaseSpaceData } from './detail/DatabaseSpaceData';

/** Server-owned database directory and persistent data tabs. Lists stay paginated on the server. */
export function DatabaseSpacesPage({ project, spaceId, onOpenSpace, onBack, onDirtyChange }: {
  project?: Summary; spaceId?: string; onOpenSpace?: (id: string) => void; onBack?: () => void; onDirtyChange?: (dirty: boolean) => void;
}) {
  const { t } = useTranslation('serverWeb');
  const [filter, setFilter] = useState(project ? 'project' : 'server'), [query, setQuery] = useState(''), [search, setSearch] = useState(''), [page, setPage] = useState(1);
  const [catalog, setCatalog] = useState<{ items: Array<{ spaceId: string; name: string; canManage: boolean }>; total: number; pageSize: number }>();
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [revision, setRevision] = useState(0), [requestTrigger, setRequestTrigger] = useState(0);
  const [opened, setOpened] = useState<Array<{ id: string; name: string }>>(spaceId ? [{ id: spaceId, name: spaceId }] : []), [active, setActive] = useState(spaceId ?? 'overview');
  const [confirmation, setConfirmation] = useState<ConfirmAction | null>(null);
  const dirty = useRef(false);
  const updateDirty = useCallback((value: boolean) => { dirty.current = value; onDirtyChange?.(value); }, [onDirtyChange]);
  useEffect(() => { setFilter(project ? 'project' : 'server'); setPage(1); }, [project?.id]);
  useEffect(() => { const timer = setTimeout(() => { setSearch(query); setPage(1); }, 250); return () => clearTimeout(timer); }, [query]);
  useEffect(() => {
    let live = true; setLoading(true); setError('');
    void apiClient.databasePage('spaces', page, search, filter === 'project' ? project?.id : undefined).then(response => {
      if (!live) return;
      if (isApiSuccess(response)) setCatalog(response.data); else setError(response.errMessage);
    }).catch(error => { if (live) setError(error instanceof Error ? error.message : String(error)); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [page, search, filter, project?.id, revision]);
  useEffect(() => {
    if (!spaceId) return;
    setOpened(current => current.some(item => item.id === spaceId) ? current : [...current, { id: spaceId, name: spaceId }]); setActive(spaceId);
  }, [spaceId]);
  useEffect(() => { if (catalog) setOpened(current => current.map(item => ({ ...item, name: catalog.items.find(space => space.spaceId === item.id)?.name ?? item.name }))); }, [catalog]);
  const guard = (change: () => void) => {
    const proceed = () => { updateDirty(false); setConfirmation(null); change(); };
    if (dirty.current) setConfirmation({ title: t('databaseDiscardDraft'), description: t('databaseDiscardDescription'), confirmLabel: t('commonConfirm'), tone: 'warning', onConfirm: proceed }); else proceed();
  };
  const open = (id: string, name = id) => id !== active && guard(() => { setOpened(current => current.some(item => item.id === id) ? current : [...current, { id, name }]); setActive(id); onOpenSpace?.(id); });
  const select = (id: string) => { if (id !== active) guard(() => { setActive(id); if (id !== 'overview' && id !== 'access') onOpenSpace?.(id); else onBack?.(); }); };
  const close = (id: string) => {
    const change = () => {
      const remaining = opened.filter(item => item.id !== id); setOpened(remaining);
      if (active === id) { const next = remaining.at(-1)?.id ?? 'overview'; setActive(next); if (next !== 'overview') onOpenSpace?.(next); else onBack?.(); }
    };
    if (active === id) guard(change); else change();
  };
  return <div className="flex min-h-0 flex-1 flex-col overflow-hidden md:flex-row">
    <aside className="flex min-h-0 shrink-0 flex-col border-b md:w-72 md:border-r md:border-b-0" aria-label={t('databaseDirectory')}>
      <div className="flex items-center gap-2 p-3"><Database /><strong className="flex-1">{t('databaseSpaces')}</strong>
        <Button variant="ghost" size="icon" aria-label={t('databaseRequest')} title={t('databaseRequest')} onClick={() => guard(() => { setActive('access'); setRequestTrigger(value => value + 1); })}><Plus /></Button>
        <Button variant="ghost" size="icon" disabled={loading} aria-label={t('commonRefresh')} title={t('commonRefresh')} onClick={() => setRevision(value => value + 1)}><RefreshCw /></Button>
      </div>
      <div className="flex flex-col gap-2 px-3 pb-3"><SelectField aria-label={t('databaseFilter')} value={filter} options={[...(project ? [{ value: 'project', label: t('databaseUsedByProject') }] : []), { value: 'server', label: t('databaseServerOnly') }, { value: 'all', label: t('databaseAllVisible') }]} onValueChange={value => { setFilter(value); setPage(1); setCatalog(undefined); }} />
        <Input aria-label={t('databaseSearch')} placeholder={t('databaseSearch')} value={query} onChange={event => setQuery(event.target.value)} />
      </div>
      {filter === 'project' && <p className="px-3 pb-2 text-xs text-muted-foreground">{project?.name}</p>}
      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      <nav className="flex min-h-0 flex-1 flex-col gap-1 overflow-auto px-2" aria-label={t('databaseDirectory')} aria-busy={loading}>
        {loading && !catalog ? <Skeleton className="h-20" /> : catalog?.items.length ? catalog.items.map(space => <Button key={space.spaceId} variant="ghost" className="h-auto justify-start py-2" aria-current={active === space.spaceId ? 'page' : undefined} disabled={space.canManage === false} title={space.spaceId} onClick={() => open(space.spaceId, space.name)}>
          <Database data-icon="inline-start" /><span className="flex min-w-0 flex-col items-start gap-1"><span className="truncate">{space.name}</span><code className="max-w-52 truncate text-xs text-muted-foreground">{space.spaceId}</code></span>
        </Button>) : !loading && !error ? <Empty><EmptyHeader><EmptyTitle>{t('databaseEmpty')}</EmptyTitle></EmptyHeader></Empty> : null}
      </nav>
      <div className="flex items-center justify-between gap-1 p-2"><Button variant="ghost" disabled={page <= 1 || loading} onClick={() => setPage(value => value - 1)}>{t('databasePrevious')}</Button><span className="text-xs text-muted-foreground">{page} / {Math.max(1, Math.ceil((catalog?.total ?? 0) / (catalog?.pageSize ?? 20)))}</span><Button variant="ghost" disabled={loading || page * (catalog?.pageSize ?? 20) >= (catalog?.total ?? 0)} onClick={() => setPage(value => value + 1)}>{t('databaseNext')}</Button></div>
      <Button variant="ghost" className="justify-start" onClick={() => select('access')}><ShieldCheck data-icon="inline-start" />{t('databaseRequestsAndPermissions')}</Button>
    </aside>
    <section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label={t('databaseWorkspace')}>
      <Tabs value={active} onValueChange={select}><TabsList className="flex h-auto w-full justify-start overflow-x-auto rounded-none">
        <TabsTrigger value="overview"><Database data-icon="inline-start" />{t('databaseSpaces')}</TabsTrigger>
        {opened.map(item => <div key={item.id} className="flex items-center"><TabsTrigger value={item.id}>{item.name}</TabsTrigger><Button variant="ghost" size="icon" aria-label={t('databaseCloseTab', { name: item.name })} title={t('databaseCloseTab', { name: item.name })} onClick={() => close(item.id)}><X /></Button></div>)}
        {active === 'access' && <TabsTrigger value="access"><ShieldCheck data-icon="inline-start" />{t('databaseRequestsAndPermissions')}</TabsTrigger>}
      </TabsList></Tabs>
      {active === 'access' ? <div className="min-h-0 flex-1 overflow-auto"><DatabaseCatalogPage project={project} requestTrigger={requestTrigger} onOpenSpace={open} onCatalogChange={() => setRevision(value => value + 1)} /></div>
        : active === 'overview' ? <Empty className="flex-1"><EmptyHeader><EmptyTitle>{t('databaseSelectToOpen')}</EmptyTitle></EmptyHeader><div className="flex gap-2"><KeyRound /><span>KV</span><BookOpen /><span>{t('detailNavKnowledge')}</span></div></Empty>
        : <div className="flex min-h-0 flex-1 overflow-auto"><DatabaseSpaceData key={active} spaceId={active} onDirtyChange={updateDirty} /></div>}
    </section>
    <ConfirmActionDialog action={confirmation} onOpenChange={open => { if (!open) setConfirmation(null); }} />
  </div>;
}
