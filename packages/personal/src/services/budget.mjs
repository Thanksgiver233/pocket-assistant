/**
 * Budget Governor (M10) — the always-on economics guard.
 *
 * Three kinds of spending, capped separately because they fail differently:
 *  - `passive`   : a user is waiting, overspend is annoying but tolerable
 *  - `proactive` : nobody is waiting, overspend is pure waste
 *  - `index`     : maintenance, capped hard, never allowed to starve the rest
 *
 * `on_exceed`: `stop` throws, `ask` returns needsApproval, `degrade` (default)
 * allows the call but tells the caller what to give up.
 *
 * State is persisted per day so a restart does not hand back a fresh budget
 * (P1-6). Reservations are always settled by the caller — including on the
 * veto and error paths — so a blocked call never silently consumes budget.
 *
 * @module @piagent/personal/services/budget
 */

import { join } from 'node:path';
import { readJson, writeJsonAtomic, ensureDir } from '../core/jsonl.mjs';
import { BudgetError, ConfigError } from '../core/errors.mjs';

/**
 * @param {{profile: Object, clock: Object, stateDir?: string}} opts
 */
export function createBudget({ profile, clock, stateDir }) {
  if (!profile) throw new ConfigError('budget requires a loaded profile');
  const cfg = profile.budget ?? {};
  const perTurnUsd = numberOr(cfg.per_turn_usd, 0.05);
  const perDayUsd = numberOr(cfg.per_day_usd, 2);
  const proactiveShare = clamp(numberOr(cfg.proactive_share, 0.3), 0, 1);
  const onExceed = cfg.on_exceed ?? 'degrade';
  if (!['stop', 'ask', 'degrade'].includes(onExceed)) {
    throw new ConfigError(`profile.budget.on_exceed must be stop|ask|degrade, got ${onExceed}`);
  }
  const storePath = stateDir ? join(stateDir, 'budget', 'day.json') : null;

  let day = dayKey(clock.now());
  let spentUsd = 0;
  let spentTokens = 0;
  /** @type {Record<string, {usd: number, tokens: number}>} */
  const byKind = emptyByKind();
  /** @type {Map<string, {kind: string, usd: number, tokens: number}>} */
  const reservations = new Map();
  let seq = 0;
  let loaded = false;

  async function load() {
    if (loaded || !storePath) {
      loaded = true;
      return;
    }
    const store = await readJson(storePath, null);
    if (store && store.day === dayKey(clock.now())) {
      spentUsd = numberOr(store.spentUsd, 0);
      spentTokens = numberOr(store.spentTokens, 0);
      for (const kind of Object.keys(byKind)) {
        const entry = store.byKind?.[kind];
        if (entry) byKind[kind] = { usd: numberOr(entry.usd, 0), tokens: numberOr(entry.tokens, 0) };
      }
    }
    loaded = true;
  }

  async function persist() {
    if (!storePath) return;
    await ensureDir(join(storePath, '..'));
    await writeJsonAtomic(storePath, {
      version: 1,
      day,
      spentUsd: round(spentUsd),
      spentTokens,
      byKind: Object.fromEntries(Object.entries(byKind).map(([kind, value]) => [kind, { usd: round(value.usd), tokens: value.tokens }])),
      updated_at: clock.iso()
    });
  }

  function rollIfNeeded() {
    const today = dayKey(clock.now());
    if (today !== day) {
      day = today;
      spentUsd = 0;
      spentTokens = 0;
      for (const kind of Object.keys(byKind)) byKind[kind] = { usd: 0, tokens: 0 };
      reservations.clear();
    }
  }

  return {
    load,

    /**
     * @param {{kind?: 'passive'|'proactive'|'index', estimateUsd?: number, estimateTokens?: number, label?: string}} input
     */
    async reserve(input = {}) {
      await load();
      rollIfNeeded();
      const kind = input.kind ?? 'passive';
      if (!byKind[kind]) throw new ConfigError(`unknown budget kind: ${kind}`);
      const estimateUsd = numberOr(input.estimateUsd, 0);
      const estimateTokens = numberOr(input.estimateTokens, 0);

      const reasons = [];
      if (estimateUsd > perTurnUsd) reasons.push('per_turn_usd');
      if (spentUsd + estimateUsd > perDayUsd) reasons.push('per_day_usd');
      const kindCap = kind === 'proactive' ? perDayUsd * proactiveShare : perDayUsd;
      if (byKind[kind].usd + estimateUsd > kindCap) reasons.push(`${kind}_share`);

      if (reasons.length === 0) {
        seq += 1;
        const reservationId = `res_${seq}_${clock.now()}`;
        reservations.set(reservationId, { kind, usd: estimateUsd, tokens: estimateTokens });
        return { ok: true, reservationId, remainingUsd: Math.max(0, perDayUsd - spentUsd) };
      }

      const detail = { reasons, estimateUsd, spentUsd, dayCap: perDayUsd, kindCap };
      if (onExceed === 'stop') throw new BudgetError(`budget exceeded (${reasons.join(', ')})`, detail);
      if (onExceed === 'ask') {
        return { ok: false, needsApproval: true, reasons, remainingUsd: Math.max(0, perDayUsd - spentUsd) };
      }
      seq += 1;
      const reservationId = `res_${seq}_${clock.now()}`;
      reservations.set(reservationId, { kind, usd: Math.min(estimateUsd, perTurnUsd), tokens: estimateTokens });
      return {
        ok: true,
        reservationId,
        degraded: true,
        downgrade: downgradesFor(reasons),
        reasons,
        remainingUsd: Math.max(0, perDayUsd - spentUsd)
      };
    },

    /**
     * Settle a reservation with the real cost. Unknown reservations are
     * counted conservatively as passive spend (never ignored).
     * @param {{reservationId: string, actualUsd?: number, actualTokens?: number}} input
     */
    async settle(input) {
      await load();
      rollIfNeeded();
      const reservation = reservations.get(input.reservationId);
      const usd = numberOr(input.actualUsd, reservation?.usd ?? 0);
      const tokens = numberOr(input.actualTokens, reservation?.tokens ?? 0);
      const kind = reservation?.kind ?? 'passive';
      spentUsd += usd;
      spentTokens += tokens;
      byKind[kind].usd += usd;
      byKind[kind].tokens += tokens;
      reservations.delete(input.reservationId);
      await persist();
      // `unknown` is a first-class signal: the caller settled a reservation
      // this process never issued (restart, cross-process, or a bug). The
      // money is still counted — silence would be the only real failure.
      // Only present when true, so a normal settle stays a 4-field shape.
      return {
        settled: reservation !== undefined,
        usd,
        tokens,
        kind,
        ...(reservation === undefined ? { unknown: true } : {})
      };
    },

    async status() {
      await load();
      rollIfNeeded();
      return {
        day,
        spentUsd: round(spentUsd),
        spentTokens,
        perDayUsd,
        byKind: Object.fromEntries(
          Object.entries(byKind).map(([kind, value]) => [kind, { usd: round(value.usd), tokens: value.tokens }])
        ),
        remainingUsd: round(Math.max(0, perDayUsd - spentUsd))
      };
    },

    async reset() {
      spentUsd = 0;
      spentTokens = 0;
      for (const kind of Object.keys(byKind)) byKind[kind] = { usd: 0, tokens: 0 };
      reservations.clear();
      await persist();
    },

    /** Exposed for doctor: the caps actually in force. */
    caps() {
      return { perTurnUsd, perDayUsd, proactiveShare, onExceed };
    }
  };
}

function emptyByKind() {
  return { passive: { usd: 0, tokens: 0 }, proactive: { usd: 0, tokens: 0 }, index: { usd: 0, tokens: 0 } };
}

/** @param {string[]} reasons */
function downgradesFor(reasons) {
  /** @type {string[]} */
  const plan = [];
  if (reasons.includes('per_turn_usd')) plan.push('use_smaller_model', 'reduce_steps');
  if (reasons.includes('per_day_usd')) plan.push('use_smaller_model', 'defer_non_urgent', 'shorten_context');
  if (reasons.some((reason) => reason.endsWith('_share'))) plan.push('defer_proactive');
  return [...new Set(plan)];
}

/** @param {number} ms */
function dayKey(ms) {
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** @param {unknown} value @param {number} fallback */
function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** @param {number} value @param {number} min @param {number} max */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** @param {number} value */
function round(value) {
  return Math.round(value * 1e6) / 1e6;
}
