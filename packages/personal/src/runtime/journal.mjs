/**
 * Journal (M3) — durable Run/Step checkpoints for long or interrupted work.
 *
 * PIagent retired its task contract in 1.9.0 and long tasks require the
 * session to stay open. A personal agent that stops working when the laptop
 * sleeps is not acceptable, so PIA keeps its own journal.
 *
 * One JSON file per run, rewritten atomically. Closures only (no `this`), so
 * a destructured method cannot explode; writes are serialised per run so two
 * patches cannot interleave a read-modify-write.
 *
 * @module @piagent/personal/runtime/journal
 */

import { join } from 'node:path';
import { readJson, writeJsonAtomic, ensureDir, listFiles } from '../core/jsonl.mjs';
import { RUN_STATUS } from '../core/contracts.mjs';
import { ResumeError } from '../core/errors.mjs';
import { newId } from '../core/ids.mjs';

/**
 * @param {{dir: string, clock: Object}} opts
 */
export function createJournal({ dir, clock }) {
  if (!dir) throw new TypeError('journal requires a directory');
  /** @type {Map<string, Object>} */
  const cache = new Map();
  /** @type {Map<string, Promise<unknown>>} per-run write queue */
  const queues = new Map();

  function pathOf(runId) {
    return join(dir, `${runId}.json`);
  }

  function enqueue(runId, task) {
    const previous = queues.get(runId) ?? Promise.resolve();
    const next = previous.then(task, task);
    queues.set(runId, next.catch(() => undefined));
    return next;
  }

  async function persist(run) {
    run.updated_at = clock.iso();
    await writeJsonAtomic(pathOf(run.run_id), run);
    cache.set(run.run_id, run);
    return run;
  }

  async function load(runId) {
    if (cache.has(runId)) return cache.get(runId);
    const run = await readJson(pathOf(runId), null);
    if (!run) throw new ResumeError(`run not found: ${runId}`, { runId });
    if (run.version !== 1) throw new ResumeError(`unsupported journal version: ${run.version}`, { runId });
    cache.set(runId, run);
    return run;
  }

  async function startRun(input) {
    await ensureDir(dir);
    const run = {
      version: 1,
      run_id: newId('run'),
      turn_id: input.turnId,
      intent: String(input.intent ?? '').slice(0, 200),
      mode: input.mode,
      status: RUN_STATUS.RUNNING,
      created_at: clock.iso(),
      updated_at: clock.iso(),
      actions: (input.actions ?? []).map((action) => ({
        id: action.id,
        kind: action.kind,
        risk: action.risk,
        status: 'pending'
      })),
      steps: [],
      pending: null,
      artifacts: [],
      error: null
    };
    await persist(run);
    return run;
  }

  async function appendStep(runId, step) {
    return enqueue(runId, async () => {
      const run = await load(runId);
      run.steps.push({ at: clock.iso(), ...step });
      const action = run.actions.find((entry) => entry.id === step.actionId);
      if (action && step.status) action.status = step.status;
      return persist(run);
    });
  }

  async function checkpoint(runId, patch = {}) {
    return enqueue(runId, async () => {
      const run = await load(runId);
      if (patch.status) run.status = patch.status;
      if (patch.pending !== undefined) run.pending = patch.pending;
      if (patch.error !== undefined) run.error = patch.error;
      if (patch.artifacts) run.artifacts = [...run.artifacts, ...patch.artifacts];
      return persist(run);
    });
  }

  async function listRuns() {
    const files = await listFiles(dir, '.json');
    const runs = [];
    for (const file of files) {
      try {
        runs.push(await readJson(file, null));
      } catch {
        runs.push({ run_id: file.split(/[\\/]/).pop().replace('.json', ''), status: 'corrupt' });
      }
    }
    return runs.filter(Boolean).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  }

  async function latestIncomplete() {
    const resumable = [RUN_STATUS.RUNNING, RUN_STATUS.AWAITING_APPROVAL, RUN_STATUS.BLOCKED];
    const runs = await listRuns();
    return runs.find((run) => resumable.includes(run.status)) ?? null;
  }

  async function remove(runId) {
    const run = await readJson(pathOf(runId), null);
    if (!run) return false;
    const { rm } = await import('node:fs/promises');
    await rm(pathOf(runId), { force: true });
    cache.delete(runId);
    return true;
  }

  return { startRun, appendStep, checkpoint, load, listRuns, latestIncomplete, remove };
}
