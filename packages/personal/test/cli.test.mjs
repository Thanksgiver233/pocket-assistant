/**
 * CLI contract tests (docs/06 §8).
 *
 * These tests spawn the real executables with `node` and assert only on the
 * public contract: exit code + stdout/stderr. They never call `pa-init` on a
 * real directory and never compose an agent, so they are safe to run against
 * any checkout — the only filesystem access is reading the bin/ sources.
 *
 * Run with: node --test test/
 *
 * @module @piagent/personal/test/cli
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = dirname(testDir);
const binDir = join(packageRoot, 'bin');

const CLI_NAMES = ['pa-init', 'pa-doctor', 'pa-run', 'pa-forget', 'pa-grant'];

/**
 * Run one CLI synchronously. `process.execPath` is used instead of a bare
 * `node` so the test runs with the same interpreter that runs the test runner.
 * @param {string} name
 * @param {string[]} args
 * @returns {{status: number|null, stdout: string, stderr: string}}
 */
function runCli(name, args) {
  const script = join(binDir, `${name}.mjs`);
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: packageRoot,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, PA_DEBUG: '' }
  });
  if (result.error) {
    assert.fail(`${name} ${args.join(' ')} 无法启动: ${result.error.message}`);
  }
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** @param {{stdout: string, stderr: string}} result */
function combined(result) {
  return `${result.stdout}${result.stderr}`;
}

// ── `--help` must succeed for every command and document its surface ──────

const HELP_CASES = [
  {
    name: 'pa-init',
    patterns: [/pa-init/, /用法/, /pa-profile\.json/, /pa-state/, /--json/, /退出码/]
  },
  {
    name: 'pa-doctor',
    patterns: [/pa-doctor/, /用法/, /--export/, /--verify-undo/, /--json/, /退出码/]
  },
  {
    name: 'pa-run',
    patterns: [/pa-run/, /用法/, /-p, --prompt/, /--resume/, /--mode/, /--approve/, /--reject/, /退出码/]
  },
  {
    name: 'pa-forget',
    patterns: [/pa-forget/, /用法/, /--scope/, /--since/, /--json/, /退出码/]
  },
  {
    name: 'pa-grant',
    patterns: [/pa-grant/, /用法/, /list/, /issue/, /revoke/, /--connector/, /--data-classes/, /退出码/]
  }
];

for (const { name, patterns } of HELP_CASES) {
  test(`${name} --help 退出码 0 且输出关键信息`, () => {
    const result = runCli(name, ['--help']);
    assert.equal(result.status, 0, `${name} --help 退出码 ${result.status}; stderr: ${result.stderr}`);
    for (const pattern of patterns) {
      assert.match(result.stdout, pattern, `${name} --help 应匹配 ${pattern}`);
    }
  });
}

test('pa-run -h 与 --help 等价', () => {
  const short = runCli('pa-run', ['-h']);
  const long = runCli('pa-run', ['--help']);
  assert.equal(short.status, 0);
  assert.equal(long.status, 0);
  assert.equal(short.stdout, long.stdout);
});

// ── unknown flags are argument errors (exit 2), never stack traces ───────

for (const name of CLI_NAMES) {
  test(`${name} --bad-flag 退出码 2`, () => {
    const result = runCli(name, ['--bad-flag']);
    assert.equal(
      result.status,
      2,
      `${name} --bad-flag 应以 2 退出，实际 ${result.status}; 输出: ${combined(result)}`
    );
    assert.match(combined(result), /--bad-flag/);
    assert.doesNotMatch(combined(result), /node:internal/);
    assert.doesNotMatch(combined(result), /^\s+at\s/m);
  });
}

// ── missing/invalid required arguments are caught before any state is written

const USAGE_CASES = [
  { name: 'pa-init', args: [], label: '缺少 <dir>', pattern: /目录/ },
  { name: 'pa-run', args: [], label: '缺少 -p / --resume', pattern: /-p|--resume/ },
  { name: 'pa-run', args: ['-p', 'hi', '--approve'], label: '--approve 缺少 --resume', pattern: /--resume/ },
  { name: 'pa-run', args: ['-p', 'hi', '--mode', 'bogus'], label: '非法 --mode', pattern: /read-only/ },
  { name: 'pa-forget', args: [], label: '缺少 --scope', pattern: /--scope/ },
  { name: 'pa-forget', args: ['--scope', 'all', '--since', 'not-a-date'], label: '非法 --since', pattern: /--since/ },
  { name: 'pa-grant', args: [], label: '缺少子命令', pattern: /list|issue|revoke/ },
  { name: 'pa-grant', args: ['bogus-command'], label: '未知子命令', pattern: /bogus-command/ },
  { name: 'pa-grant', args: ['issue'], label: 'issue 缺少 --connector', pattern: /--connector/ }
];

for (const { name, args, label, pattern } of USAGE_CASES) {
  test(`${name} ${label} 退出码 2`, () => {
    const result = runCli(name, args);
    assert.equal(
      result.status,
      2,
      `${name} ${label} 应以 2 退出，实际 ${result.status}; 输出: ${combined(result)}`
    );
    assert.match(combined(result), pattern);
    assert.match(result.stderr, /--help/);
  });
}

test('pa-run --json --bad-flag 输出机器可读错误且退出码 2', () => {
  const result = runCli('pa-run', ['--json', '--bad-flag']);
  assert.equal(result.status, 2);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.exitCode, 2);
  assert.equal(parsed.error.code, 'USAGE');
  assert.match(parsed.error.message, /--bad-flag/);
});

// ── static properties the contract depends on ────────────────────────────

test('每个 pa-* CLI 带 node shebang，bin 下不调用 process.exit()', () => {
  const files = readdirSync(binDir).filter((file) => file.endsWith('.mjs'));
  assert.ok(files.length >= CLI_NAMES.length, `bin/ 下应有至少 ${CLI_NAMES.length} 个 CLI，实际 ${files.length}`);

  const sources = files.map((file) => readFileSync(join(binDir, file), 'utf8'));
  const all = sources.join('\n');
  assert.match(all, /process\.exitCode/, 'CLI 必须用 process.exitCode');
  assert.doesNotMatch(all, /process\.exit\(/, 'CLI 不得调用 process.exit()');

  for (const name of CLI_NAMES) {
    const source = readFileSync(join(binDir, `${name}.mjs`), 'utf8');
    assert.ok(source.startsWith('#!/usr/bin/env node\n'), `${name} 缺少 #!/usr/bin/env node shebang`);
  }
});
