/**
 * Reminders / diary / proactive tests.
 *
 * These three modules are the product lines that used to be "a rule that
 * produced a sentence". The invariants worth locking:
 *  - capture is dumb and instant (no model, no interpretation);
 *  - the digest is deterministic (same day in, same draft out);
 *  - attention has a hard daily quota, and it is not negotiable.
 *
 * @module @piagent/personal/test/services/personal
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClock } from '../../src/core/clock.mjs';
import { createReminders, parseWhen } from '../../src/services/reminders.mjs';
import { createDiary } from '../../src/services/diary.mjs';
import { createProactive } from '../../src/services/proactive.mjs';

const START = '2026-10-23T09:00:00+08:00';
const DIRS = [];
after(async () => {
  for (const dir of DIRS) await rm(dir, { recursive: true, force: true });
});

async function makeStateDir() {
  const dir = await mkdtemp(join(tmpdir(), 'pa-personal-'));
  DIRS.push(dir);
  return dir;
}

async function makeReminders() {
  const stateDir = await makeStateDir();
  const clock = createClock({ start: START });
  return { stateDir, clock, reminders: createReminders({ stateDir, clock }) };
}

// ── reminders ────────────────────────────────────────────────────────────

test('TC-R01 创建提醒：排序、可列出、时间必须在未来', async () => {
  const { reminders } = await makeReminders();
  const later = await reminders.add({ text: '交周报', at: '2026-10-25T09:00:00' });
  const sooner = await reminders.add({ text: '吃药', at: '2026-10-23T20:00:00' });

  assert.match(later.id, /^rem_/);
  const list = await reminders.list();
  assert.deepEqual(
    list.map((item) => item.text),
    ['吃药', '交周报'],
    '列表按时间升序'
  );
  assert.equal(sooner.status, 'pending');

  await assert.rejects(() => reminders.add({ text: '', at: '2026-10-25T09:00:00' }), /不能为空/);
  await assert.rejects(() => reminders.add({ text: '过去的事', at: '2026-10-01T09:00:00' }), /必须晚于现在/);
  await assert.rejects(() => reminders.add({ text: '乱写', at: '不是时间' }), /无法解析/);
});

test('TC-R02 到点触发：due 只返回已到点且未触发的，fire 幂等', async () => {
  const { clock, reminders } = await makeReminders();
  const soon = await reminders.add({ text: '开会', at: '2026-10-23T10:00:00' });
  await reminders.add({ text: '明天的事', at: '2026-10-24T10:00:00' });

  assert.deepEqual(await reminders.due(), [], '还没到点');
  clock.advance(2 * 3600 * 1000);

  const due = await reminders.due();
  assert.deepEqual(due.map((item) => item.id), [soon.id]);

  assert.equal(await reminders.fire(soon.id), true);
  assert.equal(await reminders.fire(soon.id), false, '重复触发返回 false');
  assert.deepEqual(await reminders.due(), [], '触发后不再出现在 due 里');
});

test('TC-R03 complete / cancel 的状态迁移与幂等', async () => {
  const { reminders } = await makeReminders();
  const item = await reminders.add({ text: '喝水', at: '2026-10-23T11:00:00' });

  assert.equal(await reminders.cancel('rem_missing'), false);
  assert.equal(await reminders.cancel(item.id), true);
  assert.equal((await reminders.list()).length, 0, '取消后不在默认列表');

  const second = await reminders.add({ text: '站起来', at: '2026-10-23T12:00:00' });
  assert.equal(await reminders.complete(second.id), true);
  assert.equal(await reminders.complete(second.id), true, 'complete 幂等');

  const stat = await reminders.stat();
  assert.equal(stat.total, 2);
  assert.equal(stat.pending, 0);
});

test('TC-R04 parseWhen 支持 ISO 与 +Nm/+Nh/+Nd 偏移', () => {
  const now = Date.parse(START);
  assert.equal(parseWhen('+30m', now), new Date(now + 30 * 60_000).toISOString());
  assert.equal(parseWhen('+2h', now), new Date(now + 2 * 3_600_000).toISOString());
  assert.equal(parseWhen('+1d', now), new Date(now + 86_400_000).toISOString());
  assert.equal(parseWhen('2026-10-25T09:00:00', now), new Date('2026-10-25T09:00:00').toISOString());
  assert.equal(parseWhen('nope', now), null);
});

// ── diary ────────────────────────────────────────────────────────────────

test('TC-D01 随手记：立刻落盘、按天分组、不解释内容', async () => {
  const stateDir = await makeStateDir();
  const clock = createClock({ start: START });
  const diary = createDiary({ stateDir, clock });

  const entry = await diary.add({ text: '王工说接口周三给' });
  assert.match(entry.id, /^note_/);
  assert.equal(entry.day, '2026-10-23');
  assert.deepEqual(entry.tags, []);

  const list = await diary.list({ day: '2026-10-23' });
  assert.equal(list.length, 1);
  assert.equal(list[0].text, '王工说接口周三给');

  await assert.rejects(() => diary.add({ text: '   ' }), /不能为空/);
});

test('TC-D02 日记草稿：三段式、去重、离线可复现', async () => {
  const stateDir = await makeStateDir();
  const clock = createClock({ start: START });
  const diary = createDiary({ stateDir, clock });

  await diary.add({ text: '和王工对齐接口，周三给初版' });
  await diary.add({ text: '卡在权限模型，等安全评审' });
  await diary.add({ text: '明天补一版测试用例' });
  await diary.add({ text: '和王工对齐接口，周三给初版' }); // 重复

  const digest = await diary.digest('2026-10-23');
  assert.equal(digest.count, 4);
  assert.ok(digest.groups.length >= 1);
  assert.ok(digest.draft.did.length <= 6);
  assert.ok(digest.draft.blocked.some((line) => line.includes('权限模型')));
  assert.ok(digest.draft.tomorrow.some((line) => line.includes('测试用例')));
  assert.match(digest.text, /做了什么/);
  assert.match(digest.text, /卡在哪/);
  assert.match(digest.text, /明天第一件事/);

  // 同样输入必须得到同样草稿（无模型、无随机）
  const again = await diary.digest('2026-10-23');
  assert.equal(again.text, digest.text);
});

test('TC-D03 空的一天给出可操作提示，而不是空白页', async () => {
  const stateDir = await makeStateDir();
  const diary = createDiary({ stateDir, clock: createClock({ start: START }) });
  const digest = await diary.digest('2026-10-20');
  assert.equal(digest.count, 0);
  assert.match(digest.text, /没有记录/);
  assert.match(digest.text, /记一下/);
});

test('TC-D04 删除单条记录', async () => {
  const stateDir = await makeStateDir();
  const diary = createDiary({ stateDir, clock: createClock({ start: START }) });
  const entry = await diary.add({ text: '临时记录' });
  assert.equal(await diary.remove(entry.id), true);
  assert.equal(await diary.remove(entry.id), false);
  assert.equal((await diary.list()).length, 0);
});

// ── proactive ────────────────────────────────────────────────────────────

test('TC-P10 到点提醒是唯一能压过配额的事项', async () => {
  const stateDir = await makeStateDir();
  const clock = createClock({ start: '2026-10-23T23:30:00+08:00' });
  const proactive = createProactive({ stateDir, clock, profile: { autonomy: { proactive: { enabled: true, daily_quota: 2 } } } });

  const candidates = await proactive.candidates({
    reminders: [{ id: 'rem_1', text: '吃药', at: '2026-10-23T23:29:00+08:00' }],
    now: clock.now()
  });
  const due = candidates.find((item) => item.kind === 'reminder_due');
  assert.ok(due, '到点提醒应在候选里');

  const taken = await proactive.take({ candidates, max: 1 });
  assert.equal(taken.reason, null);
  assert.equal(taken.sent.length, 1, '静默时段仍允许到点提醒');
});

test('TC-P11 配额用尽即静默，且不排队', async () => {
  const stateDir = await makeStateDir();
  const clock = createClock({ start: '2026-10-23T09:30:00+08:00' });
  const proactive = createProactive({ stateDir, clock, profile: { autonomy: { proactive: { enabled: true, daily_quota: 1 } } } });

  const candidates = [{ id: 's1', kind: 'morning_brief', title: 'x', why: 'y', score: 0.9 }];
  const first = await proactive.take({ candidates, max: 1 });
  assert.equal(first.sent.length, 1);
  assert.equal(first.remaining, 0);

  const second = await proactive.take({ candidates, max: 1 });
  assert.equal(second.reason, 'quota_exhausted');
  assert.deepEqual(second.sent, [], '用尽后不发送，也不缓存到明天');
});

test('TC-P12 深夜的非紧急候选被丢掉（不是延后）', async () => {
  const stateDir = await makeStateDir();
  const clock = createClock({ start: '2026-10-23T23:30:00+08:00' });
  const proactive = createProactive({ stateDir, clock, profile: { autonomy: { proactive: { enabled: true, daily_quota: 3 } } } });

  const candidates = await proactive.candidates({ reminders: [], diary: { todayCount: 5 }, now: clock.now() });
  for (const item of candidates) {
    assert.notEqual(item.kind, 'diary_digest', '深夜不应提醒整理日记');
  }
});

test('TC-P13 关闭主动性后不产生任何发送', async () => {
  const stateDir = await makeStateDir();
  const clock = createClock({ start: '2026-10-23T09:00:00+08:00' });
  const proactive = createProactive({ stateDir, clock, profile: { autonomy: { proactive: { enabled: false } } } });

  const result = await proactive.take({ candidates: [{ id: 's', kind: 'morning_brief', score: 1 }] });
  assert.equal(result.reason, 'proactive_disabled');
  assert.deepEqual(result.sent, []);
});

test('TC-P14 配额跨天重置', async () => {
  const stateDir = await makeStateDir();
  const clock = createClock({ start: '2026-10-23T09:00:00+08:00' });
  const proactive = createProactive({ stateDir, clock, profile: { autonomy: { proactive: { enabled: true, daily_quota: 1 } } } });

  await proactive.take({ candidates: [{ id: 's', kind: 'morning_brief', score: 0.9 }] });
  assert.equal((await proactive.status()).remaining, 0);

  clock.advance(24 * 3600 * 1000);
  assert.equal((await proactive.status()).remaining, 1, '新的一天配额恢复');
});
