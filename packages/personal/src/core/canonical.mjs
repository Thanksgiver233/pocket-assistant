/**
 * Canonical JSON + digests.
 *
 * Approval means "consent to this exact thing". That only works if two runs
 * of the same definition produce the same digest, so objects are serialised
 * with sorted keys and no whitespace.
 * @module @piagent/personal/core/canonical
 */

import { createHash } from 'node:crypto';

/**
 * Deterministic JSON: keys sorted recursively, `undefined` dropped,
 * no insignificant whitespace.
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  return JSON.stringify(sortValue(value));
}

/** @param {unknown} value */
function sortValue(value) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) return null;
    if (typeof value === 'function' || typeof value === 'undefined') return undefined;
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => sortValue(item));
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const key of Object.keys(value).sort()) {
    const sorted = sortValue(/** @type {Record<string, unknown>} */ (value)[key]);
    if (typeof sorted !== 'undefined') out[key] = sorted;
  }
  return out;
}

/**
 * @param {string} text
 * @returns {string} `sha256:<hex>`
 */
export function sha256Hex(text) {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

/**
 * Digest of a structured definition (connector, tool manifest, pack).
 * @param {unknown} value
 * @returns {string}
 */
export function digestOf(value) {
  return sha256Hex(canonicalJson(value));
}

/**
 * Hash-chain link: each audit event commits to its predecessor.
 * @param {string} prevHash
 * @param {Object} payload event without hash fields
 * @returns {string}
 */
export function chainHash(prevHash, payload) {
  return sha256Hex(`${prevHash}\n${canonicalJson(payload)}`);
}
