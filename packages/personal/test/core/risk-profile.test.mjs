/**
 * 风险分级（services/risk.mjs）、Tool Registry 的 manifest 校验
 * （integrations/tool-registry.mjs）与 Profile 加载/一致性
 * （services/profile.mjs）测试。
 *
 * 核心不变量：deriveRisk 只能抬升不能降级；manifest 必须过 schema；
 * profile 缺文件/越界组合一律 ConfigError（不允许默认值静默继续）。
 *
 * 零依赖：node:test + node:assert/strict。静态编写，未经运行验证。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  deriveRisk,
  explainRisk,
  atLeast,
  exceeds,
  maxDataClass,
  maxDataClassOf,
  assertRisk,
  assertDataClass
} from '../../src/services/risk.mjs';
import { normaliseProfile, loadProfile, assertProfileCoherent } from '../../src/services/profile.mjs';
import { createToolRegistry } from '../../src/integrations/tool-registry.mjs';
import { createClock } from '../../src/core/clock.mjs';

const dir = await mkdtemp(join(tmpdir(), 'pa-core-risk-profile-'));
after(() => rm(dir, { recursive: true, force: true }));

const START = '2026-10-23T09:00:00+08:00';

const manifestSchema = JSON.parse(
  await readFile(new URL('../../schemas/tool-manifest.v1.json', import.meta.url), 'utf8')
);
const profileSchema = JSON.parse(
  await readFile(new URL('../../schemas/pa-profile.v1.json', import.meta.url), 'utf8')
);

function makeRegistry(connectorSpecs) {
  const clock = createClock({ start: START });
  const registry = createToolRegistry({ manifestSchema, clock });
  for (const spec of connectorSpecs) registry.registerConnector(spec);
  return { registry, clock };
}

function tool(id, manifestOverrides = {}) {
  return {
    manifest: {
      id,
      kind: 'native',
      risk: 'R0',
      reversible: true,
      data_in: ['D1'],
      data_out: 'D1',
      egress: false,
      idempotent: true,
      approval: { default: 'confirm' },
      ...manifestOverrides
    },
    invoke: async () => ({ ok: true })
  };
}

async function writeProfile(name, value) {
  const file = join(dir, name);
  await writeFile(file, JSON.stringify(value), 'utf8');
  return file;
}

// ── deriveRisk：只能抬升，不能降级 ─────────────────────────────────────

test('TC-E01 deriveRisk 不会把 egress 动作降级（声明 R0/R1 一律抬到 R2）', () => {
  assert.equal(deriveRisk({ risk: 'R0', egress: true }), 'R2');
  assert.equal(deriveRisk({ risk: 'R1', egress: true }), 'R2');
  assert.equal(deriveRisk({ risk: 'R2', egress: true }), 'R2');
  assert.equal(deriveRisk({ egress: true }), 'R2');
});

test('TC-E02 deriveRisk 对不可撤销动作抬升到至少 R2', () => {
  assert.equal(deriveRisk({ risk: 'R0', reversible: false }), 'R2');
  assert.equal(deriveRisk({ risk: 'R1', reversible: false }), 'R2');
});

test('TC-E03 deriveRisk 对 D2/D3 数据抬升到至少 R1（含 camelCase dataIn）', () => {
  assert.equal(deriveRisk({ risk: 'R0', data_in: ['D2'] }), 'R1');
  assert.equal(deriveRisk({ risk: 'R0', data_in: ['D1', 'D2'] }), 'R1');
  assert.equal(deriveRisk({ risk: 'R0', dataIn: ['D2'] }), 'R1');
  assert.equal(deriveRisk({ risk: 'R0', data_in: ['D3'] }), 'R1');
});

test('TC-E04 deriveRisk 保留高于事实下限的声明值', () => {
  assert.equal(deriveRisk({ risk: 'R3', data_in: ['D1'] }), 'R3');
  assert.equal(deriveRisk({ risk: 'R4' }), 'R4');
});

test('TC-E05 deriveRisk 对未知 risk/data class 抛 ValidationError', () => {
  assert.throws(() => deriveRisk({ risk: 'R9' }), (err) => err.code === 'VALIDATION_FAILED');
  assert.throws(() => deriveRisk({ data_in: ['D9'] }), (err) => err.code === 'VALIDATION_FAILED');
});

test('TC-E06 atLeast/exceeds/maxDataClass/maxDataClassOf 语义正确', () => {
  assert.equal(atLeast('R1', 'R2'), 'R2');
  assert.equal(atLeast('R3', 'R1'), 'R3');
  assert.equal(exceeds('R2', 'R1'), true);
  assert.equal(exceeds('R1', 'R2'), false);
  assert.equal(exceeds('R1', 'R1'), false);
  assert.equal(maxDataClass('D1', 'D2'), 'D2');
  assert.equal(maxDataClass('D2', 'D2'), 'D2');
  assert.equal(maxDataClassOf(['D0', 'D2', 'D1']), 'D2');
  assert.equal(maxDataClassOf([]), 'D0');
  assert.throws(() => maxDataClassOf(['D9']), (err) => err.code === 'VALIDATION_FAILED');
});

test('TC-E07 explainRisk 把抬升原因写进确认文案', () => {
  assert.equal(explainRisk({}), 'R0：只读本地操作');
  assert.equal(explainRisk({ egress: true }), 'R2：数据会离开本机');
  assert.equal(explainRisk({ reversible: false }), 'R2：动作不可撤销');
  assert.equal(explainRisk({ data_in: ['D2'] }), 'R1：涉及个人高敏数据');
  assert.equal(
    explainRisk({ egress: true, reversible: false, data_in: ['D2'] }),
    'R2：数据会离开本机、动作不可撤销、涉及个人高敏数据'
  );
});

test('TC-E08 assertRisk/assertDataClass 返回原值并拒绝未知类', () => {
  assert.equal(assertRisk('R0'), 'R0');
  assert.equal(assertRisk('R4'), 'R4');
  assert.equal(assertDataClass('D0'), 'D0');
  assert.equal(assertDataClass('D3'), 'D3');
  assert.throws(() => assertRisk('R5'), (err) => err.code === 'VALIDATION_FAILED');
  assert.throws(() => assertDataClass('D4'), (err) => err.code === 'VALIDATION_FAILED');
});

// ── Tool Registry：manifest 必须过 schema，风险只能抬升 ─────────────────

test('TC-E09 registry 校验合法 manifest 并补齐规范字段', () => {
  const { registry } = makeRegistry([{ id: 'calendar', tools: [tool('calendar.update_event', { data_in: ['D1'] })] }]);

  const manifest = registry.get('calendar.update_event');
  assert.ok(manifest);
  assert.equal(manifest.connector, 'calendar');
  assert.equal(manifest.kind, 'native');
  assert.equal(manifest.risk, 'R0');
  assert.equal(manifest.reversible, true);
  assert.equal(manifest.egress, false);
  assert.deepEqual(manifest.data_in, ['D1']);
  assert.equal(manifest.data_out, 'D1');
  assert.deepEqual(manifest.approval, { default: 'confirm' });
  assert.equal(manifest.summary, 'calendar.update_event');

  assert.match(registry.digests().calendar, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(registry.stat(), { connectors: 1, tools: 1, at: START });
});

test('TC-E10 registry 通过 deriveRisk 拒绝降级声明：egress 的 R0 manifest 实为 R2', () => {
  const { registry } = makeRegistry([
    {
      id: 'mail',
      tools: [tool('mail.send', { risk: 'R0', egress: true, reversible: false, data_in: ['D1'] })]
    }
  ]);
  assert.equal(registry.get('mail.send').risk, 'R2');
});

test('TC-E11 registry 拒绝非法 manifest（id 格式 / approval enum / 空 data_in）', () => {
  const { registry } = makeRegistry([]);
  registry.registerConnector({ id: 'src', tools: [tool('src.placeholder')] });

  assert.throws(() => registry.registerTool('src', tool('Bad Id')), (err) => err.code === 'VALIDATION_FAILED');
  assert.throws(
    () => registry.registerTool('src', tool('src.act', { approval: { default: 'maybe' } })),
    (err) => err.code === 'VALIDATION_FAILED'
  );
  assert.throws(
    () => registry.registerTool('src', tool('src.act2', { data_in: [] })),
    (err) => err.code === 'VALIDATION_FAILED'
  );
  assert.equal(registry.get('Bad Id'), null);
});

test('TC-E12 registry 拒绝重复 tool id 与非 sha256 connector digest', () => {
  const { registry } = makeRegistry([{ id: 'calendar', tools: [tool('calendar.read')] }]);
  registry.registerConnector({ id: 'other', tools: [tool('other.placeholder')] });

  assert.throws(() => registry.registerTool('other', tool('calendar.read')), (err) => err.code === 'CONFIG_INVALID');
  assert.throws(
    () => registry.registerConnector({ id: 'broken', digest: 'md5:abc', tools: [tool('broken.read')] }),
    (err) => err.code === 'CONFIG_INVALID'
  );
});

test('TC-E13 registry.list(maxRisk) 按风险过滤，digests 覆盖所有连接器', () => {
  const { registry } = makeRegistry([
    { id: 'calendar', tools: [tool('calendar.read')] },
    { id: 'mail', tools: [tool('mail.send', { egress: true })] }
  ]);

  assert.deepEqual(registry.list().map((manifest) => manifest.id).sort(), ['calendar.read', 'mail.send']);
  assert.deepEqual(registry.list({ maxRisk: 'R1' }).map((manifest) => manifest.id), ['calendar.read']);

  const digests = registry.digests();
  assert.deepEqual(Object.keys(digests).sort(), ['calendar', 'mail']);
  assert.match(digests.mail, /^sha256:[0-9a-f]{64}$/);
});

test('TC-E14 registry.invoke 返回 toolDigest；R4 工具与未注册工具不可调用', async () => {
  const { registry } = makeRegistry([
    { id: 'calendar', tools: [tool('calendar.read')] },
    { id: 'danger', tools: [tool('danger.delete_all', { risk: 'R4' })] }
  ]);

  const result = await registry.invoke('calendar.read', {}, {});
  assert.deepEqual(
    { ok: result.ok, toolId: result.toolId, connector: result.connector },
    { ok: true, toolId: 'calendar.read', connector: 'calendar' }
  );
  assert.match(result.toolDigest, /^sha256:[0-9a-f]{64}$/);

  await assert.rejects(registry.invoke('danger.delete_all', {}, {}), (err) => err.code === 'CONFIG_INVALID');
  await assert.rejects(registry.invoke('missing.tool', {}, {}), (err) => err.code === 'CONFIG_INVALID');
});

// ── Profile：保守默认值 / 深合并 / 一致性校验 ──────────────────────────

test('TC-E15 normaliseProfile 用保守默认值补齐（read-only / egress confirm / 预算默认）', () => {
  const profile = normaliseProfile({ version: 1 });
  assert.equal(profile.version, 1);
  assert.equal(profile.autonomy.default_mode, 'read-only');
  assert.equal(profile.autonomy.proactive.enabled, false);
  assert.equal(profile.privacy.egress, 'confirm');
  assert.equal(profile.privacy.telemetry, 'local');
  assert.equal(profile.budget.per_turn_usd, 0.05);
  assert.equal(profile.budget.per_day_usd, 2);
  assert.equal(profile.budget.on_exceed, 'degrade');
  assert.deepEqual(profile.tools.confirm_risk, ['R2', 'R3']);
  assert.deepEqual(profile.tools.deny_risk, ['R4']);
  assert.equal(profile.memory.allow_d2, false);
  assert.equal(profile.connectors.default_data_ceiling, 'D2');
});

test('TC-E16 normaliseProfile 深合并且不修改入参', () => {
  const input = { version: 1, budget: { per_turn_usd: 0.1 }, persona: { name: '测试助手' } };
  const profile = normaliseProfile(input);

  assert.equal(profile.budget.per_turn_usd, 0.1);
  assert.equal(profile.budget.per_day_usd, 2);
  assert.equal(profile.persona.name, '测试助手');
  assert.equal(profile.persona.language, 'zh-CN');

  assert.ok(!('per_day_usd' in input.budget));
  assert.deepEqual(input, { version: 1, budget: { per_turn_usd: 0.1 }, persona: { name: '测试助手' } });
});

test('TC-E17 loadProfile 缺文件时抛 ConfigError（不允许默认值继续运行）', async () => {
  await assert.rejects(
    loadProfile(join(dir, 'missing-profile.json'), profileSchema),
    (err) => err.code === 'CONFIG_INVALID'
  );
});

test('TC-E18 loadProfile 返回 profile+raw；未知属性与错误 version 抛 ValidationError', async () => {
  const file = await writeProfile('ok-profile.json', {
    version: 1,
    persona: { name: '测试助手', language: 'zh-CN' },
    autonomy: { default_mode: 'workspace-write' }
  });
  const { profile, raw } = await loadProfile(file, profileSchema);

  assert.equal(profile.autonomy.default_mode, 'workspace-write');
  assert.equal(profile.budget.per_day_usd, 2);
  assert.deepEqual(raw, {
    version: 1,
    persona: { name: '测试助手', language: 'zh-CN' },
    autonomy: { default_mode: 'workspace-write' }
  });

  const unknownKey = await writeProfile('bad-profile.json', { version: 1, unknown_key: true });
  await assert.rejects(loadProfile(unknownKey, profileSchema), (err) => err.code === 'VALIDATION_FAILED');

  const badVersion = await writeProfile('bad-version.json', { version: 2 });
  await assert.rejects(loadProfile(badVersion, profileSchema), (err) => err.code === 'VALIDATION_FAILED');
});

test('TC-E19 memory.allow_d2 与 privacy.telemetry=company 组合时 loadProfile 抛 ConfigError', async () => {
  const file = await writeProfile('company-telemetry.json', {
    version: 1,
    memory: { allow_d2: true },
    privacy: { telemetry: 'company' }
  });
  await assert.rejects(loadProfile(file, profileSchema), (err) => err.code === 'CONFIG_INVALID');
});

test('TC-E20 interrupt_per_day>5 违反主动性策略：coherence 抛 ConfigError，schema 层先以 ValidationError 拒绝', async () => {
  const overLimit = normaliseProfile({
    version: 1,
    autonomy: { proactive: { enabled: true, interrupt_per_day: 9 } }
  });
  assert.throws(
    () => assertProfileCoherent(overLimit, 'test-profile'),
    (err) => err.code === 'CONFIG_INVALID'
  );

  const file = await writeProfile('too-interruptive.json', {
    version: 1,
    autonomy: { proactive: { enabled: true, interrupt_per_day: 9 } }
  });
  await assert.rejects(loadProfile(file, profileSchema), (err) => err.code === 'VALIDATION_FAILED');
});

test('TC-E21 read-only 档位下 confirm_risk 为空抛 ConfigError', () => {
  const profile = normaliseProfile({ version: 1, tools: { confirm_risk: [] } });
  assert.throws(() => assertProfileCoherent(profile), (err) => err.code === 'CONFIG_INVALID');
});

test('TC-E22 normaliseProfile 拒绝非对象输入', () => {
  assert.throws(() => normaliseProfile(null), (err) => err.code === 'CONFIG_INVALID');
  assert.throws(() => normaliseProfile('nope'), (err) => err.code === 'CONFIG_INVALID');
});
