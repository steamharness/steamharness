import { createSidebars } from "./docusaurus/create-sidebars.mjs";
import serverApiSidebar from "./reference/sidebar.ts";

export default {
  ...createSidebars("zh-Hans"),
  serverApiSidebar,
};
