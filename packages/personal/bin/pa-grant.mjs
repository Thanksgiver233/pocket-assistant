#!/usr/bin/env node
/**
 * pa-grant — inspect, issue and revoke standing grants.
 *
 * Why this exists: a grant is the *only* way a D2 action (mail, files with
 * personal data) can ever run, and before this command the only way to create
 * one was to hand-write `~/.pi/pa/grants.json`. A consent system whose grants
 * cannot be issued from the product is a consent system nobody can use.
 *
 * Discipline carried over from the library:
 *  - grants are pinned to the connector digest, so `issue` reads the digest
 *    from the live registry instead of accepting one from the command line;
 *  - TTL is clamped by `profile.tools.standing_grant_max_ttl_h`;
 *  - `revoke` persists the revocation (it is not merely dropped);
 *  - machine state lives outside the workspace (P0-1), enforced by compose.
 *
 * @module @piagent/personal/bin/pa-grant
 */

import {
  CliError,
  EXIT,
  createLogger,
  parseCliArgs,
  printJson,
  resolveHomeDir,
  resolveWorkspace,
  runMain,
  singlePositional,
  usageError,
  withAgent,
  writeOut
} from './_common.mjs';

const NAME = 'pa-grant';

const HELP = `pa-grant — 查看 / 签发 / 撤销常驻授权（grant）

用法:
  pa-grant [dir] list [--json]
  pa-grant [dir] issue --connector <id> --actions <a,b> --data-classes <D1,D2> [--ttl <小时>]
  pa-grant [dir] revoke --id <grant_id>

子命令:
  list                      列出当前有效的 grant（不含已过期/已撤销）
  issue                     签发一条 grant（digest 由运行时连接器决定，不接受手填）
  revoke                    撤销一条 grant（落盘保留撤销时间）

选项:
      --connector <id>      连接器 id（如 gmail / google-calendar / local-files）
      --actions <a,b>       该 grant 覆盖的语义动作，逗号分隔（如 mail.send）
      --data-classes <c>    覆盖的数据级别，逗号分隔（D0/D1/D2；D3 永远不允许）
      --ttl <hours>         有效期小时数（默认取 profile 上限，最多 168）
      --id <grant_id>       revoke 时的目标 grant
      --home <dir>          机器级状态 ~/.pi/pa 的 home（默认 $PA_HOME 或系统 home）
      --json                输出机器可读 JSON
  -h, --help                显示本帮助

示例:
  pa-grant . list
  pa-grant . issue --connector gmail --actions mail.send --data-classes D2 --ttl 24
  pa-grant . revoke --id g_abc123

退出码:
  0  成功
  1  未能执行（配置错误 / 未知连接器 / 未知 grant）
  2  参数错误`;

const OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  json: { type: 'boolean' },
  connector: { type: 'string' },
  actions: { type: 'string' },
  'data-classes': { type: 'string' },
  ttl: { type: 'string' },
  id: { type: 'string' },
  home: { type: 'string' }
};

const COMMANDS = ['list', 'issue', 'revoke'];

await runMain(NAME, process.argv.slice(2), async (argv, ctx) => {
  const { values, positionals } = parseCliArgs(argv, { options: OPTIONS, allowPositionals: true });
  if (values.help === true) {
    writeOut(HELP);
    return EXIT.OK;
  }
  if (positionals.length === 0) {
    throw usageError(`缺少子命令：${COMMANDS.join(' | ')}`);
  }

  // Accept both `pa-grant <dir> <command>` and `pa-grant <command> [dir]`:
  // the dir is optional, so "which positional is the command" is ambiguous
  // until we look at both.
  const [first, second] = positionals.map(String);
  let command;
  let dirArg;
  if (COMMANDS.includes(first)) {
    command = first;
    dirArg = second ?? '.';
  } else if (second && COMMANDS.includes(second)) {
    command = second;
    dirArg = first;
  } else {
    throw usageError(`未知子命令「${first}」，可用：${COMMANDS.join(' | ')}`);
  }
  const workspaceRoot = resolveWorkspace(dirArg);
  const homeDir = resolveHomeDir(values.home);

  if (positionals.length > 2) {
    throw usageError(`${command} 接受至多一个目录参数`);
  }

  // Validate arguments BEFORE composing: a missing flag is a usage error
  // (exit 2), and composing first would report it as a config error (exit 1)
  // or, worse, succeed and touch state for an invalid command.
  if (command === 'issue') {
    requireString(values.connector, '--connector');
    splitList(values.actions, '--actions');
    splitList(values['data-classes'], '--data-classes');
    if (values.ttl !== undefined) positiveNumber(values.ttl, '--ttl');
  }
  if (command === 'revoke') requireString(values.id, '--id');

  const payload = await withAgent({ workspaceRoot, homeDir, logger: createLogger() }, async (api) => {
    if (command === 'list') return listPayload(api);
    if (command === 'issue') return issuePayload(api, values);
    return revokePayload(api, values);
  });

  if (ctx.json) printJson(payload);
  else writeHumanReport(payload);
  return payload.exitCode;
});

/** @param {Object} api */
function listPayload(api) {
  const grants = api.services.consent.list();
  return {
    ok: true,
    exitCode: EXIT.OK,
    command: 'list',
    count: grants.length,
    grants: grants.map(project),
    machineHome: api.machine.paDir
  };
}

/**
 * @param {Object} api
 * @param {Object} values
 */
async function issuePayload(api, values) {
  const connector = requireString(values.connector, '--connector');
  const actions = splitList(values.actions, '--actions');
  const dataClasses = splitList(values['data-classes'], '--data-classes');
  const digests = api.services.registry.digests();
  const digest = digests[connector];
  if (!digest) {
    throw new CliError(
      `未知连接器「${connector}」；已注册：${Object.keys(digests).join(', ') || '（无）'}`,
      EXIT.INCOMPLETE,
      'CONNECTOR_NOT_FOUND'
    );
  }
  const ttlHours = values.ttl === undefined ? undefined : positiveNumber(values.ttl, '--ttl');

  const grant = await api.services.consent.grant({
    connector,
    actions,
    data_classes: dataClasses,
    ttlHours,
    connectorDigest: digest,
    issuedBy: 'user'
  });
  return {
    ok: true,
    exitCode: EXIT.OK,
    command: 'issue',
    grant: project(grant),
    machineHome: api.machine.paDir
  };
}

/**
 * @param {Object} api
 * @param {Object} values
 */
async function revokePayload(api, values) {
  const id = requireString(values.id, '--id');
  const revoked = await api.services.consent.revoke(id);
  if (!revoked) {
    throw new CliError(
      `没有可撤销的 grant「${id}」（不存在或已撤销）`,
      EXIT.INCOMPLETE,
      'GRANT_NOT_FOUND'
    );
  }
  return {
    ok: true,
    exitCode: EXIT.OK,
    command: 'revoke',
    revoked: id,
    remaining: api.services.consent.list().length,
    machineHome: api.machine.paDir
  };
}

/** Keep only the fields an operator needs; never echo the whole record. */
function project(grant) {
  return {
    grant_id: grant.grant_id,
    connector: grant.connector,
    actions: grant.actions,
    data_classes: grant.data_classes,
    issued_at: grant.issued_at,
    expires_at: grant.expires_at,
    issued_by: grant.issued_by
  };
}

/** @param {unknown} value @param {string} flag */
function requireString(value, flag) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw usageError(`${flag} 必填`);
  }
  return value.trim();
}

/** @param {unknown} value @param {string} flag @returns {string[]} */
function splitList(value, flag) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw usageError(`${flag} 必填，形如 a,b`);
  }
  const items = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (items.length === 0) throw usageError(`${flag} 至少包含一项`);
  return items;
}

/** @param {unknown} value @param {string} flag @returns {number} */
function positiveNumber(value, flag) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw usageError(`${flag} 必须是正数`);
  return number;
}

/** @param {Object} payload */
function writeHumanReport(payload) {
  if (payload.command === 'list') {
    writeOut(`${NAME}: ${payload.count} 条有效授权`);
    for (const grant of payload.grants) {
      writeOut(
        `  ${grant.grant_id}  ${grant.connector}  ${grant.actions.join(',')}  ` +
          `${grant.data_classes.join('/')}  至 ${grant.expires_at}`
      );
    }
    writeOut(`  机器级目录 ${payload.machineHome}`);
    return;
  }
  if (payload.command === 'issue') {
    const grant = payload.grant;
    writeOut(`${NAME}: 已签发`);
    writeOut(`  grant     ${grant.grant_id}`);
    writeOut(`  connector ${grant.connector}`);
    writeOut(`  actions   ${grant.actions.join(', ')}`);
    writeOut(`  data      ${grant.data_classes.join(', ')}`);
    writeOut(`  有效期至  ${grant.expires_at}`);
    writeOut(`  撤销用    ${NAME} . revoke --id ${grant.grant_id}`);
    return;
  }
  writeOut(`${NAME}: 已撤销 ${payload.revoked}`);
  writeOut(`  剩余有效授权 ${payload.remaining} 条`);
}
