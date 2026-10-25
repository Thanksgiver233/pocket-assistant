/**
 * TC-B01 … TC-B17 — Session Gateway (M1) + Intent Router (M1/L1)。
 *
 * 静态编写，**未执行**：本机 shell 不可用（pwsh 0xC0000142），node 无法运行。
 * 所有断言均按 src/runtime/gateway.mjs、src/runtime/intent.mjs 逐行推演。
 *
 * 被测：src/runtime/gateway.mjs、src/runtime/intent.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createGateway } from '../../src/runtime/gateway.mjs';
import { createIntentRouter, extractParams, DEFAULT_RULES } from '../../src/runtime/intent.mjs';
import { createClock } from '../../src/core/clock.mjs';
import { ConfigError, ValidationError } from '../../src/core/errors.mjs';
import { CHANNEL, DATA_CLASS, PERMISSION_MODE, RISK } from '../../src/core/contracts.mjs';

const CLOCK_START = '2026-10-23T09:00:00+08:00';

function makeClock() {
  return createClock({ start: CLOCK_START });
}

/** @param {{autonomy?: Object, [key: string]: any}} [profile] */
function makeGateway(profile = {}) {
  return createGateway({ clock: makeClock(), profile });
}

/** Minimal Turn for the intent router (gateway not required). */
function makeTurn(text, { untrusted = false, id = 'turn_fixture' } = {}) {
  return {
    id,
    channel: CHANNEL.CLI,
    text,
    at: CLOCK_START,
    untrusted,
    mode: PERMISSION_MODE.FULL_ACCESS
  };
}

function parseText(router, text, opts) {
  return router.parse(makeTurn(text, opts));
}

// ───────────────────────────── Gateway ─────────────────────────────

test('TC-B01 gateway 构造：缺 clock 或 profile → ConfigError', () => {
  assert.throws(
    () => createGateway({ profile: {} }),
    (err) => err instanceof ConfigError && err.code === 'CONFIG_INVALID'
  );
  assert.throws(
    () => createGateway({ clock: makeClock() }),
    (err) => err instanceof ConfigError && /loaded profile/.test(err.message)
  );
});

test('TC-B02 gateway 文本校验：空/纯空白/超 8000 → ValidationError；8000 恰好放行；先 trim 再判空', () => {
  const gateway = makeGateway();

  assert.throws(() => gateway.submit({ text: '' }), ValidationError);
  assert.throws(() => gateway.submit({ text: '   \t\n  ' }), ValidationError);
  assert.throws(() => gateway.submit({}), ValidationError);
  assert.throws(
    () => gateway.submit({ text: 'x'.repeat(8001) }),
    (err) => err instanceof ValidationError && /8000/.test(err.message)
  );

  const exact = gateway.submit({ text: 'x'.repeat(8000) });
  assert.equal(exact.text.length, 8000, '8000 字符恰好在上限内');

  // trim 发生在长度检查之前：超长空白串会被 trim 成空串，报"empty"而非"8000"
  assert.throws(
    () => gateway.submit({ text: ' '.repeat(9000) }),
    (err) => err instanceof ValidationError && /empty/.test(err.message)
  );
  assert.equal(gateway.submit({ text: '  你好  ' }).text, '你好');
});

test('TC-B03 gateway channel：默认 cli；契约内 5 个值都合法；未知值 → ValidationError', () => {
  const gateway = makeGateway();

  assert.equal(gateway.submit({ text: 'hi' }).channel, CHANNEL.CLI);
  for (const channel of Object.values(CHANNEL)) {
    assert.equal(gateway.submit({ text: 'hi', channel }).channel, channel);
  }
  assert.throws(
    () => gateway.submit({ text: 'hi', channel: 'email' }),
    (err) => err instanceof ValidationError && /unknown channel/.test(err.message)
  );
});

test('TC-B04 gateway mode：默认取 profile.autonomy.default_mode；可显式覆盖；未知 mode → ValidationError', () => {
  const workspace = makeGateway({ autonomy: { default_mode: PERMISSION_MODE.WORKSPACE_WRITE } });
  assert.equal(workspace.submit({ text: 'hi' }).mode, PERMISSION_MODE.WORKSPACE_WRITE);
  assert.equal(workspace.submit({ text: 'hi', mode: PERMISSION_MODE.FULL_ACCESS }).mode, PERMISSION_MODE.FULL_ACCESS);
  assert.throws(
    () => workspace.submit({ text: 'hi', mode: 'god-mode' }),
    (err) => err instanceof ValidationError && /unknown permission mode/.test(err.message)
  );

  // profile 没有 autonomy 时 fail-safe 到 read-only（gateway.mjs:26）
  const bare = makeGateway({});
  assert.equal(bare.submit({ text: 'hi' }).mode, PERMISSION_MODE.READ_ONLY);
});

test('TC-B05 gateway Turn 形状：id 前缀、at 取 clock、threadId/source 默认、untrusted 严格 === true', () => {
  const clock = makeClock();
  const gateway = createGateway({ clock, profile: { autonomy: { default_mode: PERMISSION_MODE.READ_ONLY } } });

  const turn = gateway.submit({ text: 'hello' });
  assert.match(turn.id, /^turn_/);
  assert.equal(turn.text, 'hello');
  assert.equal(turn.at, clock.iso());
  assert.equal(turn.threadId, null);
  assert.equal(turn.source, CHANNEL.CLI);
  assert.equal(turn.untrusted, false);
  assert.equal(turn.mode, PERMISSION_MODE.READ_ONLY);

  const explicit = gateway.submit({ text: 'hi', threadId: 'th_1', source: 'dashboard' });
  assert.equal(explicit.threadId, 'th_1');
  assert.equal(explicit.source, 'dashboard');

  assert.equal(gateway.submit({ text: 'hi', untrusted: true }).untrusted, true);
  // gateway.mjs:55 用 `input.untrusted === true`：truthy 字符串/数字不得污染 taint 决策
  assert.equal(gateway.submit({ text: 'hi', untrusted: 'true' }).untrusted, false);
  assert.equal(gateway.submit({ text: 'hi', untrusted: 1 }).untrusted, false);
});

test('TC-B06 gateway.confirm：system 通道 + full-access + 绑定 runId + untrusted=false', () => {
  const clock = makeClock();
  const gateway = createGateway({ clock, profile: {} });

  const turn = gateway.confirm({ text: '执行吧', runId: 'r_1' });
  assert.match(turn.id, /^turn_/);
  assert.equal(turn.channel, CHANNEL.SYSTEM);
  assert.equal(turn.text, '执行吧');
  assert.equal(turn.threadId, 'r_1');
  assert.equal(turn.untrusted, false);
  assert.equal(turn.mode, PERMISSION_MODE.FULL_ACCESS);
  assert.equal(turn.source, 'confirmation');
  assert.equal(turn.at, clock.iso());

  assert.equal(gateway.confirm({ runId: 'r_2' }).text, '确认执行', '默认确认文案');
});

// ───────────────────────────── Intent ─────────────────────────────

test('TC-B07 intent 规则目录：15 条规则、id/kind 唯一、风险/数据分级/工具声明齐备', () => {
  assert.equal(DEFAULT_RULES.length, 15);

  const router = createIntentRouter();
  assert.equal(router.rules, DEFAULT_RULES);

  const ids = new Set(DEFAULT_RULES.map((rule) => rule.id));
  const kinds = new Set(DEFAULT_RULES.map((rule) => rule.kind));
  assert.equal(ids.size, DEFAULT_RULES.length, '规则 id 必须唯一');
  assert.equal(kinds.size, DEFAULT_RULES.length, '规则 kind 必须唯一（否则去重语义会吃掉规则）');

  for (const rule of DEFAULT_RULES) {
    assert.ok([RISK.R0, RISK.R1, RISK.R2, RISK.R3].includes(rule.risk), `${rule.id} risk 合法`);
    assert.ok(Array.isArray(rule.dataIn) && rule.dataIn.length > 0, `${rule.id} dataIn 非空`);
    assert.ok(Array.isArray(rule.toolIds), `${rule.id} toolIds 是数组`);
    assert.ok(rule.test instanceof RegExp, `${rule.id} test 是 RegExp`);
    assert.equal(typeof rule.summary, 'string');
  }
});

/**
 * 每条规则各自的最小可命中语句，以及预期 actions 序列。
 * 规则是"全部命中 → 同域读规则让位于写规则 → 按 kind 去重"：
 * 「发邮件」同时命中 mail.send 与 mail.list，但 mail.list 是 R0 读，
 * 同域已有写规则，因此被抑制（否则一句话要两次审批、两次工具调用）。
 */
const RULE_CASES = [
  {
    id: 'calendar.update',
    text: '把下周三的会议挪到周五',
    kinds: ['calendar.update_event'],
    risk: RISK.R1,
    egress: false,
    dataIn: [DATA_CLASS.D1],
    toolIds: ['calendar.update_event']
  },
  {
    id: 'calendar.create',
    text: '创建会议',
    kinds: ['calendar.create_event'],
    risk: RISK.R1,
    egress: false,
    dataIn: [DATA_CLASS.D1],
    toolIds: ['calendar.create_event']
  },
  {
    id: 'calendar.list',
    text: '今天有哪些日程',
    kinds: ['calendar.list_events'],
    risk: RISK.R0,
    egress: false,
    dataIn: [DATA_CLASS.D1],
    toolIds: ['calendar.list_events']
  },
  {
    id: 'mail.send',
    text: '发邮件给 boss@example.com',
    kinds: ['mail.send'],
    risk: RISK.R2,
    egress: true,
    dataIn: [DATA_CLASS.D2],
    toolIds: ['mail.send']
  },
  {
    id: 'mail.draft',
    text: '起草邮件给李四',
    kinds: ['mail.draft'],
    risk: RISK.R1,
    egress: false,
    dataIn: [DATA_CLASS.D2],
    toolIds: ['mail.draft']
  },
  {
    id: 'mail.list',
    text: '查看未读邮件',
    kinds: ['mail.list'],
    risk: RISK.R0,
    egress: false,
    dataIn: [DATA_CLASS.D2],
    toolIds: ['mail.list']
  },
  {
    id: 'im.send',
    text: '发个消息通知他们',
    kinds: ['im.send'],
    risk: RISK.R2,
    egress: true,
    dataIn: [DATA_CLASS.D1],
    toolIds: ['im.send']
  },
  {
    id: 'files.read',
    text: '读一下合同文件',
    kinds: ['files.read'],
    risk: RISK.R0,
    egress: false,
    dataIn: [DATA_CLASS.D1],
    toolIds: ['files.read']
  },
  {
    id: 'files.list',
    text: '列出所有文档',
    kinds: ['files.list'],
    risk: RISK.R0,
    egress: false,
    dataIn: [DATA_CLASS.D1],
    toolIds: ['files.list']
  },
  {
    id: 'payment.transfer',
    text: '给张三转账 500 元',
    kinds: ['payment.transfer'],
    risk: RISK.R3,
    egress: true,
    dataIn: [DATA_CLASS.D2],
    toolIds: []
  },
  {
    id: 'reminder.create',
    text: '明天9点提醒我交周报',
    kinds: ['reminder.create'],
    risk: RISK.R1,
    egress: false,
    dataIn: [DATA_CLASS.D1],
    toolIds: ['reminder.create']
  },
  {
    id: 'diary.create',
    text: '记一下 王工说接口周三给',
    kinds: ['diary.create'],
    risk: RISK.R1,
    egress: false,
    dataIn: [DATA_CLASS.D1],
    toolIds: ['diary.create']
  },
  {
    id: 'diary.today',
    text: '今天做了什么',
    kinds: ['diary.today'],
    risk: RISK.R0,
    egress: false,
    dataIn: [DATA_CLASS.D1],
    toolIds: ['diary.today']
  },
  {
    id: 'suggestions.list',
    text: '有什么建议',
    kinds: ['suggestions.list'],
    risk: RISK.R0,
    egress: false,
    dataIn: [DATA_CLASS.D0],
    toolIds: ['suggestions.list']
  },
  {
    id: 'assistant.summarize',
    text: '总结今天的会议',
    kinds: ['assistant.summarize'],
    risk: RISK.R0,
    egress: false,
    dataIn: [DATA_CLASS.D0],
    toolIds: []
  }
];

test('TC-B08 intent 全部规则均可命中，且 kind/risk/dataIn/egress/toolIds 与规则表一致', () => {
  const router = createIntentRouter();
  assert.equal(RULE_CASES.length, DEFAULT_RULES.length, '用例表必须覆盖全部规则');

  for (const testCase of RULE_CASES) {
    const { actions, clarification } = parseText(router, testCase.text);
    assert.equal(clarification, null, `${testCase.id} 不做澄清`);
    assert.deepEqual(
      actions.map((action) => action.kind),
      testCase.kinds,
      `${testCase.id} 命中 kind 序列：「${testCase.text}」`
    );

    const first = actions[0];
    assert.equal(first.ruleId, testCase.id, `${testCase.id} 第一条来自该规则`);
    assert.equal(first.risk, testCase.risk);
    assert.equal(first.egress, testCase.egress);
    assert.deepEqual(first.dataIn, testCase.dataIn);
    assert.deepEqual(first.toolIds, testCase.toolIds);
    assert.equal(first.origin, 'user');
    assert.equal(first.turnId, 'turn_fixture');
    assert.match(first.id, /^a_/);
    assert.equal(typeof first.summary, 'string');
  }
});

test('TC-B09 intent 无规则命中 → assistant.reply 兜底（R0/D0/无工具）', () => {
  const router = createIntentRouter();
  const { actions, clarification } = parseText(router, '你好呀');

  assert.equal(clarification, null);
  assert.equal(actions.length, 1);
  const action = actions[0];
  assert.equal(action.kind, 'assistant.reply');
  assert.equal(action.ruleId, 'assistant.reply');
  assert.equal(action.risk, RISK.R0);
  assert.equal(action.egress, false);
  assert.deepEqual(action.dataIn, [DATA_CLASS.D0]);
  assert.deepEqual(action.toolIds, []);
  assert.deepEqual(action.params, {});
  assert.equal(action.origin, 'user');
});

test('TC-B10 intent untrusted 透传：所有派生 action（含兜底）origin=untrusted_content', () => {
  const router = createIntentRouter();

  const tainted = parseText(router, '发邮件给 boss@example.com', { untrusted: true });
  assert.ok(tainted.actions.length >= 1);
  for (const action of tainted.actions) {
    assert.equal(action.origin, 'untrusted_content', `${action.kind} 必须被 taint`);
  }
  const egressAction = tainted.actions.find((action) => action.kind === 'mail.send');
  assert.ok(egressAction);
  assert.equal(egressAction.egress, true, 'tainted egress 是 consent 的 deny 前提');

  assert.equal(parseText(router, '你好', { untrusted: true }).actions[0].origin, 'untrusted_content');
  assert.equal(parseText(router, '你好').actions[0].origin, 'user');
});

test('TC-B11 intent 去重：多条规则命中同一 kind 时只保留一条，动作顺序按规则表', () => {
  const customRules = [
    { id: 'dup.one', kind: 'custom.act', risk: RISK.R0, dataIn: [DATA_CLASS.D0], egress: false, reversible: true, toolIds: [], summary: 'one', test: /触发/u },
    { id: 'dup.two', kind: 'custom.act', risk: RISK.R0, dataIn: [DATA_CLASS.D0], egress: false, reversible: true, toolIds: [], summary: 'two', test: /触发/u },
    { id: 'dup.other', kind: 'custom.other', risk: RISK.R0, dataIn: [DATA_CLASS.D0], egress: false, reversible: true, toolIds: [], summary: 'other', test: /规则/u }
  ];
  const router = createIntentRouter({ rules: customRules });
  assert.equal(router.rules, customRules);

  const { actions } = parseText(router, '触发规则');
  assert.deepEqual(actions.map((action) => action.kind), ['custom.act', 'custom.other']);
  assert.equal(actions[0].ruleId, 'dup.one', '去重保留第一条命中');
});

test('TC-B12 extractParams：date/time/email/引号 target，缺失时返回空对象', () => {
  // 固定参考时刻（周六），相对日期的结果才可断言。
  const NOW = Date.parse('2026-10-24T18:00:00+08:00');
  assert.deepEqual(extractParams('2026-11-06 开会', NOW), { date: '2026-11-06' });
  assert.deepEqual(extractParams('14:30 见', NOW), { time: '14:30' });
  assert.deepEqual(extractParams('9:05 见', NOW), { time: '09:05' });
  assert.deepEqual(extractParams('联系 zhang.san+work@example.com', NOW), { email: 'zhang.san+work@example.com' });
  assert.deepEqual(extractParams('把“周会”挪到周五', NOW), { date: '2026-10-30', target: '周会' });
  assert.deepEqual(extractParams('发送「周报」', NOW), { target: '周报' });
  assert.deepEqual(extractParams('2026-11-06 14:30 发给 zhang@example.com 主题“周报”', NOW), {
    date: '2026-11-06',
    time: '14:30',
    email: 'zhang@example.com',
    target: '周报'
  });
  assert.deepEqual(extractParams('随便聊聊', NOW), {});
});

test('TC-B12b extractParams 解析中文相对日期与事件标题（工具需要真实参数）', () => {
  const NOW = Date.parse('2026-10-24T18:00:00+08:00'); // 周六
  assert.deepEqual(extractParams('把周会挪到周五', NOW), { date: '2026-10-30', title: '周会' });
  assert.deepEqual(extractParams('把周会挪到下周三', NOW), { date: '2026-10-28', title: '周会' });
  assert.deepEqual(extractParams('明天提醒我', NOW), { date: '2026-10-25' });
  assert.deepEqual(extractParams('后天提醒我', NOW), { date: '2026-10-26' });
  assert.deepEqual(extractParams('10月30日提醒我', NOW), { date: '2026-10-30' });
  // 泛称不当作标题：否则会匹配到多个日程，工具只能拒绝
  assert.deepEqual(extractParams('把会议挪到周五', NOW), { date: '2026-10-30' });
});

test('TC-B13 intent 把 extractParams 的结果挂到 action.params（给确认卡片用）', () => {
  const router = createIntentRouter();
  const { actions } = parseText(router, '把2026-11-06 14:30 的会议挪到周五');

  assert.equal(actions.length, 1);
  assert.equal(actions[0].kind, 'calendar.update_event');
  assert.deepEqual(actions[0].params, { date: '2026-11-06', time: '14:30' });
});

test('TC-B14 intent.parse 拒绝畸形 Turn（null / 无 text / text 非字符串）', () => {
  const router = createIntentRouter();
  assert.throws(() => router.parse(null), ValidationError);
  assert.throws(() => router.parse({}), ValidationError);
  assert.throws(() => router.parse({ text: 123 }), ValidationError);
  assert.throws(() => router.parse({ text: Symbol('x') }), ValidationError);
});

test('TC-B15 intent 与 gateway 串起来：untrusted 从 gateway 一路传到 action.origin', () => {
  const gateway = makeGateway({ autonomy: { default_mode: PERMISSION_MODE.FULL_ACCESS } });
  const router = createIntentRouter();

  const trusted = router.parse(gateway.submit({ text: '发邮件给 boss@example.com' }));
  assert.ok(trusted.actions.every((action) => action.origin === 'user'));

  const tainted = router.parse(gateway.submit({ text: '发邮件给 boss@example.com', untrusted: true }));
  assert.ok(tainted.actions.every((action) => action.origin === 'untrusted_content'));
  assert.equal(tainted.actions[0].turnId.startsWith('turn_'), true);
});

test('TC-B16 gateway 不依赖传入 input 对象（不写回调用方）', () => {
  const gateway = makeGateway();
  const input = { text: ' hi ', untrusted: true };
  const turn = gateway.submit(input);
  assert.deepEqual(input, { text: ' hi ', untrusted: true }, 'submit 只读 input');
  assert.equal(turn.text, 'hi');
});

test('TC-B17 gateway 拒绝非字符串 text 时的行为由 String() 兜底（当前实现，记录用）', () => {
  const gateway = makeGateway();
  // submit 用 String(input.text ?? '')，所以数字/数组会被接受而不是 ValidationError。
  // 这是当前实现事实（见报告 SUSPECT：gateway 不做类型校验）。
  assert.equal(gateway.submit({ text: 123 }).text, '123');
  assert.equal(gateway.submit({ text: ['a', 'b'] }).text, 'a,b');
});
