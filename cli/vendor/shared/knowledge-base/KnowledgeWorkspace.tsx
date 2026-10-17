import { i18n } from "@workflow-code/i18n";
import { useTranslation } from "@workflow-code/i18n/react";
import { MarkdownContent } from "./run-workspace/markdown/markdown-content";
import { useModalFocus } from "./run-workspace/hooks/useOverlayFocus";
import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Eye,
  FilePlus,
  ImageIcon,
  Info,
  LoaderCircle,
  Pencil,
  RefreshCw,
  Save,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { createPortal } from "react-dom";
import * as React from "react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
  type RefObject,
} from "react";
import type {
  KnowledgeDocument,
  KnowledgeDocumentPage,
  KnowledgeDocumentRail,
  KnowledgeDocumentRowMenuRequest,
  KnowledgeDocumentSummary,
  KnowledgeRepository,
  KnowledgeResult,
  KnowledgeSearchResult,
  KnowledgeWorkspaceProps,
} from "./types";
import {
  formatKnowledgeDate,
  INLINE_IMAGE_MANUAL_LOAD_LIMIT,
  isKnowledgeSuccess,
  LARGE_MARKDOWN_PREVIEW_LIMIT,
  toKnowledgeDocument,
} from "./utils";
import * as knowledgeUtils from "./utils";
import styles from "./styles.module.css";

const DEFAULT_PAGE_SIZE = 20;
const DEFAULT_SEARCH_PAGE_SIZE = 200;

type EditorMode = "preview" | "edit";
type MutationKind = "create" | "save" | "delete" | null;
type PendingDiscardAction =
  | { type: "document"; documentId: string; edit?: boolean }
  | { type: "create" }
  | { type: "close-create" }
  | null;

interface DocumentDraft {
  title: string;
  markdown: string;
}

interface RequestTracker {
  requestId: number;
  controller: AbortController | null;
}

function createRequestTracker(): RequestTracker {
  return { requestId: 0, controller: null };
}

function isCurrentRequest(
  tracker: RequestTracker,
  requestId: number,
  controller: AbortController,
  workspaceEpoch: number,
  currentWorkspaceEpoch: number,
): boolean {
  return tracker.requestId === requestId
    && tracker.controller === controller
    && !controller.signal.aborted
    && workspaceEpoch === currentWorkspaceEpoch;
}

function formatRepositoryError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

export function KnowledgeWorkspace({
  repository,
  readOnly = false,
  initialDocumentId,
  refreshToken = 0,
  showRefreshAction = true,
  onBusyChange,
  documentRail,
  railCollapsed = false,
  documentRowMenu,
  resolveImageSrc,
  onError,
  onDirtyChange,
  pageSize = DEFAULT_PAGE_SIZE,
  searchPageSize = DEFAULT_SEARCH_PAGE_SIZE,
}: KnowledgeWorkspaceProps) {
  const { t } = useTranslation();
  const [documents, setDocuments] = useState<KnowledgeDocumentSummary[] | null>(null);
  const [page, setPage] = useState<KnowledgeDocumentPage | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedDocument, setSelectedDocument] = useState<KnowledgeDocument | null>(null);
  const [mode, setMode] = useState<EditorMode>("preview");
  const [draft, setDraft] = useState<DocumentDraft>({ title: "", markdown: "" });
  const [createDraftBaseline, setCreateDraftBaseline] = useState(() => t("newDocumentMarkdown"));
  const [createDraft, setCreateDraft] = useState<DocumentDraft>(() => ({
    title: "",
    markdown: t("newDocumentMarkdown"),
  }));
  const [query, setQuery] = useState("");
  const [searchResult, setSearchResult] = useState<KnowledgeSearchResult | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const [documentLoading, setDocumentLoading] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchLoadingMore, setSearchLoadingMore] = useState(false);
  const [mutation, setMutation] = useState<MutationKind>(null);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  // The document the confirm dialog would delete: the open one from the
  // toolbar, or the row a host's context menu was used on.
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const [discardDraftOpen, setDiscardDraftOpen] = useState(false);
  const [pendingDiscardAction, setPendingDiscardAction] = useState<PendingDiscardAction>(null);

  const documentsRef = useRef(documents);
  const pageRef = useRef(page);
  const selectedIdRef = useRef(selectedId);
  const selectedDocumentRef = useRef(selectedDocument);
  const draftRef = useRef(draft);
  const deleteTargetRef = useRef<{ id: string; title: string } | null>(null);
  const hasDirtyDraftRef = useRef(false);
  const mutationRef = useRef<MutationKind>(mutation);
  const onDirtyChangeRef = useRef(onDirtyChange);
  const onBusyChangeRef = useRef(onBusyChange);
  const searchResultRef = useRef(searchResult);
  const listTrackerRef = useRef(createRequestTracker());
  const documentTrackerRef = useRef(createRequestTracker());
  const searchTrackerRef = useRef(createRequestTracker());
  const mutationTrackerRef = useRef(createRequestTracker());
  const workspaceEpochRef = useRef(0);
  const previousRepositoryRef = useRef(repository);
  const documentListRef = useRef<HTMLDivElement | null>(null);
  // Repositories page by opaque cursor, so they cannot jump to an index: each
  // page's opening cursor is kept — going back re-requests the stored one, going
  // forward uses the cursor the previous page returned.
  const pageCursorsRef = useRef<(string | undefined)[]>([undefined]);
  const pageIndexRef = useRef(0);
  const resetPageCursors = useCallback(() => {
    pageCursorsRef.current = [undefined];
    pageIndexRef.current = 0;
  }, []);
  const createTriggerRef = useRef<HTMLButtonElement | null>(null);
  const deleteTriggerRef = useRef<HTMLButtonElement | null>(null);
  const infoTriggerRef = useRef<HTMLButtonElement | null>(null);
  const createTitleRef = useRef<HTMLInputElement | null>(null);
  const deleteCancelRef = useRef<HTMLButtonElement | null>(null);
  const discardCancelRef = useRef<HTMLButtonElement | null>(null);

  documentsRef.current = documents;
  pageRef.current = page;
  pageIndexRef.current = pageIndex;
  selectedIdRef.current = selectedId;
  selectedDocumentRef.current = selectedDocument;
  draftRef.current = draft;
  deleteTargetRef.current = deleteTarget;
  searchResultRef.current = searchResult;
  onDirtyChangeRef.current = onDirtyChange;
  onBusyChangeRef.current = onBusyChange;
  mutationRef.current = mutation;

  const hasDirtyDocumentDraft = selectedDocument !== null
    && (draft.title !== selectedDocument.title || draft.markdown !== selectedDocument.markdown);
  const hasDirtyCreateDraft = (createOpen || pendingDiscardAction?.type === "close-create")
    && (createDraft.title.trim() !== "" || createDraft.markdown !== createDraftBaseline);
  const hasDirtyDraft = hasDirtyDocumentDraft || hasDirtyCreateDraft;
  hasDirtyDraftRef.current = hasDirtyDraft;

  useEffect(() => {
    onDirtyChange?.(hasDirtyDraft);
  }, [hasDirtyDraft, onDirtyChange]);

  useEffect(() => () => {
    onDirtyChangeRef.current?.(false);
    onBusyChangeRef.current?.(false);
  }, []);

  const reportError = useCallback((message: string) => {
    setError(message);
    onError?.(message);
  }, [onError]);

  const abortTracker = useCallback((tracker: RequestTracker) => {
    tracker.requestId += 1;
    tracker.controller?.abort();
    tracker.controller = null;
  }, []);

  const abortAllRequests = useCallback(() => {
    abortTracker(listTrackerRef.current);
    abortTracker(documentTrackerRef.current);
    abortTracker(searchTrackerRef.current);
    abortTracker(mutationTrackerRef.current);
  }, [abortTracker]);

  const loadDocument = useCallback(async (
    documentId: string,
    workspaceEpoch = workspaceEpochRef.current,
    mode: EditorMode = "preview",
  ) => {
    const tracker = documentTrackerRef.current;
    abortTracker(tracker);
    const controller = new AbortController();
    const requestId = ++tracker.requestId;
    tracker.controller = controller;
    setError(null);
    selectedIdRef.current = documentId;
    selectedDocumentRef.current = null;
    setSelectedId(documentId);
    setSelectedDocument(null);
    setDocumentLoading(true);

    let result: KnowledgeResult<KnowledgeDocument>;
    try {
      result = await repository.getDocument(documentId, { signal: controller.signal });
    } catch (error) {
      if (!isCurrentRequest(tracker, requestId, controller, workspaceEpoch, workspaceEpochRef.current)) return;
      tracker.controller = null;
      setDocumentLoading(false);
      reportError(formatRepositoryError(error, i18n.t("knowledgeLoadFailedFallback")));
      return;
    }
    if (!isCurrentRequest(tracker, requestId, controller, workspaceEpoch, workspaceEpochRef.current)) return;

    tracker.controller = null;
    setDocumentLoading(false);
    if (!isKnowledgeSuccess(result)) {
      reportError(result.errMessage || i18n.t("knowledgeLoadFailedFallback"));
      return;
    }
    const nextDraft = { title: result.data.title, markdown: result.data.markdown };
    // apply document, draft, and mode together so a later effect cannot undo an immediate edit action.
    selectedDocumentRef.current = result.data;
    draftRef.current = nextDraft;
    setSelectedDocument(result.data);
    setDraft(nextDraft);
    setMode(mode);
    setDeleteOpen(false);
  }, [abortTracker, reportError, repository]);

  const loadPage = useCallback(async (
    targetIndex: number,
    workspaceEpoch: number,
    options: { reloadSelectedDocument?: boolean } = {},
  ) => {
    const cursor = pageCursorsRef.current[targetIndex];
    if (targetIndex > 0 && !cursor) return;
    const tracker = listTrackerRef.current;
    abortTracker(tracker);
    const controller = new AbortController();
    const requestId = ++tracker.requestId;
    tracker.controller = controller;
    const retainedSelectedId = selectedIdRef.current;
    setError(null);
    setListError(null);
    setListLoading(true);

    // A failed page turn keeps the page the user was reading; the first page
    // failing is what empties the list and offers a retry.
    const failureFallback = targetIndex > 0
      ? i18n.t("knowledgeLoadPageFailed")
      : i18n.t("knowledgeLoadFailedFallback");
    let result: KnowledgeResult<KnowledgeDocumentPage>;
    try {
      result = await repository.listDocuments({ pageSize, cursor, signal: controller.signal });
    } catch (error) {
      if (!isCurrentRequest(tracker, requestId, controller, workspaceEpoch, workspaceEpochRef.current)) return;
      tracker.controller = null;
      setListLoading(false);
      const message = formatRepositoryError(error, failureFallback);
      setListError(message);
      reportError(message);
      return;
    }
    if (!isCurrentRequest(tracker, requestId, controller, workspaceEpoch, workspaceEpochRef.current)) return;

    tracker.controller = null;
    setListLoading(false);
    if (!isKnowledgeSuccess(result)) {
      const message = result.errMessage || failureFallback;
      setListError(message);
      reportError(message);
      return;
    }

    setDocuments(result.data.items);
    setPage(result.data);
    setPageIndex(targetIndex);
    pageCursorsRef.current[targetIndex + 1] = result.data.nextCursor ?? undefined;
    if (!result.data.nextCursor) pageCursorsRef.current.length = targetIndex + 1;
    const selectedIdStillCurrent = retainedSelectedId === selectedIdRef.current;
    if (
      retainedSelectedId &&
      selectedIdStillCurrent &&
      result.data.items.some((document) => document.id === retainedSelectedId)
    ) {
      // A refresh can update summaries while the editor has unsaved text. Do
      // not replace the body in that state; explicit selection still uses the
      // shared discard guard below.
      if (!hasDirtyDraftRef.current && options.reloadSelectedDocument !== false) {
        void loadDocument(retainedSelectedId, workspaceEpoch);
      }
      return;
    }
    if (retainedSelectedId && selectedIdStillCurrent && (
      hasDirtyDraftRef.current || retainedSelectedId === initialDocumentId
    )) {
      // A selected item can sit on a later page. Refreshing only the first
      // page must not throw away an editor draft merely because its summary is
      // not in the refreshed window.
      return;
    }
    if (retainedSelectedId && selectedIdStillCurrent) {
      abortTracker(documentTrackerRef.current);
      selectedIdRef.current = null;
      selectedDocumentRef.current = null;
      setSelectedId(null);
      setSelectedDocument(null);
      setDocumentLoading(false);
    }
  }, [abortTracker, loadDocument, pageSize, reportError, repository]);

  useEffect(() => {
    const workspaceEpoch = workspaceEpochRef.current + 1;
    workspaceEpochRef.current = workspaceEpoch;
    const repositoryChanged = previousRepositoryRef.current !== repository;
    previousRepositoryRef.current = repository;
    abortAllRequests();
    setMutation(null);
    setDocumentLoading(false);
    setSearchLoading(false);
    setSearchLoadingMore(false);
    pageCursorsRef.current = [undefined];
    pageIndexRef.current = 0;
    setPageIndex(0);

    if (repositoryChanged) {
      setDocuments(null);
      setPage(null);
      setSelectedId(null);
      setSelectedDocument(null);
      setSearchResult(null);
      setQuery("");
      setMode("preview");
      setDraft({ title: "", markdown: "" });
      setCreateOpen(false);
      setDeleteOpen(false);
      setDeleteTarget(null);
      setInfoOpen(false);
      setDiscardDraftOpen(false);
      setPendingDiscardAction(null);
    }
    mutationRef.current = null;

    void loadPage(0, workspaceEpoch);
    if (initialDocumentId) void loadDocument(initialDocumentId, workspaceEpoch);
    return () => {
      if (workspaceEpochRef.current === workspaceEpoch) abortAllRequests();
    };
  }, [abortAllRequests, initialDocumentId, loadDocument, loadPage, refreshToken, repository]);

  // Manual refresh from the toolbar. `loadPage` already protects an unsaved
  // editor draft, so this only re-reads summaries (and the selected document
  // when it is clean) — of the page the user is looking at.
  const refreshWorkspace = useCallback(() => {
    if (mutationRef.current !== null) return;
    void loadPage(pageIndexRef.current, workspaceEpochRef.current);
  }, [loadPage]);

  const requestDocumentPage = useCallback((nextIndex: number) => {
    if (nextIndex < 0 || nextIndex === pageIndexRef.current) return;
    void loadPage(nextIndex, workspaceEpochRef.current);
  }, [loadPage]);

  const handleSearch = useCallback(async () => {
    const trimmedQuery = query.trim();
    if (!trimmedQuery || searchLoading) return;
    const tracker = searchTrackerRef.current;
    abortTracker(tracker);
    const controller = new AbortController();
    const requestId = ++tracker.requestId;
    tracker.controller = controller;
    const workspaceEpoch = workspaceEpochRef.current;
    setError(null);
    setSearchLoading(true);
    setSearchLoadingMore(false);
    setSearchResult(null);
    let result: KnowledgeResult<KnowledgeSearchResult>;
    try {
      result = await repository.searchDocuments({
        query: trimmedQuery,
        beforeLines: 1,
        afterLines: 1,
        pageSize: searchPageSize,
        signal: controller.signal,
      });
    } catch (error) {
      if (!isCurrentRequest(tracker, requestId, controller, workspaceEpoch, workspaceEpochRef.current)) return;
      tracker.controller = null;
      setSearchLoading(false);
      reportError(formatRepositoryError(error, i18n.t("knowledgeSearchFailed")));
      return;
    }
    if (!isCurrentRequest(tracker, requestId, controller, workspaceEpoch, workspaceEpochRef.current)) return;

    tracker.controller = null;
    setSearchLoading(false);
    if (!isKnowledgeSuccess(result)) {
      reportError(result.errMessage || i18n.t("knowledgeSearchFailed"));
      return;
    }
    setSearchResult(result.data);
  }, [abortTracker, query, reportError, repository, searchLoading, searchPageSize]);

  // Handed to a host rail as its submit action; the built-in form submits the
  // same way, so both surfaces search on Enter rather than on every keystroke.
  const submitSearch = useCallback(() => {
    void handleSearch();
  }, [handleSearch]);

  const loadMoreSearchResults = useCallback(async () => {
    const current = searchResultRef.current;
    if (!current?.hasMore || !current.nextCursor || searchLoadingMore || searchLoading) return;
    const tracker = searchTrackerRef.current;
    abortTracker(tracker);
    const controller = new AbortController();
    const requestId = ++tracker.requestId;
    tracker.controller = controller;
    const workspaceEpoch = workspaceEpochRef.current;
    setError(null);
    setSearchLoadingMore(true);
    let result: KnowledgeResult<KnowledgeSearchResult>;
    try {
      result = await repository.searchDocuments({
        query: current.query,
        beforeLines: 1,
        afterLines: 1,
        pageSize: current.pageSize || searchPageSize,
        cursor: current.nextCursor,
        signal: controller.signal,
      });
    } catch (error) {
      if (!isCurrentRequest(tracker, requestId, controller, workspaceEpoch, workspaceEpochRef.current)) return;
      tracker.controller = null;
      setSearchLoadingMore(false);
      reportError(formatRepositoryError(error, i18n.t("knowledgeSearchLoadMoreFailed")));
      return;
    }
    if (!isCurrentRequest(tracker, requestId, controller, workspaceEpoch, workspaceEpochRef.current)) return;

    tracker.controller = null;
    setSearchLoadingMore(false);
    if (!isKnowledgeSuccess(result)) {
      reportError(result.errMessage || i18n.t("knowledgeSearchLoadMoreFailed"));
      return;
    }
    setSearchResult((previous) => previous?.query === current.query
      ? { ...result.data, matches: [...previous.matches, ...result.data.matches] }
      : result.data);
  }, [abortTracker, reportError, repository, searchLoading, searchLoadingMore, searchPageSize]);

  const runMutation = useCallback(async <T,>(
    kind: Exclude<MutationKind, null>,
    request: (signal: AbortSignal) => Promise<KnowledgeResult<T>>,
  ): Promise<T | null> => {
    if (readOnly) return null;
    const tracker = mutationTrackerRef.current;
    abortTracker(tracker);
    const controller = new AbortController();
    const requestId = ++tracker.requestId;
    tracker.controller = controller;
    const workspaceEpoch = workspaceEpochRef.current;
    setError(null);
    mutationRef.current = kind;
    setMutation(kind);
    let result: KnowledgeResult<T>;
    try {
      result = await request(controller.signal);
    } catch (error) {
      if (!isCurrentRequest(tracker, requestId, controller, workspaceEpoch, workspaceEpochRef.current)) return null;
      tracker.controller = null;
      mutationRef.current = null;
      setMutation(null);
      reportError(formatRepositoryError(error, i18n.t("knowledgeOperationFailed")));
      return null;
    }
    if (!isCurrentRequest(tracker, requestId, controller, workspaceEpoch, workspaceEpochRef.current)) return null;

    tracker.controller = null;
    mutationRef.current = null;
    setMutation(null);
    if (!isKnowledgeSuccess(result)) {
      reportError(result.errMessage || i18n.t("knowledgeOperationFailed"));
      return null;
    }
    return result.data;
  }, [abortTracker, readOnly, reportError]);

  const clearSearchResult = useCallback(() => {
    abortTracker(searchTrackerRef.current);
    setSearchLoading(false);
    setSearchLoadingMore(false);
    setSearchResult(null);
  }, [abortTracker]);

  // Both rails type through here: a changed query always drops the previous
  // results, so what is on screen never answers a query the field no longer
  // holds. Only `submit` — pressing Enter — actually searches.
  const handleSearchQueryChange = useCallback((nextQuery: string) => {
    setQuery(nextQuery);
    clearSearchResult();
  }, [clearSearchResult]);

  const applyDocument = useCallback((document: KnowledgeDocument) => {
    const nextDraft = { title: document.title, markdown: document.markdown };
    selectedIdRef.current = document.id;
    selectedDocumentRef.current = document;
    draftRef.current = nextDraft;
    setSelectedId(document.id);
    setSelectedDocument(document);
    setDraft(nextDraft);
    setMode("preview");
    setDeleteOpen(false);
  }, []);

  const resetCreateDraft = useCallback(() => {
    const markdown = i18n.t("newDocumentMarkdown");
    setCreateDraftBaseline(markdown);
    setCreateDraft({ title: "", markdown });
  }, []);

  // Reads the dirty draft from its ref: the callback is part of the document
  // list's props, and depending on the draft would rebuild the list (and any
  // host rail around it) on every keystroke.
  const requestDocumentSelection = useCallback((documentId: string) => {
    if (mutationRef.current !== null) return;
    if (documentId === selectedIdRef.current && selectedDocumentRef.current !== null) return;
    if (hasDirtyDraftRef.current) {
      setPendingDiscardAction({ type: "document", documentId });
      setDiscardDraftOpen(true);
      return;
    }
    void loadDocument(documentId);
  }, [loadDocument]);

  // Row menu action: open that document straight in the editor. An already open
  // document only switches mode; another one goes through the draft guard.
  const requestEditDocument = useCallback((documentId: string) => {
    if (mutationRef.current !== null) return;
    if (documentId === selectedIdRef.current && selectedDocumentRef.current !== null) {
      setMode("edit");
      return;
    }
    if (hasDirtyDraftRef.current) {
      setPendingDiscardAction({ type: "document", documentId, edit: true });
      setDiscardDraftOpen(true);
      return;
    }
    void loadDocument(documentId, workspaceEpochRef.current, "edit");
  }, [loadDocument]);

  // Row menu action: confirm the deletion of a row that is not necessarily the
  // open document, so the target is carried by the dialog rather than by the
  // selection.
  const requestRemoveDocument = useCallback((document: KnowledgeDocumentSummary) => {
    if (mutationRef.current !== null) return;
    setDeleteTarget({ id: document.id, title: document.title });
    setDeleteOpen(true);
  }, []);

  const requestCreateDocument = useCallback(() => {
    if (mutationRef.current !== null) return;
    if (hasDirtyDraft) {
      setPendingDiscardAction({ type: "create" });
      setDiscardDraftOpen(true);
      return;
    }
    resetCreateDraft();
    setCreateOpen(true);
  }, [hasDirtyDraft, resetCreateDraft]);

  const requestCloseCreateDocument = useCallback(() => {
    if (mutationRef.current !== null) return;
    if (hasDirtyCreateDraft) {
      // Close the create dialog before presenting the discard confirmation so
      // only one modal owns focus. Choosing to continue editing restores it.
      setCreateOpen(false);
      setPendingDiscardAction({ type: "close-create" });
      setDiscardDraftOpen(true);
      return;
    }
    resetCreateDraft();
    setCreateOpen(false);
  }, [hasDirtyCreateDraft, resetCreateDraft]);

  const cancelDiscardDraft = useCallback(() => {
    const action = pendingDiscardAction;
    setDiscardDraftOpen(false);
    setPendingDiscardAction(null);
    if (action?.type === "close-create") {
      setCreateOpen(true);
    }
  }, [pendingDiscardAction]);

  const discardDraftAndContinue = useCallback(() => {
    if (mutationRef.current !== null) return;
    const action = pendingDiscardAction;
    const current = selectedDocumentRef.current;
    if (current) {
      const restoredDraft = { title: current.title, markdown: current.markdown };
      draftRef.current = restoredDraft;
      setDraft(restoredDraft);
    }
    setDiscardDraftOpen(false);
    setPendingDiscardAction(null);
    if (action?.type === "document") {
      void loadDocument(action.documentId, workspaceEpochRef.current, action.edit ? "edit" : "preview");
    } else if (action?.type === "create") {
      resetCreateDraft();
      setCreateOpen(true);
    } else if (action?.type === "close-create") {
      resetCreateDraft();
      setCreateOpen(false);
    }
  }, [loadDocument, pendingDiscardAction, resetCreateDraft]);

  const createDocument = useCallback(async () => {
    if (!createDraft.title.trim() || mutation) return;
    const input = { title: createDraft.title.trim(), markdown: createDraft.markdown };
    const result = await runMutation("create", (signal) => repository.createDocument(input, { signal }));
    if (!result) return;
    clearSearchResult();
    const document = toKnowledgeDocument(result, input.markdown);
    applyDocument(document);
    resetCreateDraft();
    setCreateOpen(false);
    // Replacing the first page after a mutation avoids retaining an opaque
    // cursor whose position may no longer describe the refreshed index.
    resetPageCursors();
    await loadPage(0, workspaceEpochRef.current, { reloadSelectedDocument: false });
  }, [applyDocument, clearSearchResult, createDraft, loadPage, mutation, repository, resetCreateDraft, resetPageCursors, runMutation]);

  const saveDocument = useCallback(async () => {
    const current = selectedDocumentRef.current;
    if (!current || mutation || draft.title.trim() === "") return;
    const input = { title: draft.title.trim(), markdown: draft.markdown };
    const result = await runMutation("save", (signal) => repository.updateDocument(current.id, input, { signal }));
    if (!result) return;
    clearSearchResult();
    applyDocument(toKnowledgeDocument(result, input.markdown));
    resetPageCursors();
    await loadPage(0, workspaceEpochRef.current, { reloadSelectedDocument: false });
  }, [applyDocument, clearSearchResult, draft, loadPage, mutation, repository, resetPageCursors, runMutation]);

  const deleteDocument = useCallback(async () => {
    const target = deleteTargetRef.current;
    if (!target || mutation) return;
    const result = await runMutation("delete", (signal) => repository.deleteDocument(target.id, { signal }));
    if (!result) return;
    clearSearchResult();
    setDeleteOpen(false);
    setDeleteTarget(null);
    // Only the document that was open leaves the editor; a row deleted from the
    // list while another document is open must not close it.
    if (selectedIdRef.current === target.id) {
      abortTracker(documentTrackerRef.current);
      selectedIdRef.current = null;
      selectedDocumentRef.current = null;
      setSelectedId(null);
      setSelectedDocument(null);
    }
    resetPageCursors();
    await loadPage(0, workspaceEpochRef.current);
  }, [abortTracker, clearSearchResult, loadPage, mutation, repository, resetPageCursors, runMutation]);

  const previewDocument = useMemo(
    () => selectedDocument === null
      ? null
      : { ...selectedDocument, title: draft.title, markdown: draft.markdown },
    [draft, selectedDocument],
  );
  const selectedSummary = documents?.find((document) => document.id === selectedDocument?.id);
  const isMutating = mutation !== null;
  const workspaceBusy = listLoading || documentLoading || searchLoading || searchLoadingMore || isMutating;
  useEffect(() => {
    onBusyChange?.(workspaceBusy);
  }, [onBusyChange, workspaceBusy]);
  const previewMetrics = useMemo(() => {
    // Updating a controlled textarea must not repeatedly scan its entire
    // Markdown body. Parse only when the user explicitly opens the preview.
    if (mode !== "preview" || previewDocument === null) {
      return { markdownByteLength: 0, imageCount: 0 };
    }
    const markdownByteLength = knowledgeUtils.getKnowledgeMarkdownByteLength(
      previewDocument.markdown,
      LARGE_MARKDOWN_PREVIEW_LIMIT,
    );
    return {
      markdownByteLength,
      imageCount: markdownByteLength <= LARGE_MARKDOWN_PREVIEW_LIMIT
        ? knowledgeUtils.countMarkdownImages(previewDocument.markdown)
        : 0,
    };
  }, [mode, previewDocument]);

  // The document index is the same element in both rails: the built-in sidebar
  // renders it directly, a host rail receives it through `documentRail`. It is
  // memoized because editing a document re-renders this component per keystroke
  // and the rail must not re-render with it.
  const totalPages = page ? Math.max(1, Math.ceil(page.total / pageSize)) : 1;
  const documentList = useMemo(() => (
    <KnowledgeDocumentList
      documents={documents}
      page={page}
      pageIndex={pageIndex}
      totalPages={totalPages}
      selectedId={selectedId}
      loading={listLoading}
      error={listError}
      disabled={isMutating}
      listRef={documentListRef}
      onSelect={requestDocumentSelection}
      onRequestPage={requestDocumentPage}
      onRowMenu={readOnly ? undefined : documentRowMenu}
      onRowEdit={requestEditDocument}
      onRowRemove={requestRemoveDocument}
      onRetry={() => void loadPage(0, workspaceEpochRef.current)}
    />
  ), [
    documents,
    documentRowMenu,
    readOnly,
    isMutating,
    listError,
    listLoading,
    loadPage,
    page,
    pageIndex,
    requestDocumentPage,
    requestDocumentSelection,
    requestEditDocument,
    requestRemoveDocument,
    selectedId,
    totalPages,
  ]);
  // The results panel renders nothing until a query runs, so a host can place
  // it unconditionally next to the list it was given.
  const searchResults = useMemo(() => (
    <KnowledgeSearchResults
      loading={searchLoading}
      loadingMore={searchLoadingMore}
      disabled={isMutating}
      result={searchResult}
      onOpenDocument={requestDocumentSelection}
      onLoadMore={() => void loadMoreSearchResults()}
    />
  ), [
    isMutating,
    loadMoreSearchResults,
    requestDocumentSelection,
    searchLoading,
    searchLoadingMore,
    searchResult,
  ]);
  const railPayload = useMemo<KnowledgeDocumentRail | null>(
    () => (documentRail
      ? {
        list: documentList,
        total: page?.total ?? null,
        busy: listLoading || isMutating,
        refresh: refreshWorkspace,
        search: {
          value: query,
          onValueChange: handleSearchQueryChange,
          submit: submitSearch,
          node: searchResults,
        },
      }
      : null),
    [
      documentList,
      documentRail,
      handleSearchQueryChange,
      isMutating,
      listLoading,
      page?.total,
      query,
      refreshWorkspace,
      searchResults,
      submitSearch,
    ],
  );
  const railNode = useMemo(
    () => (documentRail && railPayload ? documentRail(railPayload) : null),
    [documentRail, railPayload],
  );

  return (
    <div className={styles.workspaceShell} data-slot="knowledge-workspace">
      <div
        className={railCollapsed ? `${styles.workspace} ${styles.workspaceRailCollapsed}` : styles.workspace}
        data-slot="knowledge-workspace-grid"
        data-rail={railCollapsed ? "collapsed" : "expanded"}
      >
        {railCollapsed ? null : (
        <aside className={styles.sidebar} aria-label={t("knowledgeDocumentNavigation")}>
          {railNode ?? (
            <>
              <form
                className={styles.searchForm}
                onSubmit={(event: FormEvent<HTMLFormElement>) => {
                  event.preventDefault();
                  submitSearch();
                }}
              >
                <label className={styles.searchField}>
                  <Search aria-hidden="true" size={16} />
                  <input
                    type="search"
                    value={query}
                    placeholder={t("searchDocumentPlaceholder")}
                    aria-label={t("searchKnowledgeDocument")}
                    onChange={(event) => handleSearchQueryChange(event.target.value)}
                  />
                  {searchLoading ? <LoaderCircle className={styles.spin} aria-label={t("searchingKnowledgeBase")} size={16} /> : <kbd>Enter</kbd>}
                </label>
              </form>

              {documentList}

              <KnowledgeSearchResults
                loading={searchLoading}
                loadingMore={searchLoadingMore}
                disabled={isMutating}
                result={searchResult}
                onOpenDocument={requestDocumentSelection}
                onLoadMore={() => void loadMoreSearchResults()}
              />
            </>
          )}
        </aside>
        )}

        <main className={styles.main}>
          <header className={styles.toolbar}>
            <div className={styles.documentTitle}>
              <BookOpen aria-hidden="true" size={18} />
              <h2>{previewDocument?.title ?? (documentLoading ? t("loadingDocument") : t("selectOrNewDocument"))}</h2>
            </div>
            <div className={styles.toolbarActions}>
              {showRefreshAction ? (
                <>
                  <button
                    type="button"
                    className={styles.toolbarAction}
                    title={t("refreshKnowledgeBase")}
                    aria-label={listLoading ? t("refreshingKnowledgeBase") : t("refreshKnowledgeBase")}
                    disabled={listLoading || isMutating}
                    onClick={refreshWorkspace}
                  >
                    <RefreshCw className={listLoading ? styles.spin : undefined} aria-hidden="true" size={16} />
                  </button>
                  <span className={styles.toolbarDivider} aria-hidden="true" />
                </>
              ) : null}
              {selectedDocument && !readOnly ? (
                <>
                  <button
                    type="button"
                    className={styles.toolbarAction}
                    title={mode === "preview" ? t("edit") : t("preview")}
                    aria-label={mode === "preview" ? t("edit") : t("preview")}
                    disabled={isMutating}
                    onClick={() => setMode((current) => current === "preview" ? "edit" : "preview")}
                  >
                    {mode === "preview" ? <Pencil aria-hidden="true" size={16} /> : <Eye aria-hidden="true" size={16} />}
                  </button>
                  <button
                    type="button"
                    className={styles.toolbarAction}
                    title={t("save")}
                    aria-label={t("save")}
                    disabled={!hasDirtyDraft || isMutating}
                    onClick={() => void saveDocument()}
                  >
                    {mutation === "save" ? <LoaderCircle className={styles.spin} aria-hidden="true" size={16} /> : <Save aria-hidden="true" size={16} />}
                  </button>
                  <button
                    ref={deleteTriggerRef}
                    type="button"
                    className={`${styles.toolbarAction} ${styles.toolbarActionDanger}`}
                    title={t("delete")}
                    aria-label={t("delete")}
                    disabled={isMutating}
                    onClick={() => {
                      setDeleteTarget(selectedDocument
                        ? { id: selectedDocument.id, title: selectedDocument.title }
                        : null);
                      setDeleteOpen(true);
                    }}
                  >
                    <Trash2 aria-hidden="true" size={16} />
                  </button>
                  <span className={styles.toolbarDivider} aria-hidden="true" />
                </>
              ) : null}
              {!readOnly && <button
                ref={createTriggerRef}
                type="button"
                className={styles.toolbarAction}
                title={t("newDocument")}
                aria-label={t("newDocument")}
                disabled={isMutating}
                onClick={requestCreateDocument}
              >
                <FilePlus aria-hidden="true" size={16} />
              </button>}
              <button
                ref={infoTriggerRef}
                type="button"
                className={styles.toolbarAction}
                title={t("viewKnowledgeBaseInfo")}
                aria-label={t("viewKnowledgeBaseInfo")}
                onClick={() => setInfoOpen(true)}
              >
                <Info aria-hidden="true" size={16} />
              </button>
            </div>
          </header>

          {error ? (
            <div className={styles.errorBanner} role="alert">
              <CircleAlert aria-hidden="true" size={16} />
              <span>{error}</span>
              <button type="button" title={t("closeErrorNotice")} aria-label={t("closeErrorNotice")} onClick={() => setError(null)}>
                <X aria-hidden="true" size={15} />
              </button>
            </div>
          ) : null}

          <div className={styles.content} role="region" aria-label={t("knowledgeDocumentMain")} tabIndex={0}>
            {selectedDocument === null ? (
              <KnowledgeEmptyState loading={listLoading || documentLoading} documents={documents} />
            ) : mode === "edit" && !readOnly ? (
              <KnowledgeEditor draft={draft} disabled={isMutating} onChange={setDraft} />
            ) : (
              <KnowledgePreview
                document={previewDocument!}
                markdownByteLength={previewMetrics.markdownByteLength}
                imageCount={previewMetrics.imageCount}
                resolveImageSrc={resolveImageSrc}
              />
            )}
          </div>
        </main>
      </div>

      <WorkspaceDialog
        open={discardDraftOpen}
        title={t("discardUnsavedChangesTitle")}
        description={t("discardUnsavedChangesDescription")}
        onClose={() => {
          if (isMutating) return;
          cancelDiscardDraft();
        }}
        initialFocusRef={discardCancelRef}
      >
        <p className={styles.dialogCopy}>{t("discardUnsavedChangesCopy")}</p>
        <div className={styles.dialogActions}>
          <button
            ref={discardCancelRef}
            type="button"
            className={styles.secondaryButton}
            disabled={isMutating}
            onClick={cancelDiscardDraft}
          >
            {t("continueEditing")}
          </button>
          <button type="button" className={styles.dangerButton} disabled={isMutating} onClick={discardDraftAndContinue}>{t("discardChanges")}</button>
        </div>
      </WorkspaceDialog>

      <WorkspaceDialog
        open={createOpen}
        title={t("newKnowledgeDocument")}
        description={t("newKnowledgeDocumentDescription")}
        onClose={requestCloseCreateDocument}
        initialFocusRef={createTitleRef}
        returnFocusRef={createTriggerRef}
        className={styles.createDialog}
      >
        <KnowledgeEditor
          prefix="create-knowledge"
          draft={createDraft}
          disabled={isMutating}
          titleRef={createTitleRef}
          onChange={setCreateDraft}
        />
        <div className={styles.dialogActions}>
          <button type="button" className={styles.secondaryButton} disabled={isMutating} onClick={requestCloseCreateDocument}>{t("cancel")}</button>
          <button
            type="button"
            className={styles.primaryButton}
            disabled={!createDraft.title.trim() || isMutating}
            onClick={() => void createDocument()}
          >
            {mutation === "create" ? <LoaderCircle className={styles.spin} aria-hidden="true" size={15} /> : <FilePlus aria-hidden="true" size={15} />}
            {t("create")}
          </button>
        </div>
      </WorkspaceDialog>

      <WorkspaceDialog
        open={deleteOpen}
        title={t("deleteDocument")}
        description={t("deleteDocumentDescription")}
        onClose={() => {
          if (!isMutating) setDeleteOpen(false);
        }}
        initialFocusRef={deleteCancelRef}
        returnFocusRef={deleteTriggerRef}
      >
        <p className={styles.dialogCopy}>{t("deleteDocumentConfirm", { name: deleteTarget?.title ?? t("currentDocument") })}</p>
        <div className={styles.dialogActions}>
          <button ref={deleteCancelRef} type="button" className={styles.secondaryButton} disabled={isMutating} onClick={() => setDeleteOpen(false)}>{t("cancel")}</button>
          <button type="button" className={styles.dangerButton} disabled={isMutating} onClick={() => void deleteDocument()}>
            {mutation === "delete" ? <LoaderCircle className={styles.spin} aria-hidden="true" size={15} /> : <Trash2 aria-hidden="true" size={15} />}
            {t("delete")}
          </button>
        </div>
      </WorkspaceDialog>

      <WorkspaceDialog
        open={infoOpen}
        title={t("knowledgeBaseInfo")}
        description={t("knowledgeBaseInfoDescription")}
        onClose={() => setInfoOpen(false)}
        returnFocusRef={infoTriggerRef}
        className={styles.infoDialog}
      >
        <KnowledgeInfo
          documents={documents}
          page={page}
          selected={selectedDocument}
          selectedSummary={selectedSummary}
        />
        <div className={styles.dialogActions}>
          <button type="button" className={styles.secondaryButton} onClick={() => setInfoOpen(false)}>{t("close")}</button>
        </div>
      </WorkspaceDialog>
    </div>
  );
}

function KnowledgeDocumentList({
  documents,
  page,
  pageIndex,
  totalPages,
  selectedId,
  loading,
  error,
  disabled,
  listRef,
  onSelect,
  onRequestPage,
  onRowMenu,
  onRowEdit,
  onRowRemove,
  onRetry,
}: {
  documents: KnowledgeDocumentSummary[] | null;
  page: KnowledgeDocumentPage | null;
  pageIndex: number;
  totalPages: number;
  selectedId: string | null;
  loading: boolean;
  error: string | null;
  disabled: boolean;
  listRef: RefObject<HTMLDivElement | null>;
  onSelect: (documentId: string) => void;
  onRequestPage: (pageIndex: number) => void;
  /** Host actions for a row; without it rows keep the platform context menu. */
  onRowMenu?: (request: KnowledgeDocumentRowMenuRequest) => void;
  onRowEdit: (documentId: string) => void;
  onRowRemove: (document: KnowledgeDocumentSummary) => void;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  // Only a loaded, non-empty page has something to page through.
  const pagination = page === null || !documents?.length ? null : (
    <nav className={styles.pagination} aria-label={t("knowledgeDocumentPagination")}>
      <button
        type="button"
        className={styles.paginationButton}
        disabled={disabled || loading || pageIndex === 0}
        onClick={() => onRequestPage(pageIndex - 1)}
      >
        <ChevronLeft aria-hidden="true" size={14} />
        {t("previousPage")}
      </button>
      <span className={styles.paginationLabel}>{t("pageIndicator", { current: pageIndex + 1, total: totalPages })}</span>
      <button
        type="button"
        className={styles.paginationButton}
        disabled={disabled || loading || !page.nextCursor}
        onClick={() => onRequestPage(pageIndex + 1)}
      >
        {t("nextPage")}
        <ChevronRight aria-hidden="true" size={14} />
      </button>
    </nav>
  );

  if (documents === null && loading) {
    return (
      <div className={styles.documentNavigation} data-slot="knowledge-document-navigation">
        <div className={styles.documentList} role="region" aria-label={t("knowledgeDocumentList")} tabIndex={0}>
          <div className={styles.skeletonList} role="progressbar" aria-label={t("loadingKnowledgeBase")}>
            {Array.from({ length: 5 }, (_, index) => <span key={index} className={styles.skeletonRow} />)}
          </div>
        </div>
      </div>
    );
  }

  if (documents === null && error) {
    return (
      <div className={styles.documentNavigation} data-slot="knowledge-document-navigation">
        <div className={styles.documentList} role="region" aria-label={t("knowledgeDocumentList")} tabIndex={0}>
          <div className={`${styles.emptyPanel} ${styles.listErrorPanel}`} data-slot="knowledge-list-load-error">
            <span><CircleAlert aria-hidden="true" size={20} /></span>
            <strong>{t("knowledgeLoadFailed")}</strong>
            <p>{error}</p>
            <button type="button" className={`${styles.secondaryButton} ${styles.retryButton}`} onClick={onRetry}>{t("retry")}</button>
          </div>
        </div>
      </div>
    );
  }

  if (!documents || documents.length === 0) {
    return (
      <div className={styles.documentNavigation} data-slot="knowledge-document-navigation">
        <div className={styles.documentList} role="region" aria-label={t("knowledgeDocumentList")} tabIndex={0}>
          <EmptyPanel icon={<BookOpen aria-hidden="true" size={20} />} title={t("noDocuments")} description={t("noDocumentsDescription")} />
        </div>
      </div>
    );
  }

  return (
    <div className={styles.documentNavigation} data-slot="knowledge-document-navigation">
      <div
        ref={listRef}
        className={styles.documentList}
        role="region"
        aria-label={t("knowledgeDocumentList")}
        tabIndex={0}
      >
        <div className={styles.documentRows}>
          {documents.map((document) => (
            <button
              key={document.id}
              type="button"
              className={selectedId === document.id ? `${styles.documentRow} ${styles.documentRowSelected}` : styles.documentRow}
              aria-label={document.title}
              aria-current={selectedId === document.id ? "page" : undefined}
              aria-haspopup={onRowMenu ? "menu" : undefined}
              disabled={disabled}
              onClick={() => onSelect(document.id)}
              onContextMenu={onRowMenu ? (event) => {
                event.preventDefault();
                // The keyboard's context-menu key carries no pointer position,
                // so that menu anchors to the row instead.
                const anchorRect = event.clientX === 0 && event.clientY === 0
                  ? event.currentTarget.getBoundingClientRect()
                  : new DOMRect(event.clientX, event.clientY, 0, 0);
                onRowMenu({
                  document,
                  menuId: `knowledge-document-menu-${document.id.replace(/[^\w-]/g, "-")}`,
                  anchorRect,
                  edit: () => onRowEdit(document.id),
                  remove: () => onRowRemove(document),
                });
              } : undefined}
            >
              <span className={styles.documentRowTitle}>{document.title}</span>
              <span className={styles.documentRowDate}>{formatKnowledgeDate(document.updatedAt)}</span>
            </button>
          ))}
        </div>
      </div>
      {pagination}
    </div>
  );
}

function KnowledgeSearchResults({
  loading,
  loadingMore,
  disabled,
  result,
  onOpenDocument,
  onLoadMore,
}: {
  loading: boolean;
  loadingMore: boolean;
  disabled: boolean;
  result: KnowledgeSearchResult | null;
  onOpenDocument: (documentId: string) => void;
  onLoadMore: () => void;
}) {
  const { t } = useTranslation();
  if (loading) {
    return (
      <section className={styles.searchResults} role="progressbar" aria-label={t("searchingKnowledgeBase")}>
        <h3>{t("searchResults")}</h3>
        <span className={styles.skeletonSearch} />
        <span className={styles.skeletonSearch} />
      </section>
    );
  }
  if (result === null) return null;
  if (result.matches.length === 0) {
    return (
      <section className={styles.searchResults}>
        <EmptyPanel icon={<Search aria-hidden="true" size={20} />} title={t("noSearchMatches")} description={t("searchedDocumentsCount", { count: result.documentsSearched })} />
      </section>
    );
  }

  return (
    <section className={styles.searchResults} aria-label={t("knowledgeSearchResults")}>
      <header className={styles.searchResultsHeader}>
        <h3>{t("searchResults")}</h3>
        <span className={styles.countBadge}>{t("searchMatchCount", { count: result.matches.length, total: result.totalMatches })}</span>
      </header>
      {result.hasMore ? <p className={styles.searchHint}>{t("searchPaginationHint", { size: result.pageSize || result.maxMatches })}</p> : null}
      <div className={styles.searchMatchList}>
        {result.matches.map((match, index) => (
          <button
            key={`${match.documentId}-${match.lineNumber}-${index}`}
            type="button"
            className={styles.searchMatch}
            disabled={disabled}
            onClick={() => onOpenDocument(match.documentId)}
          >
            <span className={styles.searchMatchHead}>
              <span className={styles.searchMatchTitle}>{match.title}</span>
              <span className={styles.lineBadge}>L{match.lineNumber}</span>
            </span>
            {[...match.before, { lineNumber: match.lineNumber, content: match.line }, ...match.after].map((line) => (
              <span key={line.lineNumber} className={line.lineNumber === match.lineNumber ? `${styles.searchLine} ${styles.searchLineCurrent}` : styles.searchLine}>
                <span>{line.lineNumber}</span>
                <span>{line.content}</span>
              </span>
            ))}
          </button>
        ))}
      </div>
      {result.hasMore ? (
        <button type="button" className={`${styles.secondaryButton} ${styles.loadMoreButton}`} disabled={loadingMore || disabled} onClick={onLoadMore}>
          {loadingMore ? <LoaderCircle className={styles.spin} aria-hidden="true" size={15} /> : null}
          {t("loadMoreResults")}
        </button>
      ) : null}
    </section>
  );
}

function KnowledgePreview({
  document,
  markdownByteLength,
  imageCount,
  resolveImageSrc,
}: {
  document: KnowledgeDocument;
  markdownByteLength: number;
  imageCount: number;
  resolveImageSrc: KnowledgeWorkspaceProps["resolveImageSrc"];
}) {
  const { t } = useTranslation();
  if (markdownByteLength > LARGE_MARKDOWN_PREVIEW_LIMIT) {
    return (
      <div className={styles.largeDocumentNotice}>
        <h3>{t("largeDocument")}</h3>
        <p>{t("largeDocumentNotice")}</p>
      </div>
    );
  }

  const imageLoadingMode = imageCount > INLINE_IMAGE_MANUAL_LOAD_LIMIT ? "manual" : "auto";
  return (
    <div className={styles.preview}>
      {imageLoadingMode === "manual" ? (
        <div className={styles.imageNotice} role="status">
          <ImageIcon aria-hidden="true" size={18} />
          <div>
            <strong>{t("manyImagesNotice")}</strong>
            <p>{t("manyImagesNoticeDetail", { count: imageCount })}</p>
          </div>
        </div>
      ) : null}
      <article>
        <MarkdownContent content={document.markdown || " "} resolveImageSrc={resolveImageSrc} imageLoadingMode={imageLoadingMode} />
      </article>
    </div>
  );
}

function KnowledgeEmptyState({ loading, documents }: { loading: boolean; documents: KnowledgeDocumentSummary[] | null }) {
  const { t } = useTranslation();
  if (loading && documents === null) {
    return (
      <div className={styles.contentSkeleton} role="progressbar" aria-label={t("loadingKnowledgeBaseDocuments")}>
        <span className={styles.skeletonTitle} />
        <span className={styles.skeletonBody} />
      </div>
    );
  }
  if (loading) {
    return <div className={styles.contentLoading} role="status"><LoaderCircle className={styles.spin} aria-hidden="true" size={18} />{t("loadingDocument")}</div>;
  }
  return <EmptyPanel icon={<BookOpen aria-hidden="true" size={24} />} title={t("selectOrCreateDocument")} description={t("selectOrCreateDocumentDescription")} />;
}

function KnowledgeEditor({
  draft,
  disabled,
  onChange,
  prefix = "knowledge",
  titleRef,
}: {
  draft: DocumentDraft;
  disabled: boolean;
  onChange: (draft: DocumentDraft) => void;
  prefix?: string;
  titleRef?: RefObject<HTMLInputElement | null>;
}) {
  const { t } = useTranslation();
  const titleId = `${prefix}-title`;
  const markdownId = `${prefix}-markdown`;
  return (
    <div className={styles.editorFields}>
      <label htmlFor={titleId}>
        <span>{t("title")}</span>
        <input
          ref={titleRef}
          id={titleId}
          value={draft.title}
          disabled={disabled}
          onChange={(event) => onChange({ ...draft, title: event.target.value })}
        />
      </label>
      <label htmlFor={markdownId}>
        <span>{t("markdown")}</span>
        <textarea
          id={markdownId}
          value={draft.markdown}
          disabled={disabled}
          onChange={(event) => onChange({ ...draft, markdown: event.target.value })}
        />
      </label>
    </div>
  );
}

function KnowledgeInfo({
  documents,
  page,
  selected,
  selectedSummary,
}: {
  documents: KnowledgeDocumentSummary[] | null;
  page: KnowledgeDocumentPage | null;
  selected: KnowledgeDocument | null;
  selectedSummary?: KnowledgeDocumentSummary;
}) {
  const { t } = useTranslation();
  const selectedStats = useMemo(() => {
    if (!selected) return null;
    return {
      lines: selected.markdown === "" ? 0 : selected.markdown.split(/\r\n|\r|\n/).length,
      characters: selected.markdown.length,
    };
  }, [selected]);

  return (
    <div className={styles.infoContent}>
      <dl className={styles.infoGrid}>
        <InfoItem label={t("documentCount")} value={documents === null ? t("reading") : t("countDocuments", { count: page?.total ?? documents.length })} />
        <InfoItem label={t("loaded")} value={documents === null ? t("reading") : t("countDocuments", { count: documents.length })} />
      </dl>
      {selected ? (
        <section className={styles.selectedInfo}>
          <div className={styles.selectedInfoHead}>
            <div>
              <strong>{selected.title}</strong>
              <code>{selected.id}</code>
            </div>
            <span className={styles.countBadge}>{t("currentDocument")}</span>
          </div>
          <dl className={styles.infoGrid}>
            <InfoItem label={t("createdAt")} value={formatKnowledgeDate(selected.createdAt)} />
            <InfoItem label={t("updatedAt")} value={formatKnowledgeDate(selected.updatedAt)} />
            <InfoItem label={t("markdownLineCount")} value={t("linesCount", { count: selectedStats?.lines ?? 0 })} />
            <InfoItem label={t("markdownCharacterCount")} value={t("charactersCount", { count: selectedStats?.characters ?? 0 })} />
          </dl>
          {selectedSummary?.markdownPreview ? <p className={styles.previewSummary}>{selectedSummary.markdownPreview}</p> : null}
        </section>
      ) : <p className={styles.dialogCopy}>{t("noSelectedDocument")}</p>}
    </div>
  );
}

function InfoItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd title={value}>{value}</dd>
    </div>
  );
}

function EmptyPanel({ icon, title, description }: { icon: ReactNode; title: string; description: string }) {
  return (
    <div className={styles.emptyPanel}>
      <span>{icon}</span>
      <strong>{title}</strong>
      <p>{description}</p>
    </div>
  );
}

function WorkspaceDialog({
  open,
  title,
  description,
  onClose,
  children,
  initialFocusRef,
  returnFocusRef,
  className,
}: {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  initialFocusRef?: RefObject<HTMLElement | null>;
  returnFocusRef?: RefObject<HTMLElement | null>;
  className?: string;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  useModalFocus({
    active: open,
    containerRef: dialogRef,
    initialFocusRef: initialFocusRef ?? closeButtonRef,
    onClose,
    returnFocusRef,
  });

  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div
      className={styles.dialogLayer}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className={className ? `${styles.dialog} ${className}` : styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
      >
        <header className={styles.dialogHeader}>
          <div>
            <h2 id={titleId}>{title}</h2>
            {description ? <p id={descriptionId}>{description}</p> : null}
          </div>
          <button ref={closeButtonRef} type="button" className={styles.iconButton} title={t("closeDialog", { title })} aria-label={t("closeDialog", { title })} onClick={onClose}>
            <X aria-hidden="true" size={16} />
          </button>
        </header>
        {children}
      </div>
    </div>,
    document.body,
  );
}
