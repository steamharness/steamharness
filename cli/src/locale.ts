import {
  i18n,
  initI18n,
  isSupportedLocale,
  normalizeLocale,
  type LocalePreference,
  type SupportedLocale,
} from "@steamharness/i18n";
import { STEAMHARNESS_RUNTIME_LOCALE_ENV } from "steamharness";

export interface PreparedCliInvocation {
  argv: string[];
  locale: SupportedLocale;
}

/** Resolve the one CLI-global locale option before command dispatch. */
export function prepareCliInvocation(argv: string[]): PreparedCliInvocation {
  initI18n({ preference: resolveSystemLocalePreference() });

  const extracted = extractLocaleOption(argv);
  const requestedLocale = extracted.locale ?? readEnvironmentLocale();
  if (requestedLocale !== undefined) {
    if (!isSupportedLocale(requestedLocale)) {
      throw new Error(i18n.t("invalidLocale", {
        ns: "cli",
        value: requestedLocale,
      }));
    }
    initI18n({ preference: requestedLocale });
  }

  const locale = normalizeLocale(i18n.language);
  process.env[STEAMHARNESS_RUNTIME_LOCALE_ENV] = locale;

  return {
    argv: extracted.argv,
    locale,
  };
}

export function extractLocaleOption(argv: string[]): {
  argv: string[];
  locale?: string;
} {
  const filtered: string[] = [];
  let locale: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      filtered.push(...argv.slice(index));
      break;
    }

    if (arg === "--locale" || arg.startsWith("--locale=")) {
      if (locale !== undefined) {
        throw new Error(i18n.t("duplicateLocale", { ns: "cli" }));
      }
      const value = arg === "--locale" ? argv[++index] : arg.slice("--locale=".length);
      if (value === undefined || value.trim() === "") {
        throw new Error(i18n.t("missingOptionValue", { ns: "cli", name: "--locale" }));
      }
      locale = value;
      continue;
    }

    filtered.push(arg);
  }

  return { argv: filtered, locale };
}

function readEnvironmentLocale(): string | undefined {
  const value = process.env.STEAMHARNESS_LOCALE?.trim();
  return value === "" ? undefined : value;
}

function resolveSystemLocalePreference(): LocalePreference {
  const systemLocale = process.env.LC_ALL ?? process.env.LANG;
  return systemLocale?.trim() ? normalizeLocale(systemLocale) : "system";
}
