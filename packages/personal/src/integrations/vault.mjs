/**
 * Vault (M5/§4.5) — credential handles, never credential values.
 *
 * Three rules, learned from Muse's hatch-authd and Dots' credential vault:
 *  1. the model/agent only ever sees a `vault://` handle;
 *  2. the handle is scoped (connector + actions) and short-lived;
 *  3. resolving is a privileged operation the executor performs, and the
 *     value never enters the audit ledger, logs or error messages.
 *
 * At-rest format: JSON envelope, AES-256-GCM, master key supplied by the
 * host (OS keystore in production) — never derived from the workspace.
 *
 * @module @piagent/personal/integrations/vault
 */

import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { readJson, writeJsonAtomic } from '../core/jsonl.mjs';
import { ConfigError } from '../core/errors.mjs';
import { newId } from '../core/ids.mjs';

/**
 * @param {{path: string, masterKey: Buffer|string, clock: Object}} opts
 */
export function createVault({ path, masterKey, clock }) {
  if (!path) throw new ConfigError('vault requires a path');
  if (!masterKey) {
    throw new ConfigError(
      'vault requires a master key from the host keystore (pass masterKey; do not derive it from the workspace)'
    );
  }
  const key = toKey(masterKey);
  /** @type {Map<string, {handle: string, connector: string, fingerprint: string, secret: string, sealed: boolean}>} */
  const secrets = new Map();
  /** @type {Map<string, {secretId: string, connector: string, actions: string[], expiresAt: number}>} */
  const handles = new Map();
  let loaded = false;

  async function load() {
    if (loaded) return;
    const store = await readJson(path, { version: 1, entries: [] });
    for (const entry of store.entries ?? []) {
      secrets.set(entry.id, { ...entry, secret: decrypt(entry.sealed) });
    }
    loaded = true;
  }

  async function persist() {
    await writeJsonAtomic(path, {
      version: 1,
      updated_at: clock.iso(),
      entries: [...secrets.values()].map((entry) => ({
        id: entry.id,
        handle: entry.handle,
        connector: entry.connector,
        fingerprint: entry.fingerprint,
        sealed: encrypt(entry.secret)
      }))
    });
  }

  function encrypt(plaintext) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return { iv: iv.toString('base64'), tag: tag.toString('base64'), data: ciphertext.toString('base64') };
  }

  function decrypt(sealed) {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(sealed.data, 'base64')),
      decipher.final()
    ]).toString('utf8');
  }

  return {
    load,

    /**
     * Store a credential. Returns its handle and a non-reversible
     * fingerprint; the raw value is never returned.
     * @param {{connector: string, value: string, label?: string}} input
     */
    async putSecret(input) {
      await load();
      if (!input?.connector || typeof input.value !== 'string' || input.value.length < 8) {
        throw new ConfigError('putSecret requires connector and a value of at least 8 characters');
      }
      const id = newId('event');
      const fingerprint = fingerprintOf(input.value);
      const handle = `vault://${input.connector}/${id}`;
      secrets.set(id, { id, handle, connector: input.connector, fingerprint, secret: input.value, sealed: false });
      await persist();
      return { handle, fingerprint };
    },

    /**
     * Issue a short-lived, action-scoped handle. This is what gets passed
     * into a tool; it is useless without `resolve()` and expires quickly.
     * @param {{connector: string, actions?: string[], ttlSeconds?: number}} input
     */
    async issueHandle(input) {
      await load();
      const entry = [...secrets.values()].find((candidate) => candidate.connector === input.connector);
      if (!entry) throw new ConfigError(`no credential stored for connector ${input.connector}`);
      const ttlSeconds = Math.min(input.ttlSeconds ?? 300, 3600);
      const handleId = newId('event');
      handles.set(handleId, {
        secretId: entry.id,
        connector: input.connector,
        actions: input.actions ?? ['read'],
        expiresAt: clock.now() + ttlSeconds * 1000
      });
      return {
        handle: `cap://${input.connector}/${handleId}`,
        expiresAt: new Date(clock.now() + ttlSeconds * 1000).toISOString(),
        fingerprint: entry.fingerprint
      };
    },

    /**
     * Executor-only. Throws on expired/unknown handle; never logs the value.
     * @param {string} handle
     * @param {{action?: string}} [ctx]
     */
    async resolve(handle, ctx = {}) {
      await load();
      if (!handle?.startsWith('cap://')) throw new ConfigError('resolve expects a capability handle (cap://)');
      const handleId = handle.slice('cap://'.length).split('/').pop();
      const grant = handles.get(handleId);
      if (!grant) throw new ConfigError('unknown or already-consumed capability handle');
      if (clock.now() > grant.expiresAt) {
        handles.delete(handleId);
        throw new ConfigError('capability handle expired');
      }
      if (ctx.action && !grant.actions.includes(ctx.action) && !grant.actions.includes('*')) {
        throw new ConfigError(`capability handle does not cover action ${ctx.action}`);
      }
      const secret = secrets.get(grant.secretId);
      if (!secret) throw new ConfigError('credential disappeared from the vault');
      return { connector: secret.connector, value: secret.secret, fingerprint: secret.fingerprint };
    },

    /** @param {string} handle */
    revoke(handle) {
      const handleId = handle.split('/').pop();
      return handles.delete(handleId);
    },

    /** Safe description for doctor/UI: no values, only fingerprints. */
    async describe() {
      await load();
      return [...secrets.values()].map((entry) => ({
        connector: entry.connector,
        fingerprint: entry.fingerprint,
        hasSecret: true
      }));
    }
  };
}

/** @param {Buffer|string} material */
function toKey(material) {
  if (Buffer.isBuffer(material)) {
    if (material.length !== 32) throw new ConfigError('vault master key must be 32 bytes');
    return material;
  }
  const trimmed = String(material).trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return Buffer.from(trimmed, 'hex');
  const hashed = createHash('sha256').update(trimmed, 'utf8').digest();
  return hashed;
}

/** @param {string} secret */
function fingerprintOf(secret) {
  return `fp:${createHash('sha256').update(secret, 'utf8').digest('hex').slice(0, 16)}`;
}
