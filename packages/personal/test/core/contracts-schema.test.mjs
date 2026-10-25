/**
 * 契约常量、错误类型、canonical JSON 与 core/schema.mjs 校验器测试。
 *
 * 零依赖：只用 node:test + node:assert/strict。
 * 静态编写：本机无 shell / node 不可执行，本文件未经运行验证。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  RISK,
  RISK_ORDER,
  RISK_RANK,
  DATA_CLASS,
  DATA_ORDER,
  DATA_RANK,
  VERDICT,
  PERMISSION_MODE,
  MODE_RISK_CEILING,
  CHANNEL,
  URGENCY,
  URGENCY_RANK,
  RUN_STATUS,
  MEMORY_SOURCE,
  MEMORY_LAYER,
  REGISTRATION_ORDER
} from '../../src/core/contracts.mjs';
import contracts from '../../src/core/contracts.mjs';
import { validate, check } from '../../src/core/schema.mjs';
import { canonicalJson, sha256Hex, digestOf, chainHash } from '../../src/core/canonical.mjs';
import {
  PaError,
  ConfigError,
  ValidationError,
  PolicyError,
  BudgetError,
  ResumeError,
  ConnectorError,
  toPaError,
  isPolicyDenial
} from '../../src/core/errors.mjs';

// 本文件不落盘，仅保留统一的 tmpdir 生命周期辅助，便于后续追加 I/O 用例。
const dir = await mkdtemp(join(tmpdir(), 'pa-core-contracts-'));
after(() => rm(dir, { recursive: true, force: true }));

// ── 契约常量 ────────────────────────────────────────────────────────────

test('TC-A01 风险常量与排序表冻结，且 RISK_RANK 与 RISK_ORDER 顺序一致', () => {
  assert.deepEqual(RISK_ORDER, ['R0', 'R1', 'R2', 'R3', 'R4']);
  assert.equal(Object.isFrozen(RISK), true);
  assert.equal(Object.isFrozen(RISK_ORDER), true);
  assert.equal(Object.isFrozen(RISK_RANK), true);
  for (const [index, level] of RISK_ORDER.entries()) {
    assert.equal(RISK_RANK[level], index);
    assert.equal(RISK[level], level);
  }
});

test('TC-A02 三档权限模式的风险上限固定为 R0/R1/R2', () => {
  assert.deepEqual(PERMISSION_MODE, {
    READ_ONLY: 'read-only',
    WORKSPACE_WRITE: 'workspace-write',
    FULL_ACCESS: 'full-access'
  });
  assert.deepEqual(MODE_RISK_CEILING, {
    'read-only': 'R0',
    'workspace-write': 'R1',
    'full-access': 'R2'
  });
  assert.equal(Object.isFrozen(MODE_RISK_CEILING), true);
});

test('TC-A03 数据分级/通道/紧急度/运行状态/记忆枚举取值固定', () => {
  assert.deepEqual(DATA_CLASS, { D0: 'D0', D1: 'D1', D2: 'D2', D3: 'D3' });
  assert.deepEqual(DATA_ORDER, ['D0', 'D1', 'D2', 'D3']);
  assert.deepEqual(DATA_RANK, { D0: 0, D1: 1, D2: 2, D3: 3 });
  assert.deepEqual(VERDICT, { ALLOW: 'allow', CONFIRM: 'confirm', DENY: 'deny' });
  assert.deepEqual(CHANNEL, {
    CLI: 'cli',
    DASHBOARD: 'dashboard',
    IM: 'im',
    TRIGGER: 'trigger',
    SYSTEM: 'system'
  });
  assert.deepEqual(URGENCY, {
    SILENT: 'silent',
    LOG: 'log',
    DIGEST: 'digest',
    INTERRUPT: 'interrupt'
  });
  assert.deepEqual(URGENCY_RANK, { silent: 0, log: 1, digest: 2, interrupt: 3 });
  assert.deepEqual(MEMORY_SOURCE, {
    USER_EXPLICIT: 'user_explicit',
    OBSERVED: 'observed',
    INFERRED: 'inferred'
  });
  assert.deepEqual(MEMORY_LAYER, {
    EPISODIC: 'episodic',
    SEMANTIC: 'semantic',
    PROCEDURAL: 'procedural'
  });
  assert.deepEqual(Object.keys(RUN_STATUS).sort(), [
    'ABORTED',
    'AWAITING_APPROVAL',
    'BLOCKED',
    'DENIED',
    'DONE',
    'FAILED',
    'RUNNING'
  ]);
});

test('TC-A04 注册顺序是契约的一部分，默认导出与具名导出同源', () => {
  assert.deepEqual(REGISTRATION_ORDER, [
    'profile.load',
    'consent.load',
    'guard.register',
    'connectors.init',
    'tools.register',
    'context.registerLane',
    'scheduler.start',
    'channels.start'
  ]);
  assert.equal(Object.isFrozen(REGISTRATION_ORDER), true);
  assert.equal(contracts.RISK, RISK);
  assert.equal(contracts.MODE_RISK_CEILING, MODE_RISK_CEILING);
  assert.equal(contracts.REGISTRATION_ORDER, REGISTRATION_ORDER);
});

// ── 错误类型 ────────────────────────────────────────────────────────────

test('TC-A05 PaError 携带稳定 code、details，且默认 fail-closed', () => {
  const error = new PaError('SOME_CODE', 'boom', { details: { a: 1 } });
  assert.equal(error instanceof Error, true);
  assert.equal(error.name, 'PaError');
  assert.equal(error.code, 'SOME_CODE');
  assert.equal(error.message, 'boom');
  assert.deepEqual(error.details, { a: 1 });
  assert.equal(error.failClosed, true);
  assert.deepEqual(new PaError('X', 'y').details, {});
});

test('TC-A06 子类错误码映射稳定，ValidationError 携带 path', () => {
  assert.equal(new ConfigError('c').code, 'CONFIG_INVALID');
  assert.equal(new ConfigError('c').name, 'ConfigError');

  const validation = new ValidationError('v', { path: '$.a' });
  assert.equal(validation.code, 'VALIDATION_FAILED');
  assert.equal(validation.name, 'ValidationError');
  assert.equal(validation.path, '$.a');
  assert.equal(new ValidationError('v').path, '');

  assert.equal(new PolicyError('POLICY_DENIED', 'p').code, 'POLICY_DENIED');
  assert.deepEqual(new PolicyError('CONSENT_REQUIRED', 'p', { k: 1 }).details, { k: 1 });

  const budget = new BudgetError('b', { reasons: ['per_turn_usd'] });
  assert.equal(budget.code, 'BUDGET_EXCEEDED');
  assert.deepEqual(budget.details, { reasons: ['per_turn_usd'] });

  assert.equal(new ResumeError('r').code, 'RESUME_FAILED');
  assert.equal(new ConnectorError('c').code, 'CONNECTOR_UNAVAILABLE');
  for (const error of [new ConfigError('x'), new ValidationError('x'), new BudgetError('x')]) {
    assert.equal(error instanceof PaError, true);
  }
});

test('TC-A07 toPaError 把未知错误包裹成 INTERNAL_ERROR 并保留 cause', () => {
  const original = new Error('disk on fire');
  const wrapped = toPaError(original);
  assert.equal(wrapped.code, 'INTERNAL_ERROR');
  assert.equal(wrapped.cause, original);
  assert.equal(wrapped.failClosed, true);

  const alreadyTyped = new ConfigError('already typed');
  assert.equal(toPaError(alreadyTyped), alreadyTyped);

  const fromString = toPaError('plain string');
  assert.equal(fromString.code, 'INTERNAL_ERROR');
  assert.equal(fromString.message, 'plain string');
});

test('TC-A08 isPolicyDenial 仅识别三种显式策略拒绝码', () => {
  assert.equal(isPolicyDenial(new PolicyError('POLICY_DENIED', 'x')), true);
  assert.equal(isPolicyDenial(new PolicyError('CONSENT_REQUIRED', 'x')), true);
  assert.equal(isPolicyDenial(new PolicyError('DATA_CLASS_BLOCKED', 'x')), true);
  assert.equal(isPolicyDenial(new PolicyError('OTHER', 'x')), false);
  assert.equal(isPolicyDenial(new ConfigError('x')), false);
  assert.equal(isPolicyDenial(new Error('x')), false);
});

// ── canonical JSON / digest ─────────────────────────────────────────────

test('TC-A09 canonicalJson 递归排序键、丢弃 undefined、非有限数归一为 null', () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(
    canonicalJson({ z: { b: 1, a: 2 }, a: [{ y: 1, x: 2 }] }),
    '{"a":[{"x":2,"y":1}],"z":{"a":2,"b":1}}'
  );
  assert.equal(canonicalJson({ a: 1, b: undefined }), '{"a":1}');
  assert.equal(canonicalJson({ n: Number.NaN, i: Number.POSITIVE_INFINITY }), '{"i":null,"n":null}');
  assert.equal(canonicalJson(null), 'null');
});

test('TC-A10 sha256Hex/digestOf 格式稳定且对键顺序不敏感，chainHash 对前驱与内容敏感', () => {
  assert.match(sha256Hex(''), /^sha256:[0-9a-f]{64}$/);
  assert.equal(sha256Hex('same'), sha256Hex('same'));
  assert.notEqual(sha256Hex('a'), sha256Hex('b'));

  assert.equal(digestOf({ b: 2, a: 1 }), digestOf({ a: 1, b: 2 }));
  assert.match(digestOf({ a: 1 }), /^sha256:[0-9a-f]{64}$/);

  assert.equal(chainHash('sha256:prev', { x: 1 }), chainHash('sha256:prev', { x: 1 }));
  assert.notEqual(chainHash('sha256:prev', { x: 1 }), chainHash('sha256:other', { x: 1 }));
  assert.notEqual(chainHash('sha256:prev', { x: 1 }), chainHash('sha256:prev', { x: 2 }));
});

// ── schema：type / enum / const ─────────────────────────────────────────

test('TC-A11 schema type 校验：基础类型、联合类型与非对象值', () => {
  assert.doesNotThrow(() => validate({ type: 'string' }, 'x'));
  assert.throws(() => validate({ type: 'string' }, 1), (err) => err.code === 'VALIDATION_FAILED');

  assert.doesNotThrow(() => validate({ type: 'number' }, 1.5));
  assert.throws(() => validate({ type: 'number' }, '1'), (err) => err.code === 'VALIDATION_FAILED');

  assert.doesNotThrow(() => validate({ type: 'integer' }, 2));
  assert.throws(() => validate({ type: 'integer' }, 2.5), (err) => err.code === 'VALIDATION_FAILED');

  assert.doesNotThrow(() => validate({ type: ['string', 'null'] }, null));
  assert.throws(() => validate({ type: ['string', 'null'] }, 1), (err) => err.code === 'VALIDATION_FAILED');

  assert.doesNotThrow(() => validate({ type: 'object' }, {}));
  assert.throws(() => validate({ type: 'object' }, []), (err) => err.code === 'VALIDATION_FAILED');

  assert.doesNotThrow(() => validate({ type: 'array' }, []));
  assert.throws(() => validate({ type: 'array' }, {}), (err) => err.code === 'VALIDATION_FAILED');

  assert.doesNotThrow(() => validate({ type: 'boolean' }, false));
  assert.throws(() => validate({ type: 'boolean' }, 0), (err) => err.code === 'VALIDATION_FAILED');
});

test('TC-A12 schema enum/const 校验正反例', () => {
  assert.doesNotThrow(() => validate({ enum: ['a', 'b', 1] }, 1));
  assert.throws(() => validate({ enum: ['a', 'b'] }, 'c'), (err) => err.code === 'VALIDATION_FAILED');

  assert.doesNotThrow(() => validate({ const: 'fixed' }, 'fixed'));
  assert.throws(() => validate({ const: 'fixed' }, 'other'), (err) => err.code === 'VALIDATION_FAILED');
});

// ── schema：object 约束 ─────────────────────────────────────────────────

test('TC-A13 schema required 与 additionalProperties=false 正反例', () => {
  const schema = {
    type: 'object',
    required: ['a'],
    properties: { a: { type: 'string' } },
    additionalProperties: false
  };
  assert.doesNotThrow(() => validate(schema, { a: 'x' }));
  assert.throws(() => validate(schema, {}), (err) => err.code === 'VALIDATION_FAILED');
  assert.throws(() => validate(schema, { a: 'x', b: 1 }), (err) => err.code === 'VALIDATION_FAILED');
  assert.throws(() => validate(schema, { a: 1 }), (err) => err.code === 'VALIDATION_FAILED');

  const loose = { type: 'object', properties: { a: { type: 'string' } } };
  assert.doesNotThrow(() => validate(loose, { a: 'x', b: 1 }));
});

test('TC-A14 additionalProperties 为子 schema 时逐个校验未知键', () => {
  const schema = { type: 'object', properties: {}, additionalProperties: { type: 'number' } };
  assert.doesNotThrow(() => validate(schema, { a: 1 }));
  assert.throws(() => validate(schema, { a: 'x' }), (err) => err.code === 'VALIDATION_FAILED');
  assert.throws(() => validate(schema, { a: 1, b: true }), (err) => err.code === 'VALIDATION_FAILED');
});

// ── schema：字符串/数字/数组约束 ────────────────────────────────────────

test('TC-A15 pattern/minLength/maxLength 正反例', () => {
  assert.doesNotThrow(() => validate({ type: 'string', pattern: '^[a-z]+$' }, 'abc'));
  assert.throws(() => validate({ type: 'string', pattern: '^[a-z]+$' }, 'ABC'), (err) => err.code === 'VALIDATION_FAILED');

  assert.doesNotThrow(() => validate({ type: 'string', minLength: 2, maxLength: 3 }, 'ab'));
  assert.throws(() => validate({ type: 'string', minLength: 2 }, 'a'), (err) => err.code === 'VALIDATION_FAILED');
  assert.throws(() => validate({ type: 'string', maxLength: 3 }, 'abcd'), (err) => err.code === 'VALIDATION_FAILED');
});

test('TC-A16 format=date-time 正反例', () => {
  assert.doesNotThrow(() => validate({ type: 'string', format: 'date-time' }, '2026-10-23T09:00:00+08:00'));
  assert.throws(
    () => validate({ type: 'string', format: 'date-time' }, 'not-a-date'),
    (err) => err.code === 'VALIDATION_FAILED'
  );
});

test('TC-A17 minimum/maximum 正反例', () => {
  assert.doesNotThrow(() => validate({ type: 'number', minimum: 0, maximum: 10 }, 0));
  assert.doesNotThrow(() => validate({ type: 'number', minimum: 0, maximum: 10 }, 10));
  assert.throws(() => validate({ type: 'number', minimum: 0 }, -1), (err) => err.code === 'VALIDATION_FAILED');
  assert.throws(() => validate({ type: 'number', maximum: 10 }, 11), (err) => err.code === 'VALIDATION_FAILED');
});

test('TC-A18 minItems/maxItems/uniqueItems/items 正反例', () => {
  const schema = { type: 'array', minItems: 1, maxItems: 2, uniqueItems: true, items: { type: 'string' } };
  assert.doesNotThrow(() => validate(schema, ['a', 'b']));
  assert.throws(() => validate(schema, []), (err) => err.code === 'VALIDATION_FAILED');
  assert.throws(() => validate(schema, ['a', 'b', 'c']), (err) => err.code === 'VALIDATION_FAILED');
  assert.throws(() => validate(schema, ['a', 'a']), (err) => err.code === 'VALIDATION_FAILED');
  assert.throws(() => validate(schema, ['a', 1]), (err) => err.code === 'VALIDATION_FAILED');
});

// ── schema：组合子与 $ref ───────────────────────────────────────────────

test('TC-A19 oneOf/anyOf/allOf 语义', () => {
  const oneOf = { oneOf: [{ type: 'string' }, { type: 'number' }] };
  assert.doesNotThrow(() => validate(oneOf, 'x'));
  assert.doesNotThrow(() => validate(oneOf, 1));
  assert.throws(() => validate(oneOf, true), (err) => err.code === 'VALIDATION_FAILED');

  const exclusive = { oneOf: [{ type: 'number' }, { type: 'integer' }] };
  assert.throws(() => validate(exclusive, 1), (err) => err.code === 'VALIDATION_FAILED');

  const anyOf = { anyOf: [{ type: 'string' }, { type: 'number' }] };
  assert.doesNotThrow(() => validate(anyOf, 1));
  assert.throws(() => validate(anyOf, false), (err) => err.code === 'VALIDATION_FAILED');

  const allOf = { allOf: [{ type: 'string' }, { minLength: 2 }] };
  assert.doesNotThrow(() => validate(allOf, 'ab'));
  assert.throws(() => validate(allOf, 'a'), (err) => err.code === 'VALIDATION_FAILED');
});

test('TC-A20 本地 $ref 解析正反例，非本地引用拒绝', () => {
  const schema = {
    type: 'object',
    required: ['a'],
    properties: { a: { $ref: '#/$defs/dataClass' } },
    $defs: { dataClass: { type: 'string', enum: ['D0', 'D1', 'D2', 'D3'] } }
  };
  assert.doesNotThrow(() => validate(schema, { a: 'D2' }));
  assert.throws(() => validate(schema, { a: 'D9' }), (err) => err.code === 'VALIDATION_FAILED');

  assert.throws(() => validate({ $ref: '#/$defs/nope', $defs: {} }, 1), (err) => err.code === 'VALIDATION_FAILED');
  assert.throws(
    () => validate({ $ref: 'https://example.com/schema.json' }, 1),
    (err) => err.code === 'VALIDATION_FAILED'
  );
});

// ── schema：fail-closed ─────────────────────────────────────────────────

test('TC-A21 未知关键字 fail-closed：maximumx 抛 ValidationError', () => {
  assert.throws(
    () => validate({ type: 'string', maximumx: 5 }, 'x'),
    (err) => err.code === 'VALIDATION_FAILED' && /unsupported keyword/.test(err.message)
  );
  assert.throws(
    () => validate({ type: 'string', minProperties: 1 }, 'x'),
    (err) => err.code === 'VALIDATION_FAILED'
  );
});

test('TC-A22 未知 type 与非对象 schema 抛 ValidationError', () => {
  assert.throws(() => validate({ type: 'tupel' }, 'x'), (err) => err.code === 'VALIDATION_FAILED');
  assert.throws(() => validate(null, 'x'), (err) => err.code === 'VALIDATION_FAILED');
  assert.throws(() => validate('not a schema', 'x'), (err) => err.code === 'VALIDATION_FAILED');
  assert.throws(() => validate(undefined, 'x'), (err) => err.code === 'VALIDATION_FAILED');
});

test('TC-A23 ValidationError.path 指向具体位置，check 返回原值', () => {
  const schema = {
    type: 'object',
    properties: { list: { type: 'array', items: { type: 'integer' } } }
  };
  assert.throws(
    () => validate(schema, { list: [1, 'x'] }),
    (err) => err.code === 'VALIDATION_FAILED' && err.path === '$.list[1]'
  );
  assert.throws(
    () => validate(schema, { list: 'not-array' }),
    (err) => err.code === 'VALIDATION_FAILED' && err.path === '$.list'
  );

  const value = { a: 1 };
  assert.equal(check({ type: 'object' }, value), value);
  assert.throws(() => check({ type: 'string' }, 1), (err) => err.code === 'VALIDATION_FAILED');
});
