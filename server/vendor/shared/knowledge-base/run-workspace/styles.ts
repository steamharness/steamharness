import styles from "./styles.module.css";

export { styles as runWorkspaceStyles };

type StyleToken = keyof typeof styles;
type StyleValue = string | false | null | undefined;

const splitTokens = (value: string): string[] => value.split(/\s+/).filter(Boolean);
const isNonEmptyString = (value: StyleValue): value is string => typeof value === "string" && value.length > 0;

// Shared run workspace styling is compiled through CSS Modules.
// Components pass semantic tokens and this helper resolves them to the
// package-local hashed class names, while ignoring empty entries.
export function rwiClass(...tokens: StyleValue[]): string {
  return tokens
    .filter(isNonEmptyString)
    .map((token) => styles[token as StyleToken] ?? "")
    .filter(Boolean)
    .join(" ");
}

export function joinClassNames(...classNames: StyleValue[]): string {
  return classNames.filter(isNonEmptyString).join(" ");
}

// Public className props can receive either shared semantic tokens
// or already-resolved CSS Module class strings from another shared component.
// Resolve known tokens, but preserve real external/hashed class names.
export function resolveRwiClassName(value: StyleValue): string {
  return typeof value === "string"
    ? splitTokens(value).map((token) => styles[token as StyleToken] ?? token).join(" ")
    : "";
}

const attachmentActionButtonTokens = {
  icon: ["rwi-icon-button", "rwi-attachment-action-button"],
} as const;

export type AttachmentActionButtonKind = keyof typeof attachmentActionButtonTokens;

export function attachmentActionButtonClassName(
  kind: AttachmentActionButtonKind = "icon",
  ...classNames: StyleValue[]
): string {
  return joinClassNames(rwiClass(...attachmentActionButtonTokens[kind]), ...classNames);
}

const outputItemStatusTokens = {
  running: "rwi-output-item-status-running",
  success: "rwi-output-item-status-success",
  failed: "rwi-output-item-status-failed",
} as const;

export function rwiOutputItemStatusClass(
  status: keyof typeof outputItemStatusTokens,
): string {
  return rwiClass("rwi-output-item-status", outputItemStatusTokens[status]);
}
