# 性能回归检查

```sh
corepack pnpm test:performance                 # Core + CLI；也包含在根 pnpm check 中
corepack pnpm test:performance -- --suite all  # 加上 Studio，需先安装 studio/ 的独立依赖
corepack pnpm -C harness test:performance
corepack pnpm -C cli test:performance
npm --prefix studio run test:performance      # 也包含在 Studio npm run check 中
```

测试串行执行实际源码，使用真实计时器和本地 SQLite。远程服务替换为每次 60ms 的固定响应，附件正文额外等待 80ms；不会调用真实模型、数据库服务器、用户账号或桌面窗口。每项预热 2 次、采样 21 次，以毫秒记录 P50、P95、全部原始样本及请求／下载计数。模块编译、fixture 创建及清理不计入操作耗时。CLI 对话从发送输入计时到 controller 发布与当前请求 ID 对应的首条内容，模型固定等待 20ms；不是模型服务 TTFT 或屏幕绘制时间。

覆盖模型目录冷读、命中和并发刷新；本地 200 条消息的保存、100 个会话的加载、后台备份被阻塞时的保存及 Agent 检查点；1 MiB 知识附件和托管文件的下载／再次校验；CLI 资源冷读、重复打开、在线绑定检查、启动并行检查和对话首条输出；Studio 模型目录和资源视图的冷读、重复打开与并发刷新。请求次数、内容、权限校验和持久化结果同时断言，避免用少做工作换取较短耗时。

`baseline.json` 是随 Git 保存的基线。每次检查比较相同 workload 的 P95，同时保留单场景绝对耗时上限。符合任一条件即以退出码 1 失败：

- P95 相比基线同时增加 **超过 50% 和超过 25ms**。
- P95 超过场景绝对上限，即使增幅未达到 50%。
- 请求数／下载次数不符、场景缺失、工作量变化、采样失败或单个套件运行超过 60 秒。

同等幅度的加速标为 `improved`，供检查是否出现工作量或行为变化；不会因此失败。25ms 的绝对容差用于吸收短操作的调度及磁盘抖动，避免 0.1ms 到 0.3ms 这样的变化触发失败。固定网络延迟和工作量变化必须显式重新审查基线。

结果保存在忽略的 `.release/performance/results.json` 和 `report.md`；每轮 JSON 另存到 `history/`，保留环境、源码提交、采样和变化幅度。报告按 P95 变化的绝对值排序，较大的变化排在前面。可以通过 `--output <目录>` 保存独立验证结果，通过 `--baseline <文件>` 使用特定环境的参考基线。Studio 原有 CI 暂停状态保持；这些检查接入日常本地检查命令。

确认行为、固定工作量和耗时预算合理后，显式更新全部基线：

```sh
corepack pnpm test:performance -- --suite all --update-baseline
```

更新也必须先通过绝对耗时预算；套件失败时保留旧基线。正常检查不会改写已提交基线，不应通过更新基线直接放过一次异常变慢。
