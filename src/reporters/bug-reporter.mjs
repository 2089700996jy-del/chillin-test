import fs from 'node:fs';
import path from 'node:path';
import { RUNTIME_FILE, TMP_DIR } from '../env/ports.mjs';

const stripAnsi = (str) => String(str || '').replace(/\x1b\[[0-9;]*m/g, '');

class BugReporter {
    constructor(options = {}) {
        this.outputFile = options.outputFile || path.resolve('test-results/bug-report.md');
        this.failures = [];
        this.blockedList = [];
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
        const errs = (result.errors || []).map((e) => stripAnsi(e.message || e.stack || String(e)).trim());
        const stdout = stripAnsi((result.stdout || []).map((c) => c.toString()).join('')).trim();
        const attachments = (result.attachments || []).map((a) => `${a.name}: ${a.path || ''}`);
        const entry = {
            titlePath,
            file: path.relative(process.cwd(), test.location.file),
            line: test.location.line,
            status: result.status,
            durationMs: result.duration,
            errors: errs,
            stdout,
            attachments,
        };
        if (result.status === 'timedOut' || result.status === 'interrupted') {
            this.blockedList.push(entry);
        } else {
            this.failures.push(entry);
        }
    }

    onEnd(result) {
        let rt = {};
        try {
            if (fs.existsSync(RUNTIME_FILE)) {
                rt = JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8'));
            }
        } catch { /* ignore */ }

        const meta = rt.chillinMeta || {};
        const total = this.passedList.length + this.failures.length + this.blockedList.length + this.skippedList.length;
        const durationSec = ((Date.now() - this.startTime) / 1000).toFixed(1);
        const qaTier = process.env.QA_TIER || 'full';

        const lines = [
            `# Chillin QA 报告 (${result.status.toUpperCase()})`,
            ``,
            `- **被测版本**: Chillin \`v${meta.appVersion || 'unknown'}\` / SHA \`${meta.gitSha || 'unknown'}\` (${meta.gitDirty ? 'dirty' : 'clean'}) | D1 迁移: \`${meta.latestMigration || 'unknown'}\``,
            `- **执行情况**: 分级 \`${qaTier}\` | 耗时 ${durationSec}s | 通过 **${this.passedList.length}** / 失败 **${this.failures.length}** / 未执行 **${this.skippedList.length}** / 阻塞 **${this.blockedList.length}**（共 ${total} 项）`,
            ``,
        ];

        const allIssues = [...this.failures, ...this.blockedList];
        if (allIssues.length === 0) {
            lines.push(
                `> 本轮 ${total} 项自动化测试全部通过（注：仅代表已覆盖的自动化与协议仿真场景通过，不等同于真微信或物理设备验收）。`,
                ``
            );
        } else {
            lines.push(`## 失败与阻塞详情（可直接复制给 AI 修复）`, ``);
            allIssues.forEach((f, idx) => {
                lines.push(`### ${idx + 1}. ${f.titlePath}`);
                lines.push(`- **位置**: \`${f.file}:${f.line}\` (${f.status}, ${f.durationMs}ms)`);
                if (f.errors.length) {
                    lines.push(`- **报错原因**:`);
                    lines.push('```text');
                    lines.push(f.errors.join('\n---\n').slice(0, 2000));
                    lines.push('```');
                }
                if (f.stdout) {
                    lines.push(`- **诊断日志**:`);
                    lines.push('```text');
                    lines.push(f.stdout.slice(0, 800));
                    lines.push('```');
                }
                lines.push('');
            });
        }

        lines.push(`---`, `**覆盖边界**: 已检查 JS 异常 / CSP / API 5xx / 静态资源 / 登录后 401 / Console；未覆盖真实微信扫码、APNs/FCM、物理机软键盘与线上冷启动。`);
        try {
            const impactPath = path.join(TMP_DIR, 'impact-report.json');
            if (fs.existsSync(impactPath)) {
                const impact = JSON.parse(fs.readFileSync(impactPath, 'utf8'));
                const unmapped = impact.gaps?.unmappedProductionFiles || [];
                lines.push(`**影响分析**: SHA \`${impact.chillinSha}\` | 推荐 \`${impact.recommendedTier}\` | 命中域: ${(impact.matchedDomains || []).join(', ') || '无'}${unmapped.length ? ` | 未映射文件: \`${unmapped.join('`, `')}\`` : ''}`);
            }
        } catch { /* ignore metadata read errors */ }

        fs.mkdirSync(path.dirname(this.outputFile), { recursive: true });
        fs.writeFileSync(this.outputFile, lines.join('\n'), 'utf8');
    }
}

export default BugReporter;
