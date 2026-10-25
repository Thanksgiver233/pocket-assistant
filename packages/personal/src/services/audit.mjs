/**
 * Audit ledger (M11) — append-only, hash-chained, exportable.
 *
 * Why hash-chained: the question a personal agent must be able to answer is
 * not "what did it do" but "prove that this record was not edited after the
 * fact". A plain JSONL file cannot answer that; a chain can.
 *
 * Appends are serialised through a promise queue. Concurrent tool calls in
 * the same run would otherwise read the same `prev_hash` and fork the chain,
 * which `verifyChain()` would report as corruption — a false alarm that
 * teaches operators to ignore the alarm.
 *
 * @module @piagent/personal/services/audit
 */

import { join } from 'node:path';
import { appendJsonl, readJsonl, ensureDir, listFiles } from '../core/jsonl.mjs';
import { chainHash } from '../core/canonical.mjs';

/**
 * @param {{dir: string, clock: Object, runId?: string}} opts
 */
export function createAudit({ dir, clock }) {
  if (!dir) throw new TypeError('audit requires a directory');
  const ledgerFile = join(dir, 'ledger.jsonl');
  const headFile = join(dir, 'head');
  let queue = Promise.resolve();

  /**
   * Read the current chain head from disk. Always re-read: two processes
   * (a CLI and a dashboard session) may share one workspace, and a cached
   * head would fork the chain (P1-5). Personal-scale ledgers are small.
   * @returns {Promise<string>}
   */
  async function readHead() {
    const { records, corrupt } = await readJsonl(ledgerFile);
    if (corrupt.length > 0) {
      throw new Error(`audit ledger is corrupt at line ${corrupt[0].line}: ${corrupt[0].error}`);
    }
    return records.length > 0 ? records[records.length - 1].hash : 'sha256:genesis';
  }

  async function readExternalHead() {
    try {
      const { readFile } = await import('node:fs/promises');
      const raw = (await readFile(headFile, 'utf8')).trim();
      return raw || null;
    } catch {
      return null;
    }
  }

  /**
   * Append one event. Returns the stored record (with `prev_hash`/`hash`).
   * @param {Object} event
   * @returns {Promise<Object>}
   */
  async function append(event) {
    const task = queue.then(async () => {
      const prev = await readHead();
      const payload = {
        ts: event.ts ?? clock.iso(),
        run_id: event.run_id ?? '',
        turn_id: event.turn_id ?? '',
        kind: event.kind,
        ...compact(event)
      };
      const hash = chainHash(prev, payload);
      const record = { ...payload, prev_hash: prev, hash };
      await appendJsonl(ledgerFile, record);
      // External anchor: lets `pa-doctor` detect a truncated tail, which the
      // chain alone cannot (a shorter valid prefix is still a valid chain).
      const { writeFile } = await import('node:fs/promises');
      await writeFile(headFile, `${hash}\n`, { encoding: 'utf8', mode: 0o600 });
      return record;
    });
    queue = task.catch(() => undefined);
    return task;
  }

  return {
    ledgerFile,

    append,

    /** @returns {Promise<{records: Object[], corrupt: {line:number,error:string}[]}>} */
    async readAll() {
      return readJsonl(ledgerFile);
    },

    /**
     * Recompute the chain and compare the tail with the external anchor.
     * A shorter-but-valid prefix is otherwise invisible.
     * @returns {Promise<{ok: boolean, count: number, brokenAt?: number, reason?: string, anchored?: boolean}>}
     */
    async verifyChain() {
      const { records, corrupt } = await readJsonl(ledgerFile);
      if (corrupt.length > 0) {
        return { ok: false, count: records.length, brokenAt: corrupt[0].line, reason: 'unparsable line' };
      }
      let prev = 'sha256:genesis';
      for (let i = 0; i < records.length; i += 1) {
        const record = records[i];
        const { hash, prev_hash: recordedPrev, ...payload } = record;
        if (recordedPrev !== prev) {
          return { ok: false, count: records.length, brokenAt: i + 1, reason: 'prev_hash mismatch' };
        }
        const expected = chainHash(prev, payload);
        if (expected !== hash) {
          return { ok: false, count: records.length, brokenAt: i + 1, reason: 'hash mismatch (record edited)' };
        }
        prev = hash;
      }
      const anchor = await readExternalHead();
      const anchored = anchor === null ? true : anchor === prev;
      if (!anchored) {
        return { ok: false, count: records.length, reason: 'tail truncated (head anchor mismatch)', anchored };
      }
      return { ok: true, count: records.length, anchored };
    },

    /** @param {{from?: string, to?: string}} [range] */
    async export(range = {}) {
      const { records } = await readJsonl(ledgerFile);
      const filtered = records.filter((record) => {
        if (range.from && Date.parse(record.ts) < Date.parse(range.from)) return false;
        if (range.to && Date.parse(record.ts) > Date.parse(range.to)) return false;
        return true;
      });
      return filtered.map((record) => JSON.stringify(record)).join('\n');
    },

    /** @returns {Promise<{count: number, files: string[], head: string|null}>} */
    async stat() {
      const files = await listFiles(dir, '.jsonl');
      const { records } = await readJsonl(ledgerFile);
      return {
        count: records.length,
        files,
        head: records.length ? records[records.length - 1].hash : null
      };
    },

    /** Ensure the directory exists (called by compose, before first append). */
    async init() {
      await ensureDir(dir);
    }
  };
}

/**
 * Drop undefined/empty bookkeeping fields so the hashed payload stays small
 * and stable.
 * @param {Object} event
 */
function compact(event) {
  const { ts, run_id, turn_id, kind, prev_hash, hash, ...rest } = event;
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, value] of Object.entries(rest)) {
    if (value === undefined) continue;
    out[key] = value;
  }
  return out;
}
