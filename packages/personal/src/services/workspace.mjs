/**
 * Workspace bootstrap — the reusable half of `pa-init`.
 *
 * `bin/pa-init.mjs` owns argument parsing and the human report; the actual
 * "make a workspace that the agent will accept" logic lives here so the
 * desktop shell can create one on first launch without shelling out to a CLI
 * that does not exist inside a packaged app.
 *
 * @module @piagent/personal/services/workspace
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ensureDir, exists, stateLayout, writeJsonAtomic } from '../core/jsonl.mjs';
import { validate } from '../core/schema.mjs';
import { ConfigError } from '../core/errors.mjs';
import { DEFAULT_PROFILE } from './profile.mjs';

const SCHEMA_URL = new URL('../../schemas/pa-profile.v1.json', import.meta.url);

/**
 * Create `<ws>/.pi/pa-profile.json`, the state directories and `.gitignore`.
 * Idempotent: an existing profile is left untouched.
 *
 * @param {{workspaceRoot: string, persona?: Object}} input
 * @returns {Promise<{created: boolean, workspaceRoot: string, profilePath: string, stateDir: string}>}
 */
export async function ensureWorkspace({ workspaceRoot, persona } = {}) {
  if (!workspaceRoot) throw new ConfigError('ensureWorkspace requires workspaceRoot');
  const paths = stateLayout(workspaceRoot);

  if (await exists(paths.profilePath)) {
    return { created: false, workspaceRoot, profilePath: paths.profilePath, stateDir: paths.stateDir };
  }

  const profile = structuredClone(DEFAULT_PROFILE);
  if (persona && typeof persona === 'object') profile.persona = { ...profile.persona, ...persona };
  profile.workspace_root = workspaceRoot;

  // Fail closed: validate before writing. A profile that cannot be loaded is
  // worse than no workspace, because the error only shows up at run time.
  const schema = JSON.parse(await readFile(SCHEMA_URL, 'utf8'));
  validate(schema, profile);

  for (const dir of [paths.journalDir, paths.memoryDir, paths.indexDir, paths.auditDir, paths.deliveryDir]) {
    await ensureDir(dir);
  }
  // The default `local-files` connector is rooted here.
  await ensureDir(join(workspaceRoot, 'vault'));

  await writeJsonAtomic(paths.profilePath, profile);

  const gitignorePath = join(paths.piDir, '.gitignore');
  const existing = await readTextOrNull(gitignorePath);
  await writeFile(gitignorePath, ensureGitignoreLine(existing), { encoding: 'utf8', mode: 0o600 });

  return { created: true, workspaceRoot, profilePath: paths.profilePath, stateDir: paths.stateDir };
}

/** @param {string} file */
async function readTextOrNull(file) {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return null;
    throw err;
  }
}

/** Keep an existing .gitignore honest instead of overwriting it. */
function ensureGitignoreLine(existing) {
  const line = 'pa-state/';
  if (existing === null || existing.trim() === '') return `${line}\n`;
  const lines = existing.split(/\r?\n/).map((entry) => entry.trim());
  if (lines.includes(line)) return existing.endsWith('\n') ? existing : `${existing}\n`;
  return `${existing.replace(/\s+$/, '')}\n${line}\n`;
}
