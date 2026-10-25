/**
 * Audit Ledger（services/audit.mjs）不变量测试。
 *
 * 覆盖：append 后链可复算、verifyChain 检测篡改（brokenAt 精确）、
 * 并发 append 不分叉、export 按时间过滤、空账本/损坏账本/stat/init。
 *
 * 零依赖：node:test + node:assert/strict。静态编写，未经运行验证。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, appendFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAudit } from '../../src/services/audit.mjs';
import { createClock } from '../../src/core/clock.mjs';
import { chainHash } from '../../src/core/canonical.mjs';

const dir = await mkdtemp(join(tmpdir(), 'pa-core-audit-'));
after(() => rm(dir, { recursive: true, force: true }));

const START = '2026-10-23T09:00:00+08:00';

let caseNo = 0;
function nextAuditDir() {
  caseNo += 1;
  return join(dir, `audit-${String(caseNo).padStart(2, '0')}`);
}

/** 读取账本原文并按行重写（用于模拟静态篡改）。 */
async function rewriteLines(ledgerFile, mutate) {
  const text = await readFile(ledgerFile, 'utf8');
  const lines = text.split('\n').filter((line) => line.length > 0);
  const touched = mutate(lines.slice());
  await writeFile(ledgerFile, `${touched.join('\n')}\n`, 'utf8');
  return lines.length;
}

test('TC-C01 createAudit 缺少 dir 时抛 TypeError', () => {
  assert.throws(() => createAudit({ clock: createClock({ start: START }) }), (err) => err instanceof TypeError);
});

test('TC-C02 首条记录 prev_hash 为 genesis，hash 为可复算的 sha256 链值', async () => {
  const clock = createClock({ start: START });
  const audit = createAudit({ dir: nextAuditDir(), clock });
  const record = await audit.append({ kind: 'intent', run_id: 'r_1', turn_id: 'turn_1' });

  assert.match(record.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  assert.equal(record.prev_hash, 'sha256:genesis');
  assert.match(record.hash, /^sha256:[0-9a-f]{64}$/);

  const { prev_hash, hash, ...payload } = record;
  assert.equal(chainHash(prev_hash, payload), hash);
  assert.equal(payload.kind, 'intent');
  assert.equal(payload.run_id, 'r_1');
  assert.equal(payload.turn_id, 'turn_1');
});

test('TC-C03 连续 append 形成链，verifyChain 返回 ok', async () => {
  const clock = createClock({ start: START });
  const audit = createAudit({ dir: nextAuditDir(), clock });

  const first = await audit.append({ kind: 'intent' });
  const second = await audit.append({ kind: 'tool_call', tool: 'calendar.read' });
  const third = await audit.append({ kind: 'tool_result', outcome: { status: 'ok' } });

  assert.equal(second.prev_hash, first.hash);
  assert.equal(third.prev_hash, second.hash);
  assert.deepEqual(await audit.verifyChain(), { ok: true, count: 3, anchored: true });
});

test('TC-C04 并发 10 次 append 串行化，链不分叉', async () => {
  const clock = createClock({ start: START });
  const audit = createAudit({ dir: nextAuditDir(), clock });

  const appended = await Promise.all(
    Array.from({ length: 10 }, (_, index) => audit.append({ kind: 'tool_call', outcome: { n: index } }))
  );
  assert.equal(appended.length, 10);

  const { records: stored, corrupt } = await audit.readAll();
  assert.deepEqual(corrupt, []);
  assert.equal(stored.length, 10);
  assert.deepEqual(
    appended.map((record) => record.hash),
    stored.map((record) => record.hash)
  );
  assert.equal(stored[0].prev_hash, 'sha256:genesis');
  for (let index = 1; index < stored.length; index += 1) {
    assert.equal(stored[index].prev_hash, stored[index - 1].hash);
  }
  assert.deepEqual(await audit.verifyChain(), { ok: true, count: 10, anchored: true });
});

test('TC-C05 篡改第 2 条记录的 outcome 后 verifyChain 报 brokenAt=2 且 hash 不匹配', async () => {
  const clock = createClock({ start: START });
  const audit = createAudit({ dir: nextAuditDir(), clock });
  await audit.append({ kind: 'intent', outcome: { status: 'ok' } });
  await audit.append({ kind: 'tool_call', outcome: { status: 'ok' } });
  await audit.append({ kind: 'tool_result', outcome: { status: 'ok' } });

  const lineCount = await rewriteLines(audit.ledgerFile, (lines) => {
    const tampered = JSON.parse(lines[1]);
    tampered.outcome = { status: 'tampered' };
    lines[1] = JSON.stringify(tampered);
    return lines;
  });
  assert.equal(lineCount, 3);

  assert.deepEqual(await audit.verifyChain(), {
    ok: false,
    count: 3,
    brokenAt: 2,
    reason: 'hash mismatch (record edited)'
  });
});

test('TC-C06 篡改第 1 条记录的 prev_hash 后 verifyChain 报 brokenAt=1', async () => {
  const clock = createClock({ start: START });
  const audit = createAudit({ dir: nextAuditDir(), clock });
  await audit.append({ kind: 'intent' });
  await audit.append({ kind: 'tool_call' });

  await rewriteLines(audit.ledgerFile, (lines) => {
    const first = JSON.parse(lines[0]);
    first.prev_hash = 'sha256:forged';
    lines[0] = JSON.stringify(first);
    return lines;
  });

  assert.deepEqual(await audit.verifyChain(), {
    ok: false,
    count: 2,
    brokenAt: 1,
    reason: 'prev_hash mismatch'
  });
});

test('TC-C07 账本出现无法解析的行时 verifyChain 报 unparsable line 并给出行号', async () => {
  const clock = createClock({ start: START });
  const audit = createAudit({ dir: nextAuditDir(), clock });
  await audit.append({ kind: 'intent' });
  await appendFile(audit.ledgerFile, 'this is not json\n', 'utf8');

  assert.deepEqual(await audit.verifyChain(), {
    ok: false,
    count: 1,
    brokenAt: 2,
    reason: 'unparsable line'
  });
  const { corrupt } = await audit.readAll();
  assert.equal(corrupt.length, 1);
  assert.equal(corrupt[0].line, 2);
});

test('TC-C08 export 按 from/to 闭区间过滤', async () => {
  const clock = createClock({ start: START });
  const audit = createAudit({ dir: nextAuditDir(), clock });

  await audit.append({ kind: 'intent' });
  clock.advance(2 * 3600 * 1000);
  const second = await audit.append({ kind: 'tool_call' });
  clock.advance(2 * 3600 * 1000);
  await audit.append({ kind: 'tool_result' });

  const kindOf = (text) =>
    text
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line).kind);

  assert.deepEqual(kindOf(await audit.export()), ['intent', 'tool_call', 'tool_result']);
  assert.deepEqual(kindOf(await audit.export({ from: second.ts })), ['tool_call', 'tool_result']);
  assert.deepEqual(kindOf(await audit.export({ to: second.ts })), ['intent', 'tool_call']);
  assert.deepEqual(kindOf(await audit.export({ from: second.ts, to: second.ts })), ['tool_call']);
});

test('TC-C09 空账本：export 为空串，readAll/verifyChain 为空且 ok', async () => {
  const clock = createClock({ start: START });
  const audit = createAudit({ dir: nextAuditDir(), clock });

  assert.equal(await audit.export(), '');
  assert.deepEqual(await audit.readAll(), { records: [], corrupt: [] });
  assert.deepEqual(await audit.verifyChain(), { ok: true, count: 0, anchored: true });
});

test('TC-C09b 尾部截断被外部锚点发现：删掉最后一条后 verifyChain 报 tail truncated', async () => {
  const clock = createClock({ start: START });
  const audit = createAudit({ dir: nextAuditDir(), clock });
  await audit.append({ kind: 'intent' });
  await audit.append({ kind: 'tool_call' });
  await audit.append({ kind: 'tool_result' });

  // 保留一个合法前缀：链本身自洽，只有外部 head 锚点能发现少了尾巴。
  await rewriteLines(audit.ledgerFile, (lines) => lines.slice(0, 2));
  const verdict = await audit.verifyChain();
  assert.equal(verdict.ok, false);
  assert.equal(verdict.count, 2);
  assert.equal(verdict.reason, 'tail truncated (head anchor mismatch)');
  assert.equal(verdict.anchored, false);
});

test('TC-C10 stat 汇总记录数、文件列表与链头', async () => {
  const clock = createClock({ start: START });
  const audit = createAudit({ dir: nextAuditDir(), clock });
  await audit.append({ kind: 'intent' });
  const last = await audit.append({ kind: 'tool_call' });

  const result = await audit.stat();
  assert.equal(result.count, 2);
  assert.deepEqual(result.files, [audit.ledgerFile]);
  assert.equal(result.head, last.hash);
});

test('TC-C11 init 创建账本目录', async () => {
  const clock = createClock({ start: START });
  const target = nextAuditDir();
  const audit = createAudit({ dir: target, clock });
  await audit.init();
  const info = await stat(target);
  assert.equal(info.isDirectory(), true);
});

test('TC-C12 已有损坏账本时新实例 append 被拒绝（fail-closed）', async () => {
  const clock = createClock({ start: START });
  const target = nextAuditDir();
  const audit = createAudit({ dir: target, clock });
  await audit.append({ kind: 'intent' });
  await appendFile(audit.ledgerFile, 'garbage line\n', 'utf8');

  const fresh = createAudit({ dir: target, clock });
  await assert.rejects(fresh.append({ kind: 'tool_call' }), (err) => /corrupt/.test(err.message));
});

test('TC-C13 事件可覆盖 ts，并驱动 export 过滤', async () => {
  const clock = createClock({ start: START });
  const audit = createAudit({ dir: nextAuditDir(), clock });
  const customTs = '2026-10-01T08:00:00+08:00';
  const record = await audit.append({ kind: 'intent', ts: customTs });
  assert.equal(record.ts, customTs);

  const exported = await audit.export({
    from: '2026-10-01T00:00:00+08:00',
    to: '2026-10-02T00:00:00+08:00'
  });
  assert.equal(JSON.parse(exported).kind, 'intent');
});
