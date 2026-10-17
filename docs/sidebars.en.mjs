import { createSidebars } from "./docusaurus/create-sidebars.mjs";
import serverApiSidebar from "./en/reference/sidebar.ts";

export default {
  ...createSidebars("en"),
  serverApiSidebar,
};
