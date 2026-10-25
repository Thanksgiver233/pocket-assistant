#!/usr/bin/env node
/**
 * pa-forget — physically delete memory and its index residue, then verify.
 *
 * "Forget" is a security promise, not a soft delete: after this command the
 * data must be gone from the memory store *and* from the personal lane, and
 * the command must prove it rather than trust its own return value. That is
 * why the flow is stat -> forget -> stat and why a mismatch exits 2 (docs/06
 * §8: "0 已清除并校验；2 仍有残留").
 *
 * Scope is required on purpose: a destructive command must never default to
 * "delete everything".
 *
 * @module @piagent/personal/bin/pa-forget
 */

import {
  EXIT,
  createLogger,
  isInside,
  parseCliArgs,
  printJson,
  resolveHomeDir,
  resolveWorkspace,
  runMain,
  singlePositional,
  usageError,
  withAgent,
  writeErr,
  writeOut
} from './_common.mjs';

const NAME = 'pa-forget';

const HELP = `pa-forget — 物理删除记忆与索引残留，并在删除后复查

用法:
  pa-forget [dir] --scope <all|D0|D1|D2|D3|subject|tag> [--since <ISO>] [选项]

参数:
  [dir]                     工作区根目录（默认：当前目录）

选项:
      --scope <value>      必填。all = 全部；D0–D3 = 按数据级别；其他值 = subject 或 tag
      --since <ISO>         只删除该时间之后创建的记录（ISO 8601，例如 2026-10-01T00:00:00+08:00）
      --home <dir>          机器级状态 ~/.pi/pa 的 home（默认 $PA_HOME 或系统 home）
      --json                输出机器可读 JSON
  -h, --help                显示本帮助

复查（退出码 2 的依据）:
  删除后重新读取 memory.stat() 与 lane.stat()：索引计数必须正好减少报告的条数，
  memory 计数不得增加；--scope all（不带 --since）必须归零。否则视为残留。

退出码:
  0  已清除并校验
  1  未能执行（配置错误等）
  2  参数错误 / 删除后仍有残留`;

const OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  json: { type: 'boolean' },
  home: { type: 'string' },
  scope: { type: 'string' },
  since: { type: 'string' }
};

await runMain(NAME, process.argv.slice(2), async (argv, ctx) => {
  const { values, positionals } = parseCliArgs(argv, {
    options: OPTIONS,
    allowPositionals: true
  });
  if (values.help === true) {
    writeOut(HELP);
    return EXIT.OK;
  }

  const dirArg = singlePositional(positionals);
  const workspaceRoot = resolveWorkspace(dirArg);
  const homeDir = resolveHomeDir(values.home);
  const scope = normaliseScope(values.scope);
  const since = normaliseSince(values.since);
  const logger = createLogger();
  if (isInside(workspaceRoot, homeDir)) {
    logger.warn('机器级状态目录位于工作区内：工作区不得自我授权（docs/04 §5.3）');
  }

  const outcome = await withAgent({ workspaceRoot, homeDir, logger }, async (api) => {
    const memory = api.services.memory;
    const lane = api.services.lane;

    const beforeMemory = await memory.stat();
    const beforeLane = await lane.stat();
    const result = await api.forget({ scope, since });
    const afterMemory = await memory.stat();
    const afterLane = await lane.stat();

    return {
      result,
      beforeMemory,
      afterMemory,
      beforeLane,
      afterLane,
      residue: verifyForget({ scope, since, result, beforeMemory, afterMemory, beforeLane, afterLane })
    };
  });

  const payload = forgetPayload({ scope, since, ...outcome });

  if (ctx.json) printJson(payload);
  else writeForgetReport(payload);

  return payload.exitCode;
});

/**
 * @param {unknown} value
 * @returns {string}
 */
function normaliseScope(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw usageError('缺少 --scope：请指定 all、数据级别（D0–D3）或 subject/tag');
  }
  const scope = value.trim();
  if (scope.length > 200) throw usageError('--scope 过长（最多 200 字符）');
  if (/^D\d$/u.test(scope) && !['D0', 'D1', 'D2', 'D3'].includes(scope)) {
    throw usageError('--scope 的数据级别必须是 D0 | D1 | D2 | D3');
  }
  return scope;
}

/**
 * @param {unknown} value
 * @returns {string|undefined}
 */
function normaliseSince(value) {
  if (value === undefined) return undefined;
  const since = String(value);
  if (Number.isNaN(Date.parse(since))) {
    throw usageError('--since 不是合法的 ISO 8601 时间，例如 2026-10-01T00:00:00+08:00');
  }
  return since;
}

/**
 * The "did it really go" check. This is the command's reason to exist.
 * @param {{scope: string, since?: string, result: Object, beforeMemory: Object,
 *          afterMemory: Object, beforeLane: Object, afterLane: Object}} input
 * @returns {string[]} human-readable problems; empty means verified
 */
function verifyForget({ scope, since, result, beforeMemory, afterMemory, beforeLane, afterLane }) {
  const memBefore = memorySummary(beforeMemory);
  const memAfter = memorySummary(afterMemory);
  const laneBefore = Number(beforeLane?.records ?? 0);
  const laneAfter = Number(afterLane?.records ?? 0);
  const removed = Number(result?.removed ?? 0);
  const indexRemoved = Number(result?.indexRemoved ?? 0);
  /** @type {string[]} */
  const problems = [];

  // The index counter must match what forget() reported: a gap means either
  // forgotten data survived or unrelated data was destroyed.
  if (laneAfter !== laneBefore - indexRemoved) {
    problems.push(
      `索引计数不一致: 删除前 ${laneBefore}, 删除后 ${laneAfter}, 报告删除 ${indexRemoved}`
    );
  }
  // Deletion may not increase any counter.
  if (memAfter.active > memBefore.active) {
    problems.push(`memory.active 增加: ${memBefore.active} -> ${memAfter.active}`);
  }
  if (memAfter.total > memBefore.total) {
    problems.push(`memory.total 增加: ${memBefore.total} -> ${memAfter.total}`);
  }
  if (memAfter.candidates > memBefore.candidates) {
    problems.push(`memory.candidates 增加: ${memBefore.candidates} -> ${memAfter.candidates}`);
  }
  // If forget() claims work but neither facts nor candidates shrank, nothing
  // was actually deleted.
  if (
    removed > 0 &&
    memAfter.total === memBefore.total &&
    memAfter.candidates === memBefore.candidates
  ) {
    problems.push(`报告删除 ${removed} 条记忆，但 memory 计数未变化`);
  }
  // `--scope all` without `--since` is the one case that must end empty; with
  // `--since` the store is filtered by time, so "not zero" is expected.
  if (scope === 'all' && since === undefined) {
    if (memAfter.total !== 0 || memAfter.active !== 0) {
      problems.push(`scope=all 仍有记忆残留: ${memAfter.total} 条（active ${memAfter.active}）`);
    }
    if (memAfter.candidates !== 0) {
      problems.push(`scope=all 仍有候选记忆残留: ${memAfter.candidates} 条`);
    }
    if (memAfter.episodes !== 0) {
      problems.push(`scope=all 仍有情景记忆残留: ${memAfter.episodes} 条`);
    }
    if (laneAfter !== 0) {
      problems.push(`scope=all 仍有索引残留: ${laneAfter} 条`);
    }
  }
  return problems;
}

/**
 * @param {{total?: number, active?: number, candidates?: number, episodes?: number}} stat
 * @returns {{total: number, active: number, candidates: number, episodes: number}}
 */
function memorySummary(stat) {
  return {
    total: Number(stat?.total ?? 0),
    active: Number(stat?.active ?? 0),
    candidates: Number(stat?.candidates ?? 0),
    episodes: Number(stat?.episodes ?? 0)
  };
}

/**
 * @param {{scope: string, since?: string, result: Object, beforeMemory: Object,
 *          afterMemory: Object, beforeLane: Object, afterLane: Object, residue: string[]}} input
 * @returns {Object}
 */
function forgetPayload({ scope, since, result, beforeMemory, afterMemory, beforeLane, afterLane, residue }) {
  const clean = residue.length === 0;
  return {
    ok: clean,
    exitCode: clean ? EXIT.OK : EXIT.USAGE,
    scope,
    since: since ?? null,
    removed: Number(result?.removed ?? 0),
    removedEpisodes: Number(result?.removedEpisodes ?? 0),
    indexRemoved: Number(result?.indexRemoved ?? 0),
    memory: {
      before: memorySummary(beforeMemory),
      after: memorySummary(afterMemory)
    },
    lane: {
      before: Number(beforeLane?.records ?? 0),
      after: Number(afterLane?.records ?? 0)
    },
    residue
  };
}

/** @param {Object} payload */
function writeForgetReport(payload) {
  writeOut(`${NAME}: ${payload.ok ? '已清除并校验' : '删除后校验失败'}`);
  writeOut(`  scope     ${payload.scope}`);
  writeOut(`  since     ${payload.since ?? '（无）'}`);
  writeOut(
    `  memory    active ${payload.memory.before.active} -> ${payload.memory.after.active}` +
      `（删除事实 ${payload.removed} 条 / 情景 ${payload.removedEpisodes} 条）`
  );
  writeOut(
    `  index     records ${payload.lane.before} -> ${payload.lane.after}（报告删除 ${payload.indexRemoved} 条）`
  );
  for (const problem of payload.residue) writeErr(`${NAME}: 残留 — ${problem}`);
  writeOut(`  退出码    ${payload.exitCode}`);
}
