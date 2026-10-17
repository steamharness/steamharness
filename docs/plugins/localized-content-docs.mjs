import contentDocs, { validateOptions as validateContentDocsOptions } from "@docusaurus/plugin-content-docs";

export default function localizedContentDocs(context, options) {
  const english = context.i18n.currentLocale === "en";
  return contentDocs(context, {
    ...options,
    path: english ? "en" : ".",
    sidebarPath: english ? "./sidebars.en.mjs" : "./sidebars.zh.mjs",
  });
}

export function validateOptions(args) {
  return validateContentDocsOptions(args);
}
