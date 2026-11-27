#!/usr/bin/env node
/**
 * Chillin 变更影响分析与测试缺口探测器
 *
 * 用法：
 *   node scripts/analyze-impact.mjs [--base HEAD~1] [--head HEAD] [--json]
 *   node scripts/analyze-impact.mjs --files workers/src/auth.js,migrations/0045_new.sql
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { CHILLIN_ROOT, TEST_ROOT, TMP_DIR } from '../src/env/ports.mjs';

const TIER_RANK = { smoke: 1, core: 2, full: 3 };
const ZERO_SHA = /^0+$/;
const SAFE_GIT_REF_RE = /^(?!-)[A-Za-z0-9_./~^-]{1,128}$/;

export function isSafeGitRef(ref) {
    return typeof ref === 'string' && SAFE_GIT_REF_RE.test(ref) && !ref.includes('..') && !ref.includes('@{');
}

function parseArgs(argv) {
    const out = { base: 'HEAD~1', head: 'HEAD', baseExplicit: false, requireBase: false, files: null, json: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--base' && argv[i + 1]) {
            out.base = argv[++i];
            out.baseExplicit = true;
        } else if (a === '--head' && argv[i + 1]) {
            out.head = argv[++i];
        } else if (a === '--require-base') {
            out.requireBase = true;
        } else if (a === '--files' && argv[i + 1]) {
            out.files = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
        } else if (a === '--json') {
            out.json = true;
        }
    }
    return out;
}

function runGit(args) {
    return execFileSync('git', args, { cwd: CHILLIN_ROOT, encoding: 'utf8' });
}

function commitExists(ref) {
    if (!isSafeGitRef(ref) || ZERO_SHA.test(ref)) return false;
    try {
        execFileSync('git', ['cat-file', '-e', `${ref}^{commit}`], { cwd: CHILLIN_ROOT, stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

export function resolveDiffInputs(baseArg, headArg, baseExplicit = true) {
    if (!isSafeGitRef(headArg) || !commitExists(headArg)) {
        return {
            mode: 'unresolved',
            base: null,
            head: 'HEAD',
            baselineResolved: false,
            note: `invalid or unavailable head ref (${String(headArg || '').slice(0, 40)}); escalating to full`,
        };
    }

    if (commitExists(baseArg)) {
        return { mode: 'range', base: baseArg, head: headArg, baselineResolved: true };
    }

    // Explicit all-zero / missing / invalid base cannot reliably prove diff scope: must escalate to full
    const reason = !isSafeGitRef(baseArg)
        ? `unsafe or invalid base ref (${String(baseArg || '').slice(0, 40)})`
        : ZERO_SHA.test(baseArg)
            ? 'zero before SHA (initial push/new branch)'
            : `unavailable base ref (${baseArg})`;

    const parentRef = `${headArg}~1`;
    if (!baseExplicit && commitExists(parentRef)) {
        return { mode: 'range', base: parentRef, head: headArg, baselineResolved: true };
    }

    return {
        mode: commitExists(parentRef) ? 'range-unverified' : 'initial',
        base: commitExists(parentRef) ? parentRef : null,
        head: headArg,
        baselineResolved: false,
        note: `${reason}; escalating to full`,
    };
}

function getChangedFiles(diffInfo) {
    if (diffInfo.mode === 'unresolved') return [];
    if (diffInfo.mode === 'initial') {
        const raw = runGit(['-c', 'core.quotePath=false', 'diff-tree', '--no-commit-id', '--name-status', '-r', diffInfo.head]);
        return parseNameStatus(raw);
    }
    const raw = runGit(['-c', 'core.quotePath=false', 'diff', '--name-status', `${diffInfo.base}..${diffInfo.head}`]);
    return parseNameStatus(raw);
}

function parseNameStatus(raw) {
    const entries = [];
    for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const parts = trimmed.split(/\t+/);
        const status = parts[0] || 'M';
        if (status.startsWith('R') && parts.length >= 3) {
            entries.push({ status: 'D', file: parts[1] });
            entries.push({ status: 'A', file: parts[2] });
        } else if (parts[1]) {
            entries.push({ status: status[0], file: parts[1] });
        }
    }
    return entries;
}

function detectApiRouteChanges(diffInfo, changedFiles) {
    if (!changedFiles.includes('workers/api.js') || !diffInfo.base) return [];
    try {
        const diff = runGit(['diff', '-U0', `${diffInfo.base}..${diffInfo.head}`, '--', 'workers/api.js']);
        const routes = new Set();
        for (const line of diff.split(/\r?\n/)) {
            if (!line.startsWith('+') || line.startsWith('+++')) continue;
            for (const m of line.matchAll(/['"`](\/api\/[a-zA-Z0-9_/-]+)['"`]/g)) {
                routes.add(m[1]);
            }
        }
        return Array.from(routes);
    } catch {
        return [];
    }
}

function writeGithubOutputs(report) {
    const outPath = process.env.GITHUB_OUTPUT;
    if (!outPath) return;
    const lines = [
        `tier=${report.recommendedTier}`,
        `recommended_command=${report.recommendedCommand}`,
        `chillin_sha=${report.chillinSha}`,
        `baseline_resolved=${report.baselineResolved}`,
        `affected_suites=${report.affectedSuites.join(',')}`,
        `has_gaps=${Boolean(report.gaps.unmappedProductionFiles.length || report.gaps.newMigrations.length || report.gaps.newOrModifiedApiRoutes.length)}`,
    ];
    fs.appendFileSync(outPath, `${lines.join('\n')}\n`, 'utf8');
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const impactMap = JSON.parse(fs.readFileSync(path.join(TEST_ROOT, 'registry/impact-map.json'), 'utf8'));
    const catalog = JSON.parse(fs.readFileSync(path.join(TEST_ROOT, 'registry/test-catalog.json'), 'utf8'));

    let diffInfo = { mode: 'manual', base: null, head: 'HEAD', baselineResolved: true };
    let entries;
    if (args.files) {
        entries = args.files.map((file) => ({ status: 'M', file }));
    } else if (args.requireBase && !args.baseExplicit) {
        diffInfo = {
            mode: 'unresolved',
            base: null,
            head: args.head,
            baselineResolved: false,
            note: 'missing required base ref (before SHA) on dispatch; escalating to full',
        };
        entries = [];
    } else {
        diffInfo = resolveDiffInputs(args.base, args.head, args.baseExplicit);
        entries = getChangedFiles(diffInfo);
    }

    const changedFiles = entries.map((e) => e.file);
    const deletedFiles = entries.filter((e) => e.status === 'D').map((e) => e.file);
    const addedFiles = entries.filter((e) => e.status === 'A').map((e) => e.file);

    const affectedSuites = new Set();
    const matchedDomains = new Set();
    const unmappedFiles = [];
    const newMigrations = changedFiles.filter((f) => /^migrations\/.*\.sql$/.test(f));
    const newApiRoutes = args.files ? [] : detectApiRouteChanges(diffInfo, changedFiles);

    let recommendedTier = !diffInfo.baselineResolved ? 'full' : 'smoke';

    for (const entry of entries) {
        const file = entry.file;
        let matched = false;
        for (const rule of impactMap.rules) {
            if (new RegExp(rule.pattern).test(file)) {
                matched = true;
                matchedDomains.add(rule.domain);
                for (const s of rule.suites) affectedSuites.add(s);
                if (TIER_RANK[rule.recommendedTier] > TIER_RANK[recommendedTier]) {
                    recommendedTier = rule.recommendedTier;
                }
            }
        }
        const isIgnorable = /^(docs\/|tests\/|scripts\/|\.github\/|\.agents\/|README\.md|CHANGELOG\.md|PROGRESS\.md|package.*\.json)/.test(file);
        if (!matched && !isIgnorable) {
            unmappedFiles.push(file);
            const fallbackTier = impactMap.defaultTierOnUnknown || 'core';
            if (TIER_RANK[fallbackTier] > TIER_RANK[recommendedTier]) {
                recommendedTier = fallbackTier;
            }
        }
        if (entry.status === 'D' && !isIgnorable && TIER_RANK.core > TIER_RANK[recommendedTier]) {
            recommendedTier = 'core';
        }
    }

    if (newMigrations.length > 0 || newApiRoutes.length > 0) {
        recommendedTier = 'full';
    }

    const headSha = (() => {
        try {
            return runGit(['rev-parse', '--short', 'HEAD']).trim();
        } catch {
            return 'unknown';
        }
    })();

    const report = {
        analyzedAt: new Date().toISOString(),
        chillinSha: headSha,
        baselineResolved: diffInfo.baselineResolved,
        baselineNote: diffInfo.note || null,
        range: args.files ? 'manual-files' : (diffInfo.base ? `${diffInfo.base}..${diffInfo.head}` : `${diffInfo.mode}:${diffInfo.head}`),
        changedFilesCount: changedFiles.length,
        changedFiles,
        addedFiles,
        deletedFiles,
        matchedDomains: Array.from(matchedDomains),
        recommendedTier,
        recommendedCommand: recommendedTier === 'smoke'
            ? 'npm run test:smoke'
            : (recommendedTier === 'core' ? 'npm run test:l2 && npm run test:core' : 'npm run test:full'),
        affectedSuites: Array.from(affectedSuites),
        gaps: {
            unmappedProductionFiles: unmappedFiles,
            newMigrations,
            newOrModifiedApiRoutes: newApiRoutes,
        },
        catalogSuitesTotal: catalog.suites.length,
        aiGuardrail: 'AI 仅可依据本报告生成受影响测试清单与候选新增用例草案，严禁自动修改或放宽既有业务不变量断言。',
    };

    fs.mkdirSync(TMP_DIR, { recursive: true });
    fs.writeFileSync(path.join(TMP_DIR, 'impact-report.json'), JSON.stringify(report, null, 2), 'utf8');
    writeGithubOutputs(report);

    if (args.json) {
        console.log(JSON.stringify(report, null, 2));
        return;
    }

    console.log(`=== Chillin 变更影响分析 (${report.chillinSha} | ${report.range}) ===`);
    console.log(`改动文件数: ${report.changedFilesCount} (新增 ${addedFiles.length} / 删除 ${deletedFiles.length}) | 命中业务域: ${report.matchedDomains.join(', ') || '无'}`);
    console.log(`推荐执行分级: ${report.recommendedTier.toUpperCase()} -> ${report.recommendedCommand}`);
    if (report.affectedSuites.length) {
        console.log(`直接受影响测试 (${report.affectedSuites.length}):`);
        for (const s of report.affectedSuites) console.log(`  - ${s}`);
    }
    if (unmappedFiles.length || newMigrations.length || newApiRoutes.length || !diffInfo.baselineResolved) {
        console.log(`\n[覆盖缺口与风险提示]`);
        if (!diffInfo.baselineResolved) console.log(`  - 基线警告: ${diffInfo.note}`);
        if (unmappedFiles.length) console.log(`  - 未映射生产文件 (${unmappedFiles.length}): ${unmappedFiles.join(', ')}`);
        if (newMigrations.length) console.log(`  - 涉及迁移变更: ${newMigrations.join(', ')}`);
        if (newApiRoutes.length) console.log(`  - 涉及新增/修改 API 路由: ${newApiRoutes.join(', ')}`);
    }
}

main();
