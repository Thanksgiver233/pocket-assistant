/**
 * HostPort — the only surface PIA is allowed to touch on the host.
 *
 * PIagent runs as a Pi extension. We never import Pi internals: the
 * extension entry receives a host object and we talk to that. Two
 * implementations exist:
 *
 *  - `host/pi-adapter.mjs`  : production bridge to the real Pi/PIagent host
 *  - `host/mock-host.mjs`   : in-memory host for tests and for `pa-run` when
 *                             no Pi session is available
 *
 * Keeping this boundary strict is what makes the whole system testable in an
 * environment where neither Pi nor its hooks can be installed.
 *
 * @module @piagent/personal/host/host-port
 */

import { ConfigError } from '../core/errors.mjs';

/** The six hook points PIA registers. Nothing else is used. */
export const HOOKS = Object.freeze([
  'session_start',
  'input',
  'agent_start',
  'tool_call',
  'tool_result',
  'completion'
]);

/**
 * @typedef {Object} HostTool
 * @property {string} id
 * @property {Object} manifest         ToolManifest (see core/contracts)
 * @property {(args: Object, ctx: Object) => Promise<Object>} invoke
 */

/**
 * @typedef {Object} HostPort
 * @property {string} name
 * @property {(hook: string, handler: (payload: Object) => (Object|void|Promise<Object|void>)) => void} registerHook
 * @property {(tool: HostTool) => void} registerTool
 * @property {() => HostTool[]} listTools
 * @property {(name: string, payload: Object) => Promise<Object>} emitHook
 * @property {(record: Object) => Promise<void>} [appendSession]
 */

/**
 * Fail fast on a host that does not implement the contract. Called once, at
 * compose time — a half-implemented host must never reach a tool call.
 * @param {unknown} host
 * @returns {HostPort}
 */
export function assertHostPort(host) {
  if (!host || typeof host !== 'object') {
    throw new ConfigError('host is required: pass a HostPort implementation');
  }
  const candidate = /** @type {Record<string, unknown>} */ (host);
  for (const method of ['registerHook', 'registerTool', 'listTools', 'emitHook']) {
    if (typeof candidate[method] !== 'function') {
      throw new ConfigError(`host is missing required method "${method}"`);
    }
  }
  if (typeof candidate.name !== 'string' || !candidate.name) {
    throw new ConfigError('host.name must be a non-empty string');
  }
  return /** @type {HostPort} */ (host);
}

/**
 * Run the tool_call hook chain. Every registered handler sees the payload;
 * a handler may return a modified payload, but it may also throw to veto the
 * call (that is the fail-closed path).
 * @param {HostPort} host
 * @param {Object} payload
 * @returns {Promise<Object>}
 */
export async function runHookChain(host, payload) {
  const result = await host.emitHook('tool_call', payload);
  return result ?? payload;
}
