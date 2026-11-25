import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { CHILLIN_ROOT } from '../../src/env/ports.mjs';
import { openMigratedLocalD1 } from '../../src/support/local-d1.mjs';
import { startL2FakeExternals } from '../../src/support/l2-harness.mjs';

const goalsUrl = pathToFileURL(path.join(CHILLIN_ROOT, 'workers/src/agent-goals.js')).href;
const approvalsUrl = pathToFileURL(path.join(CHILLIN_ROOT, 'workers/src/agent-approvals.js')).href;
const schedulerUrl = pathToFileURL(path.join(CHILLIN_ROOT, 'workers/src/agent-scheduler.js')).href;

test('L2 Agent Goals 状态机：创建、拆解、审批级联过期、暂停守卫与调度续跑', async () => {
    const fakeExt = await startL2FakeExternals();
    const db = openMigratedLocalD1();

    try {
        const {
            createGoal,
            generatePlan,
            updateGoal,
            cancelGoal,
            getGoalDetail,
        } = await import(goalsUrl);
        const { requestAgentProposal } = await import(approvalsUrl);
        const { runAutoResume } = await import(schedulerUrl);

        await db.prepare("INSERT INTO users (id, username, password_hash) VALUES (1, 'agent_u1', 'hash')").run();
        const env = {
            DB: db,
            LLM_API_BASE: `${fakeExt.origin}/v1`,
            LLM_API_KEY: 'e2e-fake-key',
        };

        // 1. 创建目标并由 Fake DeepSeek 拆解计划
        const created = await createGoal(db, 1, {
            title: '整理季度技术复盘',
            description: '汇总最近随手记与笔记，形成一份行动总结。',
        });
        assert.ok(created.goal?.id);
        assert.equal(created.goal.status, 'draft');

        const planned = await generatePlan(db, 1, created.goal.id, { env });
        assert.ok(Array.isArray(planned.tasks) && planned.tasks.length >= 1, '拆解后应生成至少 1 条子任务');

        // 2. 创建 pending 审批提案后调用 updateGoal：旧审批必须级联过期（防僵尸审批）
        const taskId = planned.tasks[0].id;
        const prop = await requestAgentProposal(db, 1, created.goal.id, taskId, {
            action: 'save_note',
            title: '草案',
            content: '内容',
        }, env);
        assert.ok(prop?.approval?.id || prop?.id);

        await updateGoal(db, 1, created.goal.id, {
            title: '整理季度技术复盘 v2',
            description: '补充风险总结章节。',
        });
        const pendingApprovals = (await db.prepare(
            "SELECT status FROM agent_approvals WHERE goal_id = ?1 AND user_id = 1 AND status = 'pending'"
        ).bind(created.goal.id).all()).results;
        assert.equal(pendingApprovals.length, 0, 'updateGoal 后不得残留 pending 审批');

        // 3. 取消目标后不可再修改，且 runAutoResume 不会将已取消目标复活为僵尸任务
        await cancelGoal(db, 1, created.goal.id);
        await assert.rejects(
            () => updateGoal(db, 1, created.goal.id, { title: '非法复活修改' }),
            (err) => err && (err.status === 409 || /已结束|closed/i.test(String(err.message)))
        );

        const resumeRes = await runAutoResume(env, { nowMs: Date.now() });
        assert.equal(resumeRes?.processed || 0, 0);

        const detail = await getGoalDetail(db, 1, created.goal.id);
        assert.equal(detail.goal.status, 'cancelled');
    } finally {
        db.close();
        await fakeExt.close();
    }
});

