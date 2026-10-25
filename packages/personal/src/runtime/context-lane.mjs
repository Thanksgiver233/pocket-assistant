/**
 * Personal context lane (M7) — a retrieval lane the Pi context planner can
 * include when the task needs personal facts.
 *
 * P0 implementation is a persisted inverted index over small records, not a
 * vector store. That is a deliberate trade: a personal agent that cannot
 * explain *why* a snippet was retrieved has not solved the trust problem.
 * Every hit carries its citations and its data class, and D2 hits are
 * filtered unless the caller presents a grant.
 *
 * @module @piagent/personal/runtime/context-lane
 */

import { join } from 'node:path';
import { DATA_CLASS, DATA_RANK } from '../core/contracts.mjs';
import { ValidationError } from '../core/errors.mjs';
import { readJson, writeJsonAtomic, ensureDir } from '../core/jsonl.mjs';
import { assertDataClass } from '../services/risk.mjs';
import { tokenize } from '../services/memory.mjs';

const MAX_RECORDS = 5000;

/**
 * @param {{stateDir: string, clock: Object, laneName?: string}} opts
 */
export function createPersonalLane({ stateDir, clock, laneName = 'personal' }) {
  if (!stateDir) throw new TypeError('context lane requires stateDir');
  const indexPath = join(stateDir, 'index', 'personal.json');
  /** @type {Object[]} */
  let records = [];
  let loaded = false;

  async function load() {
    if (loaded) return;
    await ensureDir(join(stateDir, 'index'));
    const store = await readJson(indexPath, { version: 1, records: [] });
    records = Array.isArray(store.records) ? store.records : [];
    loaded = true;
  }

  return {
    name: laneName,
    load,

    /**
     * Index a record. `text` is what will be searched; `dataClass` decides
     * who may see it at retrieval time.
     * @param {{id: string, text: string, dataClass?: string, tags?: string[],
     *          citations?: Object[], source?: string}} record
     */
    async index(record) {
      await load();
      if (!record?.id || !record?.text) throw new TypeError('index requires {id, text}');
      const dataClass = assertDataClass(record.dataClass ?? DATA_CLASS.D1);
      // D3 never enters the index, whatever the caller says (docs/04 §4.1).
      if (dataClass === DATA_CLASS.D3) {
        throw new ValidationError('D3 credentials must never be indexed');
      }
      const entry = {
        id: record.id,
        text: String(record.text).slice(0, 4000),
        dataClass,
        tags: record.tags ?? [],
        citations: record.citations ?? [],
        source: record.source ?? 'unknown',
        indexedAt: clock.iso(),
        terms: tokenize(`${record.text} ${(record.tags ?? []).join(' ')}`).slice(0, 200)
      };
      records = records.filter((existing) => existing.id !== entry.id);
      records.push(entry);
      if (records.length > MAX_RECORDS) records = records.slice(-MAX_RECORDS);
      await writeJsonAtomic(indexPath, { version: 1, updated_at: clock.iso(), records });
      return { indexed: true, id: entry.id };
    },

    /**
     * @param {string} query
     * @param {{budgetTokens?: number, grantedDataClasses?: string[], limit?: number}} [opts]
     * @returns {Promise<{snippets: {id: string, text: string, dataClass: string,
     *   citations: Object[], score: number}[], filtered: number, tokensUsed: number}>}
     */
    async retrieve(query, opts = {}) {
      await load();
      const budgetTokens = opts.budgetTokens ?? 1200;
      const limit = opts.limit ?? 6;
      const granted = new Set((opts.grantedDataClasses ?? [DATA_CLASS.D0, DATA_CLASS.D1]).map(assertDataClass));
      // A caller cannot widen its own view by asking for D3.
      granted.delete(DATA_CLASS.D3);
      const queryTerms = new Set(tokenize(query));
      let filtered = 0;
      /** @type {{record: Object, score: number}[]} */
      const scored = [];

      for (const record of records) {
        const recordClass = record.dataClass ?? DATA_CLASS.D1;
        if (recordClass === DATA_CLASS.D3) {
          filtered += 1;
          continue;
        }
        if (DATA_RANK[recordClass] > DATA_RANK[DATA_CLASS.D1] && !granted.has(recordClass)) {
          filtered += 1;
          continue;
        }
        let score = 0;
        for (const term of record.terms) {
          if (queryTerms.has(term)) score += 1;
        }
        if (score > 0) scored.push({ record, score });
      }
      scored.sort((a, b) => b.score - a.score);

      const snippets = [];
      let tokensUsed = 0;
      for (const { record, score } of scored.slice(0, limit)) {
        const cost = Math.ceil(record.text.length / 4);
        if (tokensUsed + cost > budgetTokens) break;
        tokensUsed += cost;
        snippets.push({
          id: record.id,
          text: record.text,
          dataClass: record.dataClass,
          citations: record.citations,
          score
        });
      }
      return { snippets, filtered, tokensUsed };
    },

    /**
     * Remove records by predicate scope. Used by `pa-forget` so a deleted
     * memory cannot survive in the index.
     * @param {{ids?: string[], scope?: string}} input
     */
    async remove(input = {}) {
      await load();
      const ids = new Set(input.ids ?? []);
      const scope = input.scope ?? 'all';
      const before = records.length;
      records = records.filter((record) => {
        if (ids.size > 0) return !ids.has(record.id);
        if (scope === 'all') return false;
        return !(record.tags ?? []).includes(scope) && record.dataClass !== scope;
      });
      await writeJsonAtomic(indexPath, { version: 1, updated_at: clock.iso(), records });
      return { removed: before - records.length };
    },

    /**
     * Registration seam for the Pi context planner. When PIagent exposes a
     * lane registration hook we call it; in P0 this is a no-op that records
     * intent so `pa-doctor` can prove the lane was wired.
     * @param {{registerLane?: (name: string, retrieve: Function) => void}} registry
     */
    register(registry) {
      if (registry && typeof registry.registerLane === 'function') {
        registry.registerLane(laneName, (query, options) => this.retrieve(query, options));
        return { registered: true, lane: laneName };
      }
      return { registered: false, lane: laneName, reason: 'no_registerLane' };
    },

    /** @returns {Promise<{records: number}>} */
    async stat() {
      await load();
      return { records: records.length };
    }
  };
}
