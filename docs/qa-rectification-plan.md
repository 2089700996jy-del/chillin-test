# Chillin QA 第一轮工程审查与整改计划

## 一、 代码审查发现的短板与风险

| 编号 | 所在文件 | 审查发现 | 潜在风险 |
| :--- | :--- | :--- | :--- |
| **INF-1** | `src/env/orchestrator.mjs` | 初始化中途失败（如 Proxy 或健康检查超时）未完整释放前面已启动的 `fakeExt` / `appProxy` / `logStream` | 端口与文件句柄泄漏，后续复跑占用端口 |
| **INF-2** | `src/env/orchestrator.mjs` | 非 Windows 下 `spawn` 未设置 `detached: true`，`process.kill(-pid)` 对非进程组长无效 | Linux/macOS CI 下残留 `workerd` 孤儿进程 |
| **INF-3** | `src/env/app-proxy.mjs` | `resolved.startsWith(path.resolve(publicDir))` 缺少目录分隔符与 `realpath` 校验 | 同前缀兄弟目录或符号链接存在路径穿越风险 |
| **INF-4** | `src/env/orchestrator.mjs` | 未校验 `CHILLIN_ROOT`、`wrangler.toml`、迁移目录及本地环境隔离（如未清理 `CLOUDFLARE_API_TOKEN`） | 误指向错误目录或受外部凭据影响 |
| **INF-5** | `src/env/app-proxy.mjs` | 缺少 `Referrer-Policy`、`Permissions-Policy` 响应头，与 `public/_headers` 不完全对齐 | 安全头回归覆盖有盲区 |
| **INF-6** | `src/reporters/bug-reporter.mjs` | 缺少 Chillin Git SHA、脏工作区标记、迁移版本、测试编号、未验证边界与已知缺陷登记；全绿结论过于绝对 | 报告可追溯性不足，易误导为“全产品无 Bug” |
| **INF-7** | `src/support/pwa-harness.mjs` | 未在对象/报告层面显式区分「已检查 / 允许 / 未检查」监控项 | 排查错误归属不透明 |
| **AST-1** | `tests/01`~`04` | 图片上传未校验 `/api/file/:id` 可读取；阅读器未校验云端书目和正文同步；双端冲突未校验最终一致内容；双击未查服务端真实条数；XSS 未校验文本安全渲染；搜索跳转未查目标与高亮；Agent 目标未查任务拆解与持久化；AI 回响未校验真实历史是否进入 LLM 上下文 | 仅停留在表层 UI 存在性断言，无法证明后端真实状态 |
| **COV-1** | `tests/` | 缺少 ClawBot、Reminders、RAG、Reader 深度、跨账号隔离、备份与恢复测试；缺少桌面端 `1280×800` 浏览器工程 | 核心业务与桌面端存在大面积覆盖空白 |

---

## 二、 整改实施与验证方法

1. **基础设施加固**（修改 `src/env/ports.mjs`、`src/env/orchestrator.mjs`、`src/env/app-proxy.mjs`、`src/env/fake-externals.mjs`、`src/support/pwa-harness.mjs`、`src/reporters/bug-reporter.mjs`）：
   - 实现分步资源追踪与异常回滚清理、跨平台进程组清理、`realpath` 路径穿越保护、本地 D1/R2 强校验、Git/版本/迁移元信息采集、安全头对齐及结构化缺陷登记报告。
2. **现有用例断言升级**（修改 `tests/01`~`05`）：
   - 严格区分 **操作成功 / UI 显示成功 / 后端持久化 / 跨设备可读取** 四层断言；在 `fake-externals.mjs` 暴露最近请求上下文供 RAG & Agent 断言。
3. **补齐 6 大核心业务模块 + 桌面端项目**（新增 `tests/06-clawbot-protocol.spec.mjs`、`tests/07-reminders.spec.mjs`、`tests/08-rag-and-isolation.spec.mjs`、`tests/09-reader-sync.spec.mjs`、`tests/10-backup-restore.spec.mjs`、`tests/11-desktop-web.spec.mjs` 及 `playwright.config.mjs` `desktop-web` 工程）：
   - ClawBot 与 Reminders 的 iLink 长轮询/发信逻辑使用本地 Fake iLink HTTP 服务进行**协议仿真**（在报告中明确标注不等同于真实微信验收）。
   - 全量执行 `npm test` 并将真实执行结果与未验证边界写入报告。
