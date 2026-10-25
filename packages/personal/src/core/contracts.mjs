/**
 * PIA contracts — the frozen vocabulary shared by every module.
 *
 * Rule: this file has no imports and no side effects. Everything in the
 * system agrees on these names; nothing else may redefine them.
 *
 * Language note (ADR-8): the implementation is zero-dependency ESM
 * JavaScript, not TypeScript. Types live in these JSDoc typedefs and are
 * enforced at runtime by the schema validator (core/schema.mjs). Reason:
 * the build environment has no working shell/compiler, so a source file
 * that cannot be compiled is a source file that cannot be trusted.
 *
 * @module @piagent/personal/core/contracts
 */

/** Risk classes for any action a tool can perform. @readonly */
export const RISK = Object.freeze({
  /** read-only, local, no egress */
  R0: 'R0',
  /** reversible write (calendar edit, note create, file move) */
  R1: 'R1',
  /** external side effect, compensable (send mail/message, open PR) */
  R2: 'R2',
  /** high impact / hard to undo (pay, delete, sign) */
  R3: 'R3',
  /** forbidden to the agent */
  R4: 'R4'
});

/** Ordered risk levels, low to high. */
export const RISK_ORDER = Object.freeze([RISK.R0, RISK.R1, RISK.R2, RISK.R3, RISK.R4]);

/** Numeric rank for comparisons (`riskRank('R2') === 2`). */
export const RISK_RANK = Object.freeze({ R0: 0, R1: 1, R2: 2, R3: 3, R4: 4 });

/** Data sensitivity classes. @readonly */
export const DATA_CLASS = Object.freeze({
  /** public, safe to send anywhere */
  D0: 'D0',
  /** personal, low sensitivity (calendar titles, todos, bookmarks) */
  D1: 'D1',
  /** personal, high sensitivity (mail bodies, chats, finance, health, location) */
  D2: 'D2',
  /** credentials / secrets — never leave the vault */
  D3: 'D3'
});

export const DATA_ORDER = Object.freeze([DATA_CLASS.D0, DATA_CLASS.D1, DATA_CLASS.D2, DATA_CLASS.D3]);
export const DATA_RANK = Object.freeze({ D0: 0, D1: 1, D2: 2, D3: 3 });

/** Consent verdict for a single action. @readonly */
export const VERDICT = Object.freeze({
  ALLOW: 'allow',
  CONFIRM: 'confirm',
  DENY: 'deny'
});

/** Operator permission modes, mirrored 1:1 from PIagent's `/permission`. */
export const PERMISSION_MODE = Object.freeze({
  READ_ONLY: 'read-only',
  WORKSPACE_WRITE: 'workspace-write',
  FULL_ACCESS: 'full-access'
});

/**
 * Effective capability = min(mode, grants). Each mode caps the highest risk
 * an action may reach without an extra confirmation.
 */
export const MODE_RISK_CEILING = Object.freeze({
  [PERMISSION_MODE.READ_ONLY]: RISK.R0,
  [PERMISSION_MODE.WORKSPACE_WRITE]: RISK.R1,
  [PERMISSION_MODE.FULL_ACCESS]: RISK.R2
});

/** Channel a Turn arrives from. */
export const CHANNEL = Object.freeze({
  CLI: 'cli',
  DASHBOARD: 'dashboard',
  IM: 'im',
  TRIGGER: 'trigger',
  SYSTEM: 'system'
});

/** Delivery urgency tiers (M8). Default is the least intrusive one. */
export const URGENCY = Object.freeze({
  SILENT: 'silent',
  LOG: 'log',
  DIGEST: 'digest',
  INTERRUPT: 'interrupt'
});

export const URGENCY_RANK = Object.freeze({ silent: 0, log: 1, digest: 2, interrupt: 3 });

/** Run / step status. */
export const RUN_STATUS = Object.freeze({
  RUNNING: 'running',
  AWAITING_APPROVAL: 'awaiting_approval',
  BLOCKED: 'blocked',
  DONE: 'done',
  DENIED: 'denied',
  FAILED: 'failed',
  ABORTED: 'aborted'
});

/** Where a memory fact came from — drives the write gate. */
export const MEMORY_SOURCE = Object.freeze({
  USER_EXPLICIT: 'user_explicit',
  OBSERVED: 'observed',
  INFERRED: 'inferred'
});

export const MEMORY_LAYER = Object.freeze({
  EPISODIC: 'episodic',
  SEMANTIC: 'semantic',
  PROCEDURAL: 'procedural'
});

/**
 * Registration order in `compose.mjs`. The order *is* a security property:
 * profile and grants must load before any checker is registered, connectors
 * must be able to fail independently, and channels come last because nothing
 * may be delivered before policy is live.
 */
export const REGISTRATION_ORDER = Object.freeze([
  'profile.load',
  'consent.load',
  'guard.register',
  'connectors.init',
  'tools.register',
  'context.registerLane',
  'scheduler.start',
  'channels.start'
]);

/**
 * @typedef {Object} Turn
 * @property {string} id
 * @property {string} channel      one of CHANNEL
 * @property {string} text         raw user text (or trigger payload summary)
 * @property {string} at           ISO-8601 with offset
 * @property {string} [threadId]
 * @property {boolean} [untrusted] true when any part of the text came from an untrusted source
 * @property {string} [mode]       one of PERMISSION_MODE; defaults to profile.autonomy default
 */

/**
 * @typedef {Object} Action
 * @property {string} id
 * @property {string} kind          semantic verb, e.g. 'calendar.update_event'
 * @property {string[]} toolIds     tool ids that may be used to realise it
 * @property {string} risk          one of RISK
 * @property {string[]} dataIn      one of DATA_CLASS
 * @property {boolean} egress       true if data leaves the machine
 * @property {boolean} reversible
 * @property {string} summary       human sentence shown on the confirmation card
 * @property {Object} [params]
 * @property {string} [origin]      'user' | 'untrusted_content' | 'trigger'
 */

/**
 * @typedef {Object} Decision
 * @property {string} verdict       one of VERDICT
 * @property {string} [reason]     stable machine code, e.g. 'mode_ceiling', 'grant_expired' * @property {string} [detail]     human readable
 * @property {string} [grantId]
 * @property {string} [requires]   'none' | 'user' | 'identity'
 * @property {string} risk
 */

/**
 * @typedef {Object} ToolManifest
 * @property {string} id
 * @property {string} connector
 * @property {'mcp'|'native'|'pack'} kind
 * @property {string} risk
 * @property {boolean} reversible
 * @property {{tool?: string, strategy?: string, window_s?: number}} [undo]
 * @property {string[]} dataIn
 * @property {string} dataOut
 * @property {boolean} egress
 * @property {boolean} idempotent
 * @property {{tokens?: number, usd?: number}} [cost_hint]
 * @property {boolean} [dry_run]
 * @property {{default: 'auto'|'confirm'|'deny', standing_grant?: {max_ttl_h?: number}, identity_check?: string}} approval
 */

/**
 * @typedef {Object} Grant
 * @property {string} grant_id
 * @property {string} connector
 * @property {string[]} actions
 * @property {string[]} data_classes
 * @property {Object} [constraints]
 * @property {string} issued_at
 * @property {string} expires_at
 * @property {'user'|'policy'} issued_by
 * @property {string} connector_digest
 * @property {string|null} [revoked_at]
 */

/**
 * @typedef {Object} AuditEvent
 * @property {string} ts
 * @property {string} run_id
 * @property {string} turn_id
 * @property {string} kind        'intent'|'decision'|'tool_call'|'tool_result'|'delivery'|'budget'|'memory'
 * @property {string} [tool]
 * @property {string} [risk]
 * @property {Object} [decision]
 * @property {string[]} [data_classes]
 * @property {boolean} [egress]
 * @property {Object} [outcome]
 * @property {Object} [cost]
 * @property {string} prev_hash
 * @property {string} hash
 */

export default {
  RISK,
  RISK_ORDER,
  RISK_RANK,
  DATA_CLASS,
  DATA_ORDER,
  DATA_RANK,
  VERDICT,
  PERMISSION_MODE,
  MODE_RISK_CEILING,
  CHANNEL,
  URGENCY,
  URGENCY_RANK,
  RUN_STATUS,
  MEMORY_SOURCE,
  MEMORY_LAYER,
  REGISTRATION_ORDER
};
