import {
  getProjectKindDefinition,
  type ProjectKind,
} from "../project-types/index";

export const PROJECT_CARD_ICON_NAMES = [
  "workflow",
  "message-circle",
  "bot",
  "sparkles",
  "code",
  "git-branch",
  "boxes",
  "zap",
  "database",
  "file-text",
  "cpu",
  "brain",
] as const;

export type ProjectCardIconName = (typeof PROJECT_CARD_ICON_NAMES)[number];

export interface ProjectCardMetadata {
  icon: ProjectCardIconName;
  iconUrl?: string;
  iconColor?: string;
  iconBackgroundColor: string;
}

export interface ProjectCardColorPair {
  iconColor: string;
  iconBackgroundColor: string;
  contrastRatio: number;
}

export const PROJECT_CARD_COLOR_PRESETS = [
  "#2563eb",
  "#0f766e",
  "#7c3aed",
  "#d97706",
  "#dc2626",
  "#475569",
  "#111827",
  "#0891b2",
] as const;

const DEFAULT_PROJECT_CARD_ICON_COLOR = "#ffffff";
const MIN_PROJECT_CARD_ICON_CONTRAST = 4.5;


export class ProjectCardMetadataMigrationError extends Error {
  constructor() {
    super(
      'steamharness.json.projectCard.kind was removed. Declare the project type on its registered entry.',
    );
    this.name = "ProjectCardMetadataMigrationError";
  }
}

function canonicalizeProjectCardIconName(icon: ProjectCardIconName): ProjectCardIconName {
  return icon === "sparkles" ? "workflow" : icon;
}

export function defaultProjectCardIcon(kind: ProjectKind): ProjectCardIconName {
  return getProjectKindDefinition(kind).defaultIcon;
}

export function defaultProjectCardBackgroundColor(kind: ProjectKind): string {
  return getProjectKindDefinition(kind).defaultIconBackgroundColor;
}

export function defaultProjectCardIconColor(): string {
  return DEFAULT_PROJECT_CARD_ICON_COLOR;
}

export function normalizeProjectCardIconName(value: unknown): ProjectCardIconName | undefined {
  return typeof value === "string" && isProjectCardIconName(value)
    ? canonicalizeProjectCardIconName(value)
    : undefined;
}

export function normalizeProjectCardIconUrl(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed === "") {
    return undefined;
  }

  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function normalizeProjectCardBackgroundColor(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return /^#[0-9a-fA-F]{6}$/.test(trimmed) ? trimmed.toLowerCase() : undefined;
}

export function normalizeProjectCardIconColor(value: unknown): string | undefined {
  return normalizeProjectCardBackgroundColor(value);
}

export function getProjectCardColorContrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = getProjectCardColorRelativeLuminance(foreground);
  const backgroundLuminance = getProjectCardColorRelativeLuminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

export function getProjectCardColorRelativeLuminance(color: string): number {
  const normalized = normalizeProjectCardBackgroundColor(color);
  if (normalized === undefined) {
    throw new Error("Project card colors must be #RRGGBB values.");
  }
  const channels = [1, 3, 5].map((index) => Number.parseInt(normalized.slice(index, index + 2), 16) / 255);
  const [red, green, blue] = channels.map((channel) => (
    channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4
  ));
  return red * 0.2126 + green * 0.7152 + blue * 0.0722;
}

export function generateProjectCardColorPair(random: () => number = Math.random): ProjectCardColorPair {
  const useDarkBackground = randomUnit(random) < 0.5;

  for (let attempt = 0; attempt < 24; attempt += 1) {
    const backgroundHue = randomBetween(random, 0, 360);
    const iconHue = (backgroundHue + randomBetween(random, 24, 336)) % 360;
    const iconColor = useDarkBackground
      ? hslToHex(iconHue, randomBetween(random, 18, 68), randomBetween(random, 90, 98))
      : hslToHex(iconHue, randomBetween(random, 48, 88), randomBetween(random, 14, 28));
    const iconBackgroundColor = useDarkBackground
      ? hslToHex(backgroundHue, randomBetween(random, 42, 82), randomBetween(random, 16, 30))
      : hslToHex(backgroundHue, randomBetween(random, 22, 62), randomBetween(random, 88, 97));
    const contrastRatio = getProjectCardColorContrastRatio(iconColor, iconBackgroundColor);

    if (contrastRatio >= MIN_PROJECT_CARD_ICON_CONTRAST) {
      return { iconColor, iconBackgroundColor, contrastRatio };
    }
  }

  const fallback = useDarkBackground
    ? { iconColor: "#f8fafc", iconBackgroundColor: "#1f2937" }
    : { iconColor: "#111827", iconBackgroundColor: "#f8fafc" };
  return {
    ...fallback,
    contrastRatio: getProjectCardColorContrastRatio(fallback.iconColor, fallback.iconBackgroundColor),
  };
}

export function normalizeProjectCardMetadata(
  value: unknown,
  projectType: ProjectKind,
): ProjectCardMetadata {
  const raw = isRecord(value) ? value : {};
  return {
    icon: normalizeProjectCardIconName(raw.icon) ?? defaultProjectCardIcon(projectType),
    iconUrl: normalizeProjectCardIconUrl(raw.iconUrl),
    iconColor: normalizeProjectCardIconColor(raw.iconColor) ?? defaultProjectCardIconColor(),
    iconBackgroundColor:
      normalizeProjectCardBackgroundColor(raw.iconBackgroundColor) ??
      defaultProjectCardBackgroundColor(projectType),
  };
}

export function generateProjectCardMetadata(projectType: ProjectKind, random: () => number = Math.random): ProjectCardMetadata {
  const { iconColor, iconBackgroundColor } = generateProjectCardColorPair(random);
  return { icon: defaultProjectCardIcon(projectType), iconColor, iconBackgroundColor };
}

export function validateProjectCardMetadata(value: unknown): ProjectCardMetadata {
  if (!isRecord(value)) {
    throw new Error("Project card metadata must be an object.");
  }
  if (Object.hasOwn(value, "kind")) {
    throw new ProjectCardMetadataMigrationError();
  }

  const icon = normalizeProjectCardIconName(value.icon);
  if (icon === undefined) {
    throw new Error("Project card icon is invalid.");
  }

  const iconUrlInput = typeof value.iconUrl === "string" ? value.iconUrl.trim() : "";
  const iconUrl = iconUrlInput === "" ? undefined : normalizeProjectCardIconUrl(iconUrlInput);
  if (iconUrlInput !== "" && iconUrl === undefined) {
    throw new Error("Project icon URL must use http:// or https://.");
  }

  const iconColor = value.iconColor === undefined
    ? defaultProjectCardIconColor()
    : normalizeProjectCardIconColor(value.iconColor);
  if (iconColor === undefined) {
    throw new Error("Project icon color must be a #RRGGBB value.");
  }

  const iconBackgroundColor = normalizeProjectCardBackgroundColor(value.iconBackgroundColor);
  if (iconBackgroundColor === undefined) {
    throw new Error("Project icon background color must be a #RRGGBB value.");
  }

  return {
    icon,
    iconUrl,
    iconColor,
    iconBackgroundColor,
  };
}

export function readProjectCardMetadata(document: Record<string, unknown>, projectType: ProjectKind): ProjectCardMetadata {
  if (isRecord(document.projectCard) && Object.hasOwn(document.projectCard, "kind")) throw new ProjectCardMetadataMigrationError();
  return normalizeProjectCardMetadata(document.projectCard, projectType);
}
export function writeProjectCardMetadata(document: Record<string, unknown>, metadataInput: ProjectCardMetadata): Record<string, unknown> {
  const { iconUrl, ...metadata } = validateProjectCardMetadata(metadataInput);
  return { ...document, projectCard: { ...metadata, ...(iconUrl === undefined ? {} : {iconUrl}) } };
}

export const PROJECT_APP_CARD_ICON_NAMES = PROJECT_CARD_ICON_NAMES;
export type ProjectAppCardIconName = ProjectCardIconName;
export type ProjectAppCardMetadata = ProjectCardMetadata;
export const PROJECT_APP_CARD_COLOR_PRESETS = PROJECT_CARD_COLOR_PRESETS;
export const defaultProjectAppCardIcon = defaultProjectCardIcon;
export const defaultProjectAppCardBackgroundColor = defaultProjectCardBackgroundColor;
export const defaultProjectAppCardIconColor = defaultProjectCardIconColor;
export const normalizeProjectAppCardIconName = normalizeProjectCardIconName;
export const normalizeProjectAppCardIconUrl = normalizeProjectCardIconUrl;
export const normalizeProjectAppCardBackgroundColor = normalizeProjectCardBackgroundColor;
export const normalizeProjectAppCardIconColor = normalizeProjectCardIconColor;
export const normalizeProjectAppCardMetadata = normalizeProjectCardMetadata;
export const validateProjectAppCardMetadata = validateProjectCardMetadata;

function isProjectCardIconName(value: string): value is ProjectCardIconName {
  return PROJECT_CARD_ICON_NAMES.includes(value as ProjectCardIconName);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function randomUnit(random: () => number): number {
  const value = random();
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(Math.max(value, 0), 0.999999999999);
}

function randomBetween(random: () => number, min: number, max: number): number {
  return min + (max - min) * randomUnit(random);
}

function hslToHex(hue: number, saturation: number, lightness: number): string {
  const normalizedHue = ((hue % 360) + 360) % 360;
  const normalizedSaturation = Math.min(Math.max(saturation, 0), 100) / 100;
  const normalizedLightness = Math.min(Math.max(lightness, 0), 100) / 100;
  const chroma = (1 - Math.abs(2 * normalizedLightness - 1)) * normalizedSaturation;
  const hueSegment = normalizedHue / 60;
  const secondary = chroma * (1 - Math.abs((hueSegment % 2) - 1));
  const [red, green, blue] = hueSegment < 1
    ? [chroma, secondary, 0]
    : hueSegment < 2
      ? [secondary, chroma, 0]
      : hueSegment < 3
        ? [0, chroma, secondary]
        : hueSegment < 4
          ? [0, secondary, chroma]
          : hueSegment < 5
            ? [secondary, 0, chroma]
            : [chroma, 0, secondary];
  const match = normalizedLightness - chroma / 2;
  return `#${[red, green, blue]
    .map((channel) => Math.round((channel + match) * 255).toString(16).padStart(2, "0"))
    .join("")}`;
}
