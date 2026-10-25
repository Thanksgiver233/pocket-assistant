/**
 * TC-C29 … TC-C33 — 三个 P0 连接器：.env 保护、路径穿越、可逆写、风险声明。
 *
 * 静态编写，**未执行**：本机 shell 不可用，node 无法运行。断言按 src 推演。
 *
 * 被测：src/integrations/connectors/{local-files,calendar,mail}.mjs
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFilesConnector, isProtected } from '../../src/integrations/connectors/local-files.mjs';
import { createCalendarConnector } from '../../src/integrations/connectors/calendar.mjs';
import { createMailConnector } from '../../src/integrations/connectors/mail.mjs';
import { createToolRegistry } from '../../src/integrations/tool-registry.mjs';
import { createClock } from '../../src/core/clock.mjs';
import { PaError } from '../../src/core/errors.mjs';

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

function findTool(connector, manifestId) {
  const found = connector.tools.find((entry) => entry.manifest.id === manifestId);
  assert.ok(found, `connector ${connector.id} 缺少工具 ${manifestId}`);
  return found;
}

// ─────────────────────────── local-files ───────────────────────────

test('TC-C29 files.read 读 .env → 普通 Error(code=PROTECTED_PATH)，不是 PaError', async () => {
  const root = await makeTmp('pa-files-');
  await writeFile(join(root, '.env'), 'OPENAI_API_KEY=sk-should-never-be-read\n', 'utf8');
  await writeFile(join(root, 'note.txt'), 'hello pa', 'utf8');

  const files = createFilesConnector({ root, clock: makeClock() });
  const read = findTool(files, 'files.read');
  const list = findTool(files, 'files.list');

  await assert.rejects(
    () => read.invoke({ path: '.env' }),
    (err) => {
      assert.ok(err instanceof Error);
      assert.equal(err.code, 'PROTECTED_PATH');
      assert.ok(!(err instanceof PaError), '连接器保护应抛普通 Error，而非 PaError（不进入 fail-closed 包装）');
      return true;
    }
  );

  // 保护发生在读取之前：普通文件仍可读
  const ok = await read.invoke({ path: 'note.txt' });
  assert.equal(ok.artifact.kind, 'text');
  assert.equal(ok.artifact.text, 'hello pa');

  // 列目录时受保护文件不出现
  const listed = await list.invoke({ subdir: '.' });
  assert.equal(listed.items.length, 1);
  assert.equal(listed.items[0].name, 'note.txt');
});

test('TC-C30 路径穿越 ../x 与绝对路径逃逸 → TypeError', async () => {
  const root = await makeTmp('pa-files-escape-');
  await mkdir(join(root, 'sub'), { recursive: true });
  const files = createFilesConnector({ root, clock: makeClock() });
  const read = findTool(files, 'files.read');
  const list = findTool(files, 'files.list');

  await assert.rejects(() => read.invoke({ path: '../outside.txt' }), (err) => {
    assert.ok(err instanceof TypeError);
    assert.match(err.message, /escapes the workspace root/);
    return true;
  });
  await assert.rejects(() => list.invoke({ subdir: '../../' }), TypeError);
  // 目录内相对路径合法
  const inside = await list.invoke({ subdir: 'sub' });
  assert.deepEqual(inside.items, []);

  assert.equal(isProtected(join(root, '.env')), true);
  assert.equal(isProtected(join(root, 'notes.md')), false);
});

// ─────────────────────────── calendar ───────────────────────────

test('TC-C31 calendar.update_event 后 restore_event 能还原（snapshot_restore）', async () => {
  const clock = makeClock();
  const calendar = createCalendarConnector({ clock });
  const update = findTool(calendar, 'calendar.update_event');
  const restore = findTool(calendar, 'calendar.restore_event');

  const before = calendar._events().find((event) => event.id === 'evt_1');
  assert.equal(before.start, '2026-10-28T10:00');

  const updated = await update.invoke({ id: 'evt_1', start: '2026-10-29T10:00' });
  assert.equal(updated.artifact.kind, 'change');
  assert.equal(updated.artifact.before.start, '2026-10-28T10:00');
  assert.equal(updated.artifact.after.start, '2026-10-29T10:00');
  assert.equal(typeof updated.undoableUntil, 'string');
  assert.equal(calendar._events().find((event) => event.id === 'evt_1').start, '2026-10-29T10:00');

  await restore.invoke({ id: 'evt_1' });
  const restored = calendar._events().find((event) => event.id === 'evt_1');
  assert.equal(restored.start, '2026-10-28T10:00', 'restore 必须回到快照时间');
  assert.equal(restored.title, '周会', 'restore 不得改动未修改的字段');

  // manifest 声明了 undo，且策略是快照还原（04 §5.2「可逆优先」的前提）
  const manifest = update.manifest;
  assert.equal(manifest.reversible, true);
  assert.equal(manifest.undo.strategy, 'snapshot_restore');
  assert.equal(manifest.risk, 'R1');
});

// ─────────────────────────── mail ───────────────────────────

test('TC-C32 mail.send 必须 R2 + egress=true + reversible=false；draft 保持 R1 不出网', async () => {
  const clock = makeClock();
  const outbox = [];
  const mail = createMailConnector({ clock, outbox });

  const send = findTool(mail, 'mail.send');
  const draft = findTool(mail, 'mail.draft');
  const list = findTool(mail, 'mail.list');

  assert.equal(send.manifest.risk, 'R2');
  assert.equal(send.manifest.egress, true);
  assert.equal(send.manifest.reversible, false);
  assert.deepEqual(send.manifest.data_in, ['D2']);
  assert.equal(send.manifest.approval.default, 'confirm');

  assert.equal(draft.manifest.risk, 'R1');
  assert.equal(draft.manifest.egress, false);
  assert.equal(draft.manifest.reversible, true);

  const sent = await send.invoke({ to: 'a@example.com', subject: 'hi', body: 'body' });
  assert.equal(sent.artifact.kind, 'sent');
  assert.equal(outbox.length, 1, 'outbox 由调用方注入，可直接断言副作用');
  assert.equal(outbox[0].to, 'a@example.com');

  const drafted = await draft.invoke({ to: 'b@example.com', subject: 'draft' });
  assert.equal(drafted.artifact.kind, 'draft');
  assert.equal(mail._drafts().length, 1);
  assert.equal(outbox.length, 1, '起草不得产生发送副作用');

  // mail.list 读取 D2 正文，因此按 deriveRisk 规则必须声明 R1（而非 R0）。
  // 声明与派生一致，注册时不会被"抬升"——这是 SUSPECT-4 的修复回归锁。
  assert.equal(list.manifest.risk, 'R1');
  assert.equal(list.manifest.egress, false);
  assert.equal(list.manifest.data_in.includes('D2'), true);
});

test('TC-C33 三个连接器 digest 均为 sha256；经 registry 注册后风险被抬升而非降低', async () => {
  const root = await makeTmp('pa-conn-');
  await mkdir(join(root, 'vault'), { recursive: true });
  const clock = makeClock();
  const connectors = [
    createFilesConnector({ root: join(root, 'vault'), clock }),
    createCalendarConnector({ clock }),
    createMailConnector({ clock })
  ];

  for (const connector of connectors) {
    assert.match(connector.digest, SHA256_RE, `${connector.id} digest 必须是 sha256:<hex>`);
  }

  const schema = JSON.parse(await readFile(new URL('../../schemas/tool-manifest.v1.json', import.meta.url), 'utf8'));
  const registry = createToolRegistry({ manifestSchema: schema, clock });
  for (const connector of connectors) registry.registerConnector(connector);

  assert.equal(registry.stat().connectors, 3);
  assert.equal(registry.stat().tools, 8);

  // 派生风险：mail.send 保持 R2（声明正确，不可降级）
  assert.equal(registry.get('mail.send').risk, 'R2');
  // 【推演】mail.list 被抬到 R1（data_in = D2 → floor R1，risk.mjs:53）
  assert.equal(registry.get('mail.list').risk, 'R1');
  assert.deepEqual(registry.get('mail.list').data_in, ['D2']);
});
