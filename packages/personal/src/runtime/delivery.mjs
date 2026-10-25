/**
 * Delivery Hub (M8) — how a result reaches a human, and how often.
 *
 * The default failure mode of a personal agent is not being wrong, it is
 * being noisy. Delivery therefore has its own budget, independent of the
 * cost budget: at most N interrupts and M digests per day, inside quiet
 * hours nothing interrupts, and everything else waits in the digest queue.
 *
 * @module @piagent/personal/runtime/delivery
 */

import { join } from 'node:path';
import { URGENCY, URGENCY_RANK } from '../core/contracts.mjs';
import { readJson, writeJsonAtomic, ensureDir, appendJsonl } from '../core/jsonl.mjs';
import { inQuietHours } from '../core/ids.mjs';

/**
 * @param {{stateDir: string, clock: Object, profile: Object,
 *          channels?: {id: string, send: (payload: Object) => Promise<Object>}[]}} opts
 */
export function createDelivery({ stateDir, clock, profile, channels = [] }) {
  if (!stateDir) throw new TypeError('delivery requires stateDir');
  const cfg = profile?.autonomy?.proactive ?? {};
  const caps = {
    interrupt: cfg.interrupt_per_day ?? 2,
    digest: cfg.digest_per_day ?? 4
  };
  const quietHours = cfg.quiet_hours ?? [];
  const cooldownMinutes = cfg.cooldown_minutes ?? 90;
  const countersPath = join(stateDir, 'delivery', 'counters.json');
  const queuePath = join(stateDir, 'delivery', 'queue.jsonl');

  /** @type {{day: string, interrupt: number, digest: number, lastAt: string|null}} */
  let counters = { day: '', interrupt: 0, digest: 0, lastAt: null };
  let loaded = false;

  async function load() {
    if (loaded) return;
    await ensureDir(join(stateDir, 'delivery'));
    counters = await readJson(countersPath, counters);
    rollIfNeeded();
    loaded = true;
  }

  function rollIfNeeded() {
    const today = dayKey(clock.now());
    if (counters.day !== today) {
      counters = { day: today, interrupt: 0, digest: 0, lastAt: counters.lastAt };
    }
  }

  /** @param {{day: string}} value */
  function dayKey(value) {
    const date = new Date(value);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  /**
   * Credential-shaped strings are removed before anything is persisted or
   * sent. Redaction is a backstop, not a licence to handle secrets
   * (profile.privacy.redaction); it is always on because "off" buys nothing.
   * @param {string} text
   */
  function redact(text) {
    return String(text)
      .replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{12,}\b/g, '<redacted>')
      .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '<redacted>')
      .replace(/\bAKIA[0-9A-Z]{16}\b/g, '<redacted>')
      .replace(/\bBearer\s+[A-Za-z0-9._-]{10,}/gi, 'Bearer <redacted>');
  }

  return {
    load,

    /**
     * @param {{runId: string, text: string, artifacts?: Object[]}} artifact
     * @param {{urgency?: string, channel?: string}} [opts]
     * @returns {Promise<{delivered: boolean, urgency: string, reason?: string, queued: boolean}>}
     */
    async deliver(artifact, opts = {}) {
      await load();
      const requested = opts.urgency ?? URGENCY.DIGEST;
      if (!Object.hasOwn(URGENCY_RANK, requested)) throw new TypeError(`unknown urgency "${requested}"`);
      const nowIso = clock.iso();

      let urgency = requested;
      let reason;

      if (inQuietHours(nowIso, quietHours) && URGENCY_RANK[urgency] >= URGENCY_RANK.interrupt) {
        urgency = URGENCY.DIGEST;
        reason = 'quiet_hours';
      }
      if (urgency === URGENCY.INTERRUPT && counters.interrupt >= caps.interrupt) {
        urgency = URGENCY.DIGEST;
        reason = 'interrupt_cap';
      }
      if (urgency === URGENCY.DIGEST && counters.digest >= caps.digest) {
        urgency = URGENCY.LOG;
        reason = 'digest_cap';
      }
      if (counters.lastAt) {
        const elapsedMinutes = (clock.now() - Date.parse(counters.lastAt)) / 60000;
        if (elapsedMinutes < cooldownMinutes && URGENCY_RANK[urgency] >= URGENCY_RANK.interrupt) {
          urgency = URGENCY.DIGEST;
          reason = 'cooldown';
        }
      }

      const record = {
        at: nowIso,
        runId: artifact.runId,
        urgency,
        requested,
        reason: reason ?? null,
        text: redact(String(artifact.text ?? '')).slice(0, 4000),
        artifacts: (artifact.artifacts ?? []).length
      };

      if (urgency === URGENCY.SILENT || urgency === URGENCY.LOG) {
        await appendJsonl(join(stateDir, 'delivery', 'log.jsonl'), record);
        return { delivered: false, urgency, reason: reason ?? 'logged_only', queued: false };
      }

      if (urgency === URGENCY.DIGEST) {
        await appendJsonl(queuePath, record);
        counters.digest += 1;
        counters.lastAt = nowIso;
        await writeJsonAtomic(countersPath, counters);
        return { delivered: false, urgency, reason: reason ?? 'queued_for_digest', queued: true };
      }

      // interrupt
      const target = channels.find((channel) => channel.id === (opts.channel ?? 'console')) ?? channels[0];
      if (!target) {
        await appendJsonl(queuePath, record);
        return { delivered: false, urgency: URGENCY.DIGEST, reason: 'no_channel_available', queued: true };
      }
      try {
        await target.send(record);
      } catch (err) {
        // A failed send must not consume the daily interrupt quota.
        await appendJsonl(join(stateDir, 'delivery', 'log.jsonl'), { ...record, urgency: URGENCY.LOG, reason: 'send_failed' });
        return { delivered: false, urgency: URGENCY.LOG, reason: 'send_failed', queued: false, error: err instanceof Error ? err.message : String(err) };
      }
      counters.interrupt += 1;
      counters.lastAt = nowIso;
      await writeJsonAtomic(countersPath, counters);
      return { delivered: true, urgency, reason: reason ?? null, queued: false };
    },

    /**
     * Drain the digest queue (used by the daily briefing in P2). The queue is
     * renamed rather than truncated, so a failed downstream delivery can be
     * retried from the drained file.
     */
    async drainDigest() {
      await load();
      const { readJsonl, exists } = await import('../core/jsonl.mjs');
      const { rename } = await import('node:fs/promises');
      const { records } = await readJsonl(queuePath);
      if (records.length > 0 && (await exists(queuePath))) {
        const stamp = nowIso().replace(/[:+]/g, '-');
        await rename(queuePath, `${queuePath}.drained-${stamp}`);
      }
      counters.digest = 0;
      await writeJsonAtomic(countersPath, counters);
      return { items: records, count: records.length };
    },

    /** @returns {Promise<{caps: Object, counters: Object, quietHours: string[]}>} */
    async stat() {
      await load();
      return { caps, counters: { ...counters }, quietHours };
    }
  };
}
