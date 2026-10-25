#!/usr/bin/env node
/**
 * pa-run — execute exactly one Turn, or continue a paused Run.
 *
 * This is the non-interactive face of the agent: it composes against the mock
 * HostPort (no Pi session needed), runs one turn, prints what happened and
 * maps the Run status to the contract exit code (docs/06 §8):
 *
 *   0 done · 1 blocked/failed/aborted/config error · 3 denied · 4 awaiting approval
 *
 * Two safety properties matter here:
 *  - the raw prompt is never echoed back and `--json` never includes it;
 *  - artifacts belonging to an action that touches D2 data are reported by
 *    kind only (metadata), never by content. Everything else is redacted for
 *    credential-shaped strings and capped.
 *
 * @module @piagent/personal/bin/pa-run
 */

import { PERMISSION_MODE, RUN_STATUS } from '../src/core/contracts.mjs';
import {
  createLogger,
  exitCodeForStatus,
  isInside,
  parseCliArgs,
  printJson,
  redactSecrets,
  resolveHomeDir,
  resolveWorkspace,
  runMain,
  singlePositional,
  truncate,
  usageError,
  withAgent,
  writeOut
} from './_common.mjs';

const NAME = 'pa-run';

const HELP = `pa-run — 非交互执行一次 Turn，或续跑一个等待中的 Run

用法:
  pa-run [dir] -p "..." [选项]
  pa-run [dir] --resume <runId> [--approve | --reject] [选项]

参数:
  [dir]                     工作区根目录（默认：当前目录）

选项:
  -p, --prompt <text>       本次 Turn 的输入（--resume 时不需要）
      --mode <mode>         read-only | workspace-write | full-access（默认取 profile）
      --resume <runId>      续跑指定 run（先查询状态；加 --approve/--reject 才执行）
      --approve             批准该 run 等待中的动作（需配合 --resume）
      --reject              拒绝该 run 等待中的动作（需配合 --resume）
      --home <dir>          机器级状态 ~/.pi/pa 的 home（默认 $PA_HOME 或系统 home）
      --json                输出机器可读 JSON
  -h, --help                显示本帮助

输出:
  人类模式会打印决策、产物摘要与下一步；--json 输出结构化结果。
  D2 敏感动作的产物只输出元数据（不输出正文）；所有文本都会截断。

退出码:
  0  完成（status=done）
  1  未完成（blocked / failed / aborted / 配置错误）
  2  参数错误
  3  权限拒绝（status=denied）
  4  等待审批（status=awaiting_approval）`;

const OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  json: { type: 'boolean' },
  home: { type: 'string' },
  prompt: { type: 'string', short: 'p' },
  mode: { type: 'string' },
  resume: { type: 'string' },
  approve: { type: 'boolean' },
  reject: { type: 'boolean' }
};

await runMain(NAME, process.argv.slice(2), async (argv, ctx) => {
  const { values, positionals } = parseCliArgs(argv, {
    options: OPTIONS,
    allowPositionals: true
  });
  if (values.help === true) {
    writeOut(HELP);
    return 0;
  }

  const dirArg = singlePositional(positionals);
  const workspaceRoot = resolveWorkspace(dirArg);
  const homeDir = resolveHomeDir(values.home);
  const logger = createLogger();
  if (isInside(workspaceRoot, homeDir)) {
    logger.warn('机器级状态目录位于工作区内：工作区不得自我授权（docs/04 §5.3）');
  }

  const resumeId = typeof values.resume === 'string' ? values.resume : undefined;
  const prompt = typeof values.prompt === 'string' ? values.prompt : undefined;
  const approve = values.approve === true;
  const reject = values.reject === true;
  const mode = values.mode;

  // Argument validation happens before any workspace file is touched, so a
  // typo can never spend a turn, write state or ask for approval.
  if (approve && reject) throw usageError('--approve 与 --reject 互斥');
  if ((approve || reject) && !resumeId) {
    throw usageError('--approve / --reject 只能配合 --resume <runId> 使用');
  }
  if (resumeId && prompt !== undefined) {
    throw usageError('--resume 与 -p 互斥：续跑不会再读取新的输入');
  }
  if (resumeId && mode !== undefined) {
    throw usageError('--mode 不能与 --resume 同用（档位已记录在该 run 中）');
  }
  if (!resumeId && (prompt === undefined || prompt.trim() === '')) {
    throw usageError('缺少输入：请用 -p "..." 指定一次 Turn，或用 --resume <runId> 续跑');
  }
  // `gateway.submit` rejects >8000 chars; fail as a usage error here so the
  // caller gets exit 2 instead of a runtime config error.
  if (!resumeId && prompt !== undefined && prompt.length > 8000) {
    throw usageError('-p 文本超过 8000 字符上限');
  }
  if (mode !== undefined && !Object.values(PERMISSION_MODE).includes(mode)) {
    throw usageError(`--mode 必须是 ${Object.values(PERMISSION_MODE).join(' | ')}`);
  }

  const outcome = await withAgent({ workspaceRoot, homeDir, logger }, async (api) => {
    if (!resumeId) {
      const result = await api.turn(prompt, { channel: 'cli', mode });
      return { kind: 'turn', result, actions: result.proposal?.actions ?? [] };
    }

    const run = await api.services.journal.load(resumeId);
    if (!approve && !reject) return { kind: 'inspect', run };

    // Capture the confirmed action's data classes *before* the resume clears
    // `pending`, so artifact projection can still honour the D2 rule.
    const actions = run.pending
      ? [
          {
            id: run.pending.actionId,
            kind: run.pending.card?.kind,
            dataIn: run.pending.card?.dataIn ?? []
          }
        ]
      : [];
    const runMode = run.mode;
    const result = await api.approve(resumeId, { approve });
    return { kind: 'decision', result, actions, mode: runMode };
  });

  const payload =
    outcome.kind === 'inspect'
      ? inspectPayload(outcome.run)
      : turnPayload(outcome.result, outcome.actions, outcome.mode);

  if (ctx.json) printJson(payload);
  else if (outcome.kind === 'inspect') writeInspectReport(payload);
  else writeTurnReport(payload);

  return payload.exitCode;
});

/**
 * Convert the library's RunResult into a printable/machine payload.
 * @param {Object} result
 * @param {Object[]} actions proposal actions (for data-class projection)
 * @param {string} [fallbackMode] journal mode (resume path has no Turn)
 * @returns {Object}
 */
function turnPayload(result, actions, fallbackMode) {
  const status = String(result?.status ?? 'unknown');
  const exitCode = exitCodeForStatus(status);
  const steps = Array.isArray(result?.steps) ? result.steps : [];
  const lastStep = steps.length > 0 ? steps[steps.length - 1] : undefined;
  const pending = result?.pending ?? null;
  const decision = result?.decision ?? null;

  return {
    ok: status === RUN_STATUS.DONE,
    exitCode,
    status,
    runId: result?.runId ?? null,
    mode: result?.turn?.mode ?? fallbackMode ?? null,
    decisions: (Array.isArray(result?.decisions) ? result.decisions : []).map((entry) => ({
      actionId: entry.actionId ?? null,
      kind: entry.kind ?? null,
      risk: entry.risk ?? null,
      verdict: entry.verdict ?? null,
      reason: entry.reason ?? null,
      requires: entry.requires ?? null
    })),
    decision: decision
      ? {
          verdict: decision.verdict ?? null,
          reason: decision.reason ?? null,
          requires: decision.requires ?? null,
          risk: decision.risk ?? null
        }
      : null,
    artifacts: projectArtifacts(result?.artifacts ?? [], actions),
    pending: pending
      ? {
          actionId: pending.actionId ?? null,
          risk: pending.risk ?? null,
          requires: pending.requires ?? null,
          title: pending.card?.title ?? null,
          options: pending.card?.options ?? null
        }
      : null,
    steps: steps.map((step) => ({
      actionId: step.actionId ?? null,
      status: step.status ?? null,
      tools: Array.isArray(step.tools) ? step.tools : [],
      error: errorCode(step.error)
    })),
    error: lastStep ? errorCode(lastStep.error) : null
  };
}

/**
 * Journal-only view for `--resume <id>` without a decision. Deliberately
 * omits `intent` (raw prompt) and artifact bodies.
 * @param {Object} run
 * @returns {Object}
 */
function inspectPayload(run) {
  const status = String(run?.status ?? 'unknown');
  const exitCode = exitCodeForStatus(status);
  const pending = run?.pending ?? null;
  return {
    ok: status === RUN_STATUS.DONE,
    exitCode,
    status,
    runId: run?.run_id ?? null,
    mode: run?.mode ?? null,
    actions: (Array.isArray(run?.actions) ? run.actions : []).map((action) => ({
      id: action.id ?? null,
      kind: action.kind ?? null,
      risk: action.risk ?? null,
      status: action.status ?? null
    })),
    steps: Array.isArray(run?.steps) ? run.steps.length : 0,
    artifactCount: Array.isArray(run?.artifacts) ? run.artifacts.length : 0,
    pending: pending
      ? {
          actionId: pending.actionId ?? null,
          risk: pending.risk ?? null,
          requires: pending.requires ?? null,
          title: pending.card?.title ?? null,
          options: pending.card?.options ?? null
        }
      : null
  };
}

/**
 * Project artifacts for output. An artifact produced by an action whose
 * declared input is D2 is reduced to metadata; the rest is credential-redacted
 * and capped at 2000 chars.
 * @param {Object[]} artifacts
 * @param {Object[]} actions
 * @returns {Object[]}
 */
function projectArtifacts(artifacts, actions) {
  const dataClassesByAction = new Map(
    (Array.isArray(actions) ? actions : []).map((action) => [action.id, action.dataIn ?? []])
  );

  return (Array.isArray(artifacts) ? artifacts : []).map((artifact) => {
    const classes = dataClassesByAction.get(artifact.actionId) ?? [];
    const touchesD2 = classes.includes('D2');
    if (touchesD2) {
      return {
        kind: artifact.kind ?? 'artifact',
        actionId: artifact.actionId ?? null,
        toolId: artifact.toolId ?? null,
        redacted: true,
        text: null
      };
    }
    const text = typeof artifact.text === 'string' ? redactSecrets(artifact.text) : null;
    return {
      kind: artifact.kind ?? 'artifact',
      actionId: artifact.actionId ?? null,
      toolId: artifact.toolId ?? null,
      path: artifact.path ?? null,
      redacted: false,
      text: text === null ? null : text.slice(0, 2000)
    };
  });
}

/** @param {unknown} error @returns {string|null} */
function errorCode(error) {
  if (!error) return null;
  if (typeof error === 'string') return error.slice(0, 120);
  return typeof error.code === 'string' ? error.code : null;
}

/** @param {string} status @returns {string} */
function statusHint(status) {
  switch (status) {
    case RUN_STATUS.DONE:
      return '';
    case RUN_STATUS.DENIED:
      return '  （权限拒绝：不会被自动绕过）';
    case RUN_STATUS.AWAITING_APPROVAL:
      return '  （等待审批）';
    default:
      return '  （未完成）';
  }
}

/** @param {Object} payload */
function writeTurnReport(payload) {
  writeOut(`${NAME}: ${payload.status}   run=${payload.runId ?? '-'}`);

  if (payload.decisions.length === 0) writeOut('  决策       （无）');
  for (const decision of payload.decisions) {
    const suffix = decision.reason ? ` (${decision.reason})` : '';
    const requires = decision.requires && decision.requires !== 'none' ? ` requires=${decision.requires}` : '';
    writeOut(
      `  决策       ${decision.kind ?? decision.actionId} [${decision.risk ?? '?'}] -> ${decision.verdict}${suffix}${requires}`
    );
  }
  if (payload.decision) {
    const reason = payload.decision.reason ? ` (${payload.decision.reason})` : '';
    writeOut(`  裁决       ${payload.decision.verdict}${reason}`);
  }

  if (payload.artifacts.length === 0) writeOut('  产物       （无）');
  payload.artifacts.forEach((artifact, index) => {
    if (artifact.redacted) {
      writeOut(`  产物 #${index + 1}   ${artifact.kind}（D2 内容不输出）`);
    } else if (artifact.text) {
      writeOut(`  产物 #${index + 1}   ${truncate(artifact.text, 240)}`);
    } else {
      const path = artifact.path ? ` (${artifact.path})` : '';
      writeOut(`  产物 #${index + 1}   ${artifact.kind}${path}`);
    }
  });

  if (payload.pending) {
    writeOut(
      `  待审批     ${payload.pending.title ?? payload.pending.actionId}  risk=${payload.pending.risk} requires=${payload.pending.requires}`
    );
    writeOut(`  下一步     ${NAME} --resume ${payload.runId} --approve   （拒绝用 --reject）`);
  }
  if (payload.error) writeOut(`  失败原因   ${payload.error}`);
  writeOut(`  退出码     ${payload.exitCode}${statusHint(payload.status)}`);
}

/** @param {Object} payload */
function writeInspectReport(payload) {
  writeOut(`${NAME}: 未执行，仅查询 run 状态`);
  writeOut(`  run      ${payload.runId}`);
  writeOut(`  status   ${payload.status}`);
  writeOut(`  mode     ${payload.mode}`);
  const actions = payload.actions.map((action) => `${action.kind}[${action.risk}]=${action.status}`).join(', ');
  writeOut(`  actions  ${actions || '-'}`);
  writeOut(`  steps    ${payload.steps}`);
  if (payload.pending) {
    writeOut(
      `  pending  ${payload.pending.title ?? payload.pending.actionId}  risk=${payload.pending.risk} requires=${payload.pending.requires}`
    );
    writeOut(`  下一步   ${NAME} --resume ${payload.runId} --approve   （拒绝用 --reject）`);
  }
  writeOut(`  退出码   ${payload.exitCode}${statusHint(payload.status)}`);
}
