/**
 * TC-C14 … TC-C18 — Delivery Hub (M8)：打断上限 / 静默时段 / 摘要上限 / 冷却 / 计数。
 *
 * 静态编写，**未执行**：本机 shell 不可用，node 无法运行。断言按 src 推演。
 *
 * 被测：src/runtime/delivery.mjs
 * 注意：delivery 的 reason 码（quiet_hours / interrupt_cap / digest_cap / cooldown /
 * queued_for_digest / logged_only）只存在于 src，docs 未固定枚举 —— 见报告 SUSPECT。
 * 静默时段用全天窗口 ['00:00-23:59'] 以规避测试机时区差异（inQuietHours 用本地时间）。
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDelivery } from '../../src/runtime/delivery.mjs';
import { createClock } from '../../src/core/clock.mjs';

const CLOCK_START = '2026-10-23T09:00:00+08:00';

const TMP_DIRS = [];
async function makeTmp(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  TMP_DIRS.push(dir);
  return dir;
}
after(async () => {
  for (const dir of TMP_DIRS) await rm(dir, { recursive: true, force: true });
});

/**
 * @param {Object} proactive profile.autonomy.proactive（caps / quiet_hours / cooldown_minutes）
 */
async function makeDelivery(proactive) {
  const dir = await makeTmp('pa-delivery-');
  const clock = createClock({ start: CLOCK_START });
  const sent = [];
  const channels = [
    {
      id: 'console',
      async send(record) {
        sent.push(record);
        return { ok: true };
      }
    }
  ];
  const profile = { autonomy: { proactive } };
  const delivery = createDelivery({ stateDir: dir, clock, profile, channels });
  return { dir, clock, sent, delivery };
}

const ARTIFACT = { runId: 'r_01JTEST000001', text: '有一条需要你知道的结果' };

test('TC-C14 interrupt 超 cap → 降级 digest，reason=interrupt_cap', async () => {
  const { sent, delivery } = await makeDelivery({
    interrupt_per_day: 2,
    digest_per_day: 4,
    quiet_hours: [],
    cooldown_minutes: 0
  });

  const first = await delivery.deliver(ARTIFACT, { urgency: 'interrupt' });
  assert.equal(first.delivered, true);
  assert.equal(first.urgency, 'interrupt');

  const second = await delivery.deliver(ARTIFACT, { urgency: 'interrupt' });
  assert.equal(second.delivered, true);

  const third = await delivery.deliver(ARTIFACT, { urgency: 'interrupt' });
  assert.equal(third.delivered, false);
  assert.equal(third.urgency, 'digest');
  assert.equal(third.reason, 'interrupt_cap');
  assert.equal(third.queued, true);

  assert.equal(sent.length, 2, '只有前两次真正打断用户');
});

test('TC-C15 静默时段 interrupt → digest，reason=quiet_hours', async () => {
  const { sent, delivery } = await makeDelivery({
    interrupt_per_day: 5,
    digest_per_day: 5,
    // 两个窗口的并集覆盖全天（窗口 A 只漏 23:59，窗口 B 只漏 11:59）：
    // inQuietHours 用本地时间判断，这样断言与测试机时区无关。
    quiet_hours: ['00:00-23:59', '12:00-11:59'],
    cooldown_minutes: 0
  });

  const result = await delivery.deliver(ARTIFACT, { urgency: 'interrupt' });
  assert.equal(result.delivered, false);
  assert.equal(result.urgency, 'digest');
  assert.equal(result.reason, 'quiet_hours');
  assert.equal(result.queued, true);
  assert.equal(sent.length, 0, '静默时段不得有任何即时发送');
});

test('TC-C16 digest 超 cap → log，reason=digest_cap', async () => {
  const { sent, delivery } = await makeDelivery({
    interrupt_per_day: 2,
    digest_per_day: 1,
    quiet_hours: [],
    cooldown_minutes: 0
  });

  const first = await delivery.deliver(ARTIFACT, { urgency: 'digest' });
  assert.equal(first.urgency, 'digest');
  assert.equal(first.queued, true);
  assert.equal(first.reason, 'queued_for_digest');

  const second = await delivery.deliver(ARTIFACT, { urgency: 'digest' });
  assert.equal(second.delivered, false);
  assert.equal(second.urgency, 'log');
  assert.equal(second.reason, 'digest_cap');
  assert.equal(second.queued, false);

  assert.equal(sent.length, 0);
  const stat = await delivery.stat();
  assert.equal(stat.counters.digest, 1, '被降到 log 的那条不再计入 digest 配额');
});

test('TC-C17 cooldown 生效：冷却期内 interrupt → digest，reason=cooldown', async () => {
  const { clock, delivery } = await makeDelivery({
    interrupt_per_day: 5,
    digest_per_day: 5,
    quiet_hours: [],
    cooldown_minutes: 60
  });

  const first = await delivery.deliver(ARTIFACT, { urgency: 'interrupt' });
  assert.equal(first.delivered, true);

  // 立刻再来一条 interrupt：lastAt 距今 0 分钟 < 60 → 冷却
  const second = await delivery.deliver(ARTIFACT, { urgency: 'interrupt' });
  assert.equal(second.delivered, false);
  assert.equal(second.urgency, 'digest');
  assert.equal(second.reason, 'cooldown');

  // 冷却只压 interrupt，digest 仍可正常入队
  const third = await delivery.deliver(ARTIFACT, { urgency: 'digest' });
  assert.equal(third.urgency, 'digest');
  assert.equal(third.reason, 'queued_for_digest');

  // 冷却期过去后 interrupt 恢复
  clock.advance(61 * 60 * 1000);
  const fourth = await delivery.deliver(ARTIFACT, { urgency: 'interrupt' });
  assert.equal(fourth.delivered, true);
  assert.equal(fourth.urgency, 'interrupt');
});

test('TC-C18 连续调用计数正确：interrupt/digest 各自累计，log 不消耗配额', async () => {
  const { delivery } = await makeDelivery({
    interrupt_per_day: 2,
    digest_per_day: 4,
    quiet_hours: [],
    cooldown_minutes: 0
  });

  assert.equal((await delivery.deliver(ARTIFACT, { urgency: 'interrupt' })).delivered, true);
  assert.equal((await delivery.deliver(ARTIFACT, { urgency: 'interrupt' })).delivered, true);
  // 第 3 次 interrupt 被降级为 digest，并消耗 1 个 digest 配额
  assert.equal((await delivery.deliver(ARTIFACT, { urgency: 'interrupt' })).reason, 'interrupt_cap');
  // 再一条 digest
  assert.equal((await delivery.deliver(ARTIFACT, { urgency: 'digest' })).reason, 'queued_for_digest');
  // log 级不消耗任何配额
  const logged = await delivery.deliver(ARTIFACT, { urgency: 'log' });
  assert.equal(logged.delivered, false);
  assert.equal(logged.reason, 'logged_only');

  const stat = await delivery.stat();
  assert.equal(stat.caps.interrupt, 2);
  assert.equal(stat.caps.digest, 4);
  assert.equal(stat.counters.interrupt, 2);
  assert.equal(stat.counters.digest, 2);
  assert.equal(typeof stat.counters.day, 'string');
  assert.ok(stat.counters.lastAt);
  assert.deepEqual(stat.quietHours, []);

  // 未知 urgency 直接失败（fail-closed，不静默降级）
  await assert.rejects(() => delivery.deliver(ARTIFACT, { urgency: 'bang' }), TypeError);
});
