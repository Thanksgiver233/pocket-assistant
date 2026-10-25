/**
 * Tool Registry (M5) — the only path from an action to a real capability.
 *
 * Guarantees:
 *  - a tool cannot be registered without a *complete* manifest: the schema is
 *    validated against what the connector actually declared, before any
 *    default is filled in (P0 review finding: normalising first made every
 *    `required` in the schema decorative);
 *  - risk is *derived* and only ever raised, never lowered;
 *  - R3 tools must declare an identity check (docs/06 §4);
 *  - `invoke` takes the caller's `expect` (risk/data/egress the consent
 *    decision was based on) and refuses to run a tool that is more powerful
 *    than what was approved (P0-2: action and manifest can no longer drift).
 *
 * @module @piagent/personal/integrations/tool-registry
 */

import { ConfigError, ValidationError } from '../core/errors.mjs';
import { deriveRisk, assertRisk } from '../services/risk.mjs';
import { digestOf } from '../core/canonical.mjs';
import { validate } from '../core/schema.mjs';
import { DATA_CLASS, RISK_RANK } from '../core/contracts.mjs';

const MANIFEST_ALIASES = Object.freeze({
  dataIn: 'data_in',
  dataOut: 'data_out',
  costHint: 'cost_hint'
});

/**
 * @param {{manifestSchema: Object, clock: Object}} opts
 */
export function createToolRegistry({ manifestSchema, clock }) {
  if (!manifestSchema) throw new ConfigError('tool registry requires the tool-manifest schema');
  /** @type {Map<string, Object>} */
  const tools = new Map();
  /** @type {Map<string, Object>} */
  const connectors = new Map();

  /**
   * @param {{id: string, kind?: string, digest?: string, dataClasses?: string[],
   *          healthCheck?: () => Promise<Object>|Object,
   *          tools: {manifest: Object, invoke: Function}[]}} connector
   */
  function registerConnector(connector) {
    if (!connector?.id) throw new ConfigError('connector requires an id');
    if (connectors.has(connector.id)) throw new ConfigError(`duplicate connector: ${connector.id}`);
    const declaredTools = connector.tools ?? [];
    if (!Array.isArray(declaredTools) || declaredTools.length === 0) {
      throw new ConfigError(`connector ${connector.id} declares no tools`);
    }
    const digest = connector.digest ?? digestOf(declaredTools.map((tool) => tool.manifest));
    if (typeof digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
      throw new ConfigError(`connector ${connector.id} digest must be sha256:<64 hex>`);
    }
    connectors.set(connector.id, {
      id: connector.id,
      kind: connector.kind ?? 'native',
      digest,
      dataClasses: connector.dataClasses ?? [DATA_CLASS.D1],
      healthCheck: connector.healthCheck ?? (() => ({ ok: true })),
      toolIds: []
    });
    for (const tool of declaredTools) registerTool(connector.id, tool);
    return connectors.get(connector.id);
  }

  /**
   * Validate the *raw* declaration, then normalise.
   * @param {string} connectorId
   * @param {{manifest: Object, invoke: Function}} tool
   */
  function registerTool(connectorId, tool) {
    const connector = connectors.get(connectorId);
    if (!connector) throw new ConfigError(`unknown connector: ${connectorId}`);
    if (!tool || typeof tool.invoke !== 'function') {
      throw new ConfigError(`tool in connector ${connectorId} has no invoke()`);
    }
    const raw = normaliseDeclared(tool.manifest ?? {}, connectorId);
    validate(manifestSchema, raw);
    const manifest = normaliseManifest(raw, connectorId);
    if (manifest.risk === 'R3' && !manifest.approval?.identity_check) {
      throw new ConfigError(`R3 tool ${manifest.id} must declare approval.identity_check`);
    }
    if (tools.has(manifest.id)) throw new ConfigError(`duplicate tool id: ${manifest.id}`);
    tools.set(manifest.id, {
      manifest,
      invoke: tool.invoke,
      connector: connectorId,
      digest: digestOf(manifest)
    });
    connector.toolIds.push(manifest.id);
    return manifest;
  }

  return {
    registerConnector,
    registerTool,

    /** @param {string} toolId */
    get(toolId) {
      return tools.get(toolId)?.manifest ?? null;
    },

    /** Every registered manifest, optionally filtered by risk ceiling. */
    list({ maxRisk } = {}) {
      const manifests = [...tools.values()].map((entry) => entry.manifest);
      if (!maxRisk) return manifests;
      return manifests.filter((manifest) => RISK_RANK[manifest.risk] <= RISK_RANK[maxRisk]);
    },

    /** Map of connector -> digest, handed to consent so grants stay pinned. */
    digests() {
      /** @type {Record<string,string>} */
      const out = {};
      for (const [id, connector] of connectors) out[id] = connector.digest;
      return out;
    },

    /**
     * Invoke a tool. `expect` is what consent approved; the registry refuses
     * when the tool turns out to be more capable than that.
     * @param {string} toolId
     * @param {Object} args
     * @param {Object} ctx
     * @param {{risk?: string, dataIn?: string[], egress?: boolean}} [expect]
     */
    async invoke(toolId, args, ctx, expect) {
      const entry = tools.get(toolId);
      if (!entry) throw new ConfigError(`tool not registered: ${toolId}`);
      if (entry.manifest.risk === 'R4') {
        throw new ConfigError(`tool ${toolId} is R4 and must never be invoked`);
      }
      if (expect) assertNotMoreCapable(entry.manifest, expect);
      const result = await entry.invoke(args ?? {}, { ...ctx, toolId, connector: entry.connector });
      if (!result || typeof result !== 'object') {
        throw new ValidationError(`tool ${toolId} returned a non-object result`);
      }
      return {
        ...result,
        toolId,
        connector: entry.connector,
        toolDigest: entry.digest
      };
    },

    /** @returns {Promise<{connector: string, ok: boolean, error?: string}[]>} */
    async health() {
      /** @type {{connector: string, ok: boolean, error?: string}[]} */
      const report = [];
      for (const [id, connector] of connectors) {
        try {
          const result = await connector.healthCheck();
          report.push({ connector: id, ok: result?.ok !== false, error: result?.error });
        } catch (err) {
          report.push({ connector: id, ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      }
      return report;
    },

    stat() {
      return { connectors: connectors.size, tools: tools.size, at: clock.iso() };
    }
  };
}

/**
 * Compare an approved expectation with the actual manifest.
 * @param {Object} manifest
 * @param {{risk?: string, dataIn?: string[], egress?: boolean}} expect
 */
function assertNotMoreCapable(manifest, expect) {
  if (expect.risk && RISK_RANK[assertRisk(expect.risk)] < RISK_RANK[manifest.risk]) {
    throw new ConfigError(
      `tool ${manifest.id} is ${manifest.risk} but only ${expect.risk} was approved — refusing to run`
    );
  }
  if (manifest.egress && expect.egress !== true) {
    throw new ConfigError(`tool ${manifest.id} sends data out but the approved action does not — refusing to run`);
  }
  const approvedClasses = new Set(['D0', ...(expect.dataIn ?? [])]);
  for (const cls of manifest.data_in ?? []) {
    if (!approvedClasses.has(cls)) {
      throw new ConfigError(
        `tool ${manifest.id} touches ${cls} but the approved action only covered ${[...approvedClasses].join(',')}`
      );
    }
  }
}

/**
 * Map aliases and copy the declaration so the schema sees exactly what the
 * connector wrote (no defaults, no derivation yet).
 * @param {Object} input
 * @param {string} connectorId
 */
function normaliseDeclared(input, connectorId) {
  /** @type {Record<string, unknown>} */
  const raw = { ...input, connector: input.connector ?? connectorId };
  for (const [alias, canonical] of Object.entries(MANIFEST_ALIASES)) {
    if (raw[canonical] === undefined && raw[alias] !== undefined) raw[canonical] = raw[alias];
    delete raw[alias];
  }
  return raw;
}

/**
 * Fill defaults and derive risk.
 * @param {Object} input
 * @param {string} connectorId
 * @returns {Object}
 */
export function normaliseManifest(input, connectorId) {
  if (!input || typeof input !== 'object') throw new ConfigError('tool manifest must be an object');
  const manifest = {
    id: input.id,
    connector: input.connector ?? connectorId,
    kind: input.kind ?? 'native',
    risk: assertRisk(input.risk ?? 'R0'),
    reversible: input.reversible !== false,
    undo: input.undo ?? null,
    data_in: input.data_in ?? input.dataIn ?? [DATA_CLASS.D1],
    data_out: input.data_out ?? input.dataOut ?? DATA_CLASS.D1,
    egress: input.egress === true,
    idempotent: input.idempotent === true,
    cost_hint: input.cost_hint ?? input.costHint ?? { tokens: 0, usd: 0 },
    dry_run: input.dry_run ?? false,
    approval: input.approval ?? { default: 'confirm' },
    summary: input.summary ?? input.id,
    parameters: input.parameters ?? { type: 'object', properties: {}, additionalProperties: true }
  };
  manifest.risk = deriveRisk(manifest);
  return manifest;
}
