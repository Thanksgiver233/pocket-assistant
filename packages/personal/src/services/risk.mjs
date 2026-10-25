/**
 * Risk classification helpers (M4 support).
 *
 * Tools declare a risk; this module is the single place that decides what a
 * declaration is allowed to mean, so a connector author cannot quietly
 * downgrade a write to a read.
 * @module @piagent/personal/services/risk
 */

import { RISK, RISK_ORDER, RISK_RANK, DATA_CLASS, DATA_ORDER, DATA_RANK } from '../core/contracts.mjs';
import { ValidationError } from '../core/errors.mjs';

/** @param {string} risk */
export function assertRisk(risk) {
  if (!RISK_ORDER.includes(risk)) {
    throw new ValidationError(`unknown risk class "${risk}" (expected R0..R4)`);
  }
  return risk;
}

/** @param {string} dataClass */
export function assertDataClass(dataClass) {
  if (!DATA_ORDER.includes(dataClass)) {
    throw new ValidationError(`unknown data class "${dataClass}" (expected D0..D3)`);
  }
  return dataClass;
}

/** @param {string} a @param {string} b */
export function maxDataClass(a, b) {
  return DATA_RANK[a] >= DATA_RANK[b] ? a : b;
}

/** @param {string[]} classes */
export function maxDataClassOf(classes) {
  return classes.reduce((acc, cls) => maxDataClass(acc, assertDataClass(cls)), DATA_CLASS.D0);
}

/**
 * Derive the effective risk of a tool manifest. A declaration may be raised
 * by the facts but never lowered: egress + external side effects cannot be
 * declared R0.
 * @param {Object} manifest
 * @returns {string} risk
 */
export function deriveRisk(manifest) {
  const declared = manifest.risk ? assertRisk(manifest.risk) : null;
  let floor = RISK.R0;
  const dataIn = manifest.data_in ?? manifest.dataIn ?? [];
  const classes = dataIn.map(assertDataClass);
  if (manifest.egress) floor = atLeast(floor, RISK.R2);
  if (manifest.reversible === false) floor = atLeast(floor, RISK.R2);
  if (classes.includes(DATA_CLASS.D2) || classes.includes(DATA_CLASS.D3)) floor = atLeast(floor, RISK.R1);
  return declared ? atLeast(declared, floor) : floor;
}

/**
 * @param {string} a @param {string} b
 * @returns {string} the higher of the two
 */
export function atLeast(a, b) {
  return RISK_RANK[assertRisk(a)] >= RISK_RANK[assertRisk(b)] ? a : b;
}

/**
 * @param {string} risk
 * @param {string} ceiling
 * @returns {boolean} true when `risk` is above `ceiling`
 */
export function exceeds(risk, ceiling) {
  return RISK_RANK[assertRisk(risk)] > RISK_RANK[assertRisk(ceiling)];
}

/**
 * Human reason for why a risk was classified this way — used on the
 * confirmation card so the user sees *why* they are being asked.
 * @param {Object} manifest
 * @returns {string}
 */
export function explainRisk(manifest) {
  const parts = [];
  if (manifest.egress) parts.push('数据会离开本机');
  if (manifest.reversible === false) parts.push('动作不可撤销');
  const classes = (manifest.data_in ?? manifest.dataIn ?? []).map(assertDataClass);
  if (classes.includes(DATA_CLASS.D2)) parts.push('涉及个人高敏数据');
  if (parts.length === 0) parts.push('只读本地操作');
  return `${deriveRisk(manifest)}：${parts.join('、')}`;
}
