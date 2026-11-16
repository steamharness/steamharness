# 项目修复

## 必需知识门禁

先完整读取本文件与当前运行时 API 参考。旧版 CLI 返回 `0` 也不能覆盖直接发现的合同错误。不要把字段机械改名；重新声明入口并逐入口执行当前版本检查。代码工作区授权与 Server 项目授权分别校验。

先读取根 steamharness.json，验证顶层 id（UUID）、name、version、entries 和 defaultEntry。根目录入口使用 root: "." 并完整内联声明；子目录登记项只包含 entryId 和 root，由对应目录的 steamharness.json 提供 type、name、entry 以及可选 configuration、projectCard、projectInfo 和 schedulePresets。只检查父配置登记的子入口，不扫描其他子配置。类型属于入口，Workflow 内部操作使用 entrypointId。逐入口静态分析；非法路径、重复 ID、类型不匹配直接修复声明。

不兼容旧项目声明，不自动导入旧数据。删除旧 KV、PersistentValue、本地注册表、项目关系与组合发行锁。保留普通 npm 依赖。多模块代码保持目录结构，只在根声明聚合身份。

跨入口使用 context.entries.get(entryId)，保留原 actor、取消信号及工具限制；目标配置和 Server 项目授权在执行时重新校验。平台会话、运行记录和用量由宿主存储，按身份隔离。测试使用专用身份、项目、入口与会话，不清理其他业务数据。
