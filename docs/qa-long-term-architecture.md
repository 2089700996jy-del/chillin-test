# Chillin 长期演进型自动化质量保障架构设计

> **状态**: Phase 1 已启动 | **被测主仓**: `../chillin`（当前基线 `v2.5.281` / `6fe75b0`）  
> **核心原则**：测试的最终依据是用户真实需求与业务不变量，而非当前代码已实现什么。

## 1. 四层测试架构与执行分级

| 层级 | 运行环境与工具 | 验证重点 | 成本与定位 |
| :--- | :--- | :--- | :--- |
| **L1 快速逻辑层** | 主仓 `npm test`（`node --test`）+ 轻量契约校验 | 路由表、D1 Schema 与迁移一致性、前端静态模块依赖、纯逻辑 | 秒级完成，不重复主仓单测 |
| **L2 业务集成层** | `npm run test:l2`（`node --test tests/l2/*.test.mjs` + `openMigratedLocalD1()` + `l2-harness.mjs`） | ClawBot 收件箱并发/去重、Reminders 生命周期、Agent 状态机、Weather 幂等、备份恢复 | **无浏览器开销，并行运行**，专注后端多模块状态机与真实 D1 迁移 |
| **L3 真实用户流程层** | Playwright (`mobile-pwa` 390×844 + `desktop-web` 1280×800) + `app-proxy` + `wrangler dev` | HttpOnly Cookie 会话、SW 离线冷启、IndexedDB 同步与冲突裁决、R2 媒体/书籍、SSE 流式 AI | 只放必须经过浏览器/SW/Cookie/DOM 的端到端链路 |
| **L4 对抗与可靠性层** | Playwright + `fake-externals` 故障注入 + 混沌探针 + 定向 Mutation | 并发 401 竞态、防连击、上游 500/畸形 JSON 降级、XSS/Trusted Types、跨账号越权、三主题 WCAG | 按风险触发或夜间全量运行 |

### 执行分级
- **Smoke**：L1 + L2 核心 + L3 `01-golden-flows`（< 2 分钟）
- **Core**：L2 全量 + L3 P0 核心链路（PWA/同步/安全隔离）
- **Full**：L2 + L3 全量（Mobile + Desktop）+ L4 混沌/XSS/三主题 A11y/故障注入

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

