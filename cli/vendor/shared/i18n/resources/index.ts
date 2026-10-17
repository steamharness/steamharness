import { enResources } from "./en";
import { zhResources } from "./zh";

// 资源按语言分组传给 i18next init。zh 是默认与回退语言。
export const resources = {
  "zh-CN": zhResources,
  en: enResources,
};

export { enResources } from "./en";
export { zhResources } from "./zh";
