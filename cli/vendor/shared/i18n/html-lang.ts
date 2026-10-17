// 更新 <html lang>，替换硬编码的 lang="zh-CN"。仅浏览器环境生效。
export function setHtmlLang(lang: string): void {
  if (typeof document !== "undefined" && document.documentElement) {
    document.documentElement.lang = lang;
  }
}
