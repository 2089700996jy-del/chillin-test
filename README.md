# Chillin PWA E2E & Bug-Hunting Suite (`D:\7（test）`)

面向个人「类上架级体验」与主动抓 Bug 的独立全链路 E2E 测试工程。

## 架构特点

1. **真实全链路（非 Mock 后端）**：每次运行自动在 `.tmp/wrangler-state` 初始化干净的本地 D1（应用全部 `migrations/`）+ 本地 R2，拉起真实 `wrangler dev`。
2. **同源防线一致性**：`src/env/app-proxy.mjs` 从 `D:\7\chillin\public` 直接提供静态前端并复现 `_headers` 安全头（含 CSP 与 Trusted Types 强制检查），同时将 `/api/*` 同源反代至本地 Worker，确保 `HttpOnly` Cookie 与 Service Worker 行为与线上完全一致。
3. **可控外部仿真**：`src/env/fake-externals.mjs` 本地仿真 DeepSeek 流式/规划接口，支持运行时通过 `/__control` 注入 500、超时或畸形 JSON 以压测前端异常降级。
4. **零容忍异常监听**：所有用例默认拦截线上域名防止误触，且自动监测 `pageerror`、`console.error`、`HTTP 5xx` 与移动端横向溢出。

## 测试分层

| 文件 | 层级 | 覆盖重点 |
| :--- | :--- | :--- |
| `tests/01-golden-flows.spec.mjs` | **P0 黄金链路** | 注册、刷新免重登、随手记图文上传 R2、笔记双向链接与反向引用、提示词变量、TXT 阅读器 |
| `tests/02-pwa-offline-sync.spec.mjs` | **P1 PWA 生命线** | 真 Service Worker 预缓存、断网刷新零白屏、断网写作→联网补偿同步、双设备离线修改冲突裁决 |
| `tests/03-ai-and-goals.spec.mjs` | **P1/P2 AI 与 Agent** | SSE 流式记忆回响、AI 上游 500 故障优雅降级、Agent 目标创建与拆解 |
| `tests/04-chaos-bug-hunter.spec.mjs` | **P2 主动找 Bug** | 切后台草稿防丢 (`visibilitychange`)、防连击重复提交、Tab 极速切换竞态、XSS 注入、三主题对比度与 A11y |
| `tests/05-audit-migrated.spec.mjs` | **体验审计回归** | 整合自 `audit-tools`：长列表自动分页、跨分页搜索扩窗跳转与高亮 |

## 常用命令

```bash
npm test            # 一键重置临时库并执行全部 E2E 与找 Bug 测试
npm run report      # 打开 Playwright HTML 可视化报告（可逐帧回放 Trace 录屏）
npm run test:ui     # 打开交互式 UI 面板单步调试任意用例
npm run test:headed # 有头模式观察手机视口真实操作过程
```

### 跨机器 / CI 环境变量（可选）

* `CHILLIN_ROOT`：被测 Chillin 主仓路径（默认为测试项目上级的 `../chillin`）
* `E2E_TMP_DIR`：Wrangler 本地 D1/R2 状态与临时目录（默认为 `CHILLIN_ROOT/../.tmp`）
* `CHROME_PATH`：本地 Chrome 可执行文件路径（未设置时自动探测系统 Chrome，找不到则回落 Playwright 默认 Chromium）

每次运行结束后，会在 `test-results/bug-report.md` 自动生成结构化的 Bug 与异常巡检清单。
