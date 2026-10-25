/**
 * PiHostAdapter — production bridge to a real Pi/PIagent host.
 *
 * The Pi extension API is not vendored here and must not be imported
 * directly (that would couple us to a pinned upstream version and break the
 * extension contract). Instead the extension entry hands us a `pi` object
 * and we adapt whatever documented shape it exposes. Both common shapes are
 * accepted:
 *
 *   1. grouped:  { hooks: { on(name, fn) }, tools: { register(def) } }
 *   2. flat:     { on(name, fn), registerTool(def) }
 *
 * If neither shape is present we throw ConfigError at compose time. Failing
 * loudly once is better than silently running an unguarded agent.
 *
 * @module @piagent/personal/host/pi-adapter
 */

import { ConfigError } from '../core/errors.mjs';
import { HOOKS } from './host-port.mjs';

/**
 * @param {Object} pi the host object handed to the extension entry
 * @returns {Object} HostPort
 */
export function createPiHost(pi) {
  if (!pi || typeof pi !== 'object') {
    throw new ConfigError('createPiHost requires the Pi extension host object');
  }
  const source = /** @type {Record<string, any>} */ (pi);

  const onHook =
    pick(source, ['hooks', 'on']) ??
    pick(source, ['on']) ??
    pick(source, ['hooks', 'register']) ??
    null;
  const registerToolFn =
    pick(source, ['tools', 'register']) ??
    pick(source, ['registerTool']) ??
    pick(source, ['tools', 'add']) ??
    null;

  if (typeof onHook !== 'function') {
    throw new ConfigError(
      'Pi host exposes no hook registration (expected pi.hooks.on / pi.on). Refusing to run unguarded.'
    );
  }
  if (typeof registerToolFn !== 'function') {
    throw new ConfigError('Pi host exposes no tool registration (expected pi.tools.register / pi.registerTool)');
  }

  /** @type {Map<string, Function[]>} */
  const hooks = new Map(HOOKS.map((hook) => [hook, []]));
  /** @type {Map<string, any>} */
  const tools = new Map();

  return {
    name: 'pi',

    registerHook(hook, handler) {
      if (!hooks.has(hook)) throw new TypeError(`unknown hook: ${hook}`);
      hooks.get(hook).push(handler);
      onHook.call(source.hooks ?? source, hook, handler);
    },

    registerTool(tool) {
      if (tools.has(tool.id)) throw new TypeError(`duplicate tool id: ${tool.id}`);
      tools.set(tool.id, tool);
      registerToolFn.call(source.tools ?? source, {
        name: tool.id,
        description: tool.manifest?.summary ?? tool.manifest?.description ?? tool.id,
        parameters: tool.manifest?.parameters,
        handler: (args, ctx) => tool.invoke(args, ctx)
      });
    },

    listTools() {
      return [...tools.values()];
    },

    async emitHook(hook, payload) {
      // Pi owns the real pipeline; when embedded we simply pass the payload
      // through our own handlers and let Pi dispatch its own copy.
      let current = payload;
      for (const handler of hooks.get(hook) ?? []) {
        const next = await handler(current);
        if (next && typeof next === 'object') current = next;
      }
      return current;
    },

    async appendSession(record) {
      const append = pick(source, ['session', 'append']) ?? pick(source, ['appendSession']);
      if (typeof append === 'function') await append.call(source.session ?? source, record);
    }
  };
}

/**
 * Resolve `a.b.c` on an object, returning undefined unless every hop exists.
 * @param {Record<string, any>} source
 * @param {string[]} path
 */
function pick(source, path) {
  let node = source;
  for (const key of path) {
    if (!node || typeof node !== 'object') return undefined;
    node = node[key];
  }
  return node;
}
