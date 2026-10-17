// i18next 单例独立放在本模块，避免 index.ts / utils / react.ts 之间产生循环依赖。
// 初始化由 initI18n() 完成；React 宿主额外在 react.ts 注册 initReactI18next 插件。
import { createInstance, type i18n as I18nInstance } from "i18next";

// 显式标注类型，避免 composite tsconfig 下“无法命名来自 node_modules 的类型”报错。
export const i18n: I18nInstance = createInstance();
