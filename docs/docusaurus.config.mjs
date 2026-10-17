import path from "node:path";
import { fileURLToPath } from "node:url";

const siteDir = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('@docusaurus/types').Config} */
const config = {
  title: "Workflow Code",
  tagline: "Build, run, and publish typed workflows",
  favicon: "brand/favicon.png",
  url: "https://wfdocs.yuhe.space",
  baseUrl: "/",
  trailingSlash: true,
  onBrokenLinks: "throw",
  onBrokenAnchors: "warn",
  markdown: {
    hooks: {
      onBrokenMarkdownLinks: "throw",
    },
  },
  staticDirectories: ["images"],
  i18n: {
    defaultLocale: "zh-Hans",
    locales: ["zh-Hans", "en"],
    localeConfigs: {
      "zh-Hans": {
        label: "简体中文",
        htmlLang: "zh-CN",
      },
      en: {
        label: "English",
        htmlLang: "en",
      },
    },
  },
  presets: [
    [
      "classic",
      {
        docs: false,
        blog: false,
        pages: false,
        theme: {
          customCss: "./src/css/custom.css",
        },
      },
    ],
  ],
  plugins: [
    [
      "./plugins/localized-content-docs.mjs",
      {
        id: "default",
        routeBasePath: "/",
        include: [
          "index.mdx",
          "cli/**/*.mdx",
          "concepts/**/*.mdx",
          "core-api/**/*.mdx",
          "guides/**/*.mdx",
          "reference/**/*.mdx",
        ],
        docItemComponent: "@theme/ApiItem",
        breadcrumbs: true,
        sidebarCollapsible: true,
        sidebarCollapsed: false,
        showLastUpdateAuthor: false,
        showLastUpdateTime: false,
      },
    ],
    [
      "docusaurus-plugin-openapi-docs",
      {
        id: "openapi",
        docsPluginId: "default",
        config: {
          workflowZh: {
            specPath: ".docusaurus-openapi/workflow-code.zh.yaml",
            outputDir: "./reference",
            showSchemas: true,
            sidebarOptions: {
              groupPathsBy: "tag",
              categoryLinkSource: "tag",
              sidebarCollapsed: true,
            },
          },
          workflowEn: {
            specPath: ".docusaurus-openapi/workflow-code.en.yaml",
            outputDir: "en/reference",
            showSchemas: true,
            sidebarOptions: {
              groupPathsBy: "tag",
              categoryLinkSource: "tag",
              sidebarCollapsed: true,
            },
          },
        },
      },
    ],
    ["docusaurus-plugin-sass", {}],
    [
      "@easyops-cn/docusaurus-search-local",
      {
        hashed: true,
        docsRouteBasePath: "/",
        docsDir: ["cli", "concepts", "core-api", "guides", "en", "reference"],
        language: ["en", "zh"],
        indexBlog: false,
        indexPages: false,
        highlightSearchTermsOnTargetPage: true,
        searchBarShortcutHint: false,
      },
    ],
  ],
  themes: ["docusaurus-theme-openapi-docs"],
  themeConfig: {
    image: "brand/workflow-code-icon.svg",
    colorMode: {
      defaultMode: "light",
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: "",
      hideOnScroll: false,
      logo: {
        alt: "Workflow Code",
        src: "brand/workflow-code-docs-logo.svg",
        srcDark: "brand/workflow-code-docs-logo-dark.svg",
      },
      items: [
        { type: "docSidebar", sidebarId: "guidesSidebar", label: "指南", position: "left" },
        { type: "docSidebar", sidebarId: "referenceSidebar", label: "参考手册", position: "left" },
        { type: "docSidebar", sidebarId: "releasesSidebar", label: "发布日志", position: "left" },
        { type: "docSidebar", sidebarId: "serverApiSidebar", label: "服务端 API", position: "left" },
        { type: "localeDropdown", position: "right" },
        { type: "search", position: "right" },
      ],
    },
    footer: {
      style: "light",
      links: [
        {
          title: "Workflow Code",
          items: [
            { label: "Studio", to: "/guides/studio/overview" },
            { label: "Server Web", to: "/guides/server/overview" },
            { label: "Core API", to: "/core-api/overview" },
          ],
        },
        {
          title: "资源",
          items: [
            { label: "发布日志", to: "/guides/releases/overview" },
            { label: "服务端 API", to: "/reference/workflow-code-api/" },
          ],
        },
      ],
      copyright: `Copyright ${new Date().getFullYear()} Workflow Code`,
    },
    prism: {
      additionalLanguages: ["bash", "json", "yaml", "typescript"],
    },
  },
  customFields: {
    sourceRoot: siteDir,
  },
};

export default config;
