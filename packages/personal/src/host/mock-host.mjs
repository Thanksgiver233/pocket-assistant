/**
 * MockHost — an in-memory HostPort.
 *
 * Used by every test, by `pa-run` without a live Pi session, and by
 * `pa-doctor --smoke`. It implements the same hook pipeline semantics as the
 * Pi adapter: handlers run in registration order, may transform the payload,
 * and may throw to veto.
 * @module @piagent/personal/host/mock-host
 */

import { HOOKS } from './host-port.mjs';

/**
 * @param {{name?: string, tools?: Object[]}} [opts]
 * @returns {Object} HostPort plus test affordances
 */
export function createMockHost(opts = {}) {
  /** @type {Map<string, Function[]>} */
  const hooks = new Map(HOOKS.map((hook) => [hook, []]));
  /** @type {Map<string, any>} */
  const tools = new Map();
  /** @type {Object[]} every tool invocation, in order */
  const calls = [];
  /** @type {Object[]} */
  const hookLog = [];
  /** @type {Object[]} */
  const sessions = [];

  for (const tool of opts.tools ?? []) {
    tools.set(tool.id, tool);
  }

  return {
    name: opts.name ?? 'mock',

    registerHook(hook, handler) {
      if (!hooks.has(hook)) throw new TypeError(`unknown hook: ${hook}`);
      if (typeof handler !== 'function') throw new TypeError('hook handler must be a function');
      hooks.get(hook).push(handler);
    },

    registerTool(tool) {
      if (!tool || typeof tool.id !== 'string') throw new TypeError('tool.id must be a string');
      if (typeof tool.invoke !== 'function') throw new TypeError(`tool ${tool.id} has no invoke()`);
      if (tools.has(tool.id)) throw new TypeError(`duplicate tool id: ${tool.id}`);
      tools.set(tool.id, tool);
    },

    listTools() {
      return [...tools.values()];
    },

    /**
     * Run every handler for a hook. Later handlers see earlier transforms.
     * @param {string} hook
     * @param {Object} payload
     */
    async emitHook(hook, payload) {
      const handlers = hooks.get(hook);
      if (!handlers) throw new TypeError(`unknown hook: ${hook}`);
      let current = payload;
      for (const handler of handlers) {
        const next = await handler(current);
        if (next && typeof next === 'object') current = next;
      }
      hookLog.push({ hook, payload: current });
      return current;
    },

    async appendSession(record) {
      sessions.push(record);
    },

    // ── test affordances ─────────────────────────────────────────────
    /** @internal */ _calls: calls,
    /** @internal */ _hookLog: hookLog,
    /** @internal */ _sessions: sessions,
    /** @internal */ _hooks: hooks,
    /** @internal */ _recordCall(entry) {
      calls.push(entry);
    },
    /** @internal */ _reset() {
      calls.length = 0;
      hookLog.length = 0;
      sessions.length = 0;
    }
  };
}
