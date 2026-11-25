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
import { execSync } from 'node:child_process';
import { CHILLIN_ROOT, TEST_ROOT, TMP_DIR } from '../src/env/ports.mjs';

const TIER_RANK = { smoke: 1, core: 2, full: 3 };

function parseArgs(argv) {
    const out = { base: 'HEAD~1', head: 'HEAD', files: null, json: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--base' && argv[i + 1]) out.base = argv[++i];
        else if (a === '--head' && argv[i + 1]) out.head = argv[++i];
        else if (a === '--files' && argv[i + 1]) out.files = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
        else if (a === '--json') out.json = true;
    }
    return out;
}

function getChangedFiles(base, head) {
    const raw = execSync(`git -c core.quotePath=false diff --name-only ${base}..${head}`, { cwd: CHILLIN_ROOT, encoding: 'utf8' });
    return raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

function detectApiRouteChanges(base, head, changedFiles) {
    if (!changedFiles.includes('workers/api.js')) return [];
    try {
        const diff = execSync(`git diff -U0 ${base}..${head} -- workers/api.js`, { cwd: CHILLIN_ROOT, encoding: 'utf8' });
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

function main() {
    const args = parseArgs(process.argv.slice(2));
    const impactMap = JSON.parse(fs.readFileSync(path.join(TEST_ROOT, 'registry/impact-map.json'), 'utf8'));
    const catalog = JSON.parse(fs.readFileSync(path.join(TEST_ROOT, 'registry/test-catalog.json'), 'utf8'));

    const changedFiles = args.files || getChangedFiles(args.base, args.head);
    const affectedSuites = new Set();
    const matchedDomains = new Set();
    const unmappedFiles = [];
    const newMigrations = changedFiles.filter((f) => /^migrations\/.*\.sql$/.test(f));
    const newApiRoutes = args.files ? [] : detectApiRouteChanges(args.base, args.head, changedFiles);

    let recommendedTier = changedFiles.length === 0 ? 'smoke' : 'smoke';

    for (const file of changedFiles) {
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
        // Ignore docs/tests/scripts when reporting unmapped production files
        const isIgnorable = /^(docs\/|tests\/|scripts\/|\.github\/|\.agents\/|README\.md|CHANGELOG\.md|PROGRESS\.md|package.*\.json)/.test(file);
        if (!matched && !isIgnorable) {
            unmappedFiles.push(file);
            const fallbackTier = impactMap.defaultTierOnUnknown || 'core';
            if (TIER_RANK[fallbackTier] > TIER_RANK[recommendedTier]) {
                recommendedTier = fallbackTier;
            }
        }
    }

    const headSha = (() => {
        try {
            return execSync('git rev-parse --short HEAD', { cwd: CHILLIN_ROOT, encoding: 'utf8' }).trim();
        } catch {
            return 'unknown';
        }
    })();

    const report = {
        analyzedAt: new Date().toISOString(),
        chillinSha: headSha,
        range: args.files ? 'manual-files' : `${args.base}..${args.head}`,
        changedFilesCount: changedFiles.length,
        changedFiles,
        matchedDomains: Array.from(matchedDomains),
        recommendedTier,
        recommendedCommand: recommendedTier === 'smoke'
            ? 'npm run test:l2 && npm run test:smoke'
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

    if (args.json) {
        console.log(JSON.stringify(report, null, 2));
        return;
    }

    console.log(`=== Chillin 变更影响分析 (${report.chillinSha} | ${report.range}) ===`);
    console.log(`改动文件数: ${report.changedFilesCount} | 命中业务域: ${report.matchedDomains.join(', ') || '无'}`);
    console.log(`推荐执行分级: ${report.recommendedTier.toUpperCase()} -> ${report.recommendedCommand}`);
    if (report.affectedSuites.length) {
        console.log(`直接受影响测试 (${report.affectedSuites.length}):`);
        for (const s of report.affectedSuites) console.log(`  - ${s}`);
    }
    if (unmappedFiles.length || newMigrations.length || newApiRoutes.length) {
        console.log(`\n[覆盖缺口与风险提示]`);
        if (unmappedFiles.length) console.log(`  - 未映射生产文件 (${unmappedFiles.length}): ${unmappedFiles.join(', ')}`);
        if (newMigrations.length) console.log(`  - 涉及迁移变更: ${newMigrations.join(', ')}`);
        if (newApiRoutes.length) console.log(`  - 涉及新增/修改 API 路由: ${newApiRoutes.join(', ')}`);
    }
}

main();
