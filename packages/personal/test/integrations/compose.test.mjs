/**
 * TC-C34 … TC-C39 — Composition Root：注册顺序、启动失败语义、连接器降级、端到端 Turn。
 *
 * 静态编写，**未执行**：本机 shell 不可用，node 无法运行。断言按 src 推演。
 *
 * 被测：src/compose.mjs（+ src/index.mjs 暴露的装配面）
 * 契约来源：docs/06 §9 注册顺序；docs/04 §6.3 / §7（降级不整体失败）
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { composePersonalAgent } from '../../src/compose.mjs';
import { createMockHost } from '../../src/host/mock-host.mjs';
import { createFilesConnector } from '../../src/integrations/connectors/local-files.mjs';
import { createCalendarConnector } from '../../src/integrations/connectors/calendar.mjs';
import { createMailConnector } from '../../src/integrations/connectors/mail.mjs';
import { createClock } from '../../src/core/clock.mjs';
import { ConfigError } from '../../src/core/errors.mjs';
import { REGISTRATION_ORDER } from '../../src/core/contracts.mjs';

const CLOCK_START = '2026-10-23T09:00:00+08:00';

/**
 * profile schema 是 additionalProperties:false —— 只能写白名单字段。
 * 省略 tools.autonomy.proactive 等键，由 normaliseProfile 填保守默认值。
 */
const PROFILE = {
  version: 1,
  autonomy: { default_mode: 'read-only' },
  budget: { per_turn_usd: 0.05, per_day_usd: 2 },
  memory: { allow_d2: false },
  privacy: { egress: 'confirm' },
  connectors: { allow: [] }
};

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

/** 一个最小可用工作区：`.pi/pa-profile.json` + `vault/` 目录。 */
async function makeWorkspace({ withProfile = true } = {}) {
  const root = await makeTmp('pa-compose-');
  await mkdir(join(root, 'vault'), { recursive: true });
  if (withProfile) {
    await mkdir(join(root, '.pi'), { recursive: true });
    await writeFile(join(root, '.pi', 'pa-profile.json'), `${JSON.stringify(PROFILE, null, 2)}\n`, 'utf8');
  }
  return root;
}

function defaultConnectorsFor(root, clock) {
  return [
    createFilesConnector({ root: join(root, 'vault'), clock }),
    createCalendarConnector({ clock }),
    createMailConnector({ clock })
  ];
}

async function makeAgent(overrides = {}) {
  const root = overrides.root ?? (await makeWorkspace({ withProfile: overrides.withProfile !== false }));
  const clock = overrides.clock ?? makeClock();
  const host = overrides.host ?? createMockHost();
  // Machine state must live OUTSIDE the workspace: a cloned repo must never
  // be able to carry its own grants (P0-1). A sibling temp dir, not root/home.
  const homeDir = overrides.homeDir ?? (await makeTmp('pa-compose-home-'));
  const api = await composePersonalAgent({
    host,
    workspaceRoot: root,
    homeDir,
    clock,
    connectors: overrides.connectors ?? defaultConnectorsFor(root, clock),
    channels: overrides.channels,
    logger: overrides.logger,
    masterKey: overrides.masterKey
  });
  return { root, homeDir, clock, host, api };
}

// ─────────────────────────── 装配顺序 ───────────────────────────

test('TC-C34 正常装配：registered 严格等于 REGISTRATION_ORDER，健康且 doctor 可运行', async () => {
  const { root, api } = await makeAgent({ masterKey: Buffer.alloc(32, 7) });

  // 注册顺序即安全语义（docs/06 §9）：严格逐项相等，且顺序一致
  assert.deepEqual(api.registered, [...REGISTRATION_ORDER]);
  assert.equal(api.registered.join('>'), REGISTRATION_ORDER.join('>'));

  assert.equal(api.health.length, 3);
  assert.ok(
    api.health.every((entry) => entry.ok === true),
    `默认三个连接器都应健康: ${JSON.stringify(api.health)}`
  );
  assert.equal(api.services.registry.stat().connectors, 3);
  assert.equal(api.services.registry.stat().tools, 8);

  assert.equal(api.profile.autonomy.default_mode, 'read-only');
  assert.equal(api.paths.profilePath, join(root, '.pi', 'pa-profile.json'));

  // MockHost 没有 registerLane：lane 注册必须自报未注册，而不是假装成功
  assert.equal(api.laneRegistration.registered, false);
  assert.equal(api.laneRegistration.reason, 'no_registerLane');

  // masterKey 存在 → vault 已装配，且句柄语义可用
  assert.ok(api.services.vault, 'masterKey 注入时应装配 vault');
  const stored = await api.services.vault.putSecret({ connector: 'gmail', value: 'pa-test-secret-value' });
  assert.ok(stored.handle.startsWith('vault://gmail/'));
  assert.equal((await api.services.vault.describe()).length, 1);

  const doctor = await api.doctor();
  assert.equal(doctor.ok, true, `doctor 应判定可运行: ${JSON.stringify(doctor.checks)}`);
  assert.equal(doctor.exitCode, 0);
  const checks = Object.fromEntries(doctor.checks.map((check) => [check.id, check]));
  assert.equal(checks.profile.status, 'pass');
  assert.equal(checks.tools.status, 'pass');
  assert.equal(checks.connectors.status, 'pass');
  assert.equal(checks.audit_chain.status, 'pass');
  assert.equal(checks.context_lane.status, 'pass');
  // 没有任何 grant 时只应 warn，不应 fail
  assert.equal(checks.grants.status, 'warn');
});

test('TC-C35 无 profile → ConfigError（不允许用默认值继续跑）', async () => {
  const root = await makeWorkspace({ withProfile: false });
  const clock = makeClock();

  await assert.rejects(
    async () =>
      composePersonalAgent({
        host: createMockHost(),
        workspaceRoot: root,
        homeDir: await makeTmp('pa-compose-home-'),
        clock,
        connectors: defaultConnectorsFor(root, clock)
      }),
    (err) => {
      assert.ok(err instanceof ConfigError, `期望 ConfigError，实际 ${err?.name}`);
      assert.equal(err.code, 'CONFIG_INVALID');
      assert.match(err.message, /profile not found/);
      return true;
    }
  );
});

test('TC-C36 无工具（connectors: []）→ ConfigError：拒绝启动空能力面的 agent', async () => {
  const root = await makeWorkspace();

  await assert.rejects(
    async () =>
      composePersonalAgent({
        host: createMockHost(),
        workspaceRoot: root,
        homeDir: await makeTmp('pa-compose-home-'),
        clock: makeClock(),
        connectors: []
      }),
    (err) => {
      assert.ok(err instanceof ConfigError);
      assert.equal(err.code, 'CONFIG_INVALID');
      assert.match(err.message, /no tools registered/);
      return true;
    }
  );
});

test('TC-C37 两个连接器都挂掉：仍能 compose（局部降级），doctor 报 warn', async () => {
  const root = await makeWorkspace();
  const clock = makeClock();
  const warnings = [];
  const logger = {
    info() {},
    warn(message) {
      warnings.push(String(message));
    },
    error() {}
  };

  const { api } = await makeAgent({
    root,
    clock,
    logger,
    connectors: [
      createFilesConnector({ root: join(root, 'vault'), clock, failHealth: true }),
      createCalendarConnector({ clock, failHealth: true })
    ]
  });

  assert.deepEqual(api.registered, [...REGISTRATION_ORDER], '降级不得打乱注册顺序');
  assert.equal(api.health.length, 2);
  assert.ok(
    api.health.every((entry) => entry.ok === false),
    `两个连接器都应不健康: ${JSON.stringify(api.health)}`
  );
  // 工具仍在（连接器注册成功，只是健康检查失败）
  assert.equal(api.services.registry.stat().tools, 5);
  assert.ok(
    warnings.some((message) => /unhealthy/.test(message)),
    '降级必须可观测（compose 至少 warn 一次）'
  );

  const doctor = await api.doctor();
  assert.equal(doctor.ok, true, '单个/多个连接器掉线不等于 agent 不可运行（04 §7.4 第 2 条）');
  const connectorsCheck = doctor.checks.find((check) => check.id === 'connectors');
  assert.equal(connectorsCheck.status, 'warn');
  assert.match(connectorsCheck.detail, /offline|unreachable/);
});

// ─────────────────────────── 端到端 Turn ───────────────────────────

test('TC-C38 端到端：read-only 下「把会议挪到周五」→ denied / mode_blocks_write', async () => {
  const { api } = await makeAgent();

  const result = await api.turn('把会议挪到周五');

  assert.equal(result.status, 'denied');
  assert.equal(result.turn.mode, 'read-only');
  assert.equal(result.proposal.actions.length, 1, '意图路由应只产出 1 个语义动作');
  assert.equal(result.proposal.actions[0].kind, 'calendar.update_event');
  assert.equal(result.proposal.actions[0].risk, 'R1');

  assert.equal(result.decisions.length, 1);
  assert.equal(result.decisions[0].verdict, 'deny');
  assert.equal(result.decision.reason, 'mode_blocks_write', 'R1 高于 read-only 的 R0 上限');
  assert.equal(result.pending, null, 'deny 不是待确认，不得留下 pending');
  assert.equal(result.artifacts.length, 0, '被拒的动作不得产生任何 artifact');

  // 决策必须已落账（先决策后结果的顺序不变量）
  const { records } = await api.services.audit.readAll();
  assert.ok(
    records.some((record) => record.kind === 'decision' && record.decision?.verdict === 'deny'),
    '账本中应存在 deny 决策'
  );
  assert.ok(
    records.some((record) => record.kind === 'intent'),
    '账本中应存在 intent 事件'
  );
});

test('TC-C40 端到端：read-only 下 R2「发邮件」被 deny，且先撞 mode 上限而非 egress 策略', async () => {
  const { api } = await makeAgent();

  const result = await api.turn('发邮件给张三');

  assert.equal(result.status, 'denied');
  // 同域写规则抑制同域读规则：一句话只产生一个动作，只审一次。
  assert.equal(result.proposal.actions.length, 1);
  assert.deepEqual(
    result.proposal.actions.map((action) => action.kind),
    ['mail.send']
  );
  assert.equal(result.proposal.actions[0].risk, 'R2');
  assert.equal(result.proposal.actions[0].egress, true);
  // consent.check 的顺序：mode 上限（R2 > R0）先于 egress_confirm，因此 reason 必须是 mode_blocks_write
  assert.equal(result.decision.reason, 'mode_blocks_write');
  assert.equal(result.decisions.length, 1);
  assert.equal(result.artifacts.length, 0);
});

test('TC-C41 [P0-1 回归] 机器级状态目录落在工作区内 → 拒绝装配（仓库不能自我授权）', async () => {
  const root = await makeWorkspace();
  const clock = makeClock();

  await assert.rejects(
    async () =>
      composePersonalAgent({
        host: createMockHost(),
        workspaceRoot: root,
        homeDir: join(root, 'home'),
        clock,
        connectors: defaultConnectorsFor(root, clock)
      }),
    (err) => {
      assert.ok(err instanceof ConfigError);
      assert.match(err.message, /must not live inside the workspace/);
      return true;
    }
  );

  // 不传 homeDir 时也不能回退进工作区：默认是 OS home。
  await assert.rejects(
    async () =>
      composePersonalAgent({
        host: createMockHost(),
        workspaceRoot: join(process.env.HOME ?? process.env.USERPROFILE ?? root),
        clock,
        connectors: defaultConnectorsFor(root, clock)
      }),
    (err) => err instanceof ConfigError && /must not live inside the workspace/.test(err.message)
  );
});

test('TC-C42 [P1-7 回归] D2 动作的原文不得出现在任何状态文件里', async () => {
  const secret = 'PATIENT-ZERO-CONFIDENTIAL-9f3a';
  const clock = makeClock();
  const mail = createMailConnector({
    clock,
    messages: [{ id: 'm9', from: 'clinic@example.com', subject: '检查结果', body: secret, unread: true }]
  });
  const { root, api } = await makeAgent({
    clock,
    connectors: [createCalendarConnector({ clock }), mail]
  });

  // mail.list 读的是 D2，需要一条显式授权；否则链路在 consent 就停了，
  // 测试会变成"什么都没发生所以没泄漏"的假绿。
  await api.services.consent.grant({
    connector: 'gmail',
    actions: ['mail.list'],
    data_classes: ['D2'],
    connectorDigest: mail.digest
  });

  const result = await api.turn('查看未读邮件', { mode: 'workspace-write' });
  assert.equal(result.status, 'done', `预期读邮件成功，实际 ${result.status} / ${result.decision?.reason ?? ''}`);

  // 证明这条路径真的读到了 D2：journal 里留下的是摘要（条数），不是正文。
  const run = await api.services.journal.load(result.runId);
  const toolResults = run.steps.flatMap((step) => step.results ?? []);
  assert.ok(toolResults.length > 0, 'journal 应记录工具结果摘要（证明 mail.list 真的执行过）');
  assert.equal(toolResults.some((entry) => String(entry.summary).includes(secret)), false, '摘要里不得出现 D2 正文');

  const leaked = await findStringInTree(join(root, '.pi'), secret);
  assert.deepEqual(leaked, [], `D2 原文不得落盘，命中文件: ${leaked.join(', ')}`);
});

/** 递归查找包含某字符串的文件（用于隐私回归断言）。 */
async function findStringInTree(dir, needle) {
  /** @type {string[]} */
  const hits = [];
  async function walk(current) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else {
        try {
          const content = await readFile(full, 'utf8');
          if (content.includes(needle)) hits.push(full);
        } catch {
          // 二进制/不可读文件跳过
        }
      }
    }
  }
  await walk(dir);
  return hits;
}

test('TC-C43 端到端：read-only 下「你好」→ done / artifacts[0].kind==="text"，并落记忆与索引', async () => {
  const { api } = await makeAgent();

  const result = await api.turn('你好');

  assert.equal(result.status, 'done');
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifacts[0].kind, 'text');
  // 回答必须是一句话，而不是把用户输入原样回显（旧实现的缺陷）。
  const answer = result.artifacts[0].text;
  assert.ok(answer.length > 6, `回答过短: ${answer}`);
  assert.notEqual(answer.trim(), '你好', '不得原样回显用户输入');
  assert.doesNotMatch(answer, /^对话回答（不触碰外部系统）：/, '不得使用旧的模板回显');
  assert.equal(result.artifacts[0].source, 'local', '无 API key 时应走本地回答');
  assert.equal(result.decisions.length, 1);
  assert.equal(result.decisions[0].verdict, 'allow');
  assert.equal(result.decisions[0].reason, 'within_mode');

  // done 之后的副作用：episodic 记忆 + personal lane 索引（compose.turn 尾部）
  const memoryStat = await api.services.memory.stat();
  assert.equal(memoryStat.episodes, 1);
  assert.equal((await api.services.lane.stat()).records, 1);

  // 索引的是"回答"，不是"提问"：用回答里的词检索才应该命中。
  const recall = await api.services.lane.retrieve(answer.slice(0, 12));
  assert.ok(recall.snippets.length >= 1, '回答应已进入 personal lane');
  assert.equal(typeof recall.snippets[0].citations[0].ref, 'string');
});
