# 项目修复

## 必需知识门禁

先完整读取本文件与当前运行时 API 参考。旧版 CLI 返回 `0` 也不能覆盖直接发现的合同错误。不要把字段机械改名；重新声明入口、关系数据库与知识库需求，并逐入口执行当前版本检查。代码工作区授权与 Server 数据资源授权分别校验。

先读取根 steamharness.json，验证顶层 id（UUID）、name、version、entries 和 defaultEntry。根目录入口使用 root: "." 并完整内联声明；子目录登记项只包含 entryId 和 root，由对应目录的 steamharness.json 提供 type、name、entry 以及可选 configuration、projectCard、projectInfo、databases、knowledgeBases 和 schedulePresets。只检查父配置登记的子入口，不扫描其他子配置。类型属于入口，Workflow 内部操作使用 entrypointId。逐入口静态分析；非法路径、重复 ID、类型不匹配直接修复声明。

不兼容旧项目声明，不自动导入旧数据。删除旧 KV、PersistentValue、本地注册表、项目关系与组合发行锁。保留普通 npm 依赖。多模块代码保持目录结构，只在根声明聚合身份。

业务数据库使用 steamharness.database.ts 与 database/steamharness.schema 定义；执行 steamharness database generate 后导入生成的描述符。各入口的 databases 只声明 alias 字符串数组，使用 context.databases.connect(descriptor)。资源与绑定由 Server 按账号、projectId、entryId、alias 管理；config.json 不存关系数据库 ID。一个入口可以连接多个库，不同项目的同名模型在独立 PostgreSQL schema 中隔离。知识库单独声明 knowledgeBases，在根 config.json 的 knowledgeBases 中映射已授权的知识库 ID，可用 STEAMHARNESS_PROJECT_CONFIG 覆盖。

先申请数据库，完成 schema 校验和迁移，再为入口绑定资源。只保存非敏感引用，不把凭据写入源码。未绑定、撤权、重绑、schema 不匹配或版本冲突必须明确报错；不能自动创建、自动换库、重放写操作或回退到本地存储。Browser 使用生成的 browser 描述符，通过宿主代理访问关系表；连接在页面生命周期内固定绑定，修改与删除携带 rowVersion。

跨入口使用 context.entries.get(entryId)，保留原 actor、取消信号及工具限制；目标配置和 Server 资源授权在执行时重新校验。平台会话、运行记录和用量存入 Server 共享关系表，按身份隔离；业务表由项目自己定义。测试使用专用 Server 测试身份、项目、入口、会话与独立资源，不清理其他业务数据。
