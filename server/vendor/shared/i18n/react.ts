// React 绑定入口。注册 initReactI18next 插件后复用 index 的 initI18n。
// 必须在调用 initI18n / 渲染组件之前 import 本模块（宿主入口直接从这里导入即可）。
import { initReactI18next } from "react-i18next";
import { i18n } from "./instance";

i18n.use(initReactI18next);

export { i18n } from "./instance";
export { useTranslation, Trans } from "react-i18next";
export * from "./index";
