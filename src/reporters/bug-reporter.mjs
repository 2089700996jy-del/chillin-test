import fs from 'node:fs';
import path from 'node:path';
import { RUNTIME_FILE } from '../env/ports.mjs';
import { MONITORING_TAXONOMY } from '../support/pwa-harness.mjs';

const KNOWN_DEFECTS_REGISTRY = [
    {
        id: 'BUG-001',
        severity: 'High',
        area: 'search.js:166',
        summary: '点击顶部 #btn-open-global-search 将 PointerEvent 传入 openGlobalSearch，导致 query.startsWith 抛出 TypeError',
        status: 'Open in chillin',
    },
    {
        id: 'BUG-002',
        severity: 'High',
        area: 'auth.js / app.js',
        summary: '页面刷新恢复会话时 /api/auth/refresh 轮换令牌与并发初始化请求竞态，偶发触发 401',
        status: 'Open in chillin',
    },
    {
        id: 'BUG-003',
        severity: 'Medium',
        area: 'pwa-update.js:277',
        summary: '首次安装激活 Service Worker 时 controllerchange 触发约 8 秒后自动强制 reload',
        status: 'Open in chillin',
    },
    {
        id: 'BUG-004',
        severity: 'Medium',
        area: 'app.js:197',
        summary: '随手记发送/交互后 #mobile-bottom-nav 可能保持 inert 状态阻塞移动端 Tab 切换',
        status: 'Open in chillin',
    },
    {
        id: 'BUG-005',
        severity: 'Medium',
        area: 'index.html:80 & style.css',
        summary: 'index.html SVG path 语法报错；#btn-chip-todo 在日间/深色主题下存在 WCAG 对比度不达标',
        status: 'Open in chillin',
    },
    {
        id: 'BUG-006',
        severity: 'High',
        area: 'workers/src/garden-resources.js',
        summary: '跨账号越权请求 PUT /api/notes/:id 返回 HTTP 500 Internal Server Error 而非 403/404',
        status: 'Open in chillin',
    },
    {
        id: 'BUG-007',
        severity: 'High',
        area: 'public/js/auth.js & sync.js',
        summary: '新设备首次登录后 /api/sync/pull 已完成且 D1 已有云端笔记，但 #notes-list-container 仍只显示默认占位笔记，导致跨设备笔记同步与冲突测试在首登后无法即时呈现',
        status: 'Open in chillin',
    },
];

class BugReporter {
    constructor(options = {}) {
        this.outputFile = options.outputFile || path.resolve('test-results/bug-report.md');
        this.failures = [];
        this.passedList = [];
        this.skippedList = [];
        this.startTime = Date.now();
        this.projects = new Set();
    }

    onTestEnd(test, result) {
        const project = test.parent?.project()?.name || 'default';
        this.projects.add(project);
        const titlePath = test.titlePath().slice(1).join(' > ');
        if (result.status === 'passed') {
            this.passedList.push({ titlePath, durationMs: result.duration });
            return;
        }
        if (result.status === 'skipped') {
            this.skippedList.push({ titlePath });
            return;
        }
        const errs = (result.errors || []).map((e) => (e.message || e.stack || String(e)).trim());
        const stdout = (result.stdout || []).map((c) => c.toString()).join('').trim();
        const attachments = (result.attachments || []).map((a) => `${a.name}: ${a.path || ''}`);
        this.failures.push({
            titlePath,
            file: path.relative(process.cwd(), test.location.file),
            line: test.location.line,
            status: result.status,
            durationMs: result.duration,
            errors: errs,
            stdout,
            attachments,
        });
    }

    onEnd(result) {
        let rt = {};
        try {
            if (fs.existsSync(RUNTIME_FILE)) {
                rt = JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8'));
            }
        } catch { /* ignore */ }

        const meta = rt.chillinMeta || {};
        const total = this.passedList.length + this.failures.length + this.skippedList.length;
        const durationSec = ((Date.now() - this.startTime) / 1000).toFixed(1);

        const lines = [
            `# Chillin QA E2E 测试与 Bug 巡检报告`,
            ``,
            `## 1. 执行元信息`,
            ``,
            `- **测试编号**: \`${rt.testRunId || 'unknown'}\``,
            `- **执行时间**: ${rt.startedAt || new Date().toISOString()}（耗时 ${durationSec}s）`,
            `- **执行结果**: **${result.status.toUpperCase()}**`,
            `- **Chillin 版本**: \`v${meta.appVersion || 'unknown'}\``,
            `- **Chillin Git SHA**: \`${meta.gitSha || 'unknown'}\`（工作区未提交修改: **${meta.gitDirty ? '是 (dirty)' : '否 (clean)'}**）`,
            `- **D1 迁移版本**: \`${meta.latestMigration || 'unknown'}\`（共 ${meta.migrationCount || 0} 个迁移）`,
            `- **运行环境与浏览器**: ${meta.platform || process.platform} / Node ${meta.nodeVersion || process.version} / 浏览器工程: ${Array.from(this.projects).join(', ') || 'mobile-pwa'}`,
            `- **数据隔离**: 本地 Wrangler D1 + R2（\`${rt.stateDir || 'N/A'}\`），线上域名请求已防火墙拦截`,
            ``,
            `## 2. 统计汇总`,
            ``,
            `- **通过**: ${this.passedList.length}`,
            `- **失败**: ${this.failures.length}`,
            `- **跳过**: ${this.skippedList.length}`,
            `- **合计**: ${total} 项`,
            ``,
        ];

        if (this.failures.length === 0) {
            lines.push(
                `## 3. 巡检结论`,
                ``,
                `本轮已执行的 ${total} 项自动化测试全部通过。**注意：测试通过仅代表本轮已覆盖的自动化断言与仿真协议场景未触发失败，不代表整个 Chillin 产品不存在未发现缺陷，亦不等同于真实微信客户端或物理移动设备验收。**`,
                ``
            );
        } else {
            lines.push(`## 3. 本轮捕获到的失败与 Bug 清单 (${this.failures.length})`, ``);
            this.failures.forEach((f, idx) => {
                lines.push(`### ${idx + 1}. ${f.titlePath}`);
                lines.push(`- **复现位置**: \`${f.file}:${f.line}\` (${f.status}, ${f.durationMs}ms)`);
                if (f.errors.length) {
                    lines.push(`- **失败断言 / 异常堆栈**:`);
                    lines.push('```text');
                    lines.push(f.errors.join('\n---\n').slice(0, 2500));
                    lines.push('```');
                }
                if (f.stdout) {
                    lines.push(`- **API / 诊断日志**:`);
                    lines.push('```text');
                    lines.push(f.stdout.slice(0, 1500));
                    lines.push('```');
                }
                if (f.attachments.length) {
                    lines.push(`- **截图 / Trace / 录像取证**: ${f.attachments.join(' | ')}`);
                }
                lines.push('');
            });
        }

        lines.push(`## 4. 运行时监控与测试覆盖边界`, ``);
        lines.push(`### 已检查项目 (Checked)`);
        MONITORING_TAXONOMY.checked.forEach((x) => lines.push(`- ${x}`));
        lines.push(``, `### 允许的预期行为 (Allowed)`);
        MONITORING_TAXONOMY.allowed.forEach((x) => lines.push(`- ${x}`));
        lines.push(``, `### 未覆盖 / 人工验收边界 (Unchecked / Manual Acceptance)`);
        MONITORING_TAXONOMY.unchecked.forEach((x) => lines.push(`- ${x}`));

        lines.push(``, `## 5. 已知缺陷登记表 (Known Defects Registry)`, ``);
        lines.push(`| 编号 | 严重度 | 位置 | 摘要 | 状态 |`);
        lines.push(`| :--- | :--- | :--- | :--- | :--- |`);
        KNOWN_DEFECTS_REGISTRY.forEach((d) => {
            lines.push(`| ${d.id} | ${d.severity} | \`${d.area}\` | ${d.summary} | ${d.status} |`);
        });

        fs.mkdirSync(path.dirname(this.outputFile), { recursive: true });
        fs.writeFileSync(this.outputFile, lines.join('\n'), 'utf8');
    }
}

export default BugReporter;
