#!/usr/bin/env node
/**
 * pa-doctor — answer one question: "can this workspace run right now?"
 *
 * The exit code is the verdict (0 = operable, non-zero = not), exactly like
 * `piagent-mcp doctor`; the table is only evidence for that verdict. Checks
 * come from the composed agent (`api.doctor()`), so the CLI cannot disagree
 * with what a host would see.
 *
 * Extra documented flags (docs/06 §8): `--export` dumps the hash-chained
 * audit ledger, `--verify-undo <tool>` proves a manifest's undo target is
 * really registered.
 *
 * @module @piagent/personal/bin/pa-doctor
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

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
  withAgent,
  writeOut
} from './_common.mjs';
import { ensureDir } from '../src/core/jsonl.mjs';

const NAME = 'pa-doctor';

const HELP = `pa-doctor — 体检：回答"这个工作区现在能不能运行"

用法:
  pa-doctor [dir] [选项]

参数:
  [dir]                     工作区根目录（默认：当前目录）

选项:
      --home <dir>          机器级状态 ~/.pi/pa 的 home（默认 $PA_HOME 或系统 home）
      --export              把审计账本导出到 <pa-state>/audit/export-<时间>.jsonl
      --verify-undo <tool>  额外检查某工具声明的 undo 策略真实存在（可重复）
      --json                输出机器可读 JSON
  -h, --help                显示本帮助

退出码:
  0  可运行（无 FAIL 项；WARN 不影响）
  1  不可运行 / 未完成（存在 FAIL 项或配置错误）
  2  参数错误`;

const OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  json: { type: 'boolean' },
  home: { type: 'string' },
  export: { type: 'boolean' },
  'verify-undo': { type: 'string', multiple: true }
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
  const logger = createLogger();
  const verifyTools = normaliseVerifyList(values['verify-undo']);

  const outcome = await withAgent({ workspaceRoot, homeDir, logger }, async (api) => {
    const report = await finishDoctor(api, verifyTools, { workspaceRoot, homeDir });
    const exportPath = values.export === true ? await exportLedger(api) : null;
    return { report, exportPath };
  });

  const payload = {
    ok: outcome.report.ok,
    exitCode: outcome.report.exitCode,
    workspaceRoot,
    checks: outcome.report.checks,
    at: outcome.report.at,
    ...(outcome.exportPath ? { exportPath: outcome.exportPath } : {})
  };

  if (ctx.json) printJson(payload);
  else writeHumanReport(payload);

  return payload.exitCode;
});

/**
 * @param {unknown} value parseArgs value (array when `multiple: true`)
 * @returns {string[]}
 */
function normaliseVerifyList(value) {
  if (Array.isArray(value)) return value.map((entry) => String(entry));
  if (typeof value === 'string' && value) return [value];
  return [];
}

/**
 * Compose the doctor report and fold in the extra `--verify-undo` checks.
 * `runDoctor` already computes `ok`, but adding checks requires recomputing it
 * so a broken undo target really fails the command.
 * @param {Object} api
 * @param {string[]} verifyTools
 * @param {{workspaceRoot: string, homeDir: string}} ctx
 * @returns {Promise<{ok: boolean, exitCode: number, checks: Object[], at: string}>}
 */
async function finishDoctor(api, verifyTools, { workspaceRoot, homeDir }) {
  const base = await api.doctor();
  const checks = Array.isArray(base?.checks) ? [...base.checks] : [];
  checks.push(machineHomeCheck(workspaceRoot, homeDir));
  for (const toolId of verifyTools) checks.push(verifyUndo(api, toolId));
  const ok = checks.every((check) => check.status !== 'fail');
  return {
    ok,
    exitCode: ok ? EXIT.OK : EXIT.INCOMPLETE,
    checks,
    at: base?.at ?? new Date().toISOString()
  };
}

/**
 * P0-1 defence at the CLI boundary: the CLI always passes an explicit
 * `homeDir`, but `--home` must not be pointed inside the workspace, or the
 * workspace could ship its own grants.
 * @param {string} workspaceRoot
 * @param {string} homeDir
 * @returns {{id: string, status: 'pass'|'fail', detail: string}}
 */
function machineHomeCheck(workspaceRoot, homeDir) {
  if (isInside(workspaceRoot, homeDir)) {
    return {
      id: 'machine_home',
      status: 'fail',
      detail: `homeDir 位于工作区内 (${homeDir})：工作区不得自我授权（docs/04 §5.3）`
    };
  }
  return { id: 'machine_home', status: 'pass', detail: homeDir };
}

/**
 * Verify that a manifest's `undo` names a registered tool.
 * @param {Object} api
 * @param {string} toolId
 * @returns {{id: string, status: 'pass'|'warn'|'fail', detail: string}}
 */
function verifyUndo(api, toolId) {
  const registry = api.services?.registry;
  const manifest = registry?.get ? registry.get(toolId) : null;
  if (!manifest) {
    return { id: `undo:${toolId}`, status: 'fail', detail: `工具未注册: ${toolId}` };
  }
  const undo = manifest.undo;
  if (!undo || typeof undo !== 'object') {
    // A read-only tool legitimately promises nothing to undo. That is a
    // warning (the operator asked a question the manifest cannot answer),
    // not a reason to declare the workspace unusable.
    return { id: `undo:${toolId}`, status: 'warn', detail: 'manifest 未声明 undo 策略' };
  }
  if (undo.tool && !registry.get(undo.tool)) {
    return { id: `undo:${toolId}`, status: 'fail', detail: `undo 工具未注册: ${undo.tool}` };
  }
  const strategy = undo.strategy ?? 'unknown';
  const windowS = undo.window_s ?? 0;
  return {
    id: `undo:${toolId}`,
    status: 'pass',
    detail: `undo.tool=${undo.tool ?? '-'} strategy=${strategy} window_s=${windowS}`
  };
}

/**
 * Export the append-only audit ledger next to it. This is evidence, not a
 * backup: the JSONL copy is what an operator hands to a reviewer.
 * @param {Object} api
 * @returns {Promise<string>} absolute path written
 */
async function exportLedger(api) {
  const dir = api.paths?.auditDir;
  if (!dir) throw new Error('无法定位审计目录（pa-state/audit）');
  const content = await api.services.audit.export({});
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = join(dir, `export-${stamp}.jsonl`);
  await ensureDir(dir);
  await writeFile(file, content === '' || content.endsWith('\n') ? content : `${content}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });
  return file;
}

/** @param {Object} payload */
function writeHumanReport(payload) {
  writeOut(`${NAME} — ${payload.workspaceRoot}`);
  writeOut('');
  for (const check of payload.checks) {
    const mark = check.status === 'pass' ? 'PASS' : check.status === 'warn' ? 'WARN' : 'FAIL';
    writeOut(`  ${mark}  ${String(check.id).padEnd(16)}  ${check.detail}`);
  }
  writeOut('');
  writeOut(payload.ok ? '结论: 可运行 (exit 0)' : '结论: 不可运行 (exit 1) — 请先修复 FAIL 项');
  if (payload.exportPath) writeOut(`审计账本已导出: ${payload.exportPath}`);
}
