/**
 * Small, boring file primitives: atomic JSON, append-only JSONL, directory
 * layout. No dependencies, no caching, no cleverness.
 * @module @piagent/personal/core/jsonl
 */

import { mkdir, readFile, writeFile, rename, appendFile, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * @param {string} dir
 * @returns {Promise<string>} the same dir
 */
export async function ensureDir(dir) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * @param {string} file
 * @returns {Promise<boolean>}
 */
export async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Write JSON atomically: temp file in the same directory, then rename.
 * Prevents a crash from leaving a half-written profile or grant store.
 * @param {string} file
 * @param {unknown} value
 */
export async function writeJsonAtomic(file, value) {
  await ensureDir(dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, file);
}

/**
 * @param {string} file
 * @param {unknown} [fallback]
 * @returns {Promise<any>}
 */
export async function readJson(file, fallback = undefined) {
  try {
    const raw = await readFile(file, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT' && fallback !== undefined) {
      return fallback;
    }
    throw err;
  }
}

/**
 * Append one JSON object as a single line. Append-only files are never
 * rewritten, which is what makes the audit ledger tamper-evident.
 * @param {string} file
 * @param {unknown} value
 */
export async function appendJsonl(file, value) {
  await ensureDir(dirname(file));
  await appendFile(file, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 });
}

/**
 * Read every line of a JSONL file. Unreadable/malformed lines are reported
 * rather than silently skipped: a corrupt ledger must fail loudly.
 * @param {string} file
 * @returns {Promise<{records: any[], corrupt: {line: number, error: string}[]}>}
 */
export async function readJsonl(file) {
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return { records: [], corrupt: [] };
    throw err;
  }
  const records = [];
  const corrupt = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      records.push(JSON.parse(line));
    } catch (err) {
      corrupt.push({ line: i + 1, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { records, corrupt };
}

/**
 * @param {string} dir
 * @returns {Promise<string[]>} absolute paths, sorted
 */
export async function listFiles(dir, extension = '') {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && (!extension || entry.name.endsWith(extension)))
      .map((entry) => join(dir, entry.name))
      .sort();
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return [];
    throw err;
  }
}

/**
 * Remove a file if present. Used by `forget`: deletion must be verifiable.
 * @param {string} file
 * @returns {Promise<boolean>} true if something was removed
 */
export async function removeFile(file) {
  const present = await exists(file);
  if (present) await rm(file, { force: true });
  return present;
}

/**
 * The state layout is part of the contract (see docs/04 §4.5). Keeping it
 * in one place means `pa-doctor` can verify the whole tree at once.
 * @param {string} workspaceRoot
 */
export function stateLayout(workspaceRoot) {
  const stateDir = join(workspaceRoot, '.pi', 'pa-state');
  return {
    workspaceRoot,
    piDir: join(workspaceRoot, '.pi'),
    profilePath: join(workspaceRoot, '.pi', 'pa-profile.json'),
    stateDir,
    journalDir: join(stateDir, 'journal'),
    memoryDir: join(stateDir, 'memory'),
    indexDir: join(stateDir, 'index'),
    auditDir: join(stateDir, 'audit'),
    deliveryDir: join(stateDir, 'delivery'),
    auditFile: join(stateDir, 'audit', 'ledger.jsonl')
  };
}

/**
 * Machine-level layout: `~/.pi/pa/` holds decisions and vault material, so a
 * workspace can never grant itself authority (same discipline as PIagent's
 * `~/.pi/piagent-mcp-approvals.json`).
 * @param {string} homeDir
 */
export function machineLayout(homeDir) {
  const paDir = join(homeDir, '.pi', 'pa');
  return {
    paDir,
    connectorsPath: join(paDir, 'connectors.json'),
    vaultPath: join(paDir, 'vault.enc'),
    grantsPath: join(paDir, 'grants.json')
  };
}
