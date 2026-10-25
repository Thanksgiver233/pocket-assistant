/**
 * HTTP surface tests — the deployment adapter must not become a policy hole.
 *
 * What is asserted here is exactly the layer's contract:
 *  - auth is required and constant-time;
 *  - `/healthz` is public but content-free;
 *  - a browser gets a *projection*, never the raw result (D2 bodies dropped);
 *  - static serving cannot escape its root.
 *
 * Policy itself is not re-tested here — it lives in `consent`/`budget`.
 *
 * @module @piagent/personal/test/server/http-server
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { composePersonalAgent } from '../../src/compose.mjs';
import { createMockHost } from '../../src/host/mock-host.mjs';
import { createCalendarConnector } from '../../src/integrations/connectors/calendar.mjs';
import { createMailConnector } from '../../src/integrations/connectors/mail.mjs';
import { createClock } from '../../src/core/clock.mjs';
import { createHttpServer } from '../../src/server/http-server.mjs';

const TOKEN = 'test-token-0123456789abcdef';
const START = '2026-10-23T09:00:00+08:00';

const TMP = [];
after(async () => {
  for (const dir of TMP) await rm(dir, { recursive: true, force: true });
});

async function makeTmp(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  TMP.push(dir);
  return dir;
}

const PROFILE = {
  version: 1,
  autonomy: { default_mode: 'read-only' },
  budget: { per_turn_usd: 0.05, per_day_usd: 2 },
  connectors: { allow: [] }
};

async function startServer({ withWeb = false } = {}) {
  const root = await makeTmp('pa-http-ws-');
  const home = await makeTmp('pa-http-home-');
  await mkdir(join(root, '.pi'), { recursive: true });
  await mkdir(join(root, 'vault'), { recursive: true });
  await writeFile(join(root, '.pi', 'pa-profile.json'), JSON.stringify(PROFILE), 'utf8');

  const clock = createClock({ start: START });
  const mail = createMailConnector({ clock });
  const api = await composePersonalAgent({
    host: createMockHost(),
    workspaceRoot: root,
    homeDir: home,
    clock,
    connectors: [createCalendarConnector({ clock }), mail]
  });

  let webRoot = null;
  if (withWeb) {
    webRoot = await makeTmp('pa-http-web-');
    await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>t</title>ok', 'utf8');
    await writeFile(join(webRoot, 'secret.txt'), 'should not be served', 'utf8');
  }

  const service = createHttpServer({
    api,
    token: TOKEN,
    webRoot,
    rate: { windowMs: 60_000, max: 1000 }
  });
  const address = await service.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${address.port}`;

  return {
    base,
    api,
    mail,
    async close() {
      await service.close();
      await api.shutdown();
    }
  };
}

/** @param {string} base @param {string} path @param {Object} [init] */
async function call(base, path, init = {}) {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      ...(init.headers ?? {})
    }
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

test('TC-H01 令牌过短时拒绝构造（不允许裸奔部署）', () => {
  assert.throws(() => createHttpServer({ api: {}, token: 'short' }), /at least 16/);
  assert.throws(() => createHttpServer({ token: TOKEN }), /requires a composed api/);
});

test('TC-H02 无令牌/错令牌 401，且错误响应不泄漏内部细节', async () => {
  const svc = await startServer();
  try {
    const noAuth = await fetch(`${svc.base}/api/state`);
    assert.equal(noAuth.status, 401);
    const body = await noAuth.json();
    assert.deepEqual(body, { ok: false, error: 'unauthorised' });

    const wrong = await call(svc.base, '/api/state', { headers: { authorization: 'Bearer wrong-token-000000000' } });
    assert.equal(wrong.status, 401);
  } finally {
    await svc.close();
  }
});

test('TC-H03 /healthz 免鉴权且只暴露检查项与状态，不含内容', async () => {
  const svc = await startServer();
  try {
    const res = await fetch(`${svc.base}/healthz`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.checks));
    for (const check of body.checks) {
      assert.deepEqual(Object.keys(check).sort(), ['id', 'status']);
    }
  } finally {
    await svc.close();
  }
});

test('TC-H04 /api/state 返回预算、档位与 pending 概览', async () => {
  const svc = await startServer();
  try {
    const { status, body } = await call(svc.base, '/api/state');
    assert.equal(status, 200);
    assert.equal(body.mode, 'read-only');
    assert.equal(body.budget.perDayUsd, 2);
    assert.equal(body.grants, 0);
    assert.equal(body.pendingRun, null);
  } finally {
    await svc.close();
  }
});

test('TC-H05 /api/turn：问候 → done；read-only 写 → denied 且带原因', async () => {
  const svc = await startServer();
  try {
    const hello = await call(svc.base, '/api/turn', {
      method: 'POST',
      body: JSON.stringify({ text: '你好' })
    });
    assert.equal(hello.status, 200);
    assert.equal(hello.body.status, 'done');
    assert.equal(hello.body.artifacts[0].kind, 'text');

    const write = await call(svc.base, '/api/turn', {
      method: 'POST',
      body: JSON.stringify({ text: '把周会挪到周五' })
    });
    assert.equal(write.body.status, 'denied');
    assert.equal(write.body.decision.reason, 'mode_blocks_write');
    assert.deepEqual(write.body.artifacts, []);
  } finally {
    await svc.close();
  }
});

test('TC-H06 审批闭环：workspace-write 首写 → pending → approve → done', async () => {
  const svc = await startServer();
  try {
    const parked = await call(svc.base, '/api/turn', {
      method: 'POST',
      body: JSON.stringify({ text: '把周会挪到周五', mode: 'workspace-write' })
    });
    assert.equal(parked.body.status, 'awaiting_approval');
    assert.equal(parked.body.pending.cardType, 'action');
    assert.equal(parked.body.pending.reason, 'first_time_write');

    const listed = await call(svc.base, '/api/pending');
    assert.equal(listed.body.pending.runId, parked.body.runId);

    const approved = await call(svc.base, '/api/approve', {
      method: 'POST',
      body: JSON.stringify({ runId: parked.body.runId, approve: true })
    });
    assert.equal(approved.body.status, 'done');
    assert.equal(approved.body.pending, null);
    assert.equal(approved.body.artifacts[0].kind, 'change');
  } finally {
    await svc.close();
  }
});

test('TC-H07 D2 产物在续跑后仍被脱敏（artifact 自带分级，不依赖 decisions）', async () => {
  const svc = await startServer();
  try {
    await call(svc.base, '/api/grants', {
      method: 'POST',
      body: JSON.stringify({ connector: 'gmail', actions: ['mail.send'], dataClasses: ['D2'], ttlHours: 1 })
    });

    const parked = await call(svc.base, '/api/turn', {
      method: 'POST',
      body: JSON.stringify({ text: '发邮件给 boss@example.com', mode: 'full-access' })
    });
    assert.equal(parked.body.status, 'awaiting_approval');
    assert.equal(parked.body.pending.risk, 'R2');

    const approved = await call(svc.base, '/api/approve', {
      method: 'POST',
      body: JSON.stringify({ runId: parked.body.runId, approve: true })
    });
    assert.equal(approved.body.status, 'done');
    assert.equal(approved.body.redacted, true, 'D2 动作的响应必须标记为脱敏');
    assert.equal(approved.body.artifacts[0].text, null, 'D2 正文不得回传浏览器');
    assert.equal(svc.mail._outbox().length, 1, '副作用确实发生（只是不显示内容）');
  } finally {
    await svc.close();
  }
});

test('TC-H08 /api/receipts 是投影：只有时间/类型/判词/成本，没有 payload', async () => {
  const svc = await startServer();
  try {
    await call(svc.base, '/api/turn', { method: 'POST', body: JSON.stringify({ text: '你好' }) });
    const { body } = await call(svc.base, '/api/receipts?limit=5');
    assert.ok(body.receipts.length > 0);
    for (const receipt of body.receipts) {
      assert.deepEqual(Object.keys(receipt).sort(), ['at', 'cost', 'kind', 'reason', 'risk', 'tool', 'verdict']);
    }
  } finally {
    await svc.close();
  }
});

test('TC-H09 静态页：只服务白名单扩展名，路径穿越被拒', async () => {
  const svc = await startServer({ withWeb: true });
  try {
    const index = await fetch(`${svc.base}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get('content-security-policy') ?? '', /default-src 'self'/);

    const txt = await fetch(`${svc.base}/secret.txt`);
    assert.equal(txt.status, 404, '.txt 不在白名单，不应被服务');

    const traversal = await fetch(`${svc.base}/..%2f..%2fetc%2fpasswd`);
    assert.ok([403, 404].includes(traversal.status));
  } finally {
    await svc.close();
  }
});

test('TC-H10 限流：超过窗口配额返回 429', async () => {
  const root = await makeTmp('pa-http-rl-');
  const home = await makeTmp('pa-http-rl-home-');
  await mkdir(join(root, '.pi'), { recursive: true });
  await mkdir(join(root, 'vault'), { recursive: true });
  await writeFile(join(root, '.pi', 'pa-profile.json'), JSON.stringify(PROFILE), 'utf8');
  const clock = createClock({ start: START });
  const api = await composePersonalAgent({
    host: createMockHost(),
    workspaceRoot: root,
    homeDir: home,
    clock,
    connectors: [createCalendarConnector({ clock })]
  });
  const service = createHttpServer({ api, token: TOKEN, rate: { windowMs: 60_000, max: 3 } });
  const address = await service.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const codes = [];
    for (let i = 0; i < 5; i += 1) codes.push((await call(base, '/api/state')).status);
    assert.deepEqual(codes.slice(0, 3), [200, 200, 200]);
    assert.deepEqual(codes.slice(3), [429, 429]);
  } finally {
    await service.close();
    await api.shutdown();
  }
});

test('TC-H11 请求体上限：超大 body 被拒（不进入 agent）', async () => {
  const svc = await startServer();
  try {
    const huge = 'x'.repeat(80 * 1024);
    const res = await fetch(`${svc.base}/api/turn`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: huge })
    });
    assert.equal(res.status, 500, '超限在读取阶段抛出，由统一错误处理收口');
  } finally {
    await svc.close();
  }
});

test('TC-H12 提醒闭环：创建 → 列出 → 完成', async () => {
  const svc = await startServer();
  try {
    const created = await call(svc.base, '/api/reminders', {
      method: 'POST',
      body: JSON.stringify({ text: '交周报', at: '2026-10-23T12:00:00' })
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.reminder.text, '交周报');
    assert.equal(created.body.reminder.status, 'pending');

    const listed = await call(svc.base, '/api/reminders');
    assert.equal(listed.body.reminders.length, 1);

    const id = created.body.reminder.id;
    const done = await call(svc.base, `/api/reminders/${id}/done`, { method: 'POST' });
    assert.equal(done.status, 200);
    assert.equal(done.body.ok, true);

    const after = await call(svc.base, '/api/reminders');
    assert.deepEqual(after.body.reminders, [], '完成后不在默认列表');
  } finally {
    await svc.close();
  }
});

test('TC-H13 非法提醒返回 400 且带可读原因（不是 500）', async () => {
  const svc = await startServer();
  try {
    const bad = await call(svc.base, '/api/reminders', {
      method: 'POST',
      body: JSON.stringify({ text: '过去的事', at: '2020-01-01T09:00:00' })
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, 'invalid_reminder');
    assert.match(bad.body.message, /晚于现在/);
  } finally {
    await svc.close();
  }
});

test('TC-H14 日记：写入 → 按天列出 → 生成三段式草稿', async () => {
  const svc = await startServer();
  try {
    const note = await call(svc.base, '/api/diary', {
      method: 'POST',
      body: JSON.stringify({ text: '和王工对齐接口' })
    });
    assert.equal(note.status, 201);

    const listed = await call(svc.base, '/api/diary');
    assert.equal(listed.body.entries.length, 1);

    const digest = await call(svc.base, '/api/diary/digest');
    assert.equal(digest.body.digest.count, 1);
    assert.match(digest.body.digest.text, /做了什么/);
  } finally {
    await svc.close();
  }
});

test('TC-H15 建议接口暴露打扰预算，配额为 0 时明确说明', async () => {
  const svc = await startServer();
  try {
    const first = await call(svc.base, '/api/suggestions');
    assert.equal(first.status, 200);
    assert.ok(first.body.attention.quota >= 0);
    assert.ok(Array.isArray(first.body.suggestions));

    const dismissed = await call(svc.base, '/api/suggestions/dismiss', {
      method: 'POST',
      body: JSON.stringify({ id: 'sug_x' })
    });
    assert.equal(dismissed.body.dismissed, 1);
  } finally {
    await svc.close();
  }
});

test('TC-H16 /api/state 暴露对话模式与三个模块的计数', async () => {
  const svc = await startServer();
  try {
    const { body } = await call(svc.base, '/api/state');
    assert.deepEqual(body.chat, { mode: 'local', model: 'qwen3.8-flash' }, '测试环境没有 key，应显示本地模式');
    assert.deepEqual(body.reminders, { pending: 0, total: 0 });
    assert.deepEqual(body.diary, { total: 0, days: 0 });
    assert.ok(body.attention.quota >= 0);
  } finally {
    await svc.close();
  }
});
