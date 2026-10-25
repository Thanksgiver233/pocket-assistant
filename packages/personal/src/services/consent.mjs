/**
 * Consent Kernel (M4) — the single authority on "may this action happen?".
 *
 * Design commitments, in priority order:
 *
 *  1. FAIL CLOSED. Unknown, expired, revoked or ambiguous is a deny or a
 *     confirm — never an allow.
 *  2. TWO SOURCES OF TRUTH, ONE ORDERING. PIagent owns the coarse mode
 *     (`read-only` / `workspace-write` / `full-access`), we own fine grants
 *     (`scope + TTL + digest`). Effective capability is `min(mode, grants)`:
 *     a mode can never be widened by a grant, a grant can never widen a mode.
 *  3. TAINT BLOCKS EGRESS. An action whose origin is untrusted content and
 *     which sends data out is denied outright — no confirmation prompt can
 *     turn it into an allow (Muse / Dots lesson, applied at dispatch layer).
 *  4. ACTION, NOT TOOL CALL. One semantic action may use several tools; the
 *     user confirms once.
 *
 * Fixes folded in after the P0 review (reviews/p0-src-review.md):
 *  - grants are consulted for every risk level, not only D2 (P1-3);
 *  - R1 requires a first-time confirmation unless a grant covers it (P1-3);
 *  - grant expiry/revocation is evaluated at check time, and revocation is
 *    persisted instead of being filtered out of the file (P1-4);
 *  - a missing connector digest is a mismatch, not a pass (P1-4);
 *  - `MODE_RISK_CEILING.read-only` was parsed as a subtraction (P2-1);
 *  - profile `tools.deny_risk` / `tools.confirm_risk` are honoured.
 *
 * @module @piagent/personal/services/consent
 */

import {
  VERDICT,
  RISK,
  DATA_CLASS,
  DATA_RANK,
  PERMISSION_MODE,
  MODE_RISK_CEILING,
  RISK_RANK
} from '../core/contracts.mjs';
import { ConfigError } from '../core/errors.mjs';
import { assertRisk, assertDataClass, exceeds } from './risk.mjs';
import { readJson, writeJsonAtomic } from '../core/jsonl.mjs';
import { addHoursIso, epochOf, isExpired } from '../core/ids.mjs';

/**
 * @param {{profile: Object, grantsPath: string, clock: Object}} opts
 */
export function createConsent({ profile, grantsPath, clock }) {
  if (!profile) throw new ConfigError('consent requires a loaded profile');
  if (!grantsPath) throw new ConfigError('consent requires grantsPath (machine-level, outside the workspace)');

  /** @type {import('../core/contracts.mjs').Grant[]} all records, including revoked */
  let records = [];
  const dropped = new Set();

  const denyRisk = new Set(profile.tools?.deny_risk ?? []);
  const confirmRisk = new Set(profile.tools?.confirm_risk ?? []);

  /** Active = not revoked, not expired at this instant. */
  function activeGrants(now = clock.now()) {
    return records.filter((grant) => !grant.revoked_at && !isExpired(grant.expires_at, now));
  }

  return {
    async load() {
      const raw = await readJson(grantsPath, { version: 1, grants: [] });
      if (!raw || !Array.isArray(raw.grants)) {
        throw new ConfigError(`grants file is not shaped like { version, grants[] }: ${grantsPath}`);
      }
      const now = clock.now();
      records = [];
      for (const grant of raw.grants) {
        assertGrantShape(grant);
        records.push(grant);
        if (grant.revoked_at || isExpired(grant.expires_at, now)) dropped.add(grant.grant_id);
      }
      return { loaded: activeGrants(now).length, dropped: dropped.size };
    },

    list() {
      return activeGrants().map((grant) => ({ ...grant }));
    },

    revoked() {
      return records.filter((grant) => grant.revoked_at).map((grant) => ({ ...grant }));
    },

    dropped() {
      return [...dropped];
    },

    /**
     * Persist a new grant.
     * @param {{connector: string, actions: string[], data_classes: string[], ttlHours?: number,
     *          constraints?: Object, connectorDigest: string, issuedBy?: 'user'|'policy'}} input
     */
    async grant(input) {
      if (!input?.connector) throw new ConfigError('grant requires a connector id');
      if (!Array.isArray(input.actions) || input.actions.length === 0) {
        throw new ConfigError('grant requires at least one action');
      }
      if (!input.connectorDigest) throw new ConfigError('grant requires the connector digest (consent is pinned to it)');
      const allowed = profile.connectors?.allow ?? [];
      if (allowed.length > 0 && !allowed.includes(input.connector)) {
        throw new ConfigError(`connector "${input.connector}" is not in profile.connectors.allow`);
      }
      const dataClasses = (input.data_classes ?? []).map(assertDataClass);
      const ceiling = profile.connectors?.default_data_ceiling ?? DATA_CLASS.D1;
      for (const cls of dataClasses) {
        if (DATA_RANK[cls] > DATA_RANK[ceiling]) {
          throw new ConfigError(`grant requests ${cls} data but profile ceiling is ${ceiling}`);
        }
      }
      const maxTtl = profile.tools?.standing_grant_max_ttl_h ?? 168;
      const ttlHours = Math.min(input.ttlHours ?? maxTtl, maxTtl);
      const now = clock.now();
      const grant = {
        grant_id: `g_${Math.random().toString(36).slice(2, 10)}${now.toString(36)}`,
        connector: input.connector,
        actions: [...new Set(input.actions)],
        data_classes: [...new Set(dataClasses)],
        constraints: input.constraints ?? {},
        issued_at: clock.iso(),
        expires_at: addHoursIso(clock.iso(), ttlHours),
        issued_by: input.issuedBy ?? 'user',
        connector_digest: input.connectorDigest,
        revoked_at: null
      };
      records.push(grant);
      await persist();
      return { ...grant };
    },

    /** Revoke and persist the revocation (not merely drop it). */
    async revoke(grantId) {
      const grant = records.find((candidate) => candidate.grant_id === grantId);
      // Already revoked = nothing happened. Returning true would let a caller
      // believe it revoked something a second time (and hide a bad grant id).
      if (!grant || grant.revoked_at) return false;
      grant.revoked_at = clock.iso();
      dropped.add(grantId);
      await persist();
      return true;
    },

    /**
     * The one judgement call in the system.
     * @param {import('../core/contracts.mjs').Action} action
     * @param {{mode?: string, connectorDigests?: Record<string,string>}} [ctx]
     * @returns {import('../core/contracts.mjs').Decision}
     */
    check(action, ctx = {}) {
      const mode = ctx.mode ?? profile.autonomy?.default_mode ?? PERMISSION_MODE.READ_ONLY;
      const ceiling = MODE_RISK_CEILING[mode] ?? MODE_RISK_CEILING[PERMISSION_MODE.READ_ONLY];
      const risk = assertRisk(action.risk);
      const dataIn = (action.dataIn ?? []).map(assertDataClass);
      const verdict = (value, reason, detail, requires = 'none', grantId) => ({
        verdict: value,
        risk,
        reason,
        detail,
        requires,
        grantId
      });
      const deny = (reason, detail) => verdict(VERDICT.DENY, reason, detail);
      const confirm = (reason, detail, requires = 'user') => verdict(VERDICT.CONFIRM, reason, detail, requires);
      const allow = (reason, grantId) => verdict(VERDICT.ALLOW, reason, undefined, 'none', grantId);
      const now = clock.now();

      // 1. Hard stops that no grant or mode can override.
      if (risk === RISK.R4 || denyRisk.has(risk)) {
        return deny('risk_forbidden', `动作属于禁止级（${risk}），任何授权都不放行`);
      }
      if (dataIn.includes(DATA_CLASS.D3)) {
        return deny('data_class_blocked', 'D3 凭证不得进入任何动作上下文');
      }
      if (mode === PERMISSION_MODE.READ_ONLY && RISK_RANK[risk] >= RISK_RANK[RISK.R1]) {
        return deny('mode_blocks_write', `当前档位 ${mode} 不允许写操作（动作 ${risk}）`);
      }

      // 2. Untrusted origin + egress = tainted egress. No prompt can help.
      if (action.egress && (action.origin === 'untrusted_content' || action.untrusted === true)) {
        return deny(
          'tainted_egress',
          '动作数据来自不可信内容且会对外发送；需拆分为只读结论 + 人工发起'
        );
      }

      const covering = activeGrants(now).filter(
        (grant) => grant.actions.includes(action.kind) && digestMatches(grant, ctx.connectorDigests)
      );
      const d2Covered = covering.some((grant) => grant.data_classes.includes(DATA_CLASS.D2));

      // 3. D2 needs an explicit grant even in full-access.
      if (dataIn.includes(DATA_CLASS.D2) && !d2Covered) {
        return deny('data_class_blocked', '读取个人高敏数据（D2）需要显式授权，当前没有覆盖该动作的 grant');
      }
      // 4. Any grant must at least cover the data classes the action touches.
      const classCovered = covering.some((grant) =>
        dataIn.every((cls) => cls === DATA_CLASS.D0 || grant.data_classes.includes(cls))
      );
      const grantId = classCovered ? covering.find((grant) => dataIn.every((cls) => cls === DATA_CLASS.D0 || grant.data_classes.includes(cls))).grant_id : undefined;

      // 5. Egress policy.
      const egressPolicy = profile.privacy?.egress ?? 'confirm';
      if (action.egress && egressPolicy === 'never') {
        return deny('egress_forbidden', 'profile.privacy.egress = never，禁止任何出网');
      }

      // 6. Risk vs mode ceiling.
      if (exceeds(risk, ceiling)) {
        return confirm(
          'mode_ceiling',
          `动作 ${risk} 高于当前档位 ${mode} 的上限 ${ceiling}，需要确认`,
          risk === RISK.R3 ? 'identity' : 'user'
        );
      }

      // 7. R3 always double-confirms, even with full access and a grant.
      if (risk === RISK.R3) {
        return confirm('high_impact', '高影响动作需二次确认 + 身份校验', 'identity');
      }

      // 8. R2 with egress: confirm each time (batchable by the UI).
      if (action.egress && egressPolicy === 'confirm') {
        return confirm('egress_confirm', '数据将离开本机，需要确认');
      }

      // 9. Covered by a standing grant: R0/R1 run without a prompt.
      if (grantId && RISK_RANK[risk] <= RISK_RANK[RISK.R1]) return allow('grant', grantId);
      if (grantId && RISK_RANK[risk] === RISK_RANK[RISK.R2]) {
        return confirm('external_side_effect', '对外副作用动作需确认（可批量）');
      }

      // 10. First write without a grant: confirm once (docs/04 §5.2).
      if (RISK_RANK[risk] === RISK_RANK[RISK.R1] || confirmRisk.has(risk)) {
        return confirm('first_time_write', '首次执行该类写入需要确认；确认后可签发常驻授权');
      }

      // 11. Within mode ceiling, no grant needed.
      return allow('within_mode');
    },

    ceilingFor(mode) {
      return MODE_RISK_CEILING[mode] ?? MODE_RISK_CEILING[PERMISSION_MODE.READ_ONLY];
    }
  };

  async function persist() {
    await writeJsonAtomic(grantsPath, {
      version: 1,
      updated_at: clock.iso(),
      grants: records
    });
  }
}

/**
 * A grant is pinned to the connector definition. If the connector changed
 * scope/commands, the old consent no longer applies (same rule as PIagent's
 * digest-pinned MCP approvals). Missing digests = mismatch, never a pass.
 * @param {import('../core/contracts.mjs').Grant} grant
 * @param {Record<string,string>|undefined} digests
 */
function digestMatches(grant, digests) {
  if (!digests) return false;
  const current = digests[grant.connector];
  if (!current) return false;
  return current === grant.connector_digest;
}

/** @param {any} grant */
function assertGrantShape(grant) {
  if (!grant || typeof grant !== 'object') throw new ConfigError('grant entry is not an object');
  for (const key of ['grant_id', 'connector', 'issued_at', 'expires_at', 'connector_digest']) {
    if (typeof grant[key] !== 'string' || !grant[key]) throw new ConfigError(`grant missing ${key}`);
  }
  if (!Array.isArray(grant.actions) || !Array.isArray(grant.data_classes)) {
    throw new ConfigError(`grant ${grant.grant_id} has malformed actions/data_classes`);
  }
  if (Number.isNaN(epochOf(grant.expires_at))) throw new ConfigError(`grant ${grant.grant_id} has an invalid expires_at`);
}
