import fs from 'node:fs';
import path from 'node:path';

/**
 * Custom Playwright Reporter that summarizes passed/failed specs and compiles
 * an actionable Markdown bug report (test-results/bug-report.md) with reproduction
 * steps, failed assertions, pageerrors, and HTTP 5xx findings.
 */
class BugReporter {
    constructor(options = {}) {
        this.outputFile = options.outputFile || path.resolve('test-results/bug-report.md');
        this.failures = [];
        this.passed = 0;
        this.skipped = 0;
        this.startTime = Date.now();
    }

    onTestEnd(test, result) {
        if (result.status === 'passed') {
            this.passed += 1;
            return;
        }
        if (result.status === 'skipped') {
            this.skipped += 1;
            return;
        }
        const errs = (result.errors || []).map((e) => (e.message || e.stack || String(e)).trim());
        const stdout = (result.stdout || []).map((c) => c.toString()).join('').trim();
        const attachments = (result.attachments || []).map((a) => `${a.name}: ${a.path || ''}`);
        this.failures.push({
            titlePath: test.titlePath().slice(1).join(' > '),
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
        const total = this.passed + this.failures.length + this.skipped;
        const durationSec = ((Date.now() - this.startTime) / 1000).toFixed(1);
        const lines = [
            `# Chillin PWA E2E 测试与 Bug 巡检报告`,
            ``,
            `- **执行状态**: ${result.status.toUpperCase()}`,
            `- **总耗时**: ${durationSec}s`,
            `- **统计**: 通过 ${this.passed} / 失败 ${this.failures.length} / 跳过 ${this.skipped}（共 ${total} 项）`,
            ``,
        ];

        if (this.failures.length === 0) {
            lines.push(`## 巡检结论`, ``, `本轮全部测试通过，未捕获到功能故障、页面 JS 异常、布局溢出或接口 5xx 报错。`);
        } else {
            lines.push(`## 捕获到的 Bug 与异常清单 (${this.failures.length})`, ``);
            this.failures.forEach((f, idx) => {
                lines.push(`### ${idx + 1}. ${f.titlePath}`);
                lines.push(`- **位置**: \`${f.file}:${f.line}\` (${f.status}, ${f.durationMs}ms)`);
                if (f.errors.length) {
                    lines.push(`- **异常详情**:`);
                    lines.push('```text');
                    lines.push(f.errors.join('\n---\n').slice(0, 2500));
                    lines.push('```');
                }
                if (f.stdout) {
                    lines.push(`- **诊断日志**:`);
                    lines.push('```text');
                    lines.push(f.stdout.slice(0, 1500));
                    lines.push('```');
                }
                if (f.attachments.length) {
                    lines.push(`- **取证附件**: ${f.attachments.join(' | ')}`);
                }
                lines.push('');
            });
        }

        fs.mkdirSync(path.dirname(this.outputFile), { recursive: true });
        fs.writeFileSync(this.outputFile, lines.join('\n'), 'utf8');
    }
}

export default BugReporter;
