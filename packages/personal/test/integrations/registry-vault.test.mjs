/**
 * TC-C19 … TC-C28 — Tool Registry (M5) 清单校验/风险派生/digest/health，与 Vault 凭证句柄。
 *
 * 静态编写，**未执行**：本机 shell 不可用，node 无法运行。断言按 src 推演。
 *
 * 被测：src/integrations/tool-registry.mjs、src/integrations/vault.mjs、src/services/risk.mjs
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createToolRegistry } from '../../src/integrations/tool-registry.mjs';
import { createVault } from '../../src/integrations/vault.mjs';
import { createClock } from '../../src/core/clock.mjs';
import { ConfigError, ValidationError } from '../../src/core/errors.mjs';

const CLOCK_START = '2026-10-23T09:00:00+08:00';
const SHA256_RE = /^sha256:[0-9a-f]{64}$/;

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

let schemaPromise = null;
function manifestSchema() {
  schemaPromise ??= readFile(new URL('../../schemas/tool-manifest.v1.json', import.meta.url), 'utf8').then((raw) =>
    JSON.parse(raw)
  );
  return schemaPromise;
}

async function makeRegistry() {
  return createToolRegistry({ manifestSchema: await manifestSchema(), clock: makeClock() });
}

/** 一个最小的合法 connector：id + tools（tools 不可为空，空能力面直接拒绝注册）。 */
function connector(id, tools, extra = {}) {
  return { id, kind: 'native', tools, ...extra };
}

/**
 * A complete manifest: the schema's `required` list is enforced *before*
 * normalisation, so every field a real connector would declare must be here.
 * `connector` is filled in from the registering connector id.
 */
function tool(id, manifestExtra = {}, invokeResult = { summary: 'ok' }) {
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
      approval: { default: 'auto' },
      ...manifestExtra
    },
    async invoke() {
      return invokeResult;
    }
  };
}

// ─────────────────────────── manifest 校验 ───────────────────────────

test('TC-C19 manifest 非法：risk 不在 R0..R4 → ValidationError', async () => {
  const registry = await makeRegistry();
  registry.registerConnector(connector('bad-risk', [tool('bad.placeholder')]));

  assert.throws(
    () => registry.registerTool('bad-risk', tool('bad.risk', { risk: 'R9' })),
    (err) => {
      assert.ok(err instanceof ValidationError, `期望 ValidationError，实际 ${err?.name}`);
      assert.equal(err.code, 'VALIDATION_FAILED');
      return true;
    }
  );
  // 注册失败不得留下半个工具
  assert.equal(registry.get('bad.risk'), null);
});

test('TC-C19b manifest 缺 risk 应拒绝注册（04 §5.1「缺一不予注册」）', async () => {
  const registry = await makeRegistry();
  registry.registerConnector(connector('no-risk', [tool('no.placeholder')]));

  const incomplete = tool('no.risk');
  delete incomplete.manifest.risk;
  assert.throws(() => registry.registerTool('no-risk', incomplete), ValidationError);
  assert.equal(registry.get('no.risk'), null);
});

test('TC-C20 risk 不能低报：egress / irreversible / D2 自动抬升', async () => {
  const registry = await makeRegistry();

  registry.registerConnector(
    connector('derive', [
      // 声明 R0，但出网 + 不可撤销 → 至少 R2
      tool('test.upload', { risk: 'R0', egress: true, reversible: false }),
      // 声明 R0，但数据入参含 D2 → 至少 R1
      tool('test.mailbox', { risk: 'R0', data_in: ['D2'] }),
      // 声明 R2 但实际只读 → 允许保持 R2（声明只可被抬高）
      tool('test.conservative', { risk: 'R2' })
    ])
  );

  assert.equal(registry.get('test.upload').risk, 'R2');
  assert.equal(registry.get('test.mailbox').risk, 'R1');
  assert.equal(registry.get('test.conservative').risk, 'R2');
  // 规范化后必须补齐 schema 必填字段
  assert.equal(registry.get('test.upload').reversible, false);
  assert.equal(registry.get('test.upload').egress, true);
  assert.deepEqual(registry.get('test.upload').data_in, ['D1']);
});

test('TC-C21 重复 tool id → ConfigError（跨 connector 也算重复）', async () => {
  const registry = await makeRegistry();
  registry.registerConnector(connector('c1', [tool('dup.tool')]));

  assert.throws(
    () => registry.registerConnector(connector('c2', [tool('dup.tool')])),
    (err) => {
      assert.ok(err instanceof ConfigError);
      assert.equal(err.code, 'CONFIG_INVALID');
      assert.match(err.message, /duplicate tool id/);
      return true;
    }
  );
  // 同名 connector 也是 ConfigError
  assert.throws(() => registry.registerConnector(connector('c1', [tool('dup.other')])), ConfigError);
});

test('TC-C22 digests() 返回 sha256:<hex>；非 sha256 的显式 digest 被拒', async () => {
  const registry = await makeRegistry();
  registry.registerConnector(connector('d1', [tool('d1.read')]));
  registry.registerConnector(connector('d2', [tool('d2.read')]));

  const digests = registry.digests();
  assert.deepEqual(Object.keys(digests).sort(), ['d1', 'd2']);
  for (const digest of Object.values(digests)) {
    assert.match(digest, SHA256_RE);
  }
  // 稳定：同一定义两次计算结果一致
  assert.deepEqual(registry.digests(), digests);

  assert.throws(
    () => registry.registerConnector({ id: 'd3', tools: [tool('d3.read')], digest: 'deadbeef' }),
    (err) => {
      assert.ok(err instanceof ConfigError);
      assert.match(err.message, /sha256/);
      return true;
    }
  );
});

test('TC-C22b connector 声明空工具集 → ConfigError（拒绝启动空能力面）', async () => {
  const registry = await makeRegistry();
  assert.throws(
    () => registry.registerConnector(connector('empty', [])),
    (err) => err instanceof ConfigError && /declares no tools/.test(err.message)
  );
});

test('TC-C23 invoke 未注册工具 / R4 工具一律拒绝', async () => {
  const registry = await makeRegistry();
  registry.registerConnector(connector('inv', [tool('inv.read', {}, { summary: 'read ok', cost: { usd: 0 } })]));
  registry.registerConnector(connector('forbidden', [tool('forbidden.act', { risk: 'R4' })]));

  await assert.rejects(() => registry.invoke('not.registered', {}), (err) => {
    assert.ok(err instanceof ConfigError);
    assert.match(err.message, /not registered/);
    return true;
  });

  await assert.rejects(() => registry.invoke('forbidden.act', {}), (err) => {
    assert.ok(err instanceof ConfigError);
    assert.match(err.message, /R4/);
    return true;
  });

  const ok = await registry.invoke('inv.read', {}, { runId: 'r1' });
  assert.equal(ok.summary, 'read ok');
  assert.equal(ok.toolId, 'inv.read');
  assert.equal(ok.connector, 'inv');
  assert.match(ok.toolDigest, SHA256_RE);
});

test('TC-C24 health 容忍 connector 抛错：返回 ok:false 而不是抛出', async () => {
  const registry = await makeRegistry();
  registry.registerConnector(
    connector('explode', [tool('explode.read')], {
      healthCheck() {
        throw new Error('boom');
      }
    })
  );
  registry.registerConnector(
    connector('sick', [tool('sick.read')], { healthCheck: () => ({ ok: false, error: 'offline' }) })
  );
  registry.registerConnector(connector('healthy', [tool('healthy.read')], { healthCheck: () => ({ ok: true }) }));

  const report = await registry.health();
  assert.equal(report.length, 3);
  const byId = Object.fromEntries(report.map((entry) => [entry.connector, entry]));

  assert.equal(byId.explode.ok, false);
  assert.equal(byId.explode.error, 'boom');
  assert.equal(byId.sick.ok, false);
  assert.equal(byId.sick.error, 'offline');
  assert.equal(byId.healthy.ok, true);
  assert.equal(registry.stat().connectors, 3);
});

// ─────────────────────────── vault ───────────────────────────

const SECRET = 'pa-secret-token-0123456789';
const MASTER_KEY = Buffer.alloc(32, 7);

async function makeVault() {
  const dir = await makeTmp('pa-vault-');
  const clock = makeClock();
  const path = join(dir, 'vault.enc');
  return { dir, clock, path, vault: createVault({ path, masterKey: MASTER_KEY, clock }) };
}

test('TC-C25 putSecret 不回显明文：返回值 / describe / 磁盘 / 重载后都只有句柄与指纹', async () => {
  const { path, vault } = await makeVault();
  const stored = await vault.putSecret({ connector: 'gmail', value: SECRET });

  assert.equal(typeof stored.handle, 'string');
  assert.ok(stored.handle.startsWith('vault://gmail/'));
  assert.ok(stored.fingerprint.startsWith('fp:'));
  assert.equal(stored.value, undefined);
  assert.ok(!JSON.stringify(stored).includes(SECRET), '返回值不得包含明文');

  const described = await vault.describe();
  assert.equal(described.length, 1);
  assert.ok(!JSON.stringify(described).includes(SECRET), 'describe 不得包含明文');

  const onDisk = await readFile(path, 'utf8');
  assert.ok(!onDisk.includes(SECRET), '落盘必须是密文（AES-256-GCM 信封）');
  assert.ok(onDisk.includes('sealed'));

  // 用同一主密钥重载可解密，说明持久化链路可用
  const reopened = createVault({ path, masterKey: MASTER_KEY, clock: createClock({ start: CLOCK_START }) });
  const handle = await reopened.issueHandle({ connector: 'gmail', actions: ['mail.send'] });
  const resolved = await reopened.resolve(handle.handle, { action: 'mail.send' });
  assert.equal(resolved.value, SECRET);
});

test('TC-C26 issueHandle 过期后 resolve 抛错（且句柄被消费）', async () => {
  const { clock, vault } = await makeVault();
  await vault.putSecret({ connector: 'gmail', value: SECRET });

  const issued = await vault.issueHandle({ connector: 'gmail', actions: ['mail.send'], ttlSeconds: 1 });
  assert.ok(issued.handle.startsWith('cap://gmail/'));

  // ttl 未到 → 可用
  const before = await vault.resolve(issued.handle, { action: 'mail.send' });
  assert.equal(before.value, SECRET);
  assert.equal(before.connector, 'gmail');

  clock.advance(2000);
  await assert.rejects(() => vault.resolve(issued.handle, { action: 'mail.send' }), (err) => {
    assert.ok(err instanceof ConfigError);
    assert.match(err.message, /expired/);
    return true;
  });
});

test('TC-C27 resolve：动作不在 scope 内抛错；未知句柄 / 未存凭证也抛 ConfigError', async () => {
  const { clock, vault } = await makeVault();
  await vault.putSecret({ connector: 'gmail', value: SECRET });

  const issued = await vault.issueHandle({ connector: 'gmail', actions: ['calendar.list'], ttlSeconds: 300 });
  await assert.rejects(() => vault.resolve(issued.handle, { action: 'mail.send' }), (err) => {
    assert.ok(err instanceof ConfigError);
    assert.match(err.message, /does not cover action/);
    return true;
  });

  // 通配 scope 放行
  const wildcard = await vault.issueHandle({ connector: 'gmail', actions: ['*'], ttlSeconds: 300 });
  const allowed = await vault.resolve(wildcard.handle, { action: 'mail.send' });
  assert.equal(allowed.value, SECRET);

  await assert.rejects(() => vault.resolve('cap://gmail/nope', {}), ConfigError);
  await assert.rejects(() => vault.resolve('vault://gmail/x', {}), (err) => {
    assert.ok(err instanceof ConfigError);
    assert.match(err.message, /capability handle/);
    return true;
  });

  clock.advance(1);
  const other = createVault({ path: join(await makeTmp('pa-vault-2-'), 'vault.enc'), masterKey: MASTER_KEY, clock });
  await assert.rejects(() => other.issueHandle({ connector: 'nobody', actions: ['read'] }), ConfigError);
});

test('TC-C28 describe 只暴露 connector/fingerprint/hasSecret；构造期拒绝弱主密钥', async () => {
  const { vault } = await makeVault();
  await vault.putSecret({ connector: 'gmail', value: SECRET });
  await vault.putSecret({ connector: 'calendar', value: SECRET.concat('-2') });

  const described = await vault.describe();
  assert.equal(described.length, 2);
  for (const entry of described) {
    assert.deepEqual(Object.keys(entry).sort(), ['connector', 'fingerprint', 'hasSecret']);
    assert.equal(entry.hasSecret, true);
    assert.match(entry.fingerprint, /^fp:[0-9a-f]{16}$/);
    assert.equal(entry.value, undefined);
    assert.equal(entry.secret, undefined);
  }

  const dir = await makeTmp('pa-vault-bad-');
  assert.throws(() => createVault({ path: join(dir, 'v.enc'), clock: makeClock() }), ConfigError);
  assert.throws(() => createVault({ path: join(dir, 'v.enc'), masterKey: Buffer.alloc(16), clock: makeClock() }), (err) => {
    assert.ok(err instanceof ConfigError);
    assert.match(err.message, /32 bytes/);
    return true;
  });
  assert.throws(() => createVault({ masterKey: MASTER_KEY, clock: makeClock() }), ConfigError);
});
