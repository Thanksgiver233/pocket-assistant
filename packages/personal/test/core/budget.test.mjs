/**
 * Budget Governor（services/budget.mjs）不变量测试。
 *
 * 覆盖：per_turn 超限在 degrade/stop/ask 三种 on_exceed 下的行为、
 * proactive 受 proactive_share 限制、settle 记账、status 汇总、
 * 未知 reservation 的保守记账、跨天重置、**重启后额度不回满**（P1-6）。
 *
 * 契约注记：`reserve/settle/status/reset` 均为 async —— 预算要落盘，
 * 否则进程重启就白送一份当日额度。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createBudget } from '../../src/services/budget.mjs';
import { createClock } from '../../src/core/clock.mjs';
import { normaliseProfile } from '../../src/services/profile.mjs';

// 与实现一致：dayKey 使用宿主本地时区，测试不硬编码日期。
const dir = await mkdtemp(join(tmpdir(), 'pa-core-budget-'));
after(() => rm(dir, { recursive: true, force: true }));

const START = '2026-10-23T09:00:00+08:00';

function localDay(ms) {
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function makeBudget(budgetPatch, stateDir) {
  const clock = createClock({ start: START });
  const input = budgetPatch ? { version: 1, budget: budgetPatch } : { version: 1 };
  const profile = normaliseProfile(input);
  return { clock, profile, budget: createBudget({ profile, clock, stateDir }) };
}

const RES_ID = /^res_\d+_\d+$/;

test('TC-D01 缺少 profile 或非法 on_exceed 时抛 ConfigError', () => {
  const clock = createClock({ start: START });
  assert.throws(() => createBudget({ clock }), (err) => err.code === 'CONFIG_INVALID');
  assert.throws(
    () => createBudget({ profile: normaliseProfile({ version: 1, budget: { on_exceed: 'nope' } }), clock }),
    (err) => err.code === 'CONFIG_INVALID'
  );
});

test('TC-D02 默认 caps 与 proactive_share 夹紧', () => {
  const { budget } = makeBudget();
  assert.deepEqual(budget.caps(), {
    perTurnUsd: 0.05,
    perDayUsd: 2,
    proactiveShare: 0.3,
    onExceed: 'degrade'
  });

  const high = makeBudget({ proactive_share: 2 });
  assert.equal(high.budget.caps().proactiveShare, 1);
  const low = makeBudget({ proactive_share: -1 });
  assert.equal(low.budget.caps().proactiveShare, 0);
});

test('TC-D03 per_turn 超限时 degrade 返回 degraded + 降级建议', async () => {
  const { budget } = makeBudget();
  const result = await budget.reserve({ estimateUsd: 0.06 });

  assert.equal(result.ok, true);
  assert.equal(result.degraded, true);
  assert.deepEqual(result.downgrade, ['use_smaller_model', 'reduce_steps']);
  assert.match(result.reservationId, RES_ID);
  assert.equal(result.remainingUsd, 2);
});

test('TC-D04 stop 模式下超限抛 BudgetError(BUDGET_EXCEEDED) 并带 reasons', async () => {
  const { budget } = makeBudget({ on_exceed: 'stop' });
  await assert.rejects(
    () => budget.reserve({ estimateUsd: 0.1 }),
    (err) => err.code === 'BUDGET_EXCEEDED' && err.details.reasons.includes('per_turn_usd')
  );
});

test('TC-D05 ask 模式下超限返回 needsApproval 而不抛错', async () => {
  const { budget } = makeBudget({ on_exceed: 'ask' });
  const result = await budget.reserve({ estimateUsd: 0.1 });

  assert.equal(result.ok, false);
  assert.equal(result.needsApproval, true);
  assert.deepEqual(result.reasons, ['per_turn_usd']);
  assert.equal(result.remainingUsd, 2);
});

test('TC-D06 同时命中 per_turn 与 per_day 时降级建议去重且有序', async () => {
  const { budget } = makeBudget();
  const result = await budget.reserve({ estimateUsd: 3 });

  assert.equal(result.degraded, true);
  assert.deepEqual(result.downgrade, [
    'use_smaller_model',
    'reduce_steps',
    'defer_non_urgent',
    'shorten_context',
    'defer_proactive'
  ]);
});

test('TC-D07 proactive 花费受 proactive_share 限制并触发 defer_proactive', async () => {
  const { budget } = makeBudget({ per_turn_usd: 1, per_day_usd: 2, proactive_share: 0.3 });

  const first = await budget.reserve({ kind: 'proactive', estimateUsd: 0.5 });
  assert.equal(first.ok, true);
  assert.equal(first.degraded, undefined);
  assert.deepEqual(await budget.settle({ reservationId: first.reservationId }), {
    settled: true,
    usd: 0.5,
    tokens: 0,
    kind: 'proactive'
  });

  const second = await budget.reserve({ kind: 'proactive', estimateUsd: 0.2 });
  assert.equal(second.degraded, true);
  assert.deepEqual(second.downgrade, ['defer_proactive']);
  assert.equal(second.remainingUsd, 1.5);
});

test('TC-D08 settle 记入日汇总与分类汇总，status 反映余额', async () => {
  const { clock, budget } = makeBudget({ per_turn_usd: 1, per_day_usd: 2 });

  const reserved = await budget.reserve({ estimateUsd: 0.5 });
  assert.equal(reserved.ok, true);
  assert.equal(reserved.remainingUsd, 2);
  assert.deepEqual(
    await budget.settle({ reservationId: reserved.reservationId, actualUsd: 0.5, actualTokens: 300 }),
    { settled: true, usd: 0.5, tokens: 300, kind: 'passive' }
  );

  assert.deepEqual(await budget.status(), {
    day: localDay(clock.now()),
    spentUsd: 0.5,
    spentTokens: 300,
    perDayUsd: 2,
    byKind: {
      passive: { usd: 0.5, tokens: 300 },
      proactive: { usd: 0, tokens: 0 },
      index: { usd: 0, tokens: 0 }
    },
    remainingUsd: 1.5
  });
});

test('TC-D09 settle 未给实际值用预估入账；未知 reservation 保守计入花费', async () => {
  const { budget } = makeBudget({ per_turn_usd: 1, per_day_usd: 2 });

  const reserved = await budget.reserve({ estimateUsd: 0.5 });
  assert.deepEqual(await budget.settle({ reservationId: reserved.reservationId }), {
    settled: true,
    usd: 0.5,
    tokens: 0,
    kind: 'passive'
  });

  const unknown = await budget.settle({ reservationId: 'res_missing', actualUsd: 0.25, actualTokens: 10 });
  assert.equal(unknown.settled, false);
  assert.equal(unknown.unknown, true);

  const status = await budget.status();
  assert.equal(status.spentUsd, 0.75);
  assert.equal(status.spentTokens, 10);
  assert.equal(status.byKind.passive.usd, 0.75, '未知 reservation 也必须计入 byKind，否则可绕过 proactive 份额');
});

test('TC-D10 跨天（+24h）后预算自动重置并清理旧 reservation', async () => {
  const { clock, budget } = makeBudget();
  const before = await budget.status();

  const reserved = await budget.reserve({ estimateUsd: 0.01 });
  await budget.settle({ reservationId: reserved.reservationId, actualUsd: 0.5 });
  assert.equal((await budget.status()).spentUsd, 0.5);

  clock.advance(24 * 3600 * 1000);
  const afterRoll = await budget.status();
  assert.notEqual(afterRoll.day, before.day);
  assert.deepEqual(afterRoll, {
    day: localDay(clock.now()),
    spentUsd: 0,
    spentTokens: 0,
    perDayUsd: 2,
    byKind: {
      passive: { usd: 0, tokens: 0 },
      proactive: { usd: 0, tokens: 0 },
      index: { usd: 0, tokens: 0 }
    },
    remainingUsd: 2
  });

  const stale = await budget.settle({ reservationId: reserved.reservationId, actualUsd: 0.1 });
  assert.equal(stale.settled, false);
  assert.equal(stale.unknown, true);
  assert.equal((await budget.status()).spentUsd, 0.1);
});

test('TC-D11 合法 reserve 返回递增 reservationId，remainingUsd 按日预算计算', async () => {
  const { budget } = makeBudget({ per_turn_usd: 1, per_day_usd: 2 });

  const first = await budget.reserve({ estimateUsd: 0.1 });
  const second = await budget.reserve({ estimateUsd: 0.1 });
  assert.match(first.reservationId, /^res_1_/);
  assert.match(second.reservationId, /^res_2_/);
  assert.equal(first.remainingUsd, 2);

  await budget.settle({ reservationId: first.reservationId, actualUsd: 0.5 });
  assert.equal((await budget.reserve({ estimateUsd: 0.1 })).remainingUsd, 1.5);
});

test('TC-D12 reserve 未知 kind 抛 ConfigError', async () => {
  const { budget } = makeBudget();
  await assert.rejects(() => budget.reserve({ kind: 'turbo' }), (err) => err.code === 'CONFIG_INVALID');
});

test('TC-D13 reset 清零内存花费', async () => {
  const { budget } = makeBudget({ per_turn_usd: 1, per_day_usd: 2 });

  const reserved = await budget.reserve({ estimateUsd: 0.5 });
  await budget.settle({ reservationId: reserved.reservationId, actualUsd: 0.5, actualTokens: 100 });
  assert.equal((await budget.status()).spentUsd, 0.5);

  await budget.reset();
  assert.equal((await budget.status()).spentUsd, 0);
  assert.equal((await budget.status()).spentTokens, 0);
  assert.equal((await budget.status()).byKind.passive.usd, 0);
});

test('TC-D14 [P1-6 回归] 重启后当日额度不回满：新实例读回已花费金额', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'pa-budget-persist-'));
  try {
    const first = makeBudget({ per_turn_usd: 1, per_day_usd: 2 }, stateDir);
    const reserved = await first.budget.reserve({ estimateUsd: 0.4 });
    await first.budget.settle({ reservationId: reserved.reservationId, actualUsd: 0.4, actualTokens: 20 });

    // 模拟进程重启：新 clock、新实例，同一 stateDir。
    const second = makeBudget({ per_turn_usd: 1, per_day_usd: 2 }, stateDir);
    const status = await second.budget.status();
    assert.equal(status.spentUsd, 0.4);
    assert.equal(status.spentTokens, 20);
    assert.equal(status.remainingUsd, 1.6);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
