# Chillin 长期演进型自动化质量保障架构设计

> **状态**: 自动化闭环与 L1-L4 分层已落地 | **被测主仓**: `../chillin`  
> **核心原则**：测试的最终依据是用户真实需求与业务不变量，而非当前代码已实现什么。

## 1. 四层测试架构与执行分级

| 层级 | 运行环境与工具 | 验证重点 | 成本与定位 |
| :--- | :--- | :--- | :--- |
| **L1 快速逻辑层** | 主仓 `cd ../chillin && npm test`（`node --test`） | 路由表、D1 Schema 与迁移一致性、前端静态模块依赖、纯逻辑 | 秒级完成，在跨仓库 QA 工作流首步执行 |
| **L2 业务集成层** | `npm run test:l2`（`node --test tests/l2/*.test.mjs` + `openMigratedLocalD1()` + `l2-harness.mjs`） | ClawBot 收件箱并发/去重、Reminders 生命周期与重试上限、Agent 状态机、Weather 静默 vs 失败观测 | **无浏览器开销，并行运行**，专注后端多模块状态机与真实 D1 迁移 |
| **L3 真实用户流程层** | Playwright (`mobile-pwa` 390×844 + `desktop-web` 1280×800) + `app-proxy` + `wrangler dev` | HttpOnly Cookie 会话与撤销、SW 离线冷启、IndexedDB 同步（周记/笔记）与冲突裁决、R2 媒体/书籍与进度保护、SSE 流式 AI、`restore-drill.mjs` | 只放必须经过浏览器/SW/Cookie/DOM 或真实 Wrangler 的端到端链路 |
| **L4 对抗与可靠性层** | Playwright + `fake-externals` 故障注入 + 混沌探针 | 并发 401 竞态、防连击、上游 500/畸形 JSON 降级、XSS/Trusted Types、跨账号越权、三主题 WCAG | 按风险触发或夜间全量运行 |

### 执行分级
- **Smoke** (`npm run test:smoke`)：L3 `@smoke` (`01-golden-flows`)（< 1 分钟）
- **Core** (`npm run test:core` + `npm run test:l2`)：L2 全量 + L3 `@smoke|@core`（`01`、`02`、`08`、`12`）
- **Full** (`npm run test:full`)：L2 全量 + L3/L4 全量（Mobile + Desktop）

### L2 本地 SQLite 适配器与 Cloudflare D1 生产环境差异声明
L2 通过 `src/support/local-d1.mjs`（`node:sqlite` 内存库加载 `CHILLIN_ROOT/migrations/*.sql`）运行，**不等同于 Cloudflare D1 生产环境**，差异包括：
1. **运行时与事务模型**：`node:sqlite` 为单机进程内同步 SQLite；生产 D1 运行在 Cloudflare 边缘节点，受网络 RTT、边缘冷启动、全局读复制延迟与 Worker `waitUntil` 异步生命周期约束。
2. **参数绑定适配**：`local-d1.mjs` 对 `undefined -> null` 与 `boolean -> 1/0` 做了兼容转换，生产 D1 对未绑定或非法类型可能直接抛出绑定异常。
3. **外部网络与 Cron**：L2 中的 QWeather / iLink / LLM 均为本地 HTTP Fake 仿真，且 Cron 由测试显式传入时间推进，不等同于 Cloudflare 真实定时调度器与真实微信/和风 TLS 链路。

## 2. 跨仓库自动闭环与变更影响分析

1. **触发链路**：`chillin/.github/workflows/ci.yml` 的 `quality-gate` 通过后，由 `notify-qa` 发送 `repository_dispatch` (`chillin-updated`)，携带 `sha`、`before`、`ref`。
2. **精确检出**：`chillin-test/.github/workflows/qa-suite.yml` 使用 `fetch-depth: 0` 检出目标 `sha` 并校验 `git rev-parse HEAD == client_payload.sha`。
3. **影响分析驱动范围**：`scripts/analyze-impact.mjs` 基于 `registry/impact-map.json` 分析 `before..sha`（自动处理全零 `before` SHA、首次提交、删除文件、新增迁移、API 路由变更及未映射生产文件，无法判断时安全升级为 `core`/`full`），通过 `$GITHUB_OUTPUT` 决定本次执行的分级 (`smoke` / `core` / `full`)。

## 2. 核心业务不变量（Invariants）

- **INV-01 / 02（正确性）**：写入确认的资源与服务端存储完全一致；AI RAG 引用仅来源于当前用户真实记忆。
- **INV-03 / 04（持久性）**：已确认数据在刷新、重登、新设备首登及服务重启后 100% 可读；全量导出 + R2 恢复后完整可解析。
- **INV-05 / 06 / 07（一致性）**：离线修改重连必自动补偿；双端并发修改必触发冲突裁决或确定性收敛；D1 元数据/墓碑与 R2/IndexedDB 一致。
- **INV-08 / 09 / 10（可靠性）**：提醒/天气/ClawBot 消费幂等；上游故障可降级不锁死队列；Agent 目标与任务不无故消失或变僵尸。
- **INV-11 / 12 / 13（安全性）**：跨账号越权（CRUD/R2/Agent）必拒（403/404，绝非 200/500）；撤销会话后旧 Cookie 即时失效；输入受 Trusted Types 与清洗保护。
- **INV-14 / 15（可用性）**：三主题在 Mobile/Desktop 零横向溢出且符合 WCAG AA；切后台草稿不丢、导航不锁死、失败可见。

## 3. 对抗性审查与自动演进机制

- **三阶段对抗性审查**：仅用于 ① 基础设施防漏/防误连生产审查、② P0/高危用例反例质询（防浅层断言与同源错误自证）、③ 季度定向 Mutation Testing。
- **自动演进规划（Phase 3）**：建立 `registry/`（`quality-model.json`、`impact-map.json`、`test-catalog.json`），基于 `chillin` Git Diff（`migrations/`、路由、核心同步/安全文件）自动识别受影响测试与覆盖缺口；AI 仅生成受影响清单与候选草案，**严禁自动放宽断言**。

## 4. 实施路线

- **Phase 1（当前阶段）**：剥离 L2 业务集成测试出 Playwright 队列；清理 `bug-reporter.mjs` 静态硬编码缺陷表；沉淀设计文档。
- **Phase 2**：扩展 `fake-externals.mjs`（QWeather / Web Push / Email）；补齐 `agent-goals`、`bot-weather`、会话撤销、Wrangler `--test-scheduled` Cron 链路；为 Playwright 增加 `@smoke/@core/@full` 标签。
- **Phase 3**：落地 `registry/` 机器可读清单、变更影响分析脚本与跨仓库触发工作流（待配置跨仓 GitHub 权限后启用），并开展首次定向 Mutation 检验。

