# Chillin PWA E2E & QA Automation Suite (`D:\7（test）`)

面向 Chillin 数字花园的独立、轻量级自动化质量保障体系（L1–L4 分层 + 变更影响分析 + 跨仓库 CI 闭环）。

## 目录结构

- `src/env/`：`ports.mjs`、`orchestrator.mjs`（本地 Wrangler D1/R2 生命周期与安全隔离）、`app-proxy.mjs`（同源静态代理与安全头）、`fake-externals.mjs`（LLM / QWeather / iLink 协议仿真与故障注入）
- `src/support/`：`pwa-harness.mjs`（运行时错误监控与认证封装）、`local-d1.mjs`（`node:sqlite` 迁移适配器）、`l2-harness.mjs`、`test-data.mjs`
- `src/reporters/bug-reporter.mjs`：生成包含通过/失败/未执行/环境阻塞统计与覆盖边界的 `test-results/bug-report.md`
- `registry/`：`quality-model.json`（质量不变量）、`test-catalog.json`（套件台账）、`impact-map.json`（文件变更到测试域映射）
- `scripts/analyze-impact.mjs`：基于 Git Diff 计算受影响业务域、推荐执行分级（`smoke` / `core` / `full`）与覆盖缺口
- `tests/l2/`：无浏览器状态机与协议仿真集成测试（Agent Goals、ClawBot、Reminders、Weather）
- `tests/01..12*.spec.mjs`：Playwright 浏览器全链路 E2E（Mobile PWA `390×844` + Desktop Web `1280×800`）
- `.github/workflows/qa-suite.yml`：支持 `repository_dispatch`、`workflow_dispatch` 与夜间定时回归

## 安装与环境要求

- Node.js `>= 22.5`（依赖内置 `node:sqlite`）
- 被测主仓 `chillin` 位于同级目录 `../chillin`（或通过 `CHILLIN_ROOT` 指定）

```bash
npm ci
npx playwright install chromium
```

## 常用测试命令

```bash
npm run impact        # 分析 chillin 最近变更，输出 .tmp/impact-report.json 与推荐分级
npm run test:l2       # 运行 L2 后端状态机与协议仿真测试（秒级）
npm run test:smoke    # 运行 Smoke 冒烟链路（@smoke）
npm run test:core     # 运行 Core 核心回归（@smoke|@core）
npm test              # 运行全部 Playwright E2E（Full L3+L4）
npm run test:full     # 运行 L2 + 全部 Playwright E2E
npm run report        # 打开 Playwright HTML 可视化报告
```

## 报告与证据查看

- **结构化 QA 报告**：`test-results/bug-report.md`（区分通过、失败、未执行、环境阻塞，附 Chillin 版本/SHA/迁移版本与覆盖边界）
- **变更影响分析报告**：`.tmp/impact-report.json`
- **失败取证**：`test-results/*/trace.zip` 与失败截图

## 跨仓库 GitHub Actions 配置说明

为使 `chillin` 推送代码后自动触发 `chillin-test` 执行对应 commit 的测试，需在 GitHub 仓库手动配置以下 Secret：

1. **在 `chillin` 仓库配置 `CHILLIN_QA_DISPATCH_TOKEN`**：
   - 权限要求：Fine-grained PAT 或 Classic PAT，具备对 `2089700996jy-del/chillin-test` 的 `Actions: Read & Write` / `Contents: Read & Write`（用于触发 `repository_dispatch`）。
   - 未配置时 `chillin` CI 会安全跳过跨仓触发并输出 notice，不影响主仓构建。
2. **在 `chillin-test` 仓库配置 `CHILLIN_READ_TOKEN`**（仅当 `chillin` 为私有仓库时需要）：
   - 权限要求：具备对 `2089700996jy-del/chillin` 的 `Contents: Read` 权限，用于在 `qa-suite.yml` 中检出指定 `client_payload.sha`。

## 环境变量（可选）

- `CHILLIN_ROOT`：被测 Chillin 主仓路径（默认探测 `../chillin`）
- `E2E_TMP_DIR`：Wrangler 本地 D1/R2 状态与临时目录（默认 `CHILLIN_ROOT/../.tmp`）
- `CHROME_PATH`：本地 Chrome 路径（未设置时自动探测系统 Chrome 或回落 Playwright Chromium）
