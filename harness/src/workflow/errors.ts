export type ErrorType =
  | "input_validation"
  | "execution_aborted"
  | "user_input_required"
  | "tool_permission_denied"
  | "node_execution"
  | "provider_call"
  | "execution"
  | "stream_interrupted";

export interface ErrorCause {
  name?: string;
  message: string;
  statusCode?: number;
  url?: string;
  isRetryable?: boolean;
  responseBody?: string;
  cause?: ErrorCause;
  validation?: Array<{
    path: string;
    message: string;
  }>;
}

export interface ErrorOptions {
  type: ErrorType;
  message: string;
  nodeName?: string;
  cause?: unknown;
  metadata?: Record<string, unknown>;
}

export type ErrorFallbackOptions = Omit<ErrorOptions, "cause">;

export interface SerializedWorkflowError {
  type: ErrorType;
  message: string;
  nodeName?: string;
  metadata?: Record<string, unknown>;
  cause?: ErrorCause;
}

export interface SuccessResult<Output> {
  ok: true;
  data: Output;
}

export interface FailureResult {
  ok: false;
  error: SerializedWorkflowError;
}

export type RunResult<Output> =
  | SuccessResult<Output>
  | FailureResult;

export class HarnessError extends Error {
  readonly type: ErrorType;
  readonly nodeName?: string;
  readonly metadata?: Record<string, unknown>;
  readonly safeCause?: ErrorCause;

  constructor(options: ErrorOptions) {
    super(options.message);
    this.name = "HarnessError";
    this.type = options.type;
    this.nodeName = options.nodeName;
    this.metadata = options.metadata;
    this.safeCause = sanitizeErrorCause(options.cause);
  }
}

export function toWorkflowError(
  error: unknown,
  fallback: ErrorFallbackOptions & { cause?: unknown },
): HarnessError {
  if (error instanceof HarnessError) {
    return enrichWorkflowError(error, fallback);
  }

  return new HarnessError({
    ...fallback,
    cause: fallback.cause ?? error,
  });
}

export function serializeWorkflowError(error: unknown): SerializedWorkflowError {
  const workflowError =
    error instanceof HarnessError
      ? error
      : new HarnessError({
          type: "execution",
          message: readPublicErrorMessage(error) ?? "Unexpected workflow error.",
          cause: error,
        });

  return {
    type: workflowError.type,
    message: workflowError.message,
    nodeName: workflowError.nodeName,
    metadata: workflowError.metadata,
    cause: workflowError.safeCause,
  };
}

export function createWorkflowFailure(error: unknown): FailureResult {
  return {
    ok: false,
    error: serializeWorkflowError(error),
  };
}

function enrichWorkflowError(
  error: HarnessError,
  fallback: ErrorFallbackOptions & { cause?: unknown },
): HarnessError {
  if (
    error.nodeName !== undefined &&
    (fallback.metadata === undefined || Object.keys(fallback.metadata).length === 0)
  ) {
    return error;
  }

  return new HarnessError({
    type: error.type,
    message: error.message,
    nodeName: error.nodeName ?? fallback.nodeName,
    metadata: {
      ...fallback.metadata,
      ...error.metadata,
    },
    cause: fallback.cause ?? error.safeCause,
  });
}

function sanitizeErrorCause(error: unknown): ErrorCause | undefined {
  if (error === undefined || error === null) {
    return undefined;
  }

  if (isWorkflowErrorCause(error)) {
    return {
      name: error.name,
      message: error.message,
      statusCode: error.statusCode,
      url: error.url,
      isRetryable: error.isRetryable,
      responseBody: summarizeResponseBody(error.responseBody),
      cause: sanitizeErrorCause(readUnknownProperty(error, "cause")),
      validation: error.validation,
    };
  }

  if (typeof error === "string") {
    return {
      message: error,
    };
  }

  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...extractKnownErrorFields(error),
      cause: sanitizeErrorCause(readUnknownProperty(error, "cause")),
    };
  }

  if (typeof error === "object") {
    return {
      name: readStringProperty(error, "name"),
      message: readStringProperty(error, "message") ?? "Unknown object error.",
      ...extractKnownErrorFields(error),
      cause: sanitizeErrorCause(readUnknownProperty(error, "cause")),
    };
  }

  return {
    message: String(error),
  };
}

function readPublicErrorMessage(error: unknown): string | undefined {
  if (error === undefined || error === null) {
    return undefined;
  }

  if (typeof error === "string") {
    return normalizeErrorMessage(error);
  }

  if (error instanceof Error) {
    return normalizeErrorMessage(error.message);
  }

  if (typeof error === "object") {
    return normalizeErrorMessage(readStringProperty(error, "message"));
  }

  return normalizeErrorMessage(String(error));
}

function normalizeErrorMessage(message: string | undefined): string | undefined {
  const trimmed = message?.trim();

  return trimmed === "" ? undefined : trimmed;
}

function extractKnownErrorFields(error: object): Omit<ErrorCause, "message" | "name"> {
  const validation = extractValidation(error);

  return {
    statusCode: readNumberProperty(error, "statusCode"),
    url: readStringProperty(error, "url"),
    isRetryable: readBooleanProperty(error, "isRetryable"),
    responseBody: summarizeResponseBody(readStringProperty(error, "responseBody")),
    validation,
  };
}

const MAX_RESPONSE_BODY_SUMMARY_LENGTH = 200;
const REDACTED = "[redacted]";

/**
 * Redaction rules applied to an upstream response body before it is reported.
 *
 * The excerpt reaches run reports, logs and desktop UI, so anything credential shaped has to go. Each rule is
 * deliberately narrow enough not to swallow ordinary prose: `admin_key_invalid`, `sub-resource-not-found` and
 * `Bearer authentication is required` must survive intact, which is why every token rule additionally
 * requires the candidate to look like a random secret rather than a word.
 */
const REDACTION_RULES: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
  // JSON Web Tokens, including the payload and signature segments.
  {
    pattern: /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g,
    replacement: REDACTED,
  },
  // Bearer values, but not the English word that follows "Bearer" in prose. Applied before the keyed rule so
  // the scheme name itself survives and stays readable.
  {
    pattern: /\b(Bearer\s+)(?=[A-Za-z0-9._~+/=-]*[\d._~+/=-])([A-Za-z0-9._~+/=-]{8,})/gi,
    replacement: `$1${REDACTED}`,
  },
  // "api_key": "...", token=..., "authorization": "Bearer ..."
  {
    pattern: /(["']?(?:api[_-]?keys?|access[_-]?tokens?|refresh[_-]?tokens?|id[_-]?tokens?|tokens?|secrets?|passwords?|authorization|credentials?)["']?\s*[:=]\s*["']?(?:Bearer\s+)?)([^"'\s,;}\]]{6,})/gi,
    replacement: `$1${REDACTED}`,
  },
  // Known credential prefixes; the lookahead demands a digit so ordinary hyphenated words never match.
  {
    pattern: /\b(?:github_pat|glpat|provider|wf_access|wfllm|wfrt|wfwh|admin|ghp|gho|ghs|sk|pk)[-_](?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{12,}/gi,
    replacement: REDACTED,
  },
];

/**
 * Keeps a short, redacted excerpt of an upstream HTTP error body.
 *
 * AI SDK style errors report only the HTTP `statusText` in `message` (for example `Unauthorized`), which hides
 * the machine-readable reason the upstream actually returned. Carrying a bounded excerpt makes the real cause
 * visible without turning the report into a dump or leaking credentials echoed back by the upstream.
 */
function summarizeResponseBody(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed === "") {
    return undefined;
  }

  const redacted = REDACTION_RULES.reduce(
    (text, rule) => text.replace(rule.pattern, rule.replacement),
    collapsed,
  );

  return redacted.length > MAX_RESPONSE_BODY_SUMMARY_LENGTH
    ? `${redacted.slice(0, MAX_RESPONSE_BODY_SUMMARY_LENGTH)}…`
    : redacted;
}

function extractValidation(error: object): ErrorCause["validation"] {
  const cause = readUnknownProperty(error, "cause");
  const causeCause =
    typeof cause === "object" && cause !== null
      ? readUnknownProperty(cause, "cause")
      : undefined;
  const issues = findIssues(cause) ?? findIssues(causeCause);

  if (issues === undefined) {
    return undefined;
  }

  return issues.map((issue) => ({
    path: Array.isArray(issue.path) ? issue.path.join(".") : "",
    message: issue.message,
  }));
}

function findIssues(value: unknown): Array<{ path?: unknown; message: string }> | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const issues = readUnknownProperty(value, "issues");
  if (Array.isArray(issues)) {
    return issues.filter(isValidationIssue);
  }

  const errors = readUnknownProperty(value, "errors");
  if (Array.isArray(errors)) {
    return errors.filter(isValidationIssue);
  }

  return undefined;
}

function isValidationIssue(value: unknown): value is { path?: unknown; message: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof readUnknownProperty(value, "message") === "string"
  );
}

function isWorkflowErrorCause(value: unknown): value is ErrorCause {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof readUnknownProperty(value, "message") === "string" &&
    !("stack" in value)
  );
}

function readUnknownProperty(value: object, key: string): unknown {
  return (value as Record<string, unknown>)[key];
}

function readStringProperty(value: object, key: string): string | undefined {
  const property = readUnknownProperty(value, key);

  return typeof property === "string" ? property : undefined;
}

function readNumberProperty(value: object, key: string): number | undefined {
  const property = readUnknownProperty(value, key);

  return typeof property === "number" ? property : undefined;
}

function readBooleanProperty(value: object, key: string): boolean | undefined {
  const property = readUnknownProperty(value, key);

  return typeof property === "boolean" ? property : undefined;
}
