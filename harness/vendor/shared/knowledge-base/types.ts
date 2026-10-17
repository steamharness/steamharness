import type { ReactNode } from "react";

export type KnowledgeImageSrcResolver = (
  src: string,
) => Promise<string | null | undefined> | string | null | undefined;

export interface KnowledgeDocumentSummary {
  id: string;
  title: string;
  markdownPreview: string;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeDocument {
  id: string;
  title: string;
  markdown: string;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeDocumentPage {
  items: KnowledgeDocumentSummary[];
  nextCursor?: string;
  hasMore: boolean;
  total: number;
}

export interface KnowledgeSearchLine {
  lineNumber: number;
  content: string;
}

export interface KnowledgeSearchMatch {
  documentId: string;
  title: string;
  lineNumber: number;
  line: string;
  before: KnowledgeSearchLine[];
  after: KnowledgeSearchLine[];
}

export interface KnowledgeSearchResult {
  query: string;
  documentsSearched: number;
  totalMatches: number;
  matchesTruncated: boolean;
  maxMatches: number;
  pageSize: number;
  cursor?: string;
  nextCursor?: string;
  hasMore: boolean;
  matches: KnowledgeSearchMatch[];
}

export interface KnowledgeDocumentLinesResult {
  documentId: string;
  title: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  lines: KnowledgeSearchLine[];
}

export interface KnowledgeResult<T> {
  errCode: number;
  errMessage: string;
  data?: T;
}

export interface KnowledgeRequestOptions {
  signal?: AbortSignal;
}

export interface KnowledgeDocumentListOptions extends KnowledgeRequestOptions {
  pageSize: number;
  cursor?: string;
}

export interface KnowledgeSearchOptions extends KnowledgeRequestOptions {
  query: string;
  beforeLines?: number;
  afterLines?: number;
  pageSize: number;
  cursor?: string;
}

export interface KnowledgeRepository {
  listDocuments(options: KnowledgeDocumentListOptions): Promise<KnowledgeResult<KnowledgeDocumentPage>>;
  getDocument(documentId: string, options?: KnowledgeRequestOptions): Promise<KnowledgeResult<KnowledgeDocument>>;
  createDocument(
    input: { id?: string; title: string; markdown: string },
    options?: KnowledgeRequestOptions,
  ): Promise<KnowledgeResult<KnowledgeDocumentSummary | KnowledgeDocument>>;
  updateDocument(
    documentId: string,
    input: { title: string; markdown: string },
    options?: KnowledgeRequestOptions,
  ): Promise<KnowledgeResult<KnowledgeDocumentSummary | KnowledgeDocument>>;
  deleteDocument(
    documentId: string,
    options?: KnowledgeRequestOptions,
  ): Promise<KnowledgeResult<{ id: string; deleted: boolean }>>;
  searchDocuments(options: KnowledgeSearchOptions): Promise<KnowledgeResult<KnowledgeSearchResult>>;
  readDocumentLines?(
    documentId: string,
    options: { startLine: number; endLine: number } & KnowledgeRequestOptions,
  ): Promise<KnowledgeResult<KnowledgeDocumentLinesResult>>;
}

/**
 * Handed to a host that renders its own document rail. The workspace keeps the
 * document list with its paging, selection, empty and error states; the host
 * supplies the surrounding rail (chrome, header, actions) and places `list`.
 */
export interface KnowledgeDocumentRail {
  /**
   * Ready-to-render document list: paging, empty, loading and error included.
   * It owns its scrolling — place it in a flex column with `min-height: 0` and
   * never wrap it in another overflow container, or cursor paging stops firing.
   * Render it in every state, including while the first page is loading.
   */
  list: ReactNode;
  /** Documents in the repository once the first page has loaded. */
  total: number | null;
  /** True while the list, a document read or a mutation is in flight. */
  busy: boolean;
  /** Reloads the first page. */
  refresh: () => void;
  /**
   * Document search, driven by the host's own field. The workspace keeps the
   * query, the request and the results — including their paging — so a host
   * renders a search control and places `node`; it never queries the
   * repository itself. The built-in search uses the same state.
   */
  search: KnowledgeDocumentRailSearch;
}

/**
 * The search half of a host rail. A host renders its own field bound to
 * `value` / `onValueChange` and calls `submit` to run the query — the same
 * press-Enter contract the built-in search form uses, so both surfaces behave
 * alike.
 */
export interface KnowledgeDocumentRailSearch {
  /** The text in the host's field. Typing alone never queries. */
  value: string;
  /** New text. Also drops the current results, so typing narrows from scratch. */
  onValueChange: (value: string) => void;
  /** Runs the query for the current `value`. */
  submit: () => void;
  /**
   * Ready-to-render results, with their own "load more" control and their own
   * search-in-progress state. Renders nothing until a query has run, so it can
   * always sit below `list`.
   */
  node: ReactNode;
}

/**
 * Raised when a document row asks for its actions, from a pointer's context
 * menu or from the keyboard's context-menu key. The two operations are the
 * workspace's own flows — `edit` opens the document in the editor (asking about
 * an unsaved draft first), `remove` asks for confirmation before deleting — so
 * a host only renders its menu and calls what the user picked.
 */
export interface KnowledgeDocumentRowMenuRequest {
  document: KnowledgeDocumentSummary;
  /** Stable id for the host menu element, derived from the row's document. */
  menuId: string;
  /** Where to anchor the menu: the pointer position, or the row itself. */
  anchorRect: DOMRect;
  edit: () => void;
  remove: () => void;
}

export interface KnowledgeWorkspaceProps {
  repository: KnowledgeRepository;
  readOnly?: boolean;
  initialDocumentId?: string;
  refreshToken?: number;
  /** Hide when the host provides its own refresh action. */
  showRefreshAction?: boolean;
  onBusyChange?: (busy: boolean) => void;
  /**
   * Host-provided left rail. A host with its own navigation surface (for
   * example the Desktop knowledge rail) supplies the rail chrome here and
   * places the shared document list inside it, so the list itself, its paging
   * and its selection stay owned by this component. Hosts that omit it keep the
   * built-in search and document list.
   */
  documentRail?: (rail: KnowledgeDocumentRail) => ReactNode;
  /**
   * Collapses the left rail. The host draws the control that collapses it and
   * the one that brings it back; the workspace only stops reserving the column.
   */
  railCollapsed?: boolean;
  /**
   * Host actions for a document row, raised from that row's context menu. Omit
   * to leave rows without host actions.
   */
  documentRowMenu?: (request: KnowledgeDocumentRowMenuRequest) => void;
  resolveImageSrc?: KnowledgeImageSrcResolver;
  onError?: (message: string) => void;
  /** Lets a host protect source or route changes while an editor draft is dirty. */
  onDirtyChange?: (dirty: boolean) => void;
  pageSize?: number;
  searchPageSize?: number;
}
