#!/usr/bin/env node
/**
 * pa-serve — run PIA as a single-process web service.
 *
 * This is the deployment shape the ¥68/year box assumes:
 *   one Node process  =  HTTP API + static UI + in-process scheduler hook
 *   one SQLite/JSONL  =  state (no database server to pay for or patch)
 *
 * Security posture:
 *  - refuses to start without a token of at least 16 characters;
 *  - binds 127.0.0.1 by default (put Nginx in front; never expose Node directly);
 *  - token may come from `--token` or `PA_TOKEN`, never from a file inside the
 *    workspace (a cloned repo must not be able to authenticate itself).
 *
 * @module @piagent/personal/bin/pa-serve
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CliError,
  EXIT,
  createLogger,
  parseCliArgs,
  resolveHomeDir,
  resolveWorkspace,
  runMain,
  singlePositional,
  usageError,
  writeErr,
  writeOut
} from './_common.mjs';
import { activateMock } from '../src/index.mjs';
import { createHttpServer } from '../src/server/http-server.mjs';

const NAME = 'pa-serve';
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const HELP = `pa-serve — 以单进程 Web 服务方式运行个人助理（API + 内置页面）

用法:
  pa-serve [dir] [选项]

参数:
  [dir]                     工作区根目录（默认：当前目录）

选项:
      --port <n>            监听端口（默认 8787）
      --host <addr>         监听地址（默认 127.0.0.1；对外请用 Nginx 反代）
      --token <secret>      访问令牌（≥16 字符；默认读 $PA_TOKEN）
      --web <dir>           静态页面目录（默认包内 web/；传 none 关闭）
      --home <dir>          机器级状态 ~/.pi/pa 的 home（默认 $PA_HOME 或系统 home）
      --print-token         启动时打印令牌（仅本地调试；生产别开）
  -h, --help                显示本帮助

安全默认:
  · 没有令牌拒绝启动（不允许"裸奔"）
  · 默认只绑 127.0.0.1，公网访问必须经 Nginx + TLS
  · 令牌不接受从工作区内文件读取（仓库不能自我授权）

退出码:
  0  正常退出
  1  启动失败（配置/端口/令牌）
  2  参数错误`;

const OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  port: { type: 'string' },
  host: { type: 'string' },
  token: { type: 'string' },
  web: { type: 'string' },
  home: { type: 'string' },
  'print-token': { type: 'boolean' }
};

await runMain(NAME, process.argv.slice(2), async (argv, ctx) => {
  const { values, positionals } = parseCliArgs(argv, { options: OPTIONS, allowPositionals: true });
  if (values.help === true) {
    writeOut(HELP);
    return EXIT.OK;
  }

  const dirArg = singlePositional(positionals, { required: false });
  const workspaceRoot = resolveWorkspace(dirArg ?? '.');
  const homeDir = resolveHomeDir(values.home);
  const port = parsePort(values.port);
  const host = typeof values.host === 'string' && values.host.trim() ? values.host.trim() : '127.0.0.1';
  const token = resolveToken(values);

  const webRoot = resolveWebRoot(values.web);
  const logger = createLogger();

  // Compose explicitly (not via `withAgent`): the server owns the api for its
  // whole lifetime, so the helper's "compose → run → dispose" shape is wrong.
  const agent = await activateMock({ workspaceRoot, homeDir, logger });

  const service = createHttpServer({ api: agent.api, token, webRoot, logger });
  let address;
  try {
    address = await service.listen(port, host);
  } catch (err) {
    await agent.dispose();
    throw new CliError(
      `无法监听 ${host}:${port} — ${err instanceof Error ? err.message : String(err)}`,
      EXIT.INCOMPLETE,
      'LISTEN_FAILED'
    );
  }

  const shown = typeof address === 'object' && address ? `${address.address}:${address.port}` : `${host}:${port}`;
  writeOut(`${NAME}: 已启动`);
  writeOut(`  监听      http://${shown}`);
  writeOut(`  工作区    ${workspaceRoot}`);
  writeOut(`  机器状态  ${agent.api.machine.paDir}`);
  writeOut(`  页面      ${webRoot ?? '（未启用）'}`);
  if (values['print-token'] === true) writeOut(`  令牌      ${token}`);
  writeOut('  停止      Ctrl+C');
  if (ctx.json) writeOut(JSON.stringify({ ok: true, url: `http://${shown}`, workspaceRoot }));

  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    writeErr(`${NAME}: 收到 ${signal}，正在停止…`);
    await service.close();
    await agent.dispose();
    process.exitCode = EXIT.OK;
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // Keep the process alive until a signal arrives.
  await new Promise(() => {});
  return EXIT.OK;
});

/** @param {unknown} value */
function parsePort(value) {
  if (value === undefined) return 8787;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw usageError('--port 必须是 1–65535 的整数');
  return port;
}

/** @param {Object} values */
function resolveToken(values) {
  const fromFlag = typeof values.token === 'string' ? values.token.trim() : '';
  const fromEnv = (process.env.PA_TOKEN ?? '').trim();
  const token = fromFlag || fromEnv;
  if (!token) {
    throw new CliError(
      '缺少访问令牌：用 --token <secret> 或环境变量 PA_TOKEN 提供（≥16 字符）。\n' +
        `  生成一个：node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"`,
      EXIT.INCOMPLETE,
      'TOKEN_REQUIRED'
    );
  }
  if (token.length < 16) throw usageError('令牌至少 16 字符');
  return token;
}

/** @param {unknown} value */
function resolveWebRoot(value) {
  if (value === 'none') return null;
  if (typeof value === 'string' && value.trim()) return resolveWorkspace(value.trim());
  return join(PACKAGE_ROOT, 'web');
}
