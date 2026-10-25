/**
 * TC-B18 … TC-B28c — Loop Adapter (M3)：同意/拒绝/确认/续跑、工具调用与审计顺序。
 *
 * 静态编写，**未执行**：本机 shell 不可用（pwsh 0xC0000142），node 无法运行。
 * 断言按 src/runtime/loop-adapter.mjs 与它依赖的
 * consent / audit / budget / journal / tool-registry / mock-host 逐行推演。
 *
 * 装配方式：createMockHost() + 手工装配 services（不用 activateMock，避免
 * compose 里的 memory/lane/delivery 噪声），但 guard 的注册方式与 compose.mjs §3
 * 完全一致，因此 tool_call hook 链与生产同构。
 *
 * 被测：src/runtime/loop-adapter.mjs（及其依赖 services/*、host/mock-host.mjs）
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClock } from '../../src/core/clock.mjs';
import { createMockHost } from '../../src/host/mock-host.mjs';
import { createConsent } from '../../src/services/consent.mjs';
import { createAudit } from '../../src/services/audit.mjs';
import { createBudget } from '../../src/services/budget.mjs';
import { createJournal } from '../../src/runtime/journal.mjs';
import { createGateway } from '../../src/runtime/gateway.mjs';
import { createIntentRouter } from '../../src/runtime/intent.mjs';
import { createLoopAdapter } from '../../src/runtime/loop-adapter.mjs';
import { createToolRegistry } from '../../src/integrations/tool-registry.mjs';
import { createCalendarConnector } from '../../src/integrations/connectors/calendar.mjs';
import { createMailConnector } from '../../src/integrations/connectors/mail.mjs';
import { normaliseProfile } from '../../src/services/profile.mjs';
import { createGuard } from '../../src/compose.mjs';
import { HOOKS } from '../../src/host/host-port.mjs';
import { readJsonl } from '../../src/core/jsonl.mjs';
import { PolicyError } from '../../src/core/errors.mjs';
import { DATA_CLASS, PERMISSION_MODE, RISK, RUN_STATUS, VERDICT } from '../../src/core/contracts.mjs';

const START = '2026-10-23T09:00:00+08:00';

const MANIFEST_SCHEMA = JSON.parse(
  readFileSync(new URL('../../schemas/tool-manifest.v1.json', import.meta.url), 'utf8')
);

const TMP_DIRS = [];
after(async () => {
  for (const dir of TMP_DIRS) await rm(dir, { recursive: true, force: true });
});

async function makeTmp(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  TMP_DIRS.push(dir);
  return dir;
}

/**
 * Assemble the same service graph compose.mjs builds (minus memory/lane/delivery).
 * @param {{defaultMode?: string, profile?: Object, grantMail?: boolean, grantCalendar?: boolean,
 *          hook?: (host: Object) => void, calendarOptions?: Object, mailOptions?: Object}} [options]
 */
async function makeHarness(options = {}) {
  const {
    defaultMode = PERMISSION_MODE.FULL_ACCESS,
    profile: profileOverride,
    grantMail = false,
    grantCalendar = false,
    hook,
    calendarOptions,
    mailOptions
  } = options;

  const root = await makeTmp('pa-loop-');
  const clock = createClock({ start: START });

  // Generous default caps so budget never interferes; tests that need budget
  // pressure override the whole `budget` block.
  const profile = normaliseProfile({
    version: 1,
    autonomy: { default_mode: defaultMode },
    budget: { per_turn_usd: 1, per_day_usd: 20, on_exceed: 'degrade' },
    privacy: { egress: 'confirm' },
    ...(profileOverride ?? {})
  });

  const stateDir = join(root, '.pi', 'pa-state');
  const auditDir = join(stateDir, 'audit');
  const journalDir = join(stateDir, 'journal');
  const grantsPath = join(root, '.pi', 'pa', 'grants.json');

  const host = createMockHost({ name: 'mock-loop' });
  const consent = createConsent({ profile, grantsPath, clock });
  await consent.load();
  const audit = createAudit({ dir: auditDir, clock });
  await audit.init();
  const budget = createBudget({ profile, clock });
  const journal = createJournal({ dir: journalDir, clock });
  const registry = createToolRegistry({ manifestSchema: MANIFEST_SCHEMA, clock });

  const calendar = createCalendarConnector({ clock, ...(calendarOptions ?? {}) });
  const mail = createMailConnector({ clock, ...(mailOptions ?? {}) });
  registry.registerConnector(calendar);
  registry.registerConnector(mail);

  // Mirrors compose.mjs §3 "guard.register".
  const guard = createGuard({ registry, clock, audit });
  for (const hookName of HOOKS) {
    host.registerHook(hookName, (payload) => guard.handle(hookName, payload));
  }
  if (hook) hook(host);

  const gateway = createGateway({ clock, profile });
  const intent = createIntentRouter();
  const loop = createLoopAdapter({ host, consent, audit, budget, journal, registry, clock, profile });

  if (grantMail) {
    // R2 + D2 需要一条覆盖 mail.send 的 grant，否则 consent 在 egress_confirm
    // 之前就先 deny(data_class_blocked)。
    await consent.grant({
      connector: mail.id,
      actions: ['mail.send'],
      data_classes: [DATA_CLASS.D2],
      connectorDigest: mail.digest,
      issuedBy: 'user'
    });
  }

  if (grantCalendar) {
    // R1 的首次写入必须先确认一次（docs/04 §5.2）。需要"直接跑通"的用例
    // 用一条已签发的常驻授权代表"用户此前已确认过"。
    await consent.grant({
      connector: calendar.id,
      actions: ['calendar.update_event', 'calendar.create_event'],
      data_classes: [DATA_CLASS.D1],
      connectorDigest: calendar.digest,
      issuedBy: 'user'
    });
  }

  return {
    root,
    clock,
    profile,
    host,
    consent,
    audit,
    budget,
    journal,
    registry,
    calendar,
    mail,
    gateway,
    intent,
    loop,
    stateDir,
    auditDir,
    journalDir,
    grantsPath
  };
}

function turnFor(harness, text, extra = {}) {
  return harness.gateway.submit({
    text,
    mode: harness.profile.autonomy.default_mode,
    ...extra
  });
}

async function runAction(harness, text, action, extra = {}) {
  const turn = turnFor(harness, text, extra);
  return harness.loop.execute(turn, { actions: [action] }, { mode: turn.mode });
}

function calendarUpdateAction({ id = 'evt_1', date = '2026-10-31', actionId = 'a_cal_1' } = {}) {
  return {
    id: actionId,
    kind: 'calendar.update_event',
    toolIds: ['calendar.update_event'],
    risk: RISK.R1,
    dataIn: [DATA_CLASS.D1],
    egress: false,
    reversible: true,
    summary: '修改日历事件',
    params: { id, date },
    origin: 'user'
  };
}

function mailSendAction({ to = 'boss@example.com', actionId = 'a_mail_1' } = {}) {
  return {
    id: actionId,
    kind: 'mail.send',
    toolIds: ['mail.send'],
    risk: RISK.R2,
    dataIn: [DATA_CLASS.D2],
    egress: true,
    reversible: false,
    summary: '发送邮件（对外、不可撤回）',
    params: { to },
    origin: 'user'
  };
}

async function readLedger(harness) {
  const { records, corrupt } = await readJsonl(harness.audit.ledgerFile);
  assert.deepEqual(corrupt, [], 'audit ledger must not contain corrupt lines');
  return records;
}

function indexOfKind(records, kind, predicate = () => true) {
  return records.findIndex((record) => record.kind === kind && predicate(record));
}

// ─────────────────────────── 构造与拒绝路径 ───────────────────────────

test('TC-B18 loop 构造：缺依赖 → TypeError；空/缺失 proposal → TypeError', async () => {
  assert.throws(
    () => createLoopAdapter({}),
    (err) => err instanceof TypeError && /loop adapter requires host/.test(err.message)
  );

  const harness = await makeHarness();
  const turn = turnFor(harness, '把周会挪到周五');
  await assert.rejects(() => harness.loop.execute(turn, { actions: [] }), TypeError);
  await assert.rejects(() => harness.loop.execute(turn, undefined), TypeError);
});

test('TC-B19 loop deny：untrusted 内容触发 tainted_egress，工具零调用，run 立刻结束', async () => {
  const harness = await makeHarness();

  const turn = harness.gateway.submit({
    text: '发送邮件给 boss@example.com',
    mode: PERMISSION_MODE.FULL_ACCESS,
    untrusted: true
  });
  const proposal = harness.intent.parse(turn);

  // 同域写规则抑制同域读规则：只产生 mail.send 一个动作
  assert.equal(proposal.actions[0].kind, 'mail.send');
  assert.equal(proposal.actions.length, 1);
  assert.ok(proposal.actions.every((action) => action.origin === 'untrusted_content'));

  const result = await harness.loop.execute(turn, proposal, { mode: turn.mode });

  assert.equal(result.status, RUN_STATUS.DENIED);
  assert.equal(result.decision.verdict, VERDICT.DENY);
  assert.equal(result.decision.reason, 'tainted_egress');
  assert.equal(result.decision.requires, 'none');

  // 副作用与调用计数：mail 连接器零发送
  assert.equal(harness.mail._outbox().length, 0);
  assert.equal(harness.host._calls.length, 0);

  const journalRun = await harness.journal.load(result.runId);
  assert.equal(journalRun.status, RUN_STATUS.DENIED);
  assert.equal(journalRun.error, 'tainted_egress');
  // I3：denial 停住整个 run
  assert.equal(journalRun.actions.length, 1);
  assert.equal(journalRun.actions[0].status, RUN_STATUS.DENIED);

  const records = await readLedger(harness);
  assert.equal(indexOfKind(records, 'tool_call'), -1, 'deny 之后不得出现 tool_call');
  assert.equal(indexOfKind(records, 'tool_result'), -1);
  const decision = records[indexOfKind(records, 'decision')];
  assert.equal(decision.decision.verdict, VERDICT.DENY);
  assert.equal(decision.decision.reason, 'tainted_egress');
  assert.equal(decision.tool, 'mail.send');
});

test('TC-B20 loop deny：read-only 档位下 R1 写在 consent 就被拦，工具零调用', async () => {
  const harness = await makeHarness({ defaultMode: PERMISSION_MODE.READ_ONLY });
  const turn = turnFor(harness, '把周会挪到周五');
  const proposal = harness.intent.parse(turn);
  assert.equal(proposal.actions[0].kind, 'calendar.update_event');

  const result = await harness.loop.execute(turn, proposal, { mode: turn.mode });

  assert.equal(result.status, RUN_STATUS.DENIED);
  assert.equal(result.decision.reason, 'mode_blocks_write');
  assert.equal(harness.calendar._events()[0].start, '2026-10-28T10:00', '日历不得被改');
  const records = await readLedger(harness);
  assert.equal(indexOfKind(records, 'tool_call'), -1);
});

// ─────────────────────────── confirm / resume ───────────────────────────

test('TC-B21 loop confirm：R2 停在 awaiting_approval 并落 journal.pending；resume(approve:true) 真正执行且 user_confirmed 先于 tool_call', async () => {
  const harness = await makeHarness({ grantMail: true });

  const turn = turnFor(harness, '发送邮件给 boss@example.com');
  const parked = await harness.loop.execute(turn, { actions: [mailSendAction()] }, { mode: turn.mode });

  assert.equal(parked.status, RUN_STATUS.AWAITING_APPROVAL);
  assert.ok(parked.pending, 'confirm 路径必须把 pending 返回给调用方');
  assert.equal(parked.pending.card.kind, 'mail.send');
  assert.deepEqual(parked.pending.card.toolIds, ['mail.send']);
  assert.equal(parked.pending.requires, 'user');
  assert.equal(parked.pending.risk, RISK.R2);

  const journalRun = await harness.journal.load(parked.runId);
  assert.equal(journalRun.status, RUN_STATUS.AWAITING_APPROVAL);
  assert.equal(journalRun.pending.card.kind, 'mail.send');
  assert.equal(journalRun.pending.actionId, 'a_mail_1');
  assert.equal(harness.mail._outbox().length, 0, '确认之前绝不能发送');
  let records = await readLedger(harness);
  assert.equal(indexOfKind(records, 'tool_call'), -1);

  const resumed = await harness.loop.resume(parked.runId, { approve: true });

  assert.equal(resumed.status, RUN_STATUS.DONE);
  assert.equal(harness.mail._outbox().length, 1, '确认后必须真的调用 tool');
  assert.equal(harness.mail._outbox()[0].to, 'boss@example.com');
  assert.equal(resumed.artifacts.length, 1);

  records = await readLedger(harness);
  const confirmed = indexOfKind(records, 'decision', (record) => record.decision?.verdict === 'user_confirmed');
  const call = indexOfKind(records, 'tool_call');
  const outcome = indexOfKind(records, 'tool_result');
  assert.ok(confirmed >= 0, 'user_confirmed 必须进 ledger');
  assert.ok(confirmed < call, `user_confirmed(${confirmed}) 必须先于 tool_call(${call})`);
  assert.ok(call < outcome, `tool_call(${call}) 必须先于 tool_result(${outcome})`);

  const done = await harness.journal.load(parked.runId);
  assert.equal(done.status, RUN_STATUS.DONE);
  assert.equal(done.pending, null);
  assert.equal((await harness.audit.verifyChain()).ok, true, 'loop 的追加不得破坏哈希链');
});

test('TC-B22 loop resume(approve:false)：run 变 denied、pending 清空、工具零调用', async () => {
  const harness = await makeHarness({ grantMail: true });

  const turn = turnFor(harness, '发送邮件给 boss@example.com');
  const parked = await harness.loop.execute(turn, { actions: [mailSendAction()] }, { mode: turn.mode });
  assert.equal(parked.status, RUN_STATUS.AWAITING_APPROVAL);

  const result = await harness.loop.resume(parked.runId, { approve: false });

  assert.equal(result.status, RUN_STATUS.DENIED);
  assert.equal(result.decision.verdict, VERDICT.DENY);
  assert.equal(result.decision.reason, 'user_rejected');
  assert.equal(harness.mail._outbox().length, 0);
  assert.equal(harness.host._calls.length, 0);

  const journalRun = await harness.journal.load(parked.runId);
  assert.equal(journalRun.status, RUN_STATUS.DENIED);
  assert.equal(journalRun.pending, null);
  assert.equal(journalRun.error, 'user_rejected');

  const records = await readLedger(harness);
  assert.equal(indexOfKind(records, 'tool_call'), -1);
  const rejected = records.find(
    (record) => record.kind === 'decision' && record.decision?.verdict === VERDICT.DENY
  );
  assert.ok(rejected);
  assert.equal(rejected.decision.reason, 'user_rejected');
});

// ─────────────────────────── allow / 失败 / 阻塞 ───────────────────────────

test('TC-B23 loop allow：tool 被调用一次；audit 顺序 decision → tool_call → tool_result；host._calls 不可用（设计缺口）', async () => {
  const harness = await makeHarness({ defaultMode: PERMISSION_MODE.WORKSPACE_WRITE, grantCalendar: true });

  const result = await runAction(harness, '把周会挪到周五', calendarUpdateAction());

  assert.equal(result.status, RUN_STATUS.DONE);
  assert.equal(result.artifacts.length, 1);
  const event = harness.calendar._events().find((entry) => entry.id === 'evt_1');
  assert.equal(event.start, '2026-10-31', '副作用是断言"工具真的跑了"的可靠证据');

  const records = await readLedger(harness);
  const decision = indexOfKind(records, 'decision', (record) => record.decision?.verdict === VERDICT.ALLOW);
  const call = indexOfKind(records, 'tool_call');
  const outcome = indexOfKind(records, 'tool_result');
  assert.ok(
    decision >= 0 && decision < call && call < outcome,
    `audit 顺序必须是 decision(${decision}) -> tool_call(${call}) -> tool_result(${outcome})`
  );
  assert.equal(records[call].tool, 'calendar.update_event');
  assert.equal(records[call].outcome.status, 'started');
  assert.equal(records[outcome].outcome.status, 'ok');

  // 【设计缺口，见报告 SUSPECT-L1】tool-registry.invoke() 直接调用 connector，
  // 不经过 HostPort，所以 mock-host 的 _recordCall 永远没人调用，host._calls 恒为空。
  // 本断言用于把该事实固定下来：src 修复后这里会失败，提醒更新断言。
  assert.equal(harness.host._calls.length, 0, 'host._calls 当前不可用于断言工具调用');
  // hook 管线本身看得到调用，这也是审计链仍完整的原因。
  assert.equal(harness.host._hookLog.filter((entry) => entry.hook === 'tool_call').length, 1);
  assert.equal(harness.host._hookLog.filter((entry) => entry.hook === 'tool_result').length, 1);

  const journalRun = await harness.journal.load(result.runId);
  assert.equal(journalRun.status, RUN_STATUS.DONE);
  assert.equal(journalRun.steps.length, 1);
  assert.equal(journalRun.steps[0].status, 'done');
  assert.equal(journalRun.actions[0].status, 'done');
  assert.equal((await harness.audit.verifyChain()).ok, true);
});

test('TC-B24 loop tool 抛错：status=failed；journal step=failed；audit tool_result=error；日历未被修改', async () => {
  const harness = await makeHarness({ grantCalendar: true });
  const result = await runAction(harness, '把不存在的会挪到周五', calendarUpdateAction({ id: 'evt_missing' }));

  assert.equal(result.status, RUN_STATUS.FAILED);
  assert.equal(harness.calendar._events().length, 2, '失败的 update 不得写入 store');

  const journalRun = await harness.journal.load(result.runId);
  assert.equal(journalRun.status, RUN_STATUS.FAILED);
  assert.equal(journalRun.steps[0].status, 'failed');
  assert.equal(journalRun.steps[0].error, 'INTERNAL_ERROR');
  // 注意：RunResult 没有 error 字段（result() 不收集 error），错误只在 journal/audit 里。
  assert.equal(result.error, undefined);

  const records = await readLedger(harness);
  assert.ok(indexOfKind(records, 'tool_call') >= 0, 'tool_call 已记录（调用发生过）');
  const outcome = records[indexOfKind(records, 'tool_result')];
  assert.equal(outcome.outcome.status, 'error');
  assert.equal(outcome.outcome.code, 'INTERNAL_ERROR');
});

test('TC-B25 loop blocked：无工具且 risk != R0 → 不得假装成功，status=blocked', async () => {
  const harness = await makeHarness({ defaultMode: PERMISSION_MODE.WORKSPACE_WRITE, grantCalendar: true });
  const action = {
    id: 'a_no_tool',
    kind: 'calendar.update_event',
    toolIds: [],
    risk: RISK.R1,
    dataIn: [DATA_CLASS.D1],
    egress: false,
    reversible: true,
    summary: '修改日历事件',
    params: {},
    origin: 'user'
  };

  const result = await runAction(harness, '把周会挪到周五', action);

  assert.equal(result.status, RUN_STATUS.BLOCKED);
  const journalRun = await harness.journal.load(result.runId);
  assert.equal(journalRun.status, RUN_STATUS.BLOCKED);
  assert.equal(journalRun.steps[0].status, 'blocked');
  assert.equal(journalRun.error.code, 'NO_TOOL_REGISTERED');
  // 同样地，RunResult 不带 error（见 TC-B24 注释与报告 SUSPECT-L2）。
  assert.equal(result.error, undefined);

  const records = await readLedger(harness);
  assert.equal(indexOfKind(records, 'tool_call'), -1, '没有工具就不该有 tool_call');
  const outcome = records[indexOfKind(records, 'tool_result')];
  assert.equal(outcome.outcome.status, 'blocked');
  assert.equal(outcome.outcome.code, 'NO_TOOL_REGISTERED');
});

test('TC-B26 loop hook 否决：tool_call handler 抛 PolicyError → DENIED + audit 记 vetoed，工具零调用', async () => {
  const harness = await makeHarness({
    grantCalendar: true,
    hook: (host) => {
      host.registerHook('tool_call', () => {
        throw new PolicyError('POLICY_DENIED', 'fixture veto');
      });
    }
  });

  const result = await runAction(harness, '把周会挪到周五', calendarUpdateAction());

  assert.equal(result.status, RUN_STATUS.DENIED);
  assert.equal(harness.calendar._events()[0].start, '2026-10-28T10:00');

  const records = await readLedger(harness);
  const call = records[indexOfKind(records, 'tool_call')];
  assert.ok(call, 'veto 也必须留痕（I6）');
  assert.equal(call.decision.verdict, 'vetoed');
  assert.equal(call.decision.code, 'POLICY_DENIED');
  assert.equal(indexOfKind(records, 'tool_result'), -1, '被否决的调用没有结果记录');

  const journalRun = await harness.journal.load(result.runId);
  assert.equal(journalRun.status, RUN_STATUS.DENIED);
  assert.equal(journalRun.steps[0].status, 'vetoed');
});

// ─────────────────────────── budget 与续跑前置条件 ───────────────────────────

test('TC-B27 loop budget ask：超 per_turn 预算 → 在工具之前停成 awaiting_approval（budget 卡片）', async () => {
  const harness = await makeHarness({
    grantCalendar: true,
    profile: { budget: { per_turn_usd: 0.0005, per_day_usd: 20, on_exceed: 'ask' } }
  });

  const result = await runAction(harness, '把周会挪到周五', calendarUpdateAction());

  assert.equal(result.status, RUN_STATUS.AWAITING_APPROVAL);
  assert.equal(harness.calendar._events()[0].start, '2026-10-28T10:00', '预算审批前不得调用工具');

  const journalRun = await harness.journal.load(result.runId);
  assert.equal(journalRun.status, RUN_STATUS.AWAITING_APPROVAL);
  assert.equal(journalRun.pending.card.cardType, 'budget');
  assert.equal(journalRun.pending.card.kind, 'calendar.update_event');
  assert.deepEqual(journalRun.pending.card.reasons, ['per_turn_usd']);
  assert.equal(journalRun.pending.reason, 'budget_requires_approval');

  // 返回值必须和 journal 一致：调用方只看 result.pending 也不能漏掉审批（SUSPECT-L3）。
  assert.ok(result.pending, '预算审批的 pending 必须回传给调用方');
  assert.equal(result.pending.card.cardType, 'budget');

  const records = await readLedger(harness);
  assert.equal(indexOfKind(records, 'tool_call'), -1);
});

test('TC-B27b 预算审批通过后续跑应执行被暂停的原 action（一次性放行）', async () => {
    const harness = await makeHarness({
      grantCalendar: true,
      profile: { budget: { per_turn_usd: 0.0005, per_day_usd: 20, on_exceed: 'ask' } }
    });
    const parked = await runAction(harness, '把周会挪到周五', calendarUpdateAction());
    assert.equal(parked.status, RUN_STATUS.AWAITING_APPROVAL);

    const resumed = await harness.loop.resume(parked.runId, { approve: true });
    assert.equal(resumed.status, RUN_STATUS.DONE, '预算确认后应执行原 action');
  assert.equal(
    harness.calendar._events().find((entry) => entry.id === 'evt_1').start,
    '2026-10-31'
  );
});

test('TC-B28 resume 前置条件：非 awaiting 状态与不存在的 run 都必须报错', async () => {
  const harness = await makeHarness({ defaultMode: PERMISSION_MODE.WORKSPACE_WRITE, grantCalendar: true });
  const done = await runAction(harness, '把周会挪到周五', calendarUpdateAction());
  assert.equal(done.status, RUN_STATUS.DONE);

  await assert.rejects(
    () => harness.loop.resume(done.runId, { approve: true }),
    (err) => err instanceof TypeError && /not awaiting approval/.test(err.message)
  );
  await assert.rejects(
    () => harness.loop.resume('r_missing_run', { approve: true }),
    (err) => err.name === 'ResumeError' && err.code === 'RESUME_FAILED'
  );
});

test('TC-B28b loop 续跑可从磁盘重建：新 journal 实例能 resume 已落盘的 pending（docs/04 §7.4 #4）', async () => {
  const harness = await makeHarness({ grantMail: true });

  const turn = turnFor(harness, '发送邮件给 boss@example.com');
  const parked = await harness.loop.execute(turn, { actions: [mailSendAction()] }, { mode: turn.mode });
  assert.equal(parked.status, RUN_STATUS.AWAITING_APPROVAL);

  // 模拟进程重启：新 journal 没有任何内存缓存，只能从 journalDir 重建。
  const journalAfterRestart = createJournal({ dir: harness.journalDir, clock: harness.clock });
  const loopAfterRestart = createLoopAdapter({
    host: harness.host,
    consent: harness.consent,
    audit: harness.audit,
    budget: harness.budget,
    journal: journalAfterRestart,
    registry: harness.registry,
    clock: harness.clock,
    profile: harness.profile
  });

  const resumed = await loopAfterRestart.resume(parked.runId, { approve: true });
  assert.equal(resumed.status, RUN_STATUS.DONE, 'pending 必须足以重建被确认的 action');
  assert.equal(harness.mail._outbox().length, 1);
});

test('TC-B28c resume 重新评估 consent，而不是无条件信任 journal 里的 pending.card', async () => {
  const harness = await makeHarness({ grantMail: true });
  const turn = turnFor(harness, '发送邮件给 boss@example.com');
  const parked = await harness.loop.execute(turn, { actions: [mailSendAction()] }, { mode: turn.mode });
  assert.equal(parked.status, RUN_STATUS.AWAITING_APPROVAL);

  // 期望实现：resume 前对重建出的 action 重跑一次 consent.check。
  let checks = 0;
  const spyConsent = {
    ...harness.consent,
    check(action, ctx) {
      checks += 1;
      return harness.consent.check(action, ctx);
    }
  };
  const journalAfterRestart = createJournal({ dir: harness.journalDir, clock: harness.clock });
  const loopAfterRestart = createLoopAdapter({
    host: harness.host,
    consent: spyConsent,
    audit: harness.audit,
    budget: harness.budget,
    journal: journalAfterRestart,
    registry: harness.registry,
    clock: harness.clock,
    profile: harness.profile
  });

  const resumed = await loopAfterRestart.resume(parked.runId, { approve: true });
  assert.equal(resumed.status, RUN_STATUS.DONE);
  assert.equal(checks, 1, 'resume 必须对重建的 action 重新调用 consent.check');
});

test('TC-B28d resume 时 grant 已撤销 → 即使 approve 也必须 deny（防 journal 篡改/授权漂移）', async () => {
  const harness = await makeHarness({ grantMail: true });
  const turn = turnFor(harness, '发送邮件给 boss@example.com');
  const parked = await harness.loop.execute(turn, { actions: [mailSendAction()] }, { mode: turn.mode });
  assert.equal(parked.status, RUN_STATUS.AWAITING_APPROVAL);

  const [grant] = harness.consent.list();
  await harness.consent.revoke(grant.grant_id);

  const resumed = await harness.loop.resume(parked.runId, { approve: true });
  assert.equal(resumed.status, RUN_STATUS.DENIED);
  assert.equal(resumed.decision.reason, 'data_class_blocked', '撤销后 D2 动作失去授权依据');
  assert.equal(harness.mail._outbox().length, 0, '授权失效后不得再发送');
  const journalRun = await harness.journal.load(parked.runId);
  assert.equal(journalRun.error, 'resume_data_class_blocked');
});
