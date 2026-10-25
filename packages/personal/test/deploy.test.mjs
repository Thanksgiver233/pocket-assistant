/**
 * Deployment artefacts are part of the product — so they get tests too.
 *
 * A deployment plan rots silently: someone edits a port in one file, the
 * compose file keeps the old one, and nobody notices until the box is down.
 * These checks pin the cross-file invariants that actually matter.
 *
 * @module @piagent/personal/test/deploy
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = dirname(dirname(PACKAGE_ROOT));
const DEPLOY = join(REPO_ROOT, 'deploy');

const read = (relative) => readFile(join(DEPLOY, relative), 'utf8');

test('TC-P01 预算表自洽：每行 qty×unitPrice=amount，合计不超抵扣券', async () => {
  const budget = JSON.parse(await read('budget.json'));
  assert.ok(budget.voucher > 0);
  assert.ok(Array.isArray(budget.items) && budget.items.length >= 6);

  let total = 0;
  for (const item of budget.items) {
    const computed = Math.round(item.qty * item.unitPrice * 100) / 100;
    assert.ok(
      Math.abs(computed - item.amount) < 0.01,
      `${item.id}: ${item.qty}×${item.unitPrice}=${computed}，声明 ${item.amount}`
    );
    assert.ok(item.basis && item.basis.trim(), `${item.id} 缺少价格依据`);
    total += computed;
  }
  const grand = Math.round((total + budget.reserve.amount) * 100) / 100;
  assert.ok(grand <= budget.voucher, `合计 ${grand} 超过 ${budget.voucher}`);
  // 不把额度花到 100%：涨价/试错需要余量。
  assert.ok(grand <= budget.voucher * 0.95, `合计 ${grand} 占额度 ${(grand / budget.voucher * 100).toFixed(1)}%，留白不足`);
});

test('TC-P02 budget-check 可执行且退出码 0（预算结论可复算）', () => {
  const result = spawnSync(process.execPath, [join(DEPLOY, 'budget-check.mjs'), '--json'], {
    encoding: 'utf8',
    timeout: 20_000
  });
  assert.equal(result.status, 0, `budget-check 失败: ${result.stderr || result.stdout}`);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.ok(payload.headroom > 0, '必须留有余额');
  assert.deepEqual(payload.problems, []);
});

test('TC-P03 部署工件齐全', async () => {
  const expected = [
    'Dockerfile',
    'docker-compose.yml',
    'docker-entrypoint.sh',
    '.env.example',
    'bootstrap.sh',
    'backup.sh',
    'nginx/pa.conf',
    'systemd/pa.service'
  ];
  for (const file of expected) {
    const info = await stat(join(DEPLOY, file));
    assert.ok(info.isFile(), `${file} 缺失`);
  }
});

test('TC-P04 systemd 单元：内存上限、只读系统、单一可写路径', async () => {
  const unit = await read('systemd/pa.service');
  assert.match(unit, /^MemoryMax=700M$/m);
  assert.match(unit, /^ProtectSystem=strict$/m);
  assert.match(unit, /^NoNewPrivileges=true$/m);
  assert.match(unit, /^ReadWritePaths=\/var\/lib\/pa$/m);
  assert.match(unit, /^EnvironmentFile=\/etc\/pa\/pa\.env$/m);
  assert.match(unit, /^User=pa$/m);
  // 令牌不能出现在单元文件里
  assert.doesNotMatch(unit, /PA_TOKEN=\S+/);
});

test('TC-P05 Nginx：反代到 8787、HSTS、请求体上限、ACME 通道', async () => {
  const conf = await read('nginx/pa.conf');
  assert.match(conf, /proxy_pass http:\/\/127\.0\.0\.1:8787/);
  assert.match(conf, /Strict-Transport-Security/);
  assert.match(conf, /client_max_body_size 128k/);
  assert.match(conf, /\.well-known\/acme-challenge/);
  assert.match(conf, /limit_req zone=pa_api/);
  // 不允许把 Node 直接暴露到 0.0.0.0
  assert.doesNotMatch(conf, /proxy_pass http:\/\/0\.0\.0\.0/);
});

test('TC-P06 容器：非 root、只映射回环、只读根文件系统、带健康检查', async () => {
  const dockerfile = await read('Dockerfile');
  assert.match(dockerfile, /^USER node$/m);
  assert.match(dockerfile, /packages\/personal\/web/);
  assert.match(dockerfile, /HEALTHCHECK/);

  const compose = await read('docker-compose.yml');
  assert.match(compose, /"127\.0\.0\.1:8787:8787"/);
  assert.match(compose, /read_only: true/);
  assert.match(compose, /no-new-privileges:true/);
  assert.match(compose, /mem_limit: 700m/);
});

test('TC-P07 .env.example 只有占位符，不含可用令牌', async () => {
  const env = await read('.env.example');
  assert.match(env, /PA_TOKEN=CHANGE_ME/);
  assert.doesNotMatch(env, /PA_TOKEN=[A-Za-z0-9_-]{24,}/);
});

test('TC-P08 pa-serve 已注册为 bin，且默认只绑回环', async () => {
  const pkg = JSON.parse(await readFile(join(PACKAGE_ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.bin['pa-serve'], './bin/pa-serve.mjs');
  const cli = await readFile(join(PACKAGE_ROOT, 'bin', 'pa-serve.mjs'), 'utf8');
  assert.match(cli, /'127\.0\.0\.1'/);
  assert.match(cli, /TOKEN_REQUIRED/);
});

test('TC-P09 Web UI 不引用任何第三方资源（CSP 能收紧到 self 的前提）', async () => {
  const html = await readFile(join(PACKAGE_ROOT, 'web', 'index.html'), 'utf8');
  // 允许出现在文本/注释里的 URL，但不允许任何外链资源属性。
  const external = html.match(/(?:src|href)\s*=\s*["']https?:\/\/[^"']+/gi) ?? [];
  assert.deepEqual(external, [], `页面不得加载外部资源: ${external.join(', ')}`);
  assert.match(html, /id="tokenInput"/, '必须有令牌入口');
  assert.match(html, /id="modeSel"/, '必须能切换权限档位（否则看不到审批链路）');
  assert.match(html, /authorization/i, '请求必须带鉴权头');
});
