import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { TEST_ROOT } from '../../src/env/ports.mjs';

const scriptPath = path.join(TEST_ROOT, 'scripts/analyze-impact.mjs');

function runAnalyzer(args) {
    const out = execFileSync(process.execPath, [scriptPath, ...args, '--json'], {
        cwd: TEST_ROOT,
        encoding: 'utf8',
    });
    return JSON.parse(out);
}

test('analyze-impact 安全性与边界处理：异常 ref / 全零 SHA / 缺失基线均安全升级为 full', () => {
    const zeroReport = runAnalyzer(['--base', '0000000000000000000000000000000000000000', '--head', 'HEAD']);
    assert.equal(zeroReport.baselineResolved, false);
    assert.equal(zeroReport.recommendedTier, 'full');

    const missingReport = runAnalyzer(['--base', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', '--head', 'HEAD']);
    assert.equal(missingReport.baselineResolved, false);
    assert.equal(missingReport.recommendedTier, 'full');

    const injectionReport = runAnalyzer(['--base', 'main;echo_pwned', '--head', 'HEAD']);
    assert.equal(injectionReport.baselineResolved, false);
    assert.equal(injectionReport.recommendedTier, 'full');

    const flagInjectionReport = runAnalyzer(['--base', '--upload-pack=evil', '--head', '--help']);
    assert.equal(flagInjectionReport.baselineResolved, false);
    assert.equal(flagInjectionReport.recommendedTier, 'full');
});

test('analyze-impact 未映射生产文件与迁移文件识别', () => {
    const unknownReport = runAnalyzer(['--files', 'workers/src/brand_new_module.js']);
    assert.ok(unknownReport.gaps.unmappedProductionFiles.includes('workers/src/brand_new_module.js'));
    assert.ok(['core', 'full'].includes(unknownReport.recommendedTier));

    const migReport = runAnalyzer(['--files', 'migrations/0099_new_table.sql']);
    assert.equal(migReport.recommendedTier, 'full');
    assert.ok(migReport.gaps.newMigrations.includes('migrations/0099_new_table.sql'));
});
