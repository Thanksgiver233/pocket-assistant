/**
 * Local files connector (read-only in P0).
 *
 * The most dangerous "read" is a read that escapes the workspace or touches
 * a secret. Both are blocked here by path containment + a protected-name
 * list, before any policy layer is consulted — defence in depth, not
 * defence in one place.
 *
 * @module @piagent/personal/integrations/connectors/local-files
 */

import { readdir, readFile, stat, realpath, lstat } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { DATA_CLASS, RISK } from '../../core/contracts.mjs';
import { digestOf } from '../../core/canonical.mjs';

/** Never readable through this connector, whatever the grant says. */
export const PROTECTED_PATTERNS = [
  /(^|[\\/])\.env(\..*)?$/i,
  /(^|[\\/])\.envrc$/i,
  /(^|[\\/])id_(rsa|ed25519|ecdsa)(\.pub)?$/i,
  /\.(pem|p12|pfx|key)$/i,
  /(^|[\\/])auth\.json$/i,
  /(^|[\\/])credentials(\.json)?$/i,
  /(^|[\\/])vault\.enc$/i,
  /(^|[\\/])\.ssh([\\/]|$)/i,
  /(^|[\\/])\.git[\\/]config$/i
];

/**
 * @param {{root: string, clock?: Object, maxBytes?: number, failHealth?: boolean}} opts
 */
export function createFilesConnector({ root, clock, maxBytes = 200_000, failHealth = false }) {
  if (!root) throw new TypeError('files connector requires a root directory');
  const rootAbs = resolve(root);
  const tools = [
    {
      manifest: {
        id: 'files.list',
        connector: 'local-files',
        kind: 'native',
        risk: RISK.R0,
        reversible: true,
        data_in: [DATA_CLASS.D1],
        data_out: DATA_CLASS.D1,
        egress: false,
        idempotent: true,
        summary: '列出个人工作区中的文件',
        cost_hint: { tokens: 50, usd: 0 },
        approval: { default: 'auto' },
        parameters: {
          type: 'object',
          properties: { subdir: { type: 'string' } },
          additionalProperties: false
        }
      },
      async invoke(args) {
        const dir = await safeResolve(rootAbs, args.subdir ?? '.');
        const entries = await readdir(dir, { withFileTypes: true });
        const items = [];
        for (const entry of entries) {
          // Symlinks are never listed: they are the classic escape hatch.
          if (entry.isSymbolicLink()) continue;
          const full = join(dir, entry.name);
          if (isProtected(full)) continue;
          items.push({ name: entry.name, dir: entry.isDirectory() });
          if (items.length >= 200) break;
        }
        return { items, summary: `列出 ${items.length} 个文件`, cost: { usd: 0, tokens: 0 } };
      }
    },
    {
      manifest: {
        id: 'files.read',
        connector: 'local-files',
        kind: 'native',
        risk: RISK.R0,
        reversible: true,
        data_in: [DATA_CLASS.D1],
        data_out: DATA_CLASS.D1,
        egress: false,
        idempotent: true,
        summary: '读取个人工作区中的文件内容',
        cost_hint: { tokens: 400, usd: 0 },
        approval: { default: 'auto' },
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
          additionalProperties: false
        }
      },
      async invoke(args) {
        if (!args.path) throw new TypeError('files.read requires a path');
        const file = await safeResolve(rootAbs, args.path);
        if (isProtected(file)) {
          const error = new Error('file is on the protected list (.env / keys / credentials)');
          error.code = 'PROTECTED_PATH';
          throw error;
        }
        const info = await lstat(file);
        if (info.isSymbolicLink()) {
          const error = new Error('refusing to follow a symbolic link');
          error.code = 'SYMLINK_REFUSED';
          throw error;
        }
        if (!info.isFile()) throw new TypeError('not a file');
        if (info.size > maxBytes) throw new TypeError(`file larger than ${maxBytes} bytes`);
        const text = await readFile(file, 'utf8');
        return {
          summary: `读取 ${relative(rootAbs, file)}（${text.length} 字符）`,
          artifact: { kind: 'text', text: text.slice(0, 8000), path: relative(rootAbs, file) },
          cost: { usd: 0, tokens: Math.ceil(text.length / 4) }
        };
      }
    }
  ];

  return {
    id: 'local-files',
    kind: 'native',
    digest: digestOf(tools.map((tool) => tool.manifest)),
    dataClasses: [DATA_CLASS.D1],
    tools,
    async healthCheck() {
      if (failHealth) return { ok: false, error: 'fixture: connector offline' };
      try {
        await stat(rootAbs);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
  };
}

/**
 * Resolve `candidate` under `root`, refusing traversal, absolute escapes and
 * symlink escapes. `realpath` is used when the target exists so a link inside
 * the workspace cannot point at ~/.ssh (P1-12).
 * @param {string} root
 * @param {string} candidate
 * @returns {Promise<string>}
 */
export async function safeResolve(root, candidate) {
  const rootReal = await realpath(root).catch(() => resolve(root));
  const target = isAbsolute(candidate) ? resolve(candidate) : resolve(rootReal, candidate);
  let real = target;
  try {
    real = await realpath(target);
  } catch {
    // Target does not exist yet: fall back to the lexical path.
  }
  const rel = relative(rootReal, real);
  // "" means the root itself, which is allowed; anything escaping it is not.
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new TypeError('path escapes the workspace root');
  }
  return real;
}

/** @param {string} file */
export function isProtected(file) {
  return PROTECTED_PATTERNS.some((pattern) => pattern.test(file));
}
