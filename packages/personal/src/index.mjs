/**
 * Extension entry — what a Pi/PIagent host calls when it loads us.
 *
 * `activate(pi, options)` builds the composed agent and returns its API.
 * The host keeps the object; calling `dispose()` (or `deactivate`) releases
 * subscriptions. Nothing here loops or blocks: Pi owns the turn loop.
 *
 * @module @piagent/personal
 */

import { composePersonalAgent } from './compose.mjs';
import { createPiHost } from './host/pi-adapter.mjs';
import { createMockHost } from './host/mock-host.mjs';

export { composePersonalAgent, runDoctor, createGuard } from './compose.mjs';
export { createMockHost } from './host/mock-host.mjs';
export { createPiHost } from './host/pi-adapter.mjs';
export { HOOKS } from './host/host-port.mjs';
export * as contracts from './core/contracts.mjs';

/**
 * @param {Object} pi host object (or omit and pass options.host)
 * @param {Object} [options]
 * @param {string} options.workspaceRoot
 * @param {string} [options.homeDir]
 * @param {Object} [options.host]        inject a HostPort (tests, pa-run)
 * @param {Object} [options.clock]
 * @param {Buffer|string} [options.masterKey]
 * @param {Object[]} [options.connectors]
 * @param {Object[]} [options.channels]
 * @param {Object} [options.logger]
 * @returns {Promise<{api: Object, dispose: () => Promise<void>, host: Object}>}
 */
export async function activate(pi, options = {}) {
  const host = options.host ?? createPiHost(pi);
  const api = await composePersonalAgent({ ...options, host });
  return {
    api,
    host,
    async dispose() {
      await api.shutdown();
    }
  };
}

export default activate;

/**
 * Convenience for tests / CLI: compose against a mock host.
 * @param {{workspaceRoot: string, homeDir?: string, text?: string, clock?: Object, connectors?: Object[],
 *          channels?: Object[], masterKey?: Buffer|string, profilePath?: string}} options
 */
export async function activateMock(options) {
  const host = createMockHost();
  const api = await composePersonalAgent({ ...options, host });
  return { api, host, dispose: () => api.shutdown() };
}
