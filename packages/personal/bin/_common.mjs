/**
 * Shared plumbing for the `pa-*` commands.
 *
 * The CLIs are deliberately thin: parse argv -> compose against a mock host ->
 * call one public API method -> print -> set `process.exitCode`. All the
 * policy lives in `src/`; nothing here may re-implement a decision.
 *
 * Rules that are part of the contract (docs/06 §8):
 *  - exit codes are exactly 0/1/2/3/4 and may not be renumbered;
 *  - argument errors (exit 2) are detected before the workspace is touched;
 *  - exit is reported only through `process.exitCode`, never a forced exit,
 *    so a test can observe the code deterministically;
 *  - stdout carries the result, stderr carries warnings/errors. `--json`
 *    writes only JSON to stdout (warnings stay on stderr);
 *  - nothing here prints the raw prompt, the profile, key material or D2
 *    payloads. Errors are reduced to a single line.
 *
 * @module @piagent/personal/bin/common
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';

import { RUN_STATUS } from '../src/core/contracts.mjs';
import { activateMock } from '../src/index.mjs';

/** Exit codes are a frozen contract (docs/06 §8). Do not renumber. */
export const EXIT = Object.freeze({
  /** success / operable */
  OK: 0,
  /** not completed: blocked, failed, already initialised, config error */
  INCOMPLETE: 1,
  /** bad arguments (unknown flag, missing value, invalid enum, residue) */
  USAGE: 2,
  /** the run was denied by policy */
  DENIED: 3,
  /** the run is waiting for a human decision */
  AWAITING_APPROVAL: 4
});

/** A CLI-level failure that knows which exit code it maps to. */
export class CliError extends Error {
  /**
   * @param {string} message one line, safe to print
   * @param {number} [exitCode]
   * @param {string} [code] stable machine code, echoed in `--json`
   */
  constructor(message, exitCode = EXIT.INCOMPLETE, code = 'CLI_ERROR') {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
    this.code = code;
  }
}

/** @param {string} message @returns {CliError} */
export function usageError(message) {
  return new CliError(message, EXIT.USAGE, 'USAGE');
}

/**
 * `node:util.parseArgs` with our error style. Anything Node throws becomes a
 * usage error (exit 2) so the caller never sees a stack trace.
 * @param {string[]} argv
 * @param {{options?: Object, allowPositionals?: boolean}} [config]
 */
export function parseCliArgs(argv, { options = {}, allowPositionals = false } = {}) {
  try {
    return parseArgs({ args: argv, options, allowPositionals, strict: true });
  } catch (err) {
    throw usageError(err instanceof Error ? err.message : String(err));
  }
}

/**
 * The optional/required `<dir>` positional every command shares.
 * @param {string[]} positionals
 * @param {{required?: boolean, usage?: string}} [config]
 * @returns {string|undefined} the raw value; callers resolve it
 */
export function singlePositional(positionals, { required = false, usage = '' } = {}) {
  if (positionals.length === 0) {
    if (required) throw usageError(`缺少工作区目录（<dir>）${usage ? `；用法: ${usage}` : ''}`);
    return undefined;
  }
  if (positionals.length > 1) {
    throw usageError(`最多接受一个目录参数，收到 ${positionals.length} 个`);
  }
  return positionals[0];
}

/** @param {string|undefined} value @returns {string} absolute workspace root */
export function resolveWorkspace(value) {
  return resolve(value ?? process.cwd());
}

/**
 * Machine-level state (`~/.pi/pa/`) lives in the OS home by default, never in
 * the workspace: a workspace must not be able to grant itself authority.
 * `--home` and `$PA_HOME` exist for tests and sandboxes.
 * @param {string|undefined} value
 * @returns {string} absolute home dir
 */
export function resolveHomeDir(value) {
  const candidate = value || process.env.PA_HOME || homedir();
  return resolve(candidate);
}

/**
 * True when `child` is `parent` or lives under it. Used to enforce the
 * "a workspace can never grant itself authority" rule (docs/04 §5.3).
 * @param {string} parent
 * @param {string} child
 * @returns {boolean}
 */
export function isInside(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  if (rel === '') return true;
  if (isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith(`..${sep}`);
}

/**
 * Minimal logger handed to compose. Warning/error go to stderr so that
 * `--json` keeps stdout parseable; info is opt-in via `PA_DEBUG`.
 * @returns {{info: Function, warn: Function, error: Function}}
 */
export function createLogger() {
  const debug = Boolean(process.env.PA_DEBUG);
  return {
    info(message) {
      if (debug) writeErr(`[pa] ${message}`);
    },
    warn(message) {
      writeErr(`[pa] warning: ${message}`);
    },
    error(message) {
      writeErr(`[pa] error: ${message}`);
    }
  };
}

/** @param {string} name @returns {URL} */
export function schemaLocation(name) {
  return new URL(`../schemas/${name}`, import.meta.url);
}

/** @param {string} name @returns {Promise<Object>} */
export async function readSchema(name) {
  return JSON.parse(await readFile(schemaLocation(name), 'utf8'));
}

/**
 * Compose against the mock host, run `fn(api)`, and always dispose.
 * @template T
 * @param {{workspaceRoot: string, homeDir?: string, logger?: Object, clock?: Object,
 *          connectors?: Object[], channels?: Object[], masterKey?: Buffer|string,
 *          profilePath?: string, grantsPath?: string}} options
 * @param {(api: Object) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withAgent(options, fn) {
  const composed = await activateMock(options);
  try {
    return await fn(composed.api);
  } finally {
    try {
      await composed.dispose();
    } catch {
      // Shutdown only flushes state; it must never mask the command result.
    }
  }
}

/**
 * Map a Run status to the CLI exit code. Only `done` is success; anything
 * unfinished is exit 1, denials are 3, pending approvals are 4.
 * @param {string} status
 * @returns {number}
 */
export function exitCodeForStatus(status) {
  switch (status) {
    case RUN_STATUS.DONE:
      return EXIT.OK;
    case RUN_STATUS.DENIED:
      return EXIT.DENIED;
    case RUN_STATUS.AWAITING_APPROVAL:
      return EXIT.AWAITING_APPROVAL;
    default:
      return EXIT.INCOMPLETE;
  }
}

/** @param {unknown} value */
export function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** @param {string} [text] */
export function writeOut(text = '') {
  const value = String(text);
  process.stdout.write(value.endsWith('\n') ? value : `${value}\n`);
}

/** @param {string} [text] */
export function writeErr(text = '') {
  const value = String(text);
  process.stderr.write(value.endsWith('\n') ? value : `${value}\n`);
}

/**
 * Collapse whitespace and cap a payload for human output.
 * @param {unknown} text
 * @param {number} [max]
 * @returns {string}
 */
export function truncate(text, max = 240) {
  const value = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

/** Token-shaped strings that must never reach a terminal or a log. */
const SECRET_PATTERNS = [
  /\b(sk|pk|rk)-[A-Za-z0-9_-]{12,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bBearer\s+[A-Za-z0-9._-]{10,}/gi,
  /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g
];

/**
 * Redact credential-shaped strings from tool output before printing.
 * @param {unknown} text
 * @returns {string}
 */
export function redactSecrets(text) {
  let out = String(text ?? '');
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '<redacted>');
  return out;
}

/**
 * One-line, bounded description of any thrown value. Never includes a stack.
 * @param {unknown} err
 * @returns {string}
 */
export function describeError(err) {
  const raw = err instanceof Error ? err.message : String(err ?? '');
  const first = String(raw)
    .split(/\r?\n/)
    .find((line) => line.trim().length > 0);
  return (first ?? '未知错误').trim().slice(0, 500);
}

/**
 * CLI entry wrapper: run the command body, translate any throw into an exit
 * code, and set `process.exitCode` (never `process.exit`).
 * @param {string} name e.g. 'pa-run'
 * @param {string[]} argv
 * @param {(argv: string[], ctx: {json: boolean}) => Promise<number|void>} fn
 */
export async function runMain(name, argv, fn) {
  const jsonHint = argv.includes('--json');
  try {
    const code = await fn(argv, { json: jsonHint });
    process.exitCode = Number.isInteger(code) ? code : EXIT.OK;
  } catch (err) {
    process.exitCode = reportError(name, err, jsonHint);
  }
}

/**
 * @param {string} name
 * @param {unknown} err
 * @param {boolean} json
 * @returns {number}
 */
function reportError(name, err, json) {
  const failure = err ?? {};
  const exitCode = Number.isInteger(failure.exitCode) ? failure.exitCode : EXIT.INCOMPLETE;
  const code = typeof failure.code === 'string' && failure.code ? failure.code : 'INTERNAL_ERROR';
  const message = describeError(err);
  if (json) {
    printJson({ ok: false, exitCode, error: { code, message } });
  } else {
    writeErr(`${name}: ${message}`);
    if (exitCode === EXIT.USAGE) writeErr(`运行 \`${name} --help\` 查看用法。`);
  }
  return exitCode;
}
