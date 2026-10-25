/**
 * Consent Kernel（services/consent.mjs）不变量测试。
 *
 * 覆盖：R4 永不放行、D3 一律 deny、read-only 阻断写、tainted egress、
 * D2 需要显式 grant、mode 是上限（grant 不能放宽 mode）、digest/TTL/revoke
 * 失效、mode_ceiling → confirm、grant 参数校验。
 *
 * 零依赖：node:test + node:assert/strict。静态编写，未经运行验证。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createConsent } from '../../src/services/consent.mjs';
import { createClock } from '../../src/core/clock.mjs';
import { normaliseProfile } from '../../src/services/profile.mjs';

const dir = await mkdtemp(join(tmpdir(), 'pa-core-consent-'));
after(() => rm(dir, { recursive: true, force: true }));

const START = '2026-10-23T09:00:00+08:00';

let caseNo = 0;
function nextGrantsPath() {
  caseNo += 1;
  return join(dir, `grants-${String(caseNo).padStart(2, '0')}.json`);
}

/** 默认 workspace-write、connectors.allow 为空的 profile。 */
function makeProfile(patch = {}) {
  return normaliseProfile({
    version: 1,
    autonomy: { default_mode: 'workspace-write' },
    connectors: { allow: [] },
    ...patch
  });
}

function makeConsent(profilePatch = {}) {
  const clock = createClock({ start: START });
  const profile = makeProfile(profilePatch);
  const grantsPath = nextGrantsPath();
  const consent = createConsent({ profile, grantsPath, clock });
  return { clock, profile, consent, grantsPath };
}

/** 语义动作：默认 R1 日历写入、D1、无出网、来源用户。 */
function action(overrides = {}) {
  return {
    id: 'a_test',
    kind: 'calendar.update_event',
    toolIds: ['calendar.update_event'],
    risk: 'R1',
    dataIn: ['D1'],
    egress: false,
    reversible: true,
    summary: '测试动作',
    origin: 'user',
    ...overrides
  };
}

function grantInput(overrides = {}) {
  return {
    connector: 'calendar',
    actions: ['calendar.update_event'],
    data_classes: ['D2'],
    connectorDigest: 'sha256:calendar-v1',
    ttlHours: 2,
    ...overrides
  };
}

/**
 * Grants are pinned to the connector digest, and a missing digest map is a
 * mismatch by design (fail closed). Every test that expects a grant to be
 * *honoured* must therefore present the current digests, exactly as the loop
 * adapter does at runtime.
 */
const DIGESTS = { calendar: 'sha256:calendar-v1' };

/** @param {Object} consent @param {Object} act @param {Object} [ctx] */
function check(consent, act, ctx = {}) {
  return consent.check(act, { connectorDigests: DIGESTS, ...ctx });
}

// ── 构造与加载 ──────────────────────────────────────────────────────────

test('TC-B01 createConsent 缺少 profile 或 grantsPath 时抛 ConfigError', () => {
  const clock = createClock({ start: START });
  assert.throws(
    () => createConsent({ grantsPath: nextGrantsPath(), clock }),
    (err) => err.code === 'CONFIG_INVALID'
  );
  assert.throws(() => createConsent({ profile: makeProfile(), clock }), (err) => err.code === 'CONFIG_INVALID');
});

test('TC-B02 load 不存在的 grants 文件时返回 0/0 且列表为空', async () => {
  const { consent } = makeConsent();
  const result = await consent.load();
  assert.deepEqual(result, { loaded: 0, dropped: 0 });
  assert.deepEqual(consent.list(), []);
  assert.deepEqual(consent.dropped(), []);
});

test('TC-B03 load 对非法 grants 文件形状与残缺 grant 条目抛 ConfigError', async () => {
  const wrongShape = makeConsent();
  await writeFile(wrongShape.grantsPath, '{"version":1,"grants":"nope"}', 'utf8');
  await assert.rejects(wrongShape.consent.load(), (err) => err.code === 'CONFIG_INVALID');

  const brokenEntry = makeConsent();
  await writeFile(
    brokenEntry.grantsPath,
    JSON.stringify({ version: 1, grants: [{ grant_id: 'g_x', actions: [], data_classes: [] }] }),
    'utf8'
  );
  await assert.rejects(brokenEntry.consent.load(), (err) => err.code === 'CONFIG_INVALID');
});

test('TC-B26 load 混合清理：过期与已撤销的 grant 被丢弃，其余保留', async () => {
  const clock = createClock({ start: START });
  const base = {
    connector: 'calendar',
    actions: ['calendar.update_event'],
    data_classes: ['D2'],
    constraints: {},
    issued_at: clock.iso(),
    expires_at: '2027-01-01T00:00:00+08:00',
    issued_by: 'user',
    connector_digest: 'sha256:x',
    revoked_at: null
  };
  const grantsPath = nextGrantsPath();
  await writeFile(
    grantsPath,
    JSON.stringify({
      version: 1,
      grants: [
        { ...base, grant_id: 'g_ok' },
        { ...base, grant_id: 'g_expired', expires_at: '2026-01-01T00:00:00+08:00' },
        { ...base, grant_id: 'g_revoked', revoked_at: '2026-02-01T00:00:00+08:00' }
      ]
    }),
    'utf8'
  );
  const consent = createConsent({ profile: makeProfile(), grantsPath, clock });
  assert.deepEqual(await consent.load(), { loaded: 1, dropped: 2 });
  assert.deepEqual(consent.list().map((grant) => grant.grant_id), ['g_ok']);
  assert.deepEqual(consent.dropped().sort(), ['g_expired', 'g_revoked']);
});

// ── 硬停止：R4 / D3 / read-only ────────────────────────────────────────

test('TC-B04 R4 动作即使 full-access 且有覆盖 grant 也一律 deny(risk_forbidden)', async () => {
  const { consent } = makeConsent({ autonomy: { default_mode: 'full-access' } });
  await consent.load();
  const grant = await consent.grant(grantInput({ actions: ['danger.delete_all'] }));
  assert.ok(grant.grant_id.startsWith('g_'));

  const decision = consent.check(action({ kind: 'danger.delete_all', risk: 'R4', dataIn: ['D2'] }));
  assert.equal(decision.verdict, 'deny');
  assert.equal(decision.reason, 'risk_forbidden');
  assert.equal(decision.risk, 'R4');
});

test('TC-B05 任何含 D3 的动作一律 deny(data_class_blocked)', () => {
  const { consent } = makeConsent({ autonomy: { default_mode: 'full-access' } });
  const decision = consent.check(action({ dataIn: ['D1', 'D3'] }));
  assert.equal(decision.verdict, 'deny');
  assert.equal(decision.reason, 'data_class_blocked');
});

test('TC-B06 read-only 档位下 R1/R2 动作 deny(mode_blocks_write)，R0 仍 allow', () => {
  const { consent } = makeConsent();

  const write = consent.check(action({ risk: 'R1' }), { mode: 'read-only' });
  assert.equal(write.verdict, 'deny');
  assert.equal(write.reason, 'mode_blocks_write');

  const risky = consent.check(action({ risk: 'R2' }), { mode: 'read-only' });
  assert.equal(risky.verdict, 'deny');
  assert.equal(risky.reason, 'mode_blocks_write');

  const read = consent.check(action({ risk: 'R0' }), { mode: 'read-only' });
  assert.equal(read.verdict, 'allow');
  assert.equal(read.reason, 'within_mode');
});

test('TC-B07 grant 不能放宽 mode：read-only + 覆盖 D2 的 grant 仍是 deny(mode_blocks_write)', async () => {
  const { consent } = makeConsent();
  await consent.load();
  await consent.grant(grantInput());
  const decision = consent.check(action({ dataIn: ['D2'] }), { mode: 'read-only' });
  assert.equal(decision.verdict, 'deny');
  assert.equal(decision.reason, 'mode_blocks_write');
});

// ── Taint / D2 数据闸 ──────────────────────────────────────────────────

test('TC-B08 不可信来源 + egress 一律 deny(tainted_egress)，origin 与 untrusted 标记等效', () => {
  const { consent } = makeConsent({ autonomy: { default_mode: 'full-access' } });

  const byOrigin = consent.check(action({ risk: 'R2', egress: true, origin: 'untrusted_content' }));
  assert.equal(byOrigin.verdict, 'deny');
  assert.equal(byOrigin.reason, 'tainted_egress');

  const byFlag = consent.check(action({ risk: 'R2', egress: true, origin: 'user', untrusted: true }));
  assert.equal(byFlag.verdict, 'deny');
  assert.equal(byFlag.reason, 'tainted_egress');
});

test('TC-B09 D2 数据无覆盖 grant 时 deny(data_class_blocked)（full-access 也不例外）', () => {
  const { consent } = makeConsent({ autonomy: { default_mode: 'full-access' } });
  const decision = consent.check(action({ dataIn: ['D1', 'D2'] }));
  assert.equal(decision.verdict, 'deny');
  assert.equal(decision.reason, 'data_class_blocked');
});

test('TC-B10 覆盖动作与 D2 的 grant 使 R1 动作 allow(grant) 并带上 grantId', async () => {
  const { consent } = makeConsent();
  await consent.load();
  const grant = await consent.grant(grantInput());

  const decision = check(consent, action({ dataIn: ['D2'] }));
  assert.deepEqual(
    {
      verdict: decision.verdict,
      reason: decision.reason,
      risk: decision.risk,
      requires: decision.requires,
      grantId: decision.grantId
    },
    { verdict: 'allow', reason: 'grant', risk: 'R1', requires: 'none', grantId: grant.grant_id }
  );
});

test('TC-B11 connector digest 变化或缺省时 grant 立即失效（deny data_class_blocked）', async () => {
  const { consent } = makeConsent();
  await consent.load();
  const grant = await consent.grant(grantInput());
  const d2Action = action({ dataIn: ['D2'] });

  assert.equal(consent.check(d2Action, { connectorDigests: { calendar: grant.connector_digest } }).verdict, 'allow');

  const changed = consent.check(d2Action, { connectorDigests: { calendar: 'sha256:changed' } });
  assert.equal(changed.verdict, 'deny');
  assert.equal(changed.reason, 'data_class_blocked');

  const missing = consent.check(d2Action, { connectorDigests: { other: grant.connector_digest } });
  assert.equal(missing.verdict, 'deny');
  assert.equal(missing.reason, 'data_class_blocked');
});

// ── grant 生命周期：过期 / 撤销 ────────────────────────────────────────

test('TC-B12 grant 过期后 reload 被清理且不再生效', async () => {
  const { clock, consent } = makeConsent();
  await consent.load();
  const grant = await consent.grant(grantInput({ ttlHours: 2 }));
  const d2Action = action({ dataIn: ['D2'] });
  assert.equal(check(consent, d2Action).verdict, 'allow');

  clock.advance(2 * 3600 * 1000); // 恰好到 expires_at
  assert.deepEqual(await consent.load(), { loaded: 0, dropped: 1 });
  assert.deepEqual(consent.dropped(), [grant.grant_id]);
  assert.deepEqual(consent.list(), []);

  const decision = check(consent, d2Action);
  assert.equal(decision.verdict, 'deny');
  assert.equal(decision.reason, 'data_class_blocked');
});

test('TC-B13 grant revoke 后立即失效，重复 revoke 返回 false', async () => {
  const { consent } = makeConsent();
  await consent.load();
  const grant = await consent.grant(grantInput());
  const d2Action = action({ dataIn: ['D2'] });
  assert.equal(check(consent, d2Action).verdict, 'allow');

  assert.equal(await consent.revoke(grant.grant_id), true);
  const decision = check(consent, d2Action);
  assert.equal(decision.verdict, 'deny');
  assert.equal(decision.reason, 'data_class_blocked');

  assert.equal(await consent.revoke(grant.grant_id), false);
  assert.deepEqual(consent.dropped(), [grant.grant_id]);
});

// ── mode ceiling / egress ──────────────────────────────────────────────

test('TC-B14 R2 高于 workspace-write 上限时 confirm(mode_ceiling) 而非 deny', () => {
  const { consent } = makeConsent();
  const decision = consent.check(action({ risk: 'R2', egress: false }));
  assert.equal(decision.verdict, 'confirm');
  assert.equal(decision.reason, 'mode_ceiling');
  assert.equal(decision.requires, 'user');
  assert.equal(decision.risk, 'R2');
});

test('TC-B15 R3 在 full-access 下仍 confirm 且 requires identity', () => {
  const { consent } = makeConsent({ autonomy: { default_mode: 'full-access' } });
  const decision = consent.check(action({ risk: 'R3' }));
  assert.equal(decision.verdict, 'confirm');
  assert.equal(decision.reason, 'mode_ceiling');
  assert.equal(decision.requires, 'identity');
  assert.equal(decision.risk, 'R3');
});

test('TC-B16 profile.privacy.egress=never 时出网动作 deny(egress_forbidden)', () => {
  const { consent } = makeConsent({
    autonomy: { default_mode: 'full-access' },
    privacy: { egress: 'never' }
  });
  const decision = consent.check(action({ risk: 'R2', egress: true }));
  assert.equal(decision.verdict, 'deny');
  assert.equal(decision.reason, 'egress_forbidden');
});

test('TC-B17 egress=confirm 时 R2 出网动作 confirm(egress_confirm)', () => {
  const { consent } = makeConsent({ autonomy: { default_mode: 'full-access' } });
  const decision = consent.check(action({ risk: 'R2', egress: true }));
  assert.equal(decision.verdict, 'confirm');
  assert.equal(decision.reason, 'egress_confirm');
  assert.equal(decision.requires, 'user');
});

test('TC-B18 有覆盖 grant 的 R2 动作仍需 confirm(external_side_effect)', async () => {
  const { consent } = makeConsent({ autonomy: { default_mode: 'full-access' } });
  await consent.load();
  await consent.grant(grantInput());

  const decision = check(consent, action({ risk: 'R2', dataIn: ['D2'], egress: false }));
  assert.equal(decision.verdict, 'confirm');
  assert.equal(decision.reason, 'external_side_effect');
  assert.equal(decision.requires, 'user');
});

// ── grant() 参数校验 ────────────────────────────────────────────────────

test('TC-B19 grant() 拒绝缺字段与未在 allow 列表内的连接器', async () => {
  const { consent } = makeConsent();
  await assert.rejects(consent.grant({}), (err) => err.code === 'CONFIG_INVALID');
  await assert.rejects(consent.grant(grantInput({ actions: [] })), (err) => err.code === 'CONFIG_INVALID');
  await assert.rejects(consent.grant(grantInput({ connectorDigest: '' })), (err) => err.code === 'CONFIG_INVALID');

  const restricted = makeConsent({ connectors: { allow: ['calendar'] } });
  await assert.rejects(
    restricted.consent.grant(grantInput({ connector: 'gmail' })),
    (err) => err.code === 'CONFIG_INVALID'
  );
  const accepted = await restricted.consent.grant(grantInput({ connector: 'calendar' }));
  assert.equal(accepted.connector, 'calendar');
});

test('TC-B20 grant 请求高于 profile.default_data_ceiling 的数据级别时 ConfigError', async () => {
  const { consent } = makeConsent();
  await assert.rejects(consent.grant(grantInput({ data_classes: ['D3'] })), (err) => err.code === 'CONFIG_INVALID');

  const lowCeiling = makeConsent({ connectors: { allow: [], default_data_ceiling: 'D1' } });
  await assert.rejects(
    lowCeiling.consent.grant(grantInput({ data_classes: ['D2'] })),
    (err) => err.code === 'CONFIG_INVALID'
  );
});

test('TC-B21 grant 的 TTL 被 standing_grant_max_ttl_h（默认 168h）夹紧', async () => {
  const { consent } = makeConsent();

  const long = await consent.grant(grantInput({ ttlHours: 999 }));
  assert.equal((Date.parse(long.expires_at) - Date.parse(long.issued_at)) / 3600_000, 168);

  const short = await consent.grant(grantInput({ ttlHours: 2 }));
  assert.equal((Date.parse(short.expires_at) - Date.parse(short.issued_at)) / 3600_000, 2);
});

// ── 输入校验 / 对外形状 ────────────────────────────────────────────────

test('TC-B22 check 对非法 risk/dataIn 抛 ValidationError', () => {
  const { consent } = makeConsent();
  assert.throws(() => consent.check(action({ risk: 'R9' })), (err) => err.code === 'VALIDATION_FAILED');
  assert.throws(() => consent.check(action({ dataIn: ['D9'] })), (err) => err.code === 'VALIDATION_FAILED');
});

test('TC-B23 ceilingFor 暴露三档上限并对未知档位回落 read-only', () => {
  const { consent } = makeConsent();
  assert.equal(consent.ceilingFor('read-only'), 'R0');
  assert.equal(consent.ceilingFor('workspace-write'), 'R1');
  assert.equal(consent.ceilingFor('full-access'), 'R2');
  assert.equal(consent.ceilingFor('bogus'), 'R0');
});

test('TC-B24 Decision 结构稳定（verdict/risk/reason/detail/requires/grantId）', async () => {
  const { consent } = makeConsent();
  const denied = consent.check(action({ risk: 'R1' }), { mode: 'read-only' });
  assert.deepEqual(Object.keys(denied), ['verdict', 'risk', 'reason', 'detail', 'requires', 'grantId']);
  assert.equal(typeof denied.detail, 'string');
  assert.equal(denied.requires, 'none');
  assert.equal(denied.grantId, undefined);

  // 首次写入没有 grant：docs/04 §5.2 要求先确认一次，而不是直接放行。
  const first = consent.check(action({ risk: 'R1' }));
  assert.equal(first.verdict, 'confirm');
  assert.equal(first.reason, 'first_time_write');
  assert.equal(first.requires, 'user');
  assert.equal(first.grantId, undefined);

  // 签发常驻授权后，同类写入才进入 allow(grant) 并带上 grantId。
  await consent.load();
  const grant = await consent.grant(grantInput({ data_classes: ['D1'] }));
  const allowed = check(consent, action({ risk: 'R1' }));
  assert.equal(allowed.verdict, 'allow');
  assert.equal(allowed.reason, 'grant');
  assert.equal(allowed.requires, 'none');
  assert.equal(allowed.grantId, grant.grant_id);
});

test('TC-B25 未指定 mode 时使用 profile 默认档位（默认 read-only 拒绝写）', () => {
  const clock = createClock({ start: START });
  const consent = createConsent({
    profile: normaliseProfile({ version: 1 }),
    grantsPath: nextGrantsPath(),
    clock
  });
  const decision = consent.check(action({ risk: 'R1' }));
  assert.equal(decision.verdict, 'deny');
  assert.equal(decision.reason, 'mode_blocks_write');
});
