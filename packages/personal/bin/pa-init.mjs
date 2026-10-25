#!/usr/bin/env node
/**
 * pa-init — create a personal workspace.
 *
 * Writes exactly what docs/06 §8 promises and nothing else:
 *   <dir>/.pi/pa-profile.json          policy only (no data, no secrets)
 *   <dir>/.pi/pa-state/{journal,memory,index,audit,delivery}
 *   <dir>/.pi/.gitignore               `pa-state/` (local state is not committable)
 *
 * The profile is built from DEFAULT_PROFILE (read-only, tight budget, no
 * proactive work) and validated against `schemas/pa-profile.v1.json` *before*
 * it is written, so pa-init cannot produce a workspace pa-doctor rejects.
 * An already-initialised workspace is exit 1 and is left untouched.
 *
 * @module @piagent/personal/bin/pa-init
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  CliError,
  EXIT,
  parseCliArgs,
  printJson,
  resolveWorkspace,
  runMain,
  singlePositional,
  usageError,
  writeOut
} from './_common.mjs';
import { stateLayout, exists } from '../src/core/jsonl.mjs';
import { ensureWorkspace } from '../src/services/workspace.mjs';
import { DEFAULT_PROFILE } from '../src/services/profile.mjs';

const NAME = 'pa-init';

const HELP = `pa-init — 初始化个人工作区（策略文件 + 本地状态目录 + .gitignore）

用法:
  pa-init <dir> [选项]

参数:
  <dir>                     工作区根目录（必填；不会默认为当前目录）

选项:
      --persona-name <name> 助手名称（默认「默认助手」，1–60 字符）
      --language <ll-CC>    语言，形如 zh-CN
      --tone <tone>         concise | warm | formal
      --address-as <text>   称呼方式（默认「你」，最长 20 字符）
      --json                输出机器可读 JSON
  -h, --help                显示本帮助

写入内容:
  <dir>/.pi/pa-profile.json             version:1，autonomy.default_mode=read-only
  <dir>/.pi/pa-state/{journal,memory,index,audit,delivery}
  <dir>/vault/                          本地文件连接器的根目录
  <dir>/.pi/.gitignore                  含 \`pa-state/\`（本地状态不可提交）

已初始化（profile 已存在）时不做任何修改，退出码 1。

退出码:
  0  成功
  1  已存在 / 未完成
  2  参数错误`;

const OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  json: { type: 'boolean' },
  'persona-name': { type: 'string' },
  language: { type: 'string' },
  tone: { type: 'string' },
  'address-as': { type: 'string' }
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

  const dirArg = singlePositional(positionals, { required: true, usage: `${NAME} <dir> [选项]` });
  const workspaceRoot = resolveWorkspace(dirArg);
  const persona = normalisePersona(values);
  const result = await initialiseWorkspace({ workspaceRoot, persona });

  if (ctx.json) printJson(result);
  else writeHumanReport(result);
  return EXIT.OK;
});

/**
 * @param {Object} values parsed long options
 * @returns {Object} persona block, defaults preserved
 */
function normalisePersona(values) {
  /** @type {Record<string, string>} */
  const persona = { ...DEFAULT_PROFILE.persona };

  if (values['persona-name'] !== undefined) {
    const name = String(values['persona-name']).trim();
    if (name.length < 1 || name.length > 60) {
      throw usageError('--persona-name 必须是 1–60 个字符');
    }
    persona.name = name;
  }
  if (values.language !== undefined) {
    if (!/^[a-z]{2}-[A-Z]{2}$/.test(String(values.language))) {
      throw usageError('--language 必须形如 zh-CN');
    }
    persona.language = String(values.language);
  }
  if (values.tone !== undefined) {
    const tone = String(values.tone);
    if (!['concise', 'warm', 'formal'].includes(tone)) {
      throw usageError('--tone 必须是 concise | warm | formal');
    }
    persona.tone = tone;
  }
  if (values['address-as'] !== undefined) {
    const addressAs = String(values['address-as']);
    if (addressAs.length > 20) throw usageError('--address-as 最长 20 个字符');
    persona.address_as = addressAs;
  }
  return persona;
}

/**
 * @param {{workspaceRoot: string, persona: Object}} input
 * @returns {Promise<Object>} machine-readable summary
 */
async function initialiseWorkspace({ workspaceRoot, persona }) {
  const paths = stateLayout(workspaceRoot);
  if (await exists(paths.profilePath)) {
    throw new CliError(
      `工作区已初始化：已存在 ${paths.profilePath}，未做任何修改`,
      EXIT.INCOMPLETE,
      'ALREADY_INITIALIZED'
    );
  }

  const created = await ensureWorkspace({ workspaceRoot, persona });
  const profile = JSON.parse(await readFile(created.profilePath, 'utf8'));

  return {
    ok: true,
    exitCode: EXIT.OK,
    workspaceRoot,
    profilePath: created.profilePath,
    stateDir: created.stateDir,
    stateDirs: [
      join(created.stateDir, 'journal'),
      join(created.stateDir, 'memory'),
      join(created.stateDir, 'index'),
      join(created.stateDir, 'audit'),
      join(created.stateDir, 'delivery')
    ],
    gitignorePath: join(created.workspaceRoot, '.pi', '.gitignore'),
    profile: {
      version: profile.version,
      default_mode: profile.autonomy.default_mode,
      proactive: profile.autonomy.proactive.enabled,
      budget: profile.budget,
      memory: profile.memory,
      privacy: profile.privacy
    }
  };
}

/** @param {Object} result */
function writeHumanReport(result) {
  writeOut(`${NAME}: 已初始化个人工作区`);
  writeOut(`  workspace   ${result.workspaceRoot}`);
  writeOut(`  profile     ${result.profilePath}`);
  writeOut(`  state       ${result.stateDir}`);
  writeOut('              journal/ memory/ index/ audit/ delivery/');
  writeOut(`  gitignore   ${result.gitignorePath}  (pa-state/)`);
  writeOut('');
  writeOut('默认档位 read-only；修改策略请编辑 pa-profile.json（只放策略，不放数据、不放密钥）。');
  writeOut(`下一步: pa-doctor ${result.workspaceRoot}`);
}
