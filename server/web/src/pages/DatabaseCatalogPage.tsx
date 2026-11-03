import { useEffect, useRef, useState } from 'react';
import { useTranslation } from '@steamharness/i18n/react';
import { apiClient } from '../api';
import { isApiSuccess, type Summary } from '../types';
import { Alert, AlertDescription, Button, Field, FieldLabel, FieldGroup, Input, SelectField } from '@/components/ui';
import type { ResourceKind } from './DatabaseSpacesPage';
import { ConfirmActionDialog, type ConfirmAction } from '@/components/ConfirmActionDialog';

/** Resource access is owned by accounts. A project binding never grants resource access. */
export function DatabaseCatalogPage({ kind, resourceId, project }: { kind: ResourceKind; resourceId: string; project?: Summary }) {
  const { t } = useTranslation('serverWeb');
  const [grants, setGrants] = useState<any[]>([]), [error, setError] = useState(''), [canManage, setCanManage] = useState(false), [busy, setBusy] = useState(false), [userId, setUserId] = useState(''), [mode, setMode] = useState('read');
  const [entryId, setEntryId] = useState(project?.defaultEntry ?? ''), [alias, setAlias] = useState(''), [schemaHash, setSchemaHash] = useState(''), [revision, setRevision] = useState(0), [confirmation, setConfirmation] = useState<ConfirmAction | null>(null);
  const controller = useRef(new AbortController()), mutation = useRef(false);
  useEffect(() => {
    controller.current = new AbortController(); const signal = controller.current.signal;
    setGrants([]); setCanManage(false); setSchemaHash(''); setError(''); setBusy(false);
    void apiClient.resourceRequest(kind, `/${resourceId}/grants`, undefined, 'GET', signal).then(result => { if (!signal.aborted && isApiSuccess(result)) { setGrants(result.data); setCanManage(true); } }).catch(error => { if (!signal.aborted) setError(String(error)); });
    if (kind === 'databases') void apiClient.resourceRequest(kind, `/${resourceId}`, undefined, 'GET', signal).then(result => { if (!signal.aborted && isApiSuccess(result)) setSchemaHash(result.data.schemaHash ?? ''); }).catch(error => { if (!signal.aborted) setError(String(error)); });
    return () => controller.current.abort();
  }, [kind, resourceId, revision]);
  const send = async (endpoint: string, body: unknown, method = 'POST') => {
    if (mutation.current) return; mutation.current = true; setBusy(true); setError(''); const signal = controller.current.signal;
    try { const result = await apiClient.resourceRequest(kind, endpoint, body, method, signal); if (signal.aborted) return; if (!isApiSuccess(result)) throw new Error(result.errMessage); setRevision(value => value + 1); }
    catch (error) { if (!signal.aborted) setError(error instanceof Error ? error.message : String(error)); }
    finally { mutation.current = false; if (!signal.aborted) setBusy(false); }
  };
  const entry = project?.entries.find(entry => entry.entryId === entryId), requirements = entry?.knowledgeBases ?? [];
  return <div className="flex flex-col gap-3">
    {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
    {canManage && <><h3>{t('resourceGrants')}</h3><FieldGroup className="flex flex-wrap items-end gap-3"><Field><FieldLabel htmlFor="resource-user">{t('resourceUser')}</FieldLabel><Input id="resource-user" value={userId} disabled={busy} onChange={event => setUserId(event.target.value)} /></Field><Field><FieldLabel>{t('resourceGrants')}</FieldLabel><SelectField value={mode} options={[{ value: 'read', label: t('databaseRead') }, { value: 'write', label: t('databaseWrite') }]} onValueChange={setMode} disabled={busy} /></Field><Button disabled={busy || !userId.trim()} onClick={() => void send(`/${resourceId}/grants`, { userId: userId.trim(), mode })}>{t('resourceGrant')}</Button></FieldGroup>{grants.filter(grant => !grant.revoked).map(grant => <div key={grant.userId} className="flex items-center gap-3"><code>{grant.userId}</code><span>{grant.mode}</span><Button variant="outline" disabled={busy} onClick={() => setConfirmation({ title: t('resourceRevoke'), description: grant.userId, confirmLabel: t('commonConfirm'), tone: 'warning', onConfirm: () => { setConfirmation(null); void send(`/${resourceId}/grants/${encodeURIComponent(grant.userId)}`, undefined, 'DELETE'); } })}>{t('resourceRevoke')}</Button></div>)}</>}
    {project && <FieldGroup><Field><FieldLabel>{t('resourceBinding')}</FieldLabel><SelectField value={entryId} options={project.entries.map(entry => ({ value: entry.entryId, label: entry.name }))} onValueChange={value => { setEntryId(value); setAlias(''); }} /></Field><Field><FieldLabel>{t('resourceAlias')}</FieldLabel>{kind === 'databases' ? <Input value={alias} disabled={busy} onChange={event => setAlias(event.target.value)} /> : <SelectField value={alias} options={requirements.map(item => ({ value: item.alias, label: item.alias }))} onValueChange={setAlias} />}</Field><div className="flex gap-3"><Button disabled={busy || !/^[a-z][a-z0-9_-]{0,63}$/.test(alias) || kind === 'databases' && !schemaHash} onClick={() => void send('/bindings', { projectId: project.id, entryId, alias, mode, ...(kind === 'databases' ? { databaseId: resourceId, schemaHash } : { knowledgeBaseId: resourceId }) })}>{t('resourceBind')}</Button><Button variant="outline" disabled={busy || !/^[a-z][a-z0-9_-]{0,63}$/.test(alias)} onClick={() => void send('/bindings', { projectId: project.id, entryId, alias }, 'DELETE')}>{t('resourceUnbind')}</Button></div></FieldGroup>}
    <ConfirmActionDialog action={confirmation} onOpenChange={open => { if (!open) setConfirmation(null); }} />
  </div>;
}
