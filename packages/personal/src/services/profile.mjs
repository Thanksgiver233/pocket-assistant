/**
 * Profile loading and defaults (`pa.profile.v1`).
 *
 * A profile is the one file a user commits. It must therefore contain policy
 * only — never data, never secrets. Everything optional gets a default that
 * is *conservative*: the safe value is the one you get when you omit the key.
 *
 * @module @piagent/personal/services/profile
 */

import { readJson } from '../core/jsonl.mjs';
import { ConfigError } from '../core/errors.mjs';
import { validate } from '../core/schema.mjs';
import { PERMISSION_MODE, DATA_CLASS } from '../core/contracts.mjs';

/** Conservative defaults: no proactive work, read-only, tight budget. */
export const DEFAULT_PROFILE = Object.freeze({
  version: 1,
  persona: { name: '默认助手', language: 'zh-CN', tone: 'concise', address_as: '你' },
  workspace_root: null,
  autonomy: {
    default_mode: PERMISSION_MODE.READ_ONLY,
    default_level: 'assist',
    proactive: {
      enabled: false,
      interrupt_per_day: 2,
      digest_per_day: 4,
      quiet_hours: ['22:00-08:00'],
      cooldown_minutes: 90
    }
  },
  budget: { per_turn_usd: 0.05, per_day_usd: 2, proactive_share: 0.3, on_exceed: 'degrade' },
  connectors: { allow: [], deny: [], default_data_ceiling: DATA_CLASS.D2 },
  tools: { require_manifest: true, deny_risk: ['R4'], confirm_risk: ['R2', 'R3'], standing_grant_max_ttl_h: 168 },
  memory: { write_gate: 'strict', retention_days: { episodic: 90, semantic: 0, procedural: 0 }, allow_d2: false },
  privacy: { egress: 'confirm', redaction: true, telemetry: 'local' }
});

/**
 * @param {Object} input raw profile from disk
 * @returns {Object} profile with defaults filled and validated
 */
export function normaliseProfile(input) {
  if (!input || typeof input !== 'object') throw new ConfigError('profile must be a JSON object');
  const merged = deepMerge(structuredClone(DEFAULT_PROFILE), input);
  merged.version = 1;
  return merged;
}

/**
 * Load + validate against the published schema.
 * @param {string} profilePath
 * @param {Object} schema
 * @returns {Promise<{profile: Object, raw: Object}>}
 */
export async function loadProfile(profilePath, schema) {
  const raw = await readJson(profilePath, null);
  if (!raw) {
    throw new ConfigError(
      `profile not found: ${profilePath}. Run \`pa-init <dir>\` first (no implicit defaults: an unconfigured agent must not run).`
    );
  }
  validate(schema, raw);
  const profile = normaliseProfile(raw);
  assertProfileCoherent(profile, profilePath);
  return { profile, raw };
}

/**
 * Cross-field checks the schema cannot express.
 * @param {Object} profile
 * @param {string} source
 */
export function assertProfileCoherent(profile, source = 'profile') {
  const mode = profile.autonomy?.default_mode;
  if (mode === PERMISSION_MODE.READ_ONLY && profile.tools?.confirm_risk?.length === 0) {
    throw new ConfigError(`${source}: read-only profile must still confirm R2/R3 actions`);
  }
  if (profile.privacy?.egress === 'never' && profile.connectors?.allow?.length > 0) {
    // Legal, but likely a mistake: allowed connectors + no egress means
    // every action on them is a dead end. Warn via doctor, not here.
  }
  if (profile.autonomy?.proactive?.enabled === true) {
    const caps = profile.autonomy.proactive;
    if ((caps.interrupt_per_day ?? 0) > 5) {
      throw new ConfigError(`${source}: interrupt_per_day above 5 violates the proactivity policy`);
    }
  }
  if (profile.memory?.allow_d2 === true && profile.privacy?.telemetry === 'company') {
    throw new ConfigError(`${source}: D2 memory may not be combined with company telemetry`);
  }
}

/**
 * @param {Object} base
 * @param {Object} patch
 * @returns {Object}
 */
function deepMerge(base, patch) {
  for (const [key, value] of Object.entries(patch ?? {})) {
    // Prototype-pollution guard: a committed profile is attacker-reachable
    // if someone clones a repository containing one (P1-11).
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    if (value === undefined) continue;
    if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      base[key] = deepMerge(base[key], value);
    } else {
      base[key] = value;
    }
  }
  return base;
}
