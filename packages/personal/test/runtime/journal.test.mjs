/**
 * TC-B29 … TC-B38 — Journal (M3)：Run/Step checkpoint、持久化、续跑候选与损坏文件。
 *
 * 静态编写，**未执行**：本机 shell 不可用（pwsh 0xC0000142），node 无法运行。
 * 断言按 src/runtime/journal.mjs、src/core/jsonl.mjs、src/core/clock.mjs 逐行推演。
 *
 * 被测：src/runtime/journal.mjs
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClock } from '../../src/core/clock.mjs';
import { createJournal } from '../../src/runtime/journal.mjs';
import { readJson } from '../../src/core/jsonl.mjs';
import { RUN_STATUS } from '../../src/core/contracts.mjs';

const CLOCK_START = '2026-10-23T09:00:00+08:00';

const TMP_DIRS = [];
after(async () => {
  for (const dir of TMP_DIRS) await rm(dir, { recursive: true, force: true });
});

async function makeTmp(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  TMP_DIRS.push(dir);
  return dir;
}

/** Each test gets its own clock + journal dir. */
async function makeJournal() {
  const root = await makeTmp('pa-journal-');
  const dir = join(root, 'journal');
  const clock = createClock({ start: CLOCK_START });
  return { root, dir, clock, journal: createJournal({ dir, clock }) };
}

test('TC-B29 journal 构造：缺 dir → TypeError；有 dir 才可创建', async () => {
  assert.throws(
    () => createJournal({}),
    (err) => err instanceof TypeError && /journal requires a directory/.test(err.message)
  );
  assert.throws(() => createJournal({ clock: createClock({ start: CLOCK_START }) }), TypeError);

  const { journal } = await makeJournal();
  assert.equal(typeof journal.startRun, 'function');
  assert.equal(typeof journal.appendStep, 'function');
  assert.equal(typeof journal.checkpoint, 'function');
  assert.equal(typeof journal.load, 'function');
  assert.equal(typeof journal.listRuns, 'function');
  assert.equal(typeof journal.latestIncomplete, 'function');
});

test('TC-B30 startRun：写入 running checkpoint、actions 标 pending、落盘到 <dir>/<run_id>.json', async () => {
  const { dir, clock, journal } = await makeJournal();

  const run = await journal.startRun({
    turnId: 'turn_1',
    intent: '把会议挪到周五',
    mode: 'workspace-write',
    actions: [{ id: 'a_1', kind: 'calendar.update_event', risk: 'R1' }]
  });

  assert.match(run.run_id, /^r_/);
  assert.equal(run.version, 1);
  assert.equal(run.turn_id, 'turn_1');
  assert.equal(run.intent, '把会议挪到周五');
  assert.equal(run.mode, 'workspace-write');
  assert.equal(run.status, RUN_STATUS.RUNNING);
  assert.equal(run.created_at, clock.iso());
  assert.equal(run.updated_at, clock.iso());
  assert.deepEqual(run.actions, [
    { id: 'a_1', kind: 'calendar.update_event', risk: 'R1', status: 'pending' }
  ]);
  assert.deepEqual(run.steps, []);
  assert.equal(run.pending, null);
  assert.deepEqual(run.artifacts, []);
  assert.equal(run.error, null);

  const onDisk = await readJson(join(dir, `${run.run_id}.json`));
  assert.equal(onDisk.run_id, run.run_id);
  assert.equal(onDisk.status, RUN_STATUS.RUNNING);
});

test('TC-B31 startRun：intent 超过 200 字符被截断（隐私最小化，journal.mjs）', async () => {
  const { journal } = await makeJournal();
  const run = await journal.startRun({
    turnId: 'turn_long',
    intent: 'x'.repeat(600),
    mode: 'read-only',
    actions: []
  });
  assert.equal(run.intent.length, 200);
});

test('TC-B32 appendStep：追加 step 并带 at 时间戳；同步 action.status；新实例可从磁盘读回', async () => {
  const { dir, clock, journal } = await makeJournal();
  const run = await journal.startRun({
    turnId: 'turn_1',
    intent: 'i',
    mode: 'workspace-write',
    actions: [{ id: 'a_1', kind: 'calendar.update_event', risk: 'R1' }]
  });

  await journal.appendStep(run.run_id, {
    actionId: 'a_1',
    status: 'done',
    tools: ['calendar.update_event']
  });
  clock.advance(1500);
  await journal.appendStep(run.run_id, { actionId: 'a_1', status: 'denied', note: 'second' });

  const loaded = await journal.load(run.run_id);
  assert.equal(loaded.steps.length, 2);
  assert.equal(loaded.steps[0].actionId, 'a_1');
  assert.equal(loaded.steps[0].status, 'done');
  assert.deepEqual(loaded.steps[0].tools, ['calendar.update_event']);
  assert.ok(loaded.steps[0].at, 'step 必须带 at 时间戳');
  assert.notEqual(loaded.steps[1].at, loaded.steps[0].at, 'clock 前进后时间戳应不同');
  assert.equal(loaded.actions[0].status, 'denied', 'step.status 会回写对应 action');

  // 第二个实例没有内存缓存，只能从磁盘重建 → 证明持久化可续跑
  const secondJournal = createJournal({ dir, clock });
  const reloaded = await secondJournal.load(run.run_id);
  assert.equal(reloaded.steps.length, 2);
  assert.equal(reloaded.status, RUN_STATUS.RUNNING);
});

test('TC-B33 checkpoint：status/pending/error 按补丁更新，artifacts 追加而不是覆盖', async () => {
  const { journal } = await makeJournal();
  const run = await journal.startRun({ turnId: 'turn_1', intent: 'i', mode: 'workspace-write', actions: [] });

  await journal.checkpoint(run.run_id, {
    status: RUN_STATUS.AWAITING_APPROVAL,
    pending: { actionId: 'a_1', card: { kind: 'mail.send' } },
    error: 'fixture_error'
  });
  let loaded = await journal.load(run.run_id);
  assert.equal(loaded.status, RUN_STATUS.AWAITING_APPROVAL);
  assert.equal(loaded.pending.actionId, 'a_1');
  assert.equal(loaded.error, 'fixture_error');

  // 没传 error 时保留旧值；pending 传 null 才清空
  await journal.checkpoint(run.run_id, { status: RUN_STATUS.RUNNING, pending: null });
  loaded = await journal.load(run.run_id);
  assert.equal(loaded.pending, null);
  assert.equal(loaded.error, 'fixture_error', '未传的字段不得被清空');

  await journal.checkpoint(run.run_id, { artifacts: [{ kind: 'text', text: 'a' }] });
  await journal.checkpoint(run.run_id, { artifacts: [{ kind: 'text', text: 'b' }] });
  loaded = await journal.load(run.run_id);
  assert.equal(loaded.artifacts.length, 2, 'artifacts 是追加语义（journal.mjs:91）');
  assert.equal(loaded.artifacts[0].text, 'a');
  assert.equal(loaded.artifacts[1].text, 'b');

  await journal.checkpoint(run.run_id, { error: null });
  loaded = await journal.load(run.run_id);
  assert.equal(loaded.error, null);
});

test('TC-B34 load：未知 run / 不支持的 version → ResumeError（code=RESUME_FAILED）', async () => {
  const { dir, journal } = await makeJournal();
  await journal.startRun({ turnId: 'turn_1', intent: 'i', mode: 'read-only', actions: [] });

  await assert.rejects(
    () => journal.load('r_missing'),
    (err) => err.name === 'ResumeError' && err.code === 'RESUME_FAILED' && /run not found/.test(err.message)
  );

  await writeFile(join(dir, 'r_future.json'), JSON.stringify({ version: 2, run_id: 'r_future' }), 'utf8');
  await assert.rejects(
    () => journal.load('r_future'),
    (err) => err.name === 'ResumeError' && /unsupported journal version/.test(err.message)
  );
});

test('TC-B35 listRuns：按 created_at 新→旧；损坏文件标 corrupt 且不抛、不遮蔽其他 run', async () => {
  const { dir, clock, journal } = await makeJournal();

  const first = await journal.startRun({ turnId: 'turn_1', intent: 'first', mode: 'read-only', actions: [] });
  clock.advance(1000);
  const second = await journal.startRun({ turnId: 'turn_2', intent: 'second', mode: 'read-only', actions: [] });

  await writeFile(join(dir, 'broken.json'), '{"version":1,"run_id":', 'utf8');

  const runs = await journal.listRuns();
  assert.equal(runs.length, 3);

  const corrupt = runs.find((entry) => entry.run_id === 'broken');
  assert.ok(corrupt, '损坏文件必须出现在结果里（而不是被静默跳过）');
  assert.equal(corrupt.status, 'corrupt');

  const valid = runs.filter((entry) => entry.status !== 'corrupt');
  assert.deepEqual(valid.map((entry) => entry.run_id), [second.run_id, first.run_id], 'newest first');
});

test('TC-B36 latestIncomplete：只认 running/awaiting_approval/blocked，且取最新一条', async () => {
  const { clock, journal } = await makeJournal();

  const done = await journal.startRun({ turnId: 'turn_done', intent: 'i', mode: 'read-only', actions: [] });
  await journal.checkpoint(done.run_id, { status: RUN_STATUS.DONE });

  clock.advance(1000);
  const parked = await journal.startRun({ turnId: 'turn_parked', intent: 'i', mode: 'read-only', actions: [] });
  await journal.checkpoint(parked.run_id, {
    status: RUN_STATUS.AWAITING_APPROVAL,
    pending: { actionId: 'a_1' }
  });

  clock.advance(1000);
  const running = await journal.startRun({ turnId: 'turn_running', intent: 'i', mode: 'read-only', actions: [] });

  let latest = await journal.latestIncomplete();
  assert.equal(latest.run_id, running.run_id, '最新且 running 的 run 优先');

  await journal.checkpoint(running.run_id, { status: RUN_STATUS.DONE });
  latest = await journal.latestIncomplete();
  assert.equal(latest.run_id, parked.run_id);

  // blocked 也算可续跑
  await journal.checkpoint(parked.run_id, { status: RUN_STATUS.BLOCKED });
  latest = await journal.latestIncomplete();
  assert.equal(latest.run_id, parked.run_id);

  // denied 不可续跑，且没有其他候选 → null
  await journal.checkpoint(parked.run_id, { status: RUN_STATUS.DENIED });
  assert.equal(await journal.latestIncomplete(), null);
});

test('TC-B37 remove：存在返回 true 并删盘+清缓存；不存在返回 false', async () => {
  const { journal } = await makeJournal();
  const run = await journal.startRun({ turnId: 'turn_1', intent: 'i', mode: 'read-only', actions: [] });

  assert.equal(await journal.remove('r_missing'), false);
  assert.equal(await journal.remove(run.run_id), true);
  await assert.rejects(
    () => journal.load(run.run_id),
    (err) => err.name === 'ResumeError'
  );
  const runs = await journal.listRuns();
  assert.equal(runs.some((entry) => entry.run_id === run.run_id), false);
  assert.equal(await journal.remove(run.run_id), false);
});

test('TC-B38 listRuns / latestIncomplete：目录从未创建时返回空，不抛 ENOENT', async () => {
  const { journal } = await makeJournal();
  assert.deepEqual(await journal.listRuns(), []);
  assert.equal(await journal.latestIncomplete(), null);
});
