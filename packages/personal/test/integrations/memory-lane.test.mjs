/**
 * TC-C01 … TC-C13 — Persona Memory (M6) 写入闸 / 检索 / 遗忘 + personal context lane (M7)。
 *
 * 静态编写，**未执行**：本机 shell 不可用（pwsh 0xC0000142），无法运行 node。
 * 每条断言均按 src 逐行推演；标记【推演】处为对实现细节的判断。
 *
 * 被测：src/services/memory.mjs、src/runtime/context-lane.mjs
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMemory } from '../../src/services/memory.mjs';
import { createPersonalLane } from '../../src/runtime/context-lane.mjs';
import { createClock } from '../../src/core/clock.mjs';
import { readJson } from '../../src/core/jsonl.mjs';

const CLOCK_START = '2026-10-23T09:00:00+08:00';
/** 固定 citation：命中写入闸第 1/3 条后，citation 缺失是最后一道闸。 */
const CITATION = [{ kind: 'turn', ref: 'turn_01JTEST000001' }];

const TMP_DIRS = [];
async function makeTmp(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  TMP_DIRS.push(dir);
  return dir;
}
after(async () => {
  for (const dir of TMP_DIRS) await rm(dir, { recursive: true, force: true });
});

function makeClock() {
  return createClock({ start: CLOCK_START });
}

function memProfile(overrides = {}) {
  return {
    memory: {
      write_gate: 'strict',
      retention_days: { episodic: 90, semantic: 0, procedural: 0 },
      allow_d2: false,
      ...overrides
    }
  };
}

async function makeMemory(overrides) {
  const dir = await makeTmp('pa-mem-');
  const clock = makeClock();
  return { dir, clock, memory: createMemory({ stateDir: dir, profile: memProfile(overrides), clock }) };
}

// ─────────────────────────── 写入闸 ───────────────────────────

test('TC-C01 写入闸：无 citation → citation_required，且不入库', async () => {
  const { memory } = await makeMemory();
  const result = await memory.remember({ statement: '用户偏好上午九点开会' });

  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'citation_required');
  assert.equal(result.id, undefined);
  assert.equal((await memory.list()).length, 0);
  assert.equal((await memory.stat()).total, 0);
});

test('TC-C02 写入闸：D3 永不入记忆 → d3_never_remembered', async () => {
  const { memory } = await makeMemory();
  const result = await memory.remember({
    statement: '用户的银行登录口令保存在某处',
    data_class: 'D3',
    citation: CITATION
  });

  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'd3_never_remembered');
  assert.equal((await memory.list()).length, 0);
});

test('TC-C03 写入闸：D2 且 profile.allow_d2=false → d2_not_allowed_by_profile', async () => {
  const { memory } = await makeMemory({ allow_d2: false });
  const result = await memory.remember({
    statement: '用户每月五号收到银行对账单',
    data_class: 'D2',
    citation: CITATION
  });

  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'd2_not_allowed_by_profile');
  assert.equal((await memory.list()).length, 0);
});

test('TC-C04 写入闸：inferred 且置信 < 0.7 → 进 candidate 区，不参与 recall', async () => {
  const { memory } = await makeMemory();
  const result = await memory.remember({
    statement: '用户可能更喜欢喝乌龙茶',
    source: 'inferred',
    confidence: 0.4,
    citation: CITATION
  });

  assert.equal(result.accepted, false);
  assert.equal(result.candidate, true);
  assert.equal(result.reason, 'inferred_low_confidence');
  assert.equal(typeof result.id, 'string');

  // candidate 不在 facts 中：list() 与 recall() 都看不到
  assert.equal((await memory.list()).length, 0);
  const recall = await memory.recall('乌龙茶');
  assert.equal(recall.snippets.length, 0);
  const stat = await memory.stat();
  assert.equal(stat.candidates, 1);
  assert.equal(stat.total, 0);
});

test('TC-C05 写入闸：同一 subject+statement 重复写入 → duplicate，不产生第二条', async () => {
  const { memory } = await makeMemory();
  const statement = '用户偏好上午九点到十一点之间开会';

  const first = await memory.remember({ statement, citation: CITATION });
  assert.equal(first.accepted, true);
  assert.equal(typeof first.id, 'string');

  const second = await memory.remember({ statement, citation: CITATION });
  assert.equal(second.accepted, false);
  assert.equal(second.reason, 'duplicate');
  assert.equal(second.id, first.id, 'duplicate 应回指已有事实');

  assert.equal((await memory.list()).length, 1);
});

test('TC-C06 边界：statement 长度不合规 → statement_length（4..280）', async () => {
  const { memory } = await makeMemory();
  const tooShort = await memory.remember({ statement: '冷', citation: CITATION });
  assert.equal(tooShort.reason, 'statement_length');

  const tooLong = await memory.remember({ statement: 'x'.repeat(281), citation: CITATION });
  assert.equal(tooLong.reason, 'statement_length');
});

// ─────────────────────────── 检索 ───────────────────────────

test('TC-C07 recall：关键词命中返回 snippet + citation，并刷新 last_used_at', async () => {
  const { memory } = await makeMemory();
  const stored = await memory.remember({
    statement: '用户偏好上午九点到十一点之间开会',
    citation: CITATION
  });
  assert.equal(stored.accepted, true);

  const recall = await memory.recall('开会');
  assert.equal(recall.snippets.length, 1);
  assert.equal(recall.snippets[0].id, stored.id);
  assert.equal(recall.snippets[0].dataClass, 'D1');
  assert.ok(recall.snippets[0].text.includes('开会'));
  assert.equal(recall.citations.length, 1);
  assert.equal(recall.citations[0].factId, stored.id);
  assert.equal(recall.citations[0].kind, 'turn');
  assert.equal(recall.filtered, 0);

  // 无关键词命中
  const miss = await memory.recall('量子色动力学');
  assert.equal(miss.snippets.length, 0);
});

test('TC-C08 recall：D2 未授权被 filtered；显式 grantedDataClasses 后才可见', async () => {
  const { memory } = await makeMemory({ allow_d2: true });
  const stored = await memory.remember({
    statement: '用户的银行对账单每月五号生成',
    data_class: 'D2',
    citation: CITATION
  });
  assert.equal(stored.accepted, true, 'allow_d2=true 时 D2 应可写入');

  const denied = await memory.recall('对账单');
  assert.equal(denied.snippets.length, 0, '默认只授权 D0/D1，D2 不得返回');
  assert.equal(denied.filtered, 1);

  const granted = await memory.recall('对账单', { grantedDataClasses: ['D0', 'D1', 'D2'] });
  assert.equal(granted.snippets.length, 1);
  assert.equal(granted.snippets[0].dataClass, 'D2');
  assert.equal(granted.filtered, 0);
});

// ─────────────────────────── 遗忘 ───────────────────────────

test('TC-C09 forget：物理删除后 list() 与 recall() 都查不到，磁盘上也不再有事实', async () => {
  const { dir, memory } = await makeMemory();
  for (const statement of ['用户偏好上午九点开会', '用户的工位在十四层', '用户养了一只叫年糕的猫']) {
    const res = await memory.remember({ statement, citation: CITATION });
    assert.equal(res.accepted, true, `应写入: ${statement}`);
  }
  assert.equal((await memory.list()).length, 3);

  const removed = await memory.forget({ scope: 'all' });
  assert.equal(removed.removed, 3);
  assert.equal(removed.ids.length, 3);

  assert.equal((await memory.list()).length, 0);
  const recall = await memory.recall('开会');
  assert.equal(recall.snippets.length, 0);
  assert.equal(recall.citations.length, 0);

  const onDisk = await readJson(join(dir, 'memory', 'facts.json'));
  assert.equal(onDisk.facts.length, 0, 'forget 必须是物理删除，而不只是标记 forgotten');
  assert.equal(onDisk.candidates.length, 0);
});

// ─────────────────────────── context lane (M7) ───────────────────────────

async function makeLane() {
  const dir = await makeTmp('pa-lane-');
  const clock = makeClock();
  return { dir, clock, lane: createPersonalLane({ stateDir: dir, clock }) };
}

test('TC-C10 lane index/retrieve：命中记录返回 id/text/dataClass/citations/score', async () => {
  const { lane } = await makeLane();
  const indexed = await lane.index({
    id: 'note_1',
    text: '周会安排在周四下午三点',
    tags: ['会议'],
    citations: [{ kind: 'turn', ref: 'turn_01JTEST000002' }]
  });
  assert.equal(indexed.indexed, true);

  const result = await lane.retrieve('周会');
  assert.equal(result.snippets.length, 1);
  assert.equal(result.snippets[0].id, 'note_1');
  assert.equal(result.snippets[0].dataClass, 'D1');
  assert.equal(result.snippets[0].citations.length, 1);
  assert.ok(result.snippets[0].score > 0);
  assert.equal(result.filtered, 0);

  const miss = await lane.retrieve('完全不相关的查询词');
  assert.equal(miss.snippets.length, 0);
  assert.equal(miss.tokensUsed, 0);
});

test('TC-C11 lane retrieve：budgetTokens 截断（cost = ceil(text.length/4)）', async () => {
  const { lane } = await makeLane();
  // 每条 text 长度 100 → cost 25 tokens
  await lane.index({ id: 'budget_1', text: '预算'.concat('a'.repeat(98)) });
  await lane.index({ id: 'budget_2', text: '预算'.concat('b'.repeat(98)) });

  const budgeted = await lane.retrieve('预算', { budgetTokens: 30 });
  assert.equal(budgeted.snippets.length, 1, '第二条放不下（25+25 > 30）应被截断');
  assert.equal(budgeted.tokensUsed, 25);
  assert.equal(budgeted.snippets[0].id, 'budget_1');

  const unbounded = await lane.retrieve('预算', { budgetTokens: 1200 });
  assert.equal(unbounded.snippets.length, 2);
  assert.equal(unbounded.tokensUsed, 50);
});

test('TC-C12 lane retrieve：D2 未授权被 filtered，授权后可见', async () => {
  const { lane } = await makeLane();
  await lane.index({ id: 'secret_1', text: '银行流水与还款日', dataClass: 'D2' });

  const denied = await lane.retrieve('银行');
  assert.equal(denied.snippets.length, 0);
  assert.equal(denied.filtered, 1);

  const granted = await lane.retrieve('银行', { grantedDataClasses: ['D0', 'D1', 'D2'] });
  assert.equal(granted.snippets.length, 1);
  assert.equal(granted.snippets[0].dataClass, 'D2');
});

test('TC-C13 lane remove：remove 后检索为空，stat 归零', async () => {
  const { lane } = await makeLane();
  await lane.index({ id: 'gone_1', text: '待删除的临时笔记' });
  assert.equal((await lane.stat()).records, 1);

  const removed = await lane.remove({ scope: 'all' });
  assert.equal(removed.removed, 1);
  assert.equal((await lane.stat()).records, 0);
  assert.equal((await lane.retrieve('临时笔记')).snippets.length, 0);
});
