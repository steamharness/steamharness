import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from '@steamharness/i18n/react';
import { apiClient } from '../../api';
import { isApiSuccess } from '../../types';
import { Alert, AlertDescription, Button, Empty, EmptyHeader, EmptyTitle, Field, FieldLabel, Input, Skeleton, TablePanel, TableHeader, TableHead, TableRow, TableBody, TableCell } from '@/components/ui';
import { KnowledgeTableWorkspace } from './KnowledgeTableWorkspace';
import { createServerKnowledgeRepository } from './knowledge-repository';
import { ConfirmActionDialog, type ConfirmAction } from '@/components/ConfirmActionDialog';

/** Knowledge records and private attachments are independent of business database models. */
export function DatabaseSpaceData({ spaceId, onDirtyChange }: { spaceId: string; onDirtyChange?: (value: boolean) => void }) {
  const { t } = useTranslation('serverWeb');
  const [mode, setMode] = useState('read'), [page, setPage] = useState(1), [files, setFiles] = useState<{ items: any[]; total: number }>(), [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [error, setError] = useState(''), [fileId, setFileId] = useState(''), [confirmation, setConfirmation] = useState<ConfirmAction | null>(null);
  const repository = useMemo(() => createServerKnowledgeRepository(apiClient, spaceId), [spaceId]);
  const controller = useRef(new AbortController()), preparing = useRef(false), mutation = useRef(false), imageUrls = useRef(new Map<string, string>());
  useEffect(() => {
    controller.current = new AbortController(); const signal = controller.current.signal;
    void apiClient.resourceRequest('knowledge-bases', `/${spaceId}`, undefined, 'GET', signal).then(result => { if (signal.aborted) return; if (isApiSuccess(result)) setMode(result.data.mode); else setError(result.errMessage); }).catch(error => { if (!signal.aborted) setError(String(error)); });
    return () => { controller.current.abort(); for (const url of imageUrls.current.values()) URL.revokeObjectURL(url); imageUrls.current.clear(); };
  }, [spaceId]);
  useEffect(() => {
    const abort = new AbortController(); setLoading(true); setError('');
    void apiClient.knowledgeOperation('' + spaceId, 'files.list', { page, pageSize: 20 }, abort.signal).then(result => { if (abort.signal.aborted) return; if (isApiSuccess(result)) setFiles(result.data as any); else setError(result.errMessage); }).catch(error => { if (!abort.signal.aborted) setError(String(error)); }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [spaceId, page, revision]);
  const run = async (operation: string, input: unknown, receive?: (data: any) => void) => {
    if (mutation.current) return; mutation.current = true; setBusy(true); setError(''); const signal = controller.current.signal;
    try { const result = await apiClient.knowledgeOperation(spaceId, operation, input, signal); if (signal.aborted) return; if (!isApiSuccess(result)) throw new Error(result.errMessage); receive?.(result.data); setRevision(value => value + 1); }
    catch (error) { if (!signal.aborted) setError(error instanceof Error ? error.message : String(error)); }
    finally { mutation.current = false; if (!signal.aborted) setBusy(false); }
  };
  const resolveImageSrc = useCallback(async (src: string) => {
    const match = /^database:\/\/([^/]+)\/files\/([a-f0-9-]+)$/i.exec(src);
    if (!match) return src; if (match[1] !== spaceId) return null;
    // Reauthorize each use. Do not carry object URLs between accounts or resources.
    const signal = controller.current.signal;
    const blob = await apiClient.fetchDatabaseFile(spaceId, match[2], signal);
    if (signal.aborted) return null;
    const previous = imageUrls.current.get(src); if (previous) URL.revokeObjectURL(previous);
    const url = URL.createObjectURL(blob); imageUrls.current.set(src, url); return url;
  }, [spaceId]);
  return <div className="flex min-h-0 flex-1 flex-col gap-4">
    {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
    <KnowledgeTableWorkspace repository={repository} readOnly={mode !== 'write'} onDirtyChange={onDirtyChange} resolveImageSrc={resolveImageSrc} />
    <h3>{t('resourceAttachments')}</h3>
    <Field><FieldLabel htmlFor="knowledge-upload">{t('resourceUpload')}</FieldLabel><Input id="knowledge-upload" type="file" disabled={busy || mode !== 'write'} onChange={event => {
      const file = event.target.files?.[0]; event.target.value = ''; if (!file || preparing.current || mutation.current) return; if (file.size > 50 * 1024 * 1024) { setError(t('databaseAttachmentSize')); return; }
      const signal = controller.current.signal; preparing.current = true; setBusy(true);
      void (async () => { try { const bytes = new Uint8Array(await file.arrayBuffer()); if (signal.aborted) return; let binary = ''; for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768)); await run('files.createFile', { name: file.name, mimeType: file.type || 'application/octet-stream', base64: btoa(binary) }, result => setFileId(result.id)); } catch (error) { if (!signal.aborted) setError(String(error)); } finally { preparing.current = false; if (!signal.aborted) setBusy(false); } })();
    }} /></Field>
    {fileId && <p>{t('resourceAttachmentLink')}: <code>{`database://${spaceId}/files/${fileId}`}</code></p>}
    {loading ? <Skeleton className="h-20" /> : files?.items.length ? <TablePanel><TableHeader><TableRow><TableHead>{t('resourceName')}</TableHead><TableHead>{t('resourceAttachmentLink')}</TableHead><TableHead>{t('resourceAttachments')}</TableHead></TableRow></TableHeader><TableBody>{files.items.map(file => <TableRow key={file.id}><TableCell>{file.name} ({file.size})</TableCell><TableCell><code>{`database://${spaceId}/files/${file.id}`}</code></TableCell><TableCell><Button variant="outline" disabled={busy} onClick={() => void run('files.readFile', { fileId: file.id }, result => { const bytes = Uint8Array.from(atob(result.base64), char => char.charCodeAt(0)); const url = URL.createObjectURL(new Blob([bytes], { type: result.file.mimeType })); const link = document.createElement('a'); link.href = url; link.download = file.name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); })}>{t('resourceDownload')}</Button><Button variant="destructive" disabled={busy || mode !== 'write'} onClick={() => setConfirmation({ title: t('commonDelete'), description: file.name, confirmLabel: t('commonDelete'), tone: 'destructive', onConfirm: () => { setConfirmation(null); void run('files.deleteFile', { fileId: file.id }); } })}>{t('commonDelete')}</Button></TableCell></TableRow>)}</TableBody></TablePanel> : !error && <Empty><EmptyHeader><EmptyTitle>{t('databaseEmpty')}</EmptyTitle></EmptyHeader></Empty>}
    <div className="flex items-center gap-3"><Button variant="outline" disabled={loading || page === 1} onClick={() => setPage(page - 1)}>{t('databasePrevious')}</Button><span>{page} / {Math.max(1, Math.ceil((files?.total ?? 0) / 20))}</span><Button variant="outline" disabled={loading || page * 20 >= (files?.total ?? 0)} onClick={() => setPage(page + 1)}>{t('databaseNext')}</Button></div>
    <ConfirmActionDialog action={confirmation} onOpenChange={open => { if (!open) setConfirmation(null); }} />
  </div>;
}
