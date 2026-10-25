/**
 * Persona Memory (M6) — three layers, a hard write gate, citations, expiry.
 *
 * The interesting part of memory is not retrieval, it is **admission**:
 * what may be remembered, on whose authority, for how long, and how it is
 * forgotten. Retrieval is deliberately simple (lexical scoring) because a
 * vector store would make the governance story harder, not better.
 *
 * Write gate (all four must pass):
 *   1. trustworthy  : explicit/observed, or inferred with confidence >= 0.7
 *   2. durable      : 4..280 chars, not single-use chatter
 *   3. non-sensitive: D3 never; D2 only when profile.memory.allow_d2
 *   4. useful       : statement differs from what we already know
 *
 * @module @piagent/personal/services/memory
 */

import { join } from 'node:path';
import { DATA_CLASS, DATA_RANK, MEMORY_LAYER, MEMORY_SOURCE } from '../core/contracts.mjs';
import { ConfigError, ValidationError } from '../core/errors.mjs';
import { readJson, writeJsonAtomic, ensureDir } from '../core/jsonl.mjs';
import { newId, isExpired, addHoursIso } from '../core/ids.mjs';
import { digestOf } from '../core/canonical.mjs';

const MIN_STATEMENT = 4;
const MAX_STATEMENT = 280;

/**
 * @param {{stateDir: string, profile: Object, clock: Object}} opts
 */
export function createMemory({ stateDir, profile, clock }) {
  if (!stateDir) throw new ConfigError('memory requires stateDir');
  if (!profile) throw new ConfigError('memory requires a loaded profile');
  const factsPath = join(stateDir, 'memory', 'facts.json');
  const episodesPath = join(stateDir, 'memory', 'episodes.json');
  const allowD2 = profile.memory?.allow_d2 === true;
  const retention = profile.memory?.retention_days ?? {};

  /** @type {Object[]} */
  let facts = [];
  /** @type {Object[]} */
  let candidates = [];
  /** @type {Object[]} */
  let episodes = [];
  let loaded = false;

  async function load() {
    if (loaded) return;
    await ensureDir(join(stateDir, 'memory'));
    const factsStore = await readJson(factsPath, { version: 1, facts: [], candidates: [] });
    facts = Array.isArray(factsStore.facts) ? factsStore.facts : [];
    candidates = Array.isArray(factsStore.candidates) ? factsStore.candidates : [];
    const episodeStore = await readJson(episodesPath, { version: 1, episodes: [] });
    episodes = Array.isArray(episodeStore.episodes) ? episodeStore.episodes : [];
    loaded = true;
  }

  async function persist() {
    await writeJsonAtomic(factsPath, { version: 1, updated_at: clock.iso(), facts, candidates });
  }

  return {
    load,

    /**
     * Try to remember something. Never throws for a rejected candidate —
     * rejection is a normal outcome and must be visible in telemetry.
     * @param {{statement: string, subject?: string, source?: string, confidence?: number,
     *          data_class?: string, citation?: {kind: string, ref: string}[], layer?: string,
     *          tags?: string[], ttlDays?: number}} input
     * @returns {Promise<{accepted: boolean, id?: string, reason?: string, candidate?: boolean}>}
     */
    async remember(input) {
      await load();
      const statement = String(input?.statement ?? '').trim();
      if (statement.length < MIN_STATEMENT || statement.length > MAX_STATEMENT) {
        return { accepted: false, reason: 'statement_length' };
      }
      const source = input.source ?? MEMORY_SOURCE.USER_EXPLICIT;
      if (!Object.values(MEMORY_SOURCE).includes(source)) {
        throw new ValidationError(`unknown memory source "${source}"`);
      }
      const confidence = typeof input.confidence === 'number' ? input.confidence : source === MEMORY_SOURCE.INFERRED ? 0 : 0.9;
      if (source === MEMORY_SOURCE.INFERRED && confidence < 0.7) {
        // Keep it, but never let it influence retrieval until a human or a
        // stronger signal promotes it.
        const candidate = {
          id: newId('memory'),
          statement,
          subject: input.subject ?? 'general',
          source,
          confidence,
          created_at: clock.iso()
        };
        candidates.push(candidate);
        await persist();
        return { accepted: false, candidate: true, reason: 'inferred_low_confidence', id: candidate.id };
      }

      const dataClass = input.data_class ?? DATA_CLASS.D1;
      if (!Object.values(DATA_CLASS).includes(dataClass)) {
        throw new ValidationError(`unknown data class "${dataClass}"`);
      }
      if (dataClass === DATA_CLASS.D3) return { accepted: false, reason: 'd3_never_remembered' };
      if (dataClass === DATA_CLASS.D2 && !allowD2) {
        return { accepted: false, reason: 'd2_not_allowed_by_profile' };
      }
      const citation = Array.isArray(input.citation) ? input.citation : [];
      if (citation.length === 0) return { accepted: false, reason: 'citation_required' };
      for (const cite of citation) {
        if (!cite || typeof cite.ref !== 'string' || !cite.ref) {
          return { accepted: false, reason: 'citation_malformed' };
        }
      }

      const layer = input.layer ?? MEMORY_LAYER.SEMANTIC;
      const subject = input.subject ?? 'general';
      const fingerprint = digestOf({ subject, statement });
      const duplicate = facts.find((fact) => fact.fingerprint === fingerprint && fact.status === 'active');
      if (duplicate) {
        duplicate.last_used_at = clock.iso();
        await persist();
        return { accepted: false, reason: 'duplicate', id: duplicate.id };
      }

      const ttlDays = input.ttlDays ?? retention[layer] ?? 0;
      const record = {
        id: newId('memory'),
        layer,
        subject,
        statement,
        confidence,
        citation,
        data_class: dataClass,
        tags: Array.isArray(input.tags) ? input.tags.slice(0, 12) : [],
        source,
        fingerprint,
        created_at: clock.iso(),
        expires_at: ttlDays > 0 ? addHoursIso(clock.iso(), ttlDays * 24) : null,
        last_used_at: clock.iso(),
        status: 'active',
        supersedes: null
      };
      facts.push(record);
      await persist();
      return { accepted: true, id: record.id };
    },

    /**
     * Retrieve facts relevant to a query.
     * @param {string} query
     * @param {{limit?: number, grantedDataClasses?: string[]}} [opts]
     * @returns {Promise<{snippets: Object[], citations: Object[], filtered: number}>}
     */
    async recall(query, opts = {}) {
      await load();
      const limit = opts.limit ?? 5;
      const granted = new Set(opts.grantedDataClasses ?? [DATA_CLASS.D0, DATA_CLASS.D1]);
      const tokens = tokenize(query);
      const now = clock.now();
      /** @type {{fact: Object, score: number}[]} */
      const scored = [];
      let filtered = 0;

      for (const fact of facts) {
        if (fact.status !== 'active') continue;
        if (fact.expires_at && isExpired(fact.expires_at, now)) continue;
        const factClass = fact.data_class ?? DATA_CLASS.D1;
        if (DATA_RANK[factClass] > DATA_RANK[DATA_CLASS.D2]) {
          filtered += 1;
          continue;
        }
        if (!granted.has(factClass) && DATA_RANK[factClass] >= DATA_RANK[DATA_CLASS.D2]) {
          filtered += 1;
          continue;
        }
        const haystack = `${fact.subject} ${fact.statement} ${(fact.tags ?? []).join(' ')}`.toLowerCase();
        let score = 0;
        for (const token of tokens) {
          if (haystack.includes(token)) score += 1;
        }
        if (score > 0) {
          score += Math.min(2, Math.max(0, fact.confidence ?? 0));
          if (fact.last_used_at) score += Math.min(1, (now - Date.parse(fact.last_used_at)) < 7 * 86400000 ? 0.5 : 0);
          scored.push({ fact, score });
        }
      }

      scored.sort((a, b) => b.score - a.score || String(b.fact.last_used_at).localeCompare(String(a.fact.last_used_at)));
      const top = scored.slice(0, limit);
      for (const hit of top) hit.fact.last_used_at = clock.iso();
      if (top.length > 0) await persist();

      return {
        snippets: top.map(({ fact }) => ({
          id: fact.id,
          text: fact.statement,
          subject: fact.subject,
          dataClass: fact.data_class,
          confidence: fact.confidence
        })),
        citations: top.flatMap(({ fact }) => fact.citation.map((cite) => ({ factId: fact.id, ...cite }))),
        filtered
      };
    },

    /**
     * Physical deletion. `scope` is 'all' or a subject / connector tag /
     * data class. Returns removed ids so the caller can log exactly what
     * disappeared (and `pa-forget` can verify nothing remains).
     * @param {{scope?: string, since?: string, ids?: string[]}} input
     */
    async forget(input = {}) {
      await load();
      const scope = input.scope ?? 'all';
      const sinceMs = input.since ? Date.parse(input.since) : null;
      if (input.since && Number.isNaN(sinceMs)) throw new ValidationError('bad --since timestamp');
      const idSet = input.ids ? new Set(input.ids) : null;

      const removed = [];
      facts = facts.filter((fact) => {
        const matches =
          (idSet ? idSet.has(fact.id) : true) &&
          (scope === 'all' ||
            fact.subject === scope ||
            fact.data_class === scope ||
            (fact.tags ?? []).includes(scope)) &&
          (sinceMs === null || Date.parse(fact.created_at) >= sinceMs);
        if (matches) {
          removed.push(fact.id);
          return false;
        }
        return true;
      });
      const removedCandidates = [];
      candidates = candidates.filter((candidate) => {
        const matches =
          (scope === 'all' || candidate.subject === scope) &&
          (sinceMs === null || Date.parse(candidate.created_at) >= sinceMs);
        if (matches) removedCandidates.push(candidate.id);
        return !matches;
      });
      const removedEpisodes = scope === 'all' ? episodes.length : episodes.filter((episode) => (episode.tags ?? []).includes(scope)).length;
      episodes = scope === 'all' ? [] : episodes.filter((episode) => !(episode.tags ?? []).includes(scope));
      await persist();
      await writeJsonAtomic(episodesPath, { version: 1, episodes });
      // Episodes count too: a "forget everything" that silently keeps the
      // interaction log would be a lie in the one place honesty matters.
      return {
        removed: removed.length + removedCandidates.length,
        removedFacts: removed.length,
        removedCandidates: removedCandidates.length,
        removedEpisodes,
        ids: [...removed, ...removedCandidates]
      };
    },

    /** @returns {Promise<Object[]>} active facts (use sparingly — for UI/doctor) */
    async list(layer) {
      await load();
      return facts.filter((fact) => fact.status === 'active' && (!layer || fact.layer === layer)).map((fact) => ({ ...fact }));
    },

    /** Record an interaction summary (episodic layer). */
    async rememberEpisode({ turnId, summary, tags = [] }) {
      await load();
      if (!summary) return { accepted: false, reason: 'empty' };
      episodes.push({
        id: newId('event'),
        turnId,
        summary: String(summary).slice(0, 500),
        tags,
        at: clock.iso()
      });
      episodes = episodes.slice(-500);
      await writeJsonAtomic(episodesPath, { version: 1, episodes });
      return { accepted: true };
    },

    /** Doctor hook: counts by layer + expiry sweep. */
    async stat() {
      await load();
      const now = clock.now();
      const active = facts.filter((fact) => fact.status === 'active' && (!fact.expires_at || !isExpired(fact.expires_at, now)));
      const byLayer = {};
      for (const fact of active) byLayer[fact.layer] = (byLayer[fact.layer] ?? 0) + 1;
      return { total: facts.length, active: active.length, byLayer, candidates: candidates.length, episodes: episodes.length };
    }
  };
}

/**
 * Tokenise for lexical scoring: latin words + CJK bigrams (no dictionary,
 * no external tokenizer).
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  const lower = String(text ?? '').toLowerCase();
  /** @type {string[]} */
  const tokens = [];
  for (const word of lower.split(/[^\p{Letter}\p{Number}]+/u)) {
    if (!word) continue;
    if (/[\u4e00-\u9fff]/.test(word)) {
      if (word.length === 1) tokens.push(word);
      for (let i = 0; i < word.length - 1; i += 1) tokens.push(word.slice(i, i + 2));
    } else if (word.length > 1 && word.length < 40) {
      tokens.push(word);
    }
  }
  return [...new Set(tokens)];
}
