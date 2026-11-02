import { useEffect, useRef, useState } from 'react';
import { useTranslation } from '@steamharness/i18n/react';
import { apiClient } from '../../api';
import { isApiSuccess } from '../../types';
import { Alert, AlertDescription, Button, Empty, EmptyHeader, EmptyTitle, Field, FieldGroup, FieldLabel, Input, SelectField, Skeleton, TablePanel, TableHeader, TableHead, TableRow, TableBody, TableCell, Textarea } from '@/components/ui';
import { ConfirmActionDialog, type ConfirmAction } from '@/components/ConfirmActionDialog';
interface Model { name: string; fields: { name: string; type: string; required: boolean; list: boolean }[]; keyFields: string[] }
interface Row { values: Record<string, unknown>; rowVersion: string }
export function RelationalTableData({ resourceId, onDirtyChange }: { resourceId: string; onDirtyChange?: (dirty: boolean) => void }) {
  const { t } = useTranslation('serverWeb');
  const [models, setModels] = useState<Model[]>([]), [modelName, setModelName] = useState(''), [schemaHash, setSchemaHash] = useState(''), [mode, setMode] = useState('read');
  const [page, setPage] = useState(1), [search, setSearch] = useState(''), [result, setResult] = useState<{ items: Row[]; total: number }>(), [selected, setSelected] = useState<Row>(), [draft, setDraft] = useState('{}'), [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(''), [revision, setRevision] = useState(0), [confirmation, setConfirmation] = useState<ConfirmAction | null>(null);
  const mutation = useRef(false), controller = useRef(new AbortController());
  const dirty = (creating || !!selected) && draft !== (selected ? JSON.stringify(selected.values, null, 2) : '{}');
  const model = models.find(item => item.name === modelName);
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);
  useEffect(() => {
    controller.current = new AbortController(); const signal = controller.current.signal; setLoading(true); setError('');
    void apiClient.resourceRequest('databases', `/${resourceId}/data`, { operation: 'models' }, 'POST', signal).then(response => {
      if (signal.aborted) return; if (!isApiSuccess(response)) throw new Error(response.errMessage);
      setModels(response.data.models); setMode(response.data.mode); setSchemaHash(response.data.schemaHash); setModelName(response.data.models[0]?.name ?? '');
    }).catch(error => { if (!signal.aborted) setError(error.message); }).finally(() => { if (!signal.aborted) setLoading(false); });
    return () => controller.current.abort();
  }, [resourceId]);
  useEffect(() => {
    if (!modelName || !schemaHash) return; const abort = new AbortController(); setLoading(true); setError(''); setResult(undefined);
    void apiClient.resourceRequest('databases', `/${resourceId}/data`, { operation: 'rows', model: modelName, schemaHash, page, pageSize: 20, search }, 'POST', abort.signal).then(response => {
      if (abort.signal.aborted) return; if (!isApiSuccess(response)) throw new Error(response.errMessage); setResult(response.data);
    }).catch(error => { if (!abort.signal.aborted) setError(error.message); }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [resourceId, modelName, schemaHash, page, search, revision]);
  const guard = (change: () => void) => dirty ? setConfirmation({ title: t('databaseDiscardDraft'), description: t('databaseDiscardDescription'), confirmLabel: t('commonConfirm'), tone: 'warning', onConfirm: () => { setConfirmation(null); change(); } }) : change();
  const mutate = async (operation: string) => {
    if (mutation.current || mode !== 'write') return; mutation.current = true; setBusy(true); setError(''); const signal = controller.current.signal;
    try {
      const data = operation === 'delete' ? {} : JSON.parse(draft); if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(t('resourceJSONInvalid'));
      const key = selected && Object.fromEntries((model?.keyFields ?? []).map(name => [name, selected.values[name]]));
      const response = await apiClient.resourceRequest('databases', `/${resourceId}/data`, { operation, model: modelName, schemaHash, ...(operation !== 'delete' ? { data } : {}), ...(selected ? { key, rowVersion: selected.rowVersion } : {}) }, 'POST', signal);
      if (signal.aborted) return; if (!isApiSuccess(response)) throw new Error(response.errMessage); setSelected(undefined); setCreating(false); setDraft('{}'); setRevision(value => value + 1);
    } catch (error) { if (!signal.aborted) setError(error instanceof Error ? error.message : String(error)); }
    finally { mutation.current = false; if (!signal.aborted) setBusy(false); }
  };
  return <div className="flex min-h-0 flex-col gap-4"><h3>{t('resourceModels')}</h3><FieldGroup><Field><FieldLabel>{t('resourceModel')}</FieldLabel><SelectField value={modelName} disabled={busy} options={models.map(item => ({ value: item.name, label: item.name }))} onValueChange={value => guard(() => { setModelName(value); setPage(1); setSelected(undefined); setCreating(false); })} /></Field><Field><FieldLabel htmlFor="table-search">{t('databaseSearch')}</FieldLabel><Input id="table-search" value={search} disabled={busy} onChange={event => { setSearch(event.target.value); setPage(1); }} /></Field></FieldGroup>
    <p>{t('resourceSchemaHash')}: <code>{schemaHash}</code></p>{mode === 'read' && <p>{t('resourceReadOnly')}</p>}
    {model && <p>{t('resourceFields')}: {model.fields.map(field => `${field.name}: ${field.type}${field.list ? '[]' : ''}${field.required ? '' : '?'}`).join(', ')}</p>}
    {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
    <div className="flex gap-3"><Button disabled={mode !== 'write' || busy || !model} onClick={() => guard(() => { setCreating(true); setSelected(undefined); setDraft('{}'); })}>{t('resourceNewRow')}</Button><Button variant="outline" disabled={loading} onClick={() => setRevision(value => value + 1)}>{t('commonRefresh')}</Button></div>
    {loading ? <Skeleton className="h-24" /> : result?.items.length ? <TablePanel><TableHeader><TableRow>{model?.fields.map(field => <TableHead key={field.name}>{field.name}</TableHead>)}<TableHead>{t('commonEdit')}</TableHead></TableRow></TableHeader><TableBody>{result.items.map((row, index) => <TableRow key={model?.keyFields.length ? JSON.stringify(model.keyFields.map(name => row.values[name])) : index}>{model?.fields.map(field => <TableCell key={field.name}><code>{JSON.stringify(row.values[field.name])}</code></TableCell>)}<TableCell><Button variant="outline" disabled={busy} onClick={() => guard(() => { setSelected(row); setCreating(false); setDraft(JSON.stringify(row.values, null, 2)); })}>{t('commonEdit')}</Button></TableCell></TableRow>)}</TableBody></TablePanel> : !error && <Empty><EmptyHeader><EmptyTitle>{t('databaseEmpty')}</EmptyTitle></EmptyHeader></Empty>}
    <div className="flex items-center gap-3"><Button variant="outline" disabled={loading || page === 1} onClick={() => setPage(page - 1)}>{t('databasePrevious')}</Button><span>{page} / {Math.max(1, Math.ceil((result?.total ?? 0) / 20))}</span><Button variant="outline" disabled={loading || page * 20 >= (result?.total ?? 0)} onClick={() => setPage(page + 1)}>{t('databaseNext')}</Button></div>
    {(creating || selected) && <FieldGroup><Field><FieldLabel htmlFor="row-values">{t('resourceData')}</FieldLabel><Textarea id="row-values" value={draft} disabled={busy || mode !== 'write'} onChange={event => setDraft(event.target.value)} /></Field><div className="flex gap-3"><Button disabled={busy || mode !== 'write'} onClick={() => void mutate(creating ? 'insert' : 'update')}>{t('resourceSaveRow')}</Button>{selected && <Button variant="destructive" disabled={busy || mode !== 'write'} onClick={() => setConfirmation({ title: t('resourceDeleteRow'), description: JSON.stringify(selected.values), confirmLabel: t('commonDelete'), tone: 'destructive', onConfirm: () => { setConfirmation(null); void mutate('delete'); } })}>{t('resourceDeleteRow')}</Button>}</div></FieldGroup>}
    <ConfirmActionDialog action={confirmation} onOpenChange={open => { if (!open) setConfirmation(null); }} />
  </div>;
}
