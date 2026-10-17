import { useEffect, useRef, useState } from "react";
import { FilePlus, Loader2, Pencil, Save, Trash2 } from "lucide-react";
import { useTranslation } from "@workflow-code/i18n/react";
import { isKnowledgeSuccess, toKnowledgeDocument, type KnowledgeDocument, type KnowledgeWorkspaceProps } from "@workflow-code/knowledge-base";
import { Alert, AlertDescription, AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, Button, Field, FieldGroup, FieldLabel, Input, Separator, Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, Skeleton, Textarea } from "@/components/ui";
import { formatDate } from "@/utils/format";
import { KnowledgeDocumentPreview } from "./KnowledgeDocumentPreview";

interface DocumentSheetProps extends Pick<KnowledgeWorkspaceProps, "repository" | "readOnly" | "refreshToken" | "resolveImageSrc" | "onDirtyChange" | "onBusyChange"> {
  documentId?: string;
  onClose(): void;
  onChanged(): void;
}

export function KnowledgeDocumentSheet({ documentId, repository, readOnly, refreshToken, resolveImageSrc, onDirtyChange, onBusyChange, onClose, onChanged }: DocumentSheetProps) {
  const { t } = useTranslation();
  const initialMarkdown = useRef(documentId ? "" : t("newDocumentMarkdown"));
  const [document, setDocument] = useState<KnowledgeDocument | null>(null);
  const [draft, setDraft] = useState({ title: "", markdown: initialMarkdown.current });
  const [editing, setEditing] = useState(!documentId && !readOnly);
  const [loading, setLoading] = useState(!!documentId);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"close" | "cancel" | "delete" | null>(null);
  const mutationRef = useRef(false);
  const mutationController = useRef<AbortController | null>(null);
  const callbacks = useRef({ onDirtyChange, onBusyChange });
  callbacks.current = { onDirtyChange, onBusyChange };
  const dirty = document ? draft.title !== document.title || draft.markdown !== document.markdown : draft.title !== "" || draft.markdown !== initialMarkdown.current;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const busy = loading || saving || deleting;

  useEffect(() => { callbacks.current.onDirtyChange?.(dirty); }, [dirty]);
  useEffect(() => { callbacks.current.onBusyChange?.(busy); }, [busy]);
  useEffect(() => () => {
    mutationController.current?.abort();
    callbacks.current.onDirtyChange?.(false);
    callbacks.current.onBusyChange?.(false);
  }, []);

  useEffect(() => {
    if (!documentId || dirtyRef.current) { setLoading(false); return; }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void repository.getDocument(documentId, { signal: controller.signal }).then(result => {
      if (controller.signal.aborted || dirtyRef.current) return;
      if (!isKnowledgeSuccess(result)) throw new Error(result.errMessage || t("knowledgeLoadFailedFallback"));
      setDocument(result.data);
      setDraft({ title: result.data.title, markdown: result.data.markdown });
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : t("knowledgeLoadFailedFallback"));
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [repository, documentId, refreshToken, t]);

  function close() {
    if (mutationRef.current) return;
    if (dirtyRef.current) setConfirm("close");
    else onClose();
  }

  function cancelEdit() {
    if (dirtyRef.current) setConfirm("cancel");
    else if (!document) onClose();
    else setEditing(false);
  }

  async function save() {
    if (mutationRef.current || readOnly || !draft.title.trim()) return;
    mutationRef.current = true;
    const controller = new AbortController();
    mutationController.current = controller;
    setSaving(true);
    setError(null);
    const input = { title: draft.title.trim(), markdown: draft.markdown };
    try {
      const result = document
        ? await repository.updateDocument(document.id, input, { signal: controller.signal })
        : await repository.createDocument(input, { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (!isKnowledgeSuccess(result)) throw new Error(result.errMessage || t("knowledgeOperationFailed"));
      const saved = toKnowledgeDocument(result.data, input.markdown);
      setDocument(saved);
      setDraft({ title: saved.title, markdown: saved.markdown });
      setEditing(false);
      onChanged();
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : t("saveFailed"));
    } finally {
      if (!controller.signal.aborted) { mutationRef.current = false; setSaving(false); }
    }
  }

  async function remove() {
    if (mutationRef.current || readOnly || !document) return;
    mutationRef.current = true;
    const controller = new AbortController();
    mutationController.current = controller;
    setDeleting(true);
    setError(null);
    try {
      const result = await repository.deleteDocument(document.id, { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (!isKnowledgeSuccess(result)) throw new Error(result.errMessage || t("knowledgeOperationFailed"));
      onChanged();
      onClose();
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : t("knowledgeOperationFailed"));
    } finally {
      if (!controller.signal.aborted) { mutationRef.current = false; setDeleting(false); setConfirm(null); }
    }
  }

  const hasDocument = !!document;
  return (
    <Sheet open onOpenChange={open => { if (!open) close(); }}>
      <SheetContent className="w-full gap-0 sm:max-w-3xl" onEscapeKeyDown={event => { if (confirm || mutationRef.current) event.preventDefault(); }}>
        <SheetHeader className="shrink-0 pr-12">
          <SheetTitle className="break-words">{document?.title ?? (documentId ? t("preview") : t("newKnowledgeDocument"))}</SheetTitle>
          <SheetDescription className="break-all font-mono">{document?.id ?? documentId ?? t("newKnowledgeDocumentDescription")}</SheetDescription>
        </SheetHeader>
        <Separator />
        {hasDocument && <>
          <dl className="grid shrink-0 grid-cols-2 gap-4 p-4 text-sm">
            <div className="min-w-0"><dt className="text-muted-foreground">{t("createdAt")}</dt><dd className="break-words">{formatDate(document.createdAt)}</dd></div>
            <div className="min-w-0"><dt className="text-muted-foreground">{t("updatedAt")}</dt><dd className="break-words">{formatDate(document.updatedAt)}</dd></div>
          </dl>
          <Separator />
        </>}
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4" aria-busy={busy}>
          {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
          {loading && !document ? <div className="flex flex-col gap-4" role="status" aria-label={t("loadingDocument")}><Skeleton className="h-7 w-2/3" /><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-5/6" /><Skeleton className="h-52 w-full" /></div> : editing && !readOnly ? (
            <FieldGroup className="flex min-h-full flex-col">
              <Field><FieldLabel htmlFor="knowledge-title">{t("title")}</FieldLabel><Input id="knowledge-title" value={draft.title} disabled={busy} onChange={event => setDraft(current => ({ ...current, title: event.target.value }))} /></Field>
              <Field className="min-h-64 flex-1"><FieldLabel htmlFor="knowledge-markdown">{t("markdown")}</FieldLabel><Textarea id="knowledge-markdown" className="min-h-64 flex-1 resize-y font-mono" value={draft.markdown} disabled={busy} onChange={event => setDraft(current => ({ ...current, markdown: event.target.value }))} /></Field>
            </FieldGroup>
          ) : document && <KnowledgeDocumentPreview markdown={document.markdown} resolveImageSrc={resolveImageSrc} />}
        </div>
        <Separator />
        <SheetFooter className="shrink-0 sm:flex-row sm:items-center">
          {!readOnly && document && <Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirm("delete")}><Trash2 data-icon="inline-start" />{t("deleteDocument")}</Button>}
          <div className="flex flex-wrap items-center justify-end gap-2 sm:ml-auto">
            {editing && !readOnly ? <>
              <Button size="sm" variant="outline" disabled={busy} onClick={cancelEdit}>{t("cancel")}</Button>
              <Button size="sm" disabled={busy || !draft.title.trim() || (hasDocument && !dirty)} onClick={() => void save()}>{saving ? <Loader2 data-icon="inline-start" className="animate-spin" /> : hasDocument ? <Save data-icon="inline-start" /> : <FilePlus data-icon="inline-start" />}{hasDocument ? t("save") : t("create")}</Button>
            </> : <>
              <Button size="sm" variant="outline" disabled={saving || deleting} onClick={close}>{t("close")}</Button>
              {!readOnly && document && <Button size="sm" disabled={busy} onClick={() => setEditing(true)}><Pencil data-icon="inline-start" />{t("edit")}</Button>}
            </>}
          </div>
        </SheetFooter>
        <AlertDialog open={confirm !== null} onOpenChange={open => { if (!open && !mutationRef.current) setConfirm(null); }}>
          <AlertDialogContent>
            <AlertDialogHeader><AlertDialogTitle>{confirm === "delete" ? t("deleteDocument") : t("discardUnsavedChangesTitle")}</AlertDialogTitle><AlertDialogDescription>{confirm === "delete" ? t("deleteDocumentConfirm", { name: document?.title }) : t("discardUnsavedChangesDescription")}</AlertDialogDescription></AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={deleting}>{confirm === "delete" ? t("cancel") : t("continueEditing")}</AlertDialogCancel>
              <AlertDialogAction variant="destructive" disabled={deleting} onClick={event => {
                event.preventDefault();
                if (confirm === "delete") { void remove(); return; }
                if (confirm === "close" || !document) onClose();
                else { setDraft({ title: document.title, markdown: document.markdown }); setEditing(false); setConfirm(null); }
              }}>{deleting && <Loader2 data-icon="inline-start" className="animate-spin" />}{confirm === "delete" ? t("deleteDocument") : t("discardChanges")}</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </SheetContent>
    </Sheet>
  );
}
