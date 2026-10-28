# 项目修复

## 必需知识门禁

先完整读取本文件与当前运行时 API 参考。旧版 CLI 返回 `0` 也不能覆盖直接发现的合同错误。不要把字段机械改名；重新声明入口及数据库需求，并逐入口执行当前版本检查。代码工作区授权与数据库空间的 KV 权限分别校验。


先读取根 package.json，验证顶层 UUID、steamHarness.entries 和 defaultEntry。每个入口都有独立 entryId、type、name、root、entry、databases，可选 configuration 和 schedulePresets。类型属于入口，Workflow 内部操作使用 entrypointId。逐入口静态分析；非法路径、重复 ID、类型不匹配直接修复声明。

不兼容旧项目声明，不自动导入旧数据。删除旧关系、双向授权、组合发行锁和默认项目数据库声明。保留普通 npm 依赖。多模块代码保持目录结构，只在根声明聚合身份。

数据库使用独立空间，声明 alias、host 与所需 KV/知识库读写规则。申请新空间或共享已有空间，等待 local 使用者或 Server 负责人审批，再绑定获批 bindingRef。只保存非敏感引用，不把凭据写入源码。未审批、撤销或错绑必须显示恢复操作，不能自动创建或回退。

运行代码使用 context.entries.get(entryId) 与 context.databases.get(alias)。跨入口保留原 actor、取消信号及工具限制；目标配置在执行时重新校验。发行包剥离绑定，安装后重新申请。测试使用隔离的宿主注册表和数据库空间，不清理宿主其他业务数据。
