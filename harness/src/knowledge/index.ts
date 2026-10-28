import type {
  KVNamespace,
  KVNamespaceMutation,
} from "../kv/index";
import { HarnessError } from "../workflow/errors";

export const KNOWLEDGE_DOCUMENT_INDEX_KEY = "knowledge.documents";
export const KNOWLEDGE_DOCUMENT_KEY_PREFIX = "knowledge.document.";
export const DEFAULT_KNOWLEDGE_SEARCH_MAX_MATCHES = 200;
export const MAX_KNOWLEDGE_SEARCH_MAX_MATCHES = 1000;
export const DEFAULT_KNOWLEDGE_SEARCH_PAGE_SIZE = DEFAULT_KNOWLEDGE_SEARCH_MAX_MATCHES;
export const MAX_KNOWLEDGE_SEARCH_PAGE_SIZE = MAX_KNOWLEDGE_SEARCH_MAX_MATCHES;
export const MAX_KNOWLEDGE_LINE_RANGE_LINES = 1000;
export const DEFAULT_KNOWLEDGE_DOCUMENT_PAGE_SIZE = 20;
export const MAX_KNOWLEDGE_DOCUMENT_PAGE_SIZE = 100;
export const MAX_KNOWLEDGE_MARKDOWN_PREVIEW_LENGTH = 160;
export const MAX_KNOWLEDGE_MARKDOWN_PREVIEW_SCAN_CODE_UNITS = 16 * 1024;

const KNOWLEDGE_DOCUMENT_INDEX_VERSION = 2;
const KNOWLEDGE_DOCUMENT_INDEX_PAGE_SIZE = 128;
const KNOWLEDGE_DOCUMENT_INDEX_PAGE_KEY_PREFIX = `${KNOWLEDGE_DOCUMENT_INDEX_KEY}.page.`;
const KNOWLEDGE_DOCUMENT_INDEX_LOCATOR_KEY_PREFIX = `${KNOWLEDGE_DOCUMENT_INDEX_KEY}.locator.`;
const KNOWLEDGE_SEARCH_READ_CONCURRENCY = 4;
const KNOWLEDGE_MARKDOWN_PREVIEW_WHITESPACE_PATTERN = /\s/u;

/**
 * What the knowledge helpers need: a persistent-value namespace.
 *
 * Named as one member rather than as `Pick<StorageLocationContext, …>`
 * so a namespace that is not a run's own storage can be handed in — the
 * database-space namespace builds one over the target project's store.
 */
export interface KnowledgeContext {
  persistentValue: KVNamespace;
}

/**
 * Whether a persistent-value key belongs to the knowledge document store.
 *
 * The key space is this module's, so every other module that needs to tell one
 * of these keys from the project's other persistent values asks here instead of
 * repeating the prefixes.
 */
export function isKnowledgeDocumentStorageKey(key: string): boolean {
  return key === KNOWLEDGE_DOCUMENT_INDEX_KEY
    || key.startsWith(KNOWLEDGE_DOCUMENT_KEY_PREFIX)
    || key.startsWith(KNOWLEDGE_DOCUMENT_INDEX_PAGE_KEY_PREFIX)
    || key.startsWith(KNOWLEDGE_DOCUMENT_INDEX_LOCATOR_KEY_PREFIX);
}

/**
 * The keys a knowledge mutation reads and writes, for a host about to hand it
 * to a store that runs it.
 *
 * A store with `executeNamespaceMutation` — the Runtime API's, and any host
 * store built to match — carries the whole mutation out itself, index
 * bookkeeping included, so a namespace view that checks keys one call at a
 * time never sees the ones a mutation touches. Callers that must enforce a
 * per-key grant ask here first and check the answer before the mutation
 * leaves; the index keys are the document list's own bookkeeping, and the
 * document key is what the grant names.
 *
 * Both the mutation vocabulary this module emits (`knowledge-document.*`) and
 * the one the Runtime API speaks (`create`/`edit`/`delete`) are understood, so
 * either host can check without translating first.
 *
 * `undefined` means the keys cannot be named — an unknown mutation, or a
 * create that left the document id to the store. A caller that cannot say
 * which keys it will write is refused rather than trusted.
 */
export function describeKnowledgeMutationKeys(
  mutation: KVNamespaceMutation,
): { read: string[]; write: string[] } | undefined {
  const type = mutation.type.startsWith("knowledge-document.")
    ? mutation.type.slice("knowledge-document.".length)
    : mutation.type;
  const input = isRecord(mutation.input) ? mutation.input : undefined;
  if (input === undefined) return undefined;

  if (type === "create") {
    const id = readMutationString(input["id"]);
    if (id === undefined) return undefined;
    const documentKey = tryCreateKnowledgeDocumentKey(id);
    if (documentKey === undefined) return undefined;
    return {
      // A create reads the index it is about to add itself to.
      read: [KNOWLEDGE_DOCUMENT_INDEX_KEY],
      write: [KNOWLEDGE_DOCUMENT_INDEX_KEY, documentKey],
    };
  }
  if (type === "edit" || type === "delete") {
    // The document field is `documentId` on the wire and `id` in this module's
    // own vocabulary, and an edit reads the document before rewriting it.
    const id = readMutationString(input["documentId"]) ?? readMutationString(input["id"]);
    if (id === undefined) return undefined;
    const documentKey = tryCreateKnowledgeDocumentKey(id);
    if (documentKey === undefined) return undefined;
    return {
      read: [KNOWLEDGE_DOCUMENT_INDEX_KEY, documentKey],
      write: [KNOWLEDGE_DOCUMENT_INDEX_KEY, documentKey],
    };
  }
  return undefined;
}

function readMutationString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** `createKnowledgeDocumentKey` for ids that may have come from a caller. */
function tryCreateKnowledgeDocumentKey(id: string): string | undefined {
  try {
    return createKnowledgeDocumentKey(id);
  } catch {
    return undefined;
  }
}

export interface KnowledgeDocument {
  id: string;
  title: string;
  markdown: string;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeDocumentSummaryRecord {
  id: string;
  title: string;
  markdownPreview: string;
  createdAt: string;
  updatedAt: string;
}

export interface ListKnowledgeDocumentsInput {
  pageSize?: number;
  cursor?: string;
}

export interface KnowledgeDocumentPageRecord {
  items: KnowledgeDocumentSummaryRecord[];
  nextCursor?: string;
  hasMore: boolean;
  total: number;
}

export interface CreateKnowledgeDocumentInput {
  id?: string;
  title: string;
  markdown: string;
}

export interface EditKnowledgeDocumentInput {
  id: string;
  title?: string;
  markdown?: string;
}

export interface SearchKnowledgeDocumentsInput {
  query: string;
  documentId?: string;
  beforeLines?: number;
  afterLines?: number;
  maxMatches?: number;
  pageSize?: number;
  cursor?: string;
}

export interface ReadKnowledgeDocumentLinesInput {
  documentId: string;
  startLine: number;
  endLine: number;
}

export interface KnowledgeSearchMatch {
  documentId: string;
  title: string;
  lineNumber: number;
  line: string;
  before: Array<{ lineNumber: number; content: string }>;
  after: Array<{ lineNumber: number; content: string }>;
}

export interface KnowledgeSearchResultRecord {
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
  lines: Array<{ lineNumber: number; content: string }>;
}

interface KnowledgeDocumentIndexMeta {
  version: typeof KNOWLEDGE_DOCUMENT_INDEX_VERSION;
  total: number;
  nextSequence: number;
  headPageId?: string;
}

interface KnowledgeDocumentIndexEntry {
  summary: KnowledgeDocumentSummaryRecord;
  sequence: number;
}

interface KnowledgeDocumentIndexPageValue {
  version: typeof KNOWLEDGE_DOCUMENT_INDEX_VERSION;
  entries: KnowledgeDocumentIndexEntry[];
  nextPageId?: string;
}

interface KnowledgeDocumentIndexLocator {
  version: typeof KNOWLEDGE_DOCUMENT_INDEX_VERSION;
  pageId?: string;
  sequence?: number;
  deleted?: boolean;
  deletedAt?: string;
}

interface KnowledgeDocumentPageCursor {
  version: typeof KNOWLEDGE_DOCUMENT_INDEX_VERSION;
  pageId: string;
  /** Entries at or above this sequence belong to an earlier page snapshot. */
  beforeSequence: number;
}

interface KnowledgeDocumentIndexPageState {
  pageId: string;
  page: KnowledgeDocumentIndexPageValue;
  raw: unknown;
}

interface KnowledgeValueChange {
  key: string;
  value: unknown;
  restoreValue: unknown;
}

export async function listKnowledgeDocuments(
  context: KnowledgeContext,
): Promise<KnowledgeDocumentSummaryRecord[]> {
  const { meta } = await readKnowledgeDocumentIndexMeta(context);
  return readAllKnowledgeDocumentSummaries(context, meta);
}

export async function listKnowledgeDocumentPage(
  context: KnowledgeContext,
  input: ListKnowledgeDocumentsInput = {},
): Promise<KnowledgeDocumentPageRecord> {
  const pageSize = normalizeKnowledgeDocumentPageSize(input.pageSize);
  const cursor = normalizeKnowledgeDocumentPageCursor(input.cursor);
  const { meta } = await readKnowledgeDocumentIndexMeta(context);

  if (meta.total === 0 || meta.headPageId === undefined) {
    return { items: [], hasMore: false, total: meta.total };
  }

  const page = await readKnowledgeDocumentSummaryPage(
    context,
    meta,
    cursor?.pageId,
    cursor?.beforeSequence,
    pageSize,
  );

  return {
    items: page.items,
    ...(page.nextCursor === undefined ? {} : { nextCursor: createKnowledgeDocumentPageCursor(page.nextCursor) }),
    hasMore: page.nextCursor !== undefined,
    total: meta.total,
  };
}

export async function getKnowledgeDocument(
  context: KnowledgeContext,
  documentId: string,
): Promise<KnowledgeDocument | undefined> {
  const id = normalizeKnowledgeDocumentId(documentId);
  return readKnowledgeDocumentValue(await context.persistentValue.getValue(createKnowledgeDocumentKey(id)));
}

export async function createKnowledgeDocument(
  context: KnowledgeContext,
  input: CreateKnowledgeDocumentInput,
): Promise<KnowledgeDocument> {
  // The id is settled here, before the mutation can leave for a store that
  // runs it, so that a host checking the grant on the way out can name the key
  // the store will write. Otherwise the id would be invented inside the store,
  // where nothing outside it can see which document was created.
  const id = createKnowledgeDocumentMutationId(input);
  return executeKnowledgeDocumentMutation(
    context,
    { type: "knowledge-document.create", input: { ...input, id } },
    () => createKnowledgeDocumentUnlocked(context, { ...input, id }),
  );
}

function createKnowledgeDocumentMutationId(input: CreateKnowledgeDocumentInput): string {
  return normalizeKnowledgeDocumentId(input.id ?? createKnowledgeDocumentId(input.title));
}

async function createKnowledgeDocumentUnlocked(
  context: KnowledgeContext,
  input: CreateKnowledgeDocumentInput,
): Promise<KnowledgeDocument> {
  const id = normalizeKnowledgeDocumentId(input.id ?? createKnowledgeDocumentId(input.title));
  const title = normalizeKnowledgeDocumentTitle(input.title);
  const markdown = normalizeKnowledgeDocumentMarkdown(input.markdown);
  const now = new Date().toISOString();
  const document: KnowledgeDocument = {
    id,
    title,
    markdown,
    createdAt: now,
    updatedAt: now,
  };
  const namespace = context.persistentValue;
  const documentKey = createKnowledgeDocumentKey(id);
  const previousDocument = await namespace.getValue(documentKey);
  if (readKnowledgeDocumentValue(previousDocument) !== undefined) {
    throw new HarnessError({
      type: "input_validation",
      message: `Knowledge document "${id}" already exists.`,
      metadata: { documentId: id },
    });
  }

  const { meta, raw: previousMeta } = await readKnowledgeDocumentIndexMeta(context);
  const sequence = meta.nextSequence + 1;
  const entry: KnowledgeDocumentIndexEntry = {
    summary: createKnowledgeDocumentSummary(document),
    sequence,
  };
  const { pageId, page, previousPage } = await prepareKnowledgeDocumentHeadPage(context, meta, sequence);
  const nextMeta: KnowledgeDocumentIndexMeta = {
    ...meta,
    total: meta.total + 1,
    nextSequence: sequence,
    headPageId: pageId,
  };
  const nextPage: KnowledgeDocumentIndexPageValue = {
    ...page,
    entries: [entry, ...page.entries],
  };
  const locatorKey = createKnowledgeDocumentIndexLocatorKey(id);
  const previousLocator = await namespace.getValue(locatorKey);

  await writeKnowledgeValues(context, [
    createKnowledgeValueChange(createKnowledgeDocumentIndexPageKey(pageId), nextPage, previousPage),
    createKnowledgeValueChange(KNOWLEDGE_DOCUMENT_INDEX_KEY, nextMeta, previousMeta),
    createKnowledgeValueChange(locatorKey, {
      version: KNOWLEDGE_DOCUMENT_INDEX_VERSION,
      pageId,
      sequence,
    } satisfies KnowledgeDocumentIndexLocator, previousLocator),
    createKnowledgeValueChange(documentKey, document, previousDocument, id),
  ]);
  return document;
}

export async function editKnowledgeDocument(
  context: KnowledgeContext,
  input: EditKnowledgeDocumentInput,
): Promise<KnowledgeDocument> {
  return executeKnowledgeDocumentMutation(
    context,
    { type: "knowledge-document.edit", input },
    () => editKnowledgeDocumentUnlocked(context, input),
  );
}

async function editKnowledgeDocumentUnlocked(
  context: KnowledgeContext,
  input: EditKnowledgeDocumentInput,
): Promise<KnowledgeDocument> {
  const id = normalizeKnowledgeDocumentId(input.id);
  const namespace = context.persistentValue;
  const documentKey = createKnowledgeDocumentKey(id);
  const previousDocument = await namespace.getValue(documentKey);
  const current = readKnowledgeDocumentValue(previousDocument);
  if (current === undefined) {
    throw new HarnessError({
      type: "input_validation",
      message: `Knowledge document "${id}" does not exist.`,
      metadata: { documentId: id },
    });
  }

  const next: KnowledgeDocument = {
    ...current,
    title: input.title === undefined ? current.title : normalizeKnowledgeDocumentTitle(input.title),
    markdown: input.markdown === undefined ? current.markdown : normalizeKnowledgeDocumentMarkdown(input.markdown),
    updatedAt: new Date().toISOString(),
  };
  const { meta, raw: previousMeta } = await readKnowledgeDocumentIndexMeta(context);
  const locatorKey = createKnowledgeDocumentIndexLocatorKey(id);
  const previousLocator = await namespace.getValue(locatorKey);
  const locator = readKnowledgeDocumentIndexLocator(previousLocator);
  if (locator === undefined || locator.deleted === true || locator.pageId === undefined) {
    throw createKnowledgeDocumentIndexError(id, "has no active index locator");
  }

  const oldPageState = await readKnowledgeDocumentIndexPage(context, locator.pageId);
  const oldEntryIndex = oldPageState.page.entries.findIndex((entry) => entry.summary.id === id && entry.sequence === locator.sequence);
  if (oldEntryIndex === -1) {
    throw createKnowledgeDocumentIndexError(id, "is missing from its indexed page");
  }

  const sequence = meta.nextSequence + 1;
  const entry: KnowledgeDocumentIndexEntry = {
    summary: createKnowledgeDocumentSummary(next),
    sequence,
  };
  const pageWithoutCurrent: KnowledgeDocumentIndexPageValue = {
    ...oldPageState.page,
    entries: oldPageState.page.entries.filter((_, index) => index !== oldEntryIndex),
  };
  const target = await prepareKnowledgeDocumentEditTargetPage(context, meta, sequence, oldPageState, pageWithoutCurrent);
  const nextMeta: KnowledgeDocumentIndexMeta = {
    ...meta,
    nextSequence: sequence,
    headPageId: target.pageId,
  };
  const changes = new Map<string, KnowledgeValueChange>();
  let nextTargetPage: KnowledgeDocumentIndexPageValue = {
    ...target.page,
    entries: [entry, ...target.page.entries],
  };
  if (target.pageId === oldPageState.pageId) {
    changes.set(
      createKnowledgeDocumentIndexPageKey(oldPageState.pageId),
      createKnowledgeValueChange(
        createKnowledgeDocumentIndexPageKey(oldPageState.pageId),
        nextTargetPage,
        oldPageState.raw,
      ),
    );
  } else {
    changes.set(
      createKnowledgeDocumentIndexPageKey(oldPageState.pageId),
      createKnowledgeValueChange(
        createKnowledgeDocumentIndexPageKey(oldPageState.pageId),
        pageWithoutCurrent,
        oldPageState.raw,
      ),
    );
    if (pageWithoutCurrent.entries.length === 0) {
      const previousPage = await findKnowledgeDocumentPreviousPage(context, meta, oldPageState.pageId);
      if (previousPage === undefined) {
        throw createKnowledgeDocumentIndexError(id, "cannot unlink an empty index page");
      }
      if (previousPage.pageId === target.pageId) {
        nextTargetPage = withKnowledgeDocumentIndexNextPageId(nextTargetPage, oldPageState.page.nextPageId);
      } else {
        changes.set(
          createKnowledgeDocumentIndexPageKey(previousPage.pageId),
          createKnowledgeValueChange(
            createKnowledgeDocumentIndexPageKey(previousPage.pageId),
            withKnowledgeDocumentIndexNextPageId(previousPage.page, oldPageState.page.nextPageId),
            previousPage.raw,
          ),
        );
      }
    }
    changes.set(
      createKnowledgeDocumentIndexPageKey(target.pageId),
      createKnowledgeValueChange(
        createKnowledgeDocumentIndexPageKey(target.pageId),
        nextTargetPage,
        target.previousPage,
      ),
    );
  }
  changes.set(
    KNOWLEDGE_DOCUMENT_INDEX_KEY,
    createKnowledgeValueChange(KNOWLEDGE_DOCUMENT_INDEX_KEY, nextMeta, previousMeta),
  );
  changes.set(
    locatorKey,
    createKnowledgeValueChange(locatorKey, {
      version: KNOWLEDGE_DOCUMENT_INDEX_VERSION,
      pageId: target.pageId,
      sequence,
    } satisfies KnowledgeDocumentIndexLocator, previousLocator),
  );
  changes.set(documentKey, createKnowledgeValueChange(documentKey, next, previousDocument, id));
  await writeKnowledgeValues(context, [...changes.values()]);
  return next;
}

export async function deleteKnowledgeDocument(
  context: KnowledgeContext,
  documentId: string,
): Promise<{ id: string; deleted: boolean }> {
  return executeKnowledgeDocumentMutation(
    context,
    { type: "knowledge-document.delete", input: { documentId } },
    () => deleteKnowledgeDocumentUnlocked(context, documentId),
  );
}

async function deleteKnowledgeDocumentUnlocked(
  context: KnowledgeContext,
  documentId: string,
): Promise<{ id: string; deleted: boolean }> {
  const id = normalizeKnowledgeDocumentId(documentId);
  const namespace = context.persistentValue;
  const documentKey = createKnowledgeDocumentKey(id);
  const previousDocument = await namespace.getValue(documentKey);
  const current = readKnowledgeDocumentValue(previousDocument);
  const tombstone = createKnowledgeDocumentTombstone(id);

  if (current === undefined) {
    await writeKnowledgeValues(context, [
      createKnowledgeValueChange(documentKey, tombstone, previousDocument, id),
    ]);
    return { id, deleted: false };
  }

  const { meta, raw: previousMeta } = await readKnowledgeDocumentIndexMeta(context);
  const locatorKey = createKnowledgeDocumentIndexLocatorKey(id);
  const previousLocator = await namespace.getValue(locatorKey);
  const locator = readKnowledgeDocumentIndexLocator(previousLocator);
  if (locator === undefined || locator.deleted === true || locator.pageId === undefined) {
    throw createKnowledgeDocumentIndexError(id, "has no active index locator");
  }

  const pageState = await readKnowledgeDocumentIndexPage(context, locator.pageId);
  const oldEntryIndex = pageState.page.entries.findIndex((entry) => entry.summary.id === id && entry.sequence === locator.sequence);
  if (oldEntryIndex === -1) {
    throw createKnowledgeDocumentIndexError(id, "is missing from its indexed page");
  }
  const nextPage: KnowledgeDocumentIndexPageValue = {
    ...pageState.page,
    entries: pageState.page.entries.filter((_, index) => index !== oldEntryIndex),
  };
  const nextTotal = Math.max(0, meta.total - 1);
  const nextMeta: KnowledgeDocumentIndexMeta = nextTotal === 0
    ? createKnowledgeDocumentIndexMetaWithTotal(meta.nextSequence, 0)
    : nextPage.entries.length === 0 && pageState.pageId === meta.headPageId
      ? nextPage.nextPageId === undefined
        ? (() => {
            throw createKnowledgeDocumentIndexError(id, "would leave an unreachable index page");
          })()
        : createKnowledgeDocumentIndexMetaWithTotal(meta.nextSequence, nextTotal, nextPage.nextPageId)
      : { ...meta, total: nextTotal };
  const changes = [
    createKnowledgeValueChange(createKnowledgeDocumentIndexPageKey(pageState.pageId), nextPage, pageState.raw),
  ];
  if (nextTotal > 0 && nextPage.entries.length === 0 && pageState.pageId !== meta.headPageId) {
    const previousPage = await findKnowledgeDocumentPreviousPage(context, meta, pageState.pageId);
    if (previousPage === undefined) {
      throw createKnowledgeDocumentIndexError(id, "cannot unlink an empty index page");
    }
    changes.push(
      createKnowledgeValueChange(
        createKnowledgeDocumentIndexPageKey(previousPage.pageId),
        withKnowledgeDocumentIndexNextPageId(previousPage.page, pageState.page.nextPageId),
        previousPage.raw,
      ),
    );
  }
  changes.push(
    createKnowledgeValueChange(KNOWLEDGE_DOCUMENT_INDEX_KEY, nextMeta, previousMeta),
    createKnowledgeValueChange(locatorKey, {
      version: KNOWLEDGE_DOCUMENT_INDEX_VERSION,
      deleted: true,
      deletedAt: new Date().toISOString(),
    } satisfies KnowledgeDocumentIndexLocator, previousLocator),
    createKnowledgeValueChange(documentKey, tombstone, previousDocument, id),
  );
  await writeKnowledgeValues(context, changes);

  return { id, deleted: true };
}

export async function searchKnowledgeDocuments(
  context: KnowledgeContext,
  input: SearchKnowledgeDocumentsInput,
): Promise<KnowledgeSearchResultRecord> {
  const withReadLock = context.persistentValue.withReadLock;
  return withReadLock === undefined
    ? searchKnowledgeDocumentsUnlocked(context, input)
    : withReadLock(() => searchKnowledgeDocumentsUnlocked(context, input));
}

async function searchKnowledgeDocumentsUnlocked(
  context: KnowledgeContext,
  input: SearchKnowledgeDocumentsInput,
): Promise<KnowledgeSearchResultRecord> {
  const query = normalizeSearchQuery(input.query);
  const beforeLines = normalizeContextLineCount(input.beforeLines, "beforeLines");
  const afterLines = normalizeContextLineCount(input.afterLines, "afterLines");
  const pageSize = input.pageSize === undefined
    ? normalizeSearchPageSize(input.maxMatches, "maxMatches")
    : normalizeSearchPageSize(input.pageSize, "pageSize");
  const cursor = normalizeSearchCursor(input.cursor);
  const normalizedQuery = query.toLowerCase();
  const matches: KnowledgeSearchMatch[] = [];
  let totalMatches = 0;
  let documentsSearched = 0;

  const scanDocument = (document: KnowledgeDocument) => {
    documentsSearched += 1;
    const lines = document.markdown.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      if (!line.toLowerCase().includes(normalizedQuery)) continue;
      totalMatches += 1;
      // Page large result payloads while still counting every matching line.
      if (totalMatches <= cursor || matches.length >= pageSize) continue;
      const lineNumber = index + 1;
      matches.push({
        documentId: document.id,
        title: document.title,
        lineNumber,
        line,
        before: readContextLines(lines, Math.max(0, index - beforeLines), index),
        after: readContextLines(lines, index + 1, Math.min(lines.length, index + afterLines + 1)),
      });
    }
  };

  if (input.documentId !== undefined) {
    scanDocument(await getRequiredKnowledgeDocument(context, input.documentId));
  } else {
    const summaries = await listKnowledgeDocuments(context);
    // Exact totalMatches still needs a full scan, but bounded reads avoid
    // loading an entire markdown knowledge base into memory at once.
    for (let start = 0; start < summaries.length; start += KNOWLEDGE_SEARCH_READ_CONCURRENCY) {
      const batch = await Promise.all(summaries
        .slice(start, start + KNOWLEDGE_SEARCH_READ_CONCURRENCY)
        .map((summary) => getKnowledgeDocument(context, summary.id)));
      for (const document of batch) {
        if (document !== undefined) scanDocument(document);
      }
    }
  }

  const nextOffset = cursor + matches.length;
  const hasMore = totalMatches > nextOffset;
  return {
    query,
    documentsSearched,
    totalMatches,
    matchesTruncated: hasMore,
    maxMatches: pageSize,
    pageSize,
    ...(cursor > 0 ? { cursor: String(cursor) } : {}),
    ...(hasMore ? { nextCursor: String(nextOffset) } : {}),
    hasMore,
    matches,
  };
}

export async function readKnowledgeDocumentLines(
  context: KnowledgeContext,
  input: ReadKnowledgeDocumentLinesInput,
): Promise<KnowledgeDocumentLinesResult> {
  const document = await getRequiredKnowledgeDocument(context, input.documentId);
  const { startLine, endLine } = normalizeLineRange(input.startLine, input.endLine);
  const lines = document.markdown.split(/\r?\n/);
  const clampedEndLine = Math.min(endLine, lines.length);
  return {
    documentId: document.id,
    title: document.title,
    startLine,
    endLine: clampedEndLine,
    totalLines: lines.length,
    lines: startLine > lines.length
      ? []
      : readContextLines(lines, startLine - 1, clampedEndLine),
  };
}

export function createKnowledgeDocumentKey(documentId: string): string {
  return `${KNOWLEDGE_DOCUMENT_KEY_PREFIX}${normalizeKnowledgeDocumentId(documentId)}`;
}

function createKnowledgeDocumentSummary(document: KnowledgeDocument): KnowledgeDocumentSummaryRecord {
  return {
    id: document.id,
    title: document.title,
    markdownPreview: createKnowledgeMarkdownPreview(document.markdown),
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
  };
}

async function withKnowledgeDocumentMutationLock<T>(
  context: KnowledgeContext,
  operation: () => Promise<T>,
): Promise<T> {
  const namespace = context.persistentValue;
  if (namespace.withLock === undefined) {
    throw new HarnessError({
      type: "execution",
      message: "Knowledge document mutations require an atomic PersistentValue namespace lock or mutation executor.",
    });
  }
  // A knowledge mutation only updates its own document and index. Optimistic
  // hosts may retry the whole operation when another consumer changed the index.
  for (let attempt = 0; ; attempt++) {
    try { return await namespace.withLock(operation); }
    catch (error) {
      if (attempt >= 23 || (error as {code?:string}).code !== "DATABASE_TRANSACTION_CONFLICT") throw error;
    }
  }
}

async function executeKnowledgeDocumentMutation<T>(
  context: KnowledgeContext,
  mutation: KVNamespaceMutation,
  operation: () => Promise<T>,
): Promise<T> {
  const namespace = context.persistentValue;
  if (namespace.executeMutation !== undefined) {
    return namespace.executeMutation<T>(mutation);
  }
  return withKnowledgeDocumentMutationLock(context, operation);
}

async function getRequiredKnowledgeDocument(
  context: KnowledgeContext,
  documentId: string,
): Promise<KnowledgeDocument> {
  const id = normalizeKnowledgeDocumentId(documentId);
  const document = await getKnowledgeDocument(context, id);
  if (document === undefined) {
    throw new HarnessError({
      type: "input_validation",
      message: `Knowledge document "${id}" does not exist.`,
      metadata: { documentId: id },
    });
  }
  return document;
}

async function readKnowledgeDocumentIndexMeta(
  context: KnowledgeContext,
): Promise<{ meta: KnowledgeDocumentIndexMeta; raw: unknown }> {
  const raw = await context.persistentValue.getValue(KNOWLEDGE_DOCUMENT_INDEX_KEY);
  return { meta: normalizeKnowledgeDocumentIndexMeta(raw), raw };
}

async function readKnowledgeDocumentIndexPage(
  context: KnowledgeContext,
  pageId: string,
): Promise<KnowledgeDocumentIndexPageState> {
  const normalizedPageId = normalizeKnowledgeDocumentIndexPageId(pageId);
  const raw = await context.persistentValue.getValue(createKnowledgeDocumentIndexPageKey(normalizedPageId));
  const page = normalizeKnowledgeDocumentIndexPage(raw);
  if (page === undefined) {
    throw new HarnessError({
      type: "execution",
      message: `Knowledge document index page "${normalizedPageId}" is missing or invalid.`,
      metadata: { pageId: normalizedPageId },
    });
  }
  return { pageId: normalizedPageId, page, raw };
}

async function readAllKnowledgeDocumentSummaries(
  context: KnowledgeContext,
  meta: KnowledgeDocumentIndexMeta,
): Promise<KnowledgeDocumentSummaryRecord[]> {
  if (meta.headPageId === undefined) return [];

  const summaries: KnowledgeDocumentSummaryRecord[] = [];
  const visited = new Set<string>();
  let pageId: string | undefined = meta.headPageId;
  while (pageId !== undefined) {
    if (visited.has(pageId)) {
      throw createKnowledgeDocumentIndexCycleError(pageId);
    }
    visited.add(pageId);
    const page = await readKnowledgeDocumentIndexPage(context, pageId);
    summaries.push(...page.page.entries.map((entry) => entry.summary));
    pageId = page.page.nextPageId;
  }
  return summaries;
}

async function readKnowledgeDocumentSummaryPage(
  context: KnowledgeContext,
  meta: KnowledgeDocumentIndexMeta,
  initialPageId: string | undefined,
  beforeSequence: number | undefined,
  pageSize: number,
): Promise<{ items: KnowledgeDocumentSummaryRecord[]; nextCursor?: KnowledgeDocumentPageCursor }> {
  const items: KnowledgeDocumentSummaryRecord[] = [];
  const visited = new Set<string>();
  let pageId: string | undefined = initialPageId ?? meta.headPageId;

  while (pageId !== undefined && items.length < pageSize) {
    if (visited.has(pageId)) {
      throw createKnowledgeDocumentIndexCycleError(pageId);
    }
    visited.add(pageId);
    const page = await readKnowledgeDocumentIndexPage(context, pageId);
    for (let index = 0; index < page.page.entries.length && items.length < pageSize; index += 1) {
      const entry = page.page.entries[index]!;
      if (beforeSequence !== undefined && entry.sequence >= beforeSequence) continue;
      items.push(entry.summary);
      if (items.length === pageSize) {
        const hasMore = await hasKnowledgeDocumentEntryBeforeSequence(
          context,
          page.page,
          index + 1,
          entry.sequence,
          visited,
        );
        return {
          items,
          ...(hasMore
            ? {
                nextCursor: {
                  version: KNOWLEDGE_DOCUMENT_INDEX_VERSION,
                  pageId,
                  beforeSequence: entry.sequence,
                } satisfies KnowledgeDocumentPageCursor,
              }
            : {}),
        };
      }
    }
    pageId = page.page.nextPageId;
  }

  return { items };
}

async function hasKnowledgeDocumentEntryBeforeSequence(
  context: KnowledgeContext,
  initialPage: KnowledgeDocumentIndexPageValue,
  initialOffset: number,
  beforeSequence: number,
  visited: Set<string>,
): Promise<boolean> {
  for (let index = initialOffset; index < initialPage.entries.length; index += 1) {
    if (initialPage.entries[index]!.sequence < beforeSequence) return true;
  }

  let pageId = initialPage.nextPageId;

  while (pageId !== undefined) {
    if (visited.has(pageId)) {
      throw createKnowledgeDocumentIndexCycleError(pageId);
    }
    visited.add(pageId);
    const page = await readKnowledgeDocumentIndexPage(context, pageId);
    if (page.page.entries.some((entry) => entry.sequence < beforeSequence)) {
      return true;
    }
    pageId = page.page.nextPageId;
  }
  return false;
}

async function prepareKnowledgeDocumentHeadPage(
  context: KnowledgeContext,
  meta: KnowledgeDocumentIndexMeta,
  sequence: number,
): Promise<{
  pageId: string;
  page: KnowledgeDocumentIndexPageValue;
  previousPage: unknown;
}> {
  if (meta.headPageId === undefined) {
    return {
      pageId: createKnowledgeDocumentIndexPageId(sequence),
      page: createKnowledgeDocumentIndexPage(),
      previousPage: undefined,
    };
  }

  const head = await readKnowledgeDocumentIndexPage(context, meta.headPageId);
  if (head.page.entries.length < KNOWLEDGE_DOCUMENT_INDEX_PAGE_SIZE) {
    return { pageId: head.pageId, page: head.page, previousPage: head.raw };
  }
  return {
    pageId: createKnowledgeDocumentIndexPageId(sequence),
    page: createKnowledgeDocumentIndexPage(head.pageId),
    previousPage: undefined,
  };
}

async function prepareKnowledgeDocumentEditTargetPage(
  context: KnowledgeContext,
  meta: KnowledgeDocumentIndexMeta,
  sequence: number,
  oldPage: KnowledgeDocumentIndexPageState,
  pageWithoutCurrent: KnowledgeDocumentIndexPageValue,
): Promise<{
  pageId: string;
  page: KnowledgeDocumentIndexPageValue;
  previousPage: unknown;
}> {
  if (oldPage.pageId === meta.headPageId) {
    return {
      pageId: oldPage.pageId,
      page: pageWithoutCurrent,
      previousPage: oldPage.raw,
    };
  }
  return prepareKnowledgeDocumentHeadPage(context, meta, sequence);
}

async function findKnowledgeDocumentPreviousPage(
  context: KnowledgeContext,
  meta: KnowledgeDocumentIndexMeta,
  pageId: string,
): Promise<KnowledgeDocumentIndexPageState | undefined> {
  let currentPageId = meta.headPageId;
  const visited = new Set<string>();
  while (currentPageId !== undefined) {
    if (visited.has(currentPageId)) {
      throw createKnowledgeDocumentIndexCycleError(currentPageId);
    }
    visited.add(currentPageId);
    const current = await readKnowledgeDocumentIndexPage(context, currentPageId);
    if (current.page.nextPageId === pageId) return current;
    currentPageId = current.page.nextPageId;
  }
  return undefined;
}

function withKnowledgeDocumentIndexNextPageId(
  page: KnowledgeDocumentIndexPageValue,
  nextPageId: string | undefined,
): KnowledgeDocumentIndexPageValue {
  const { nextPageId: _previousNextPageId, ...withoutNextPageId } = page;
  return nextPageId === undefined
    ? withoutNextPageId
    : { ...withoutNextPageId, nextPageId };
}

async function writeKnowledgeValues(
  context: KnowledgeContext,
  changes: KnowledgeValueChange[],
): Promise<void> {
  const namespace = context.persistentValue;
  const applied: KnowledgeValueChange[] = [];
  try {
    for (const change of changes) {
      await namespace.setValue(change.key, change.value);
      applied.push(change);
    }
  } catch (error) {
    for (const change of applied.reverse()) {
      await namespace.setValue(change.key, change.restoreValue).catch(() => undefined);
    }
    throw error;
  }
}

function createKnowledgeValueChange(
  key: string,
  value: unknown,
  previous: unknown,
  documentId?: string,
): KnowledgeValueChange {
  return {
    key,
    value,
    restoreValue: previous ?? createKnowledgeValueRollbackFallback(key, documentId),
  };
}

function createKnowledgeValueRollbackFallback(key: string, documentId?: string): unknown {
  if (key === KNOWLEDGE_DOCUMENT_INDEX_KEY) {
    return createKnowledgeDocumentIndexMeta();
  }
  if (key.startsWith(KNOWLEDGE_DOCUMENT_INDEX_PAGE_KEY_PREFIX)) {
    return createKnowledgeDocumentIndexPage();
  }
  if (key.startsWith(KNOWLEDGE_DOCUMENT_INDEX_LOCATOR_KEY_PREFIX)) {
    return {
      version: KNOWLEDGE_DOCUMENT_INDEX_VERSION,
      deleted: true,
      deletedAt: new Date().toISOString(),
    } satisfies KnowledgeDocumentIndexLocator;
  }
  return createKnowledgeDocumentTombstone(documentId ?? key.slice(KNOWLEDGE_DOCUMENT_KEY_PREFIX.length));
}

function createKnowledgeDocumentIndexMeta(): KnowledgeDocumentIndexMeta {
  return createKnowledgeDocumentIndexMetaWithTotal(0, 0);
}

function createKnowledgeDocumentIndexMetaWithTotal(
  nextSequence: number,
  total: number,
  headPageId?: string,
): KnowledgeDocumentIndexMeta {
  return {
    version: KNOWLEDGE_DOCUMENT_INDEX_VERSION,
    total,
    nextSequence,
    ...(headPageId === undefined ? {} : { headPageId }),
  };
}

function createKnowledgeDocumentIndexPage(nextPageId?: string): KnowledgeDocumentIndexPageValue {
  return {
    version: KNOWLEDGE_DOCUMENT_INDEX_VERSION,
    entries: [],
    ...(nextPageId === undefined ? {} : { nextPageId }),
  };
}

function createKnowledgeDocumentIndexPageId(sequence: number): string {
  return `page-${sequence.toString(36)}`;
}

function createKnowledgeDocumentIndexPageKey(pageId: string): string {
  return `${KNOWLEDGE_DOCUMENT_INDEX_PAGE_KEY_PREFIX}${normalizeKnowledgeDocumentIndexPageId(pageId)}`;
}

function createKnowledgeDocumentIndexLocatorKey(documentId: string): string {
  return `${KNOWLEDGE_DOCUMENT_INDEX_LOCATOR_KEY_PREFIX}${normalizeKnowledgeDocumentId(documentId)}`;
}

function createKnowledgeDocumentPageCursor(cursor: KnowledgeDocumentPageCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function createKnowledgeDocumentTombstone(id: string): { deleted: true; id: string; deletedAt: string } {
  return {
    deleted: true,
    id,
    deletedAt: new Date().toISOString(),
  };
}

function createKnowledgeDocumentIndexError(documentId: string, reason: string): HarnessError {
  return new HarnessError({
    type: "execution",
    message: `Knowledge document "${documentId}" ${reason}.`,
    metadata: { documentId },
  });
}

function createKnowledgeDocumentIndexCycleError(pageId: string): HarnessError {
  return new HarnessError({
    type: "execution",
    message: "Knowledge document index contains a page cycle.",
    metadata: { pageId },
  });
}

function readKnowledgeDocumentValue(value: unknown): KnowledgeDocument | undefined {
  return isKnowledgeDocument(value) ? value : undefined;
}

function readKnowledgeDocumentIndexLocator(value: unknown): KnowledgeDocumentIndexLocator | undefined {
  if (!isRecord(value) || value["version"] !== KNOWLEDGE_DOCUMENT_INDEX_VERSION) {
    return undefined;
  }
  if (value["deleted"] === true) {
    return {
      version: KNOWLEDGE_DOCUMENT_INDEX_VERSION,
      deleted: true,
      ...(typeof value["deletedAt"] === "string" ? { deletedAt: value["deletedAt"] } : {}),
    };
  }
  if (
    typeof value["pageId"] !== "string" ||
    !isKnowledgeDocumentIndexPageId(value["pageId"]) ||
    !isPositiveSafeInteger(value["sequence"])
  ) {
    return undefined;
  }
  return {
    version: KNOWLEDGE_DOCUMENT_INDEX_VERSION,
    pageId: value["pageId"],
    sequence: value["sequence"],
  };
}

function normalizeKnowledgeDocumentIndexMeta(value: unknown): KnowledgeDocumentIndexMeta {
  if (value === undefined) {
    return createKnowledgeDocumentIndexMeta();
  }
  if (
    !isRecord(value) ||
    value["version"] !== KNOWLEDGE_DOCUMENT_INDEX_VERSION ||
    !isNonNegativeSafeInteger(value["total"]) ||
    !isNonNegativeSafeInteger(value["nextSequence"])
  ) {
    throw new HarnessError({
      type: "execution",
      message: "Knowledge document index is invalid and cannot be overwritten safely.",
    });
  }
  const headPageId = typeof value["headPageId"] === "string" && isKnowledgeDocumentIndexPageId(value["headPageId"])
    ? value["headPageId"]
    : undefined;
  if (
    (value["total"] === 0 && headPageId !== undefined) ||
    (value["total"] > 0 && headPageId === undefined) ||
    value["nextSequence"] < value["total"]
  ) {
    throw new HarnessError({
      type: "execution",
      message: "Knowledge document index metadata is inconsistent and cannot be overwritten safely.",
    });
  }
  return {
    version: KNOWLEDGE_DOCUMENT_INDEX_VERSION,
    total: value["total"],
    nextSequence: value["nextSequence"],
    ...(headPageId === undefined ? {} : { headPageId }),
  };
}

function normalizeKnowledgeDocumentIndexPage(value: unknown): KnowledgeDocumentIndexPageValue | undefined {
  if (!isRecord(value) || value["version"] !== KNOWLEDGE_DOCUMENT_INDEX_VERSION || !Array.isArray(value["entries"])) {
    return undefined;
  }
  const entries = value["entries"].filter(isKnowledgeDocumentIndexEntry);
  if (entries.length > KNOWLEDGE_DOCUMENT_INDEX_PAGE_SIZE) {
    return undefined;
  }
  const nextPageId = typeof value["nextPageId"] === "string" && isKnowledgeDocumentIndexPageId(value["nextPageId"])
    ? value["nextPageId"]
    : undefined;
  return {
    version: KNOWLEDGE_DOCUMENT_INDEX_VERSION,
    entries,
    ...(nextPageId === undefined ? {} : { nextPageId }),
  };
}

function normalizeKnowledgeDocumentPageCursor(value: string | undefined): KnowledgeDocumentPageCursor | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value.trim(), "base64url").toString("utf8")) as unknown;
    if (
      !isRecord(parsed) ||
      parsed["version"] !== KNOWLEDGE_DOCUMENT_INDEX_VERSION ||
      typeof parsed["pageId"] !== "string" ||
      !isKnowledgeDocumentIndexPageId(parsed["pageId"]) ||
      !isPositiveSafeInteger(parsed["beforeSequence"])
    ) {
      throw new Error("invalid cursor");
    }
    return {
      version: KNOWLEDGE_DOCUMENT_INDEX_VERSION,
      pageId: parsed["pageId"],
      beforeSequence: parsed["beforeSequence"],
    };
  } catch {
    throw new HarnessError({
      type: "input_validation",
      message: "cursor must be a valid knowledge document page cursor.",
      metadata: { cursor: value },
    });
  }
}

function normalizeKnowledgeDocumentId(value: string): string {
  const id = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) {
    throw new HarnessError({
      type: "input_validation",
      message: "Knowledge document id must start with a letter or number and contain only letters, numbers, dot, underscore, or dash.",
      metadata: { documentId: value },
    });
  }
  return id;
}

function normalizeKnowledgeDocumentIndexPageId(value: string): string {
  if (!isKnowledgeDocumentIndexPageId(value)) {
    throw new HarnessError({
      type: "execution",
      message: "Knowledge document index page id is invalid.",
      metadata: { pageId: value },
    });
  }
  return value;
}

function isKnowledgeDocumentIndexPageId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

function normalizeKnowledgeDocumentTitle(value: string): string {
  const title = value.trim();
  if (title === "") {
    throw new HarnessError({
      type: "input_validation",
      message: "Knowledge document title must be a non-empty string.",
    });
  }
  return title;
}

function normalizeKnowledgeDocumentMarkdown(value: string): string {
  if (typeof value !== "string") {
    throw new HarnessError({
      type: "input_validation",
      message: "Knowledge document markdown must be a string.",
    });
  }
  return value;
}

function normalizeSearchQuery(value: string): string {
  const query = value.trim();
  if (query === "") {
    throw new HarnessError({
      type: "input_validation",
      message: "Knowledge document search query must be a non-empty string.",
    });
  }
  return query;
}

function normalizeContextLineCount(value: number | undefined, fieldName: string): number {
  if (value === undefined) return 0;
  if (!Number.isInteger(value) || value < 0 || value > 50) {
    throw new HarnessError({
      type: "input_validation",
      message: `${fieldName} must be an integer between 0 and 50.`,
      metadata: { [fieldName]: value },
    });
  }
  return value;
}

function normalizeSearchPageSize(value: number | undefined, fieldName: "pageSize" | "maxMatches"): number {
  if (value === undefined) return DEFAULT_KNOWLEDGE_SEARCH_PAGE_SIZE;
  if (!Number.isInteger(value) || value < 1 || value > MAX_KNOWLEDGE_SEARCH_PAGE_SIZE) {
    throw new HarnessError({
      type: "input_validation",
      message: `${fieldName} must be an integer between 1 and ${MAX_KNOWLEDGE_SEARCH_PAGE_SIZE}.`,
      metadata: { [fieldName]: value },
    });
  }
  return value;
}

function normalizeKnowledgeDocumentPageSize(value: number | undefined): number {
  if (value === undefined) return DEFAULT_KNOWLEDGE_DOCUMENT_PAGE_SIZE;
  if (!Number.isInteger(value) || value < 1 || value > MAX_KNOWLEDGE_DOCUMENT_PAGE_SIZE) {
    throw new HarnessError({
      type: "input_validation",
      message: `pageSize must be an integer between 1 and ${MAX_KNOWLEDGE_DOCUMENT_PAGE_SIZE}.`,
      metadata: { pageSize: value },
    });
  }
  return value;
}

function normalizeSearchCursor(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return 0;
  if (!/^\d+$/.test(value.trim())) {
    throw new HarnessError({
      type: "input_validation",
      message: "cursor must be a non-negative integer offset.",
      metadata: { cursor: value },
    });
  }
  const offset = Number(value.trim());
  if (!Number.isSafeInteger(offset)) {
    throw new HarnessError({
      type: "input_validation",
      message: "cursor must be a safe non-negative integer offset.",
      metadata: { cursor: value },
    });
  }
  return offset;
}

function normalizeLineRange(startLine: number, endLine: number): { startLine: number; endLine: number } {
  if (!Number.isInteger(startLine) || startLine < 1) {
    throw new HarnessError({
      type: "input_validation",
      message: "startLine must be an integer greater than or equal to 1.",
      metadata: { startLine },
    });
  }
  if (!Number.isInteger(endLine) || endLine < startLine) {
    throw new HarnessError({
      type: "input_validation",
      message: "endLine must be an integer greater than or equal to startLine.",
      metadata: { startLine, endLine },
    });
  }
  if (endLine - startLine + 1 > MAX_KNOWLEDGE_LINE_RANGE_LINES) {
    throw new HarnessError({
      type: "input_validation",
      message: `Knowledge document line range cannot exceed ${MAX_KNOWLEDGE_LINE_RANGE_LINES} lines.`,
      metadata: { startLine, endLine, maxLines: MAX_KNOWLEDGE_LINE_RANGE_LINES },
    });
  }
  return { startLine, endLine };
}

function createKnowledgeDocumentId(title: string): string {
  const normalized = title.trim().toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
  const base = normalized === "" ? "document" : normalized;
  return `${base}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Builds the compact markdown preview stored in knowledge-document summaries.
 *
 * Preview generation is intentionally bounded. A summary only needs enough
 * normalized text to decide whether it exceeds the display limit, so scanning
 * a multi-megabyte body or allocating normalized copies of it is unnecessary.
 */
export function createKnowledgeMarkdownPreview(markdown: string): string {
  let preview = "";
  let pendingWhitespace = false;
  const scanLength = Math.min(markdown.length, MAX_KNOWLEDGE_MARKDOWN_PREVIEW_SCAN_CODE_UNITS);

  for (let index = 0; index < scanLength; index += 1) {
    const character = markdown[index]!;
    if (isKnowledgeMarkdownPreviewWhitespace(character) || isKnowledgeMarkdownPreviewSyntax(character)) {
      pendingWhitespace = preview !== "";
      continue;
    }

    if (pendingWhitespace) {
      preview += " ";
      pendingWhitespace = false;
    }
    preview += character;
    if (preview.length > MAX_KNOWLEDGE_MARKDOWN_PREVIEW_LENGTH) {
      return `${preview.slice(0, MAX_KNOWLEDGE_MARKDOWN_PREVIEW_LENGTH - 3)}...`;
    }
  }

  return preview;
}

function isKnowledgeMarkdownPreviewSyntax(character: string): boolean {
  return character === "#" ||
    character === "*" ||
    character === "_" ||
    character === "`" ||
    character === ">" ||
    character === "[" ||
    character === "]" ||
    character === "(" ||
    character === ")";
}

function isKnowledgeMarkdownPreviewWhitespace(character: string): boolean {
  return KNOWLEDGE_MARKDOWN_PREVIEW_WHITESPACE_PATTERN.test(character);
}

function readContextLines(
  lines: string[],
  startIndex: number,
  endIndex: number,
): Array<{ lineNumber: number; content: string }> {
  const result: Array<{ lineNumber: number; content: string }> = [];
  for (let index = startIndex; index < endIndex; index += 1) {
    result.push({ lineNumber: index + 1, content: lines[index] ?? "" });
  }
  return result;
}

function isKnowledgeDocument(value: unknown): value is KnowledgeDocument {
  return isRecord(value) &&
    typeof value["id"] === "string" &&
    typeof value["title"] === "string" &&
    typeof value["markdown"] === "string" &&
    typeof value["createdAt"] === "string" &&
    typeof value["updatedAt"] === "string";
}

function isKnowledgeDocumentSummary(value: unknown): value is KnowledgeDocumentSummaryRecord {
  return isRecord(value) &&
    typeof value["id"] === "string" &&
    typeof value["title"] === "string" &&
    typeof value["markdownPreview"] === "string" &&
    typeof value["createdAt"] === "string" &&
    typeof value["updatedAt"] === "string";
}

function isKnowledgeDocumentIndexEntry(value: unknown): value is KnowledgeDocumentIndexEntry {
  return isRecord(value) &&
    isKnowledgeDocumentSummary(value["summary"]) &&
    isPositiveSafeInteger(value["sequence"]);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return isNonNegativeSafeInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
