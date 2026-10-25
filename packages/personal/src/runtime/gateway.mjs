/**
 * Session Gateway (M1) — normalises every entry point into one Turn shape.
 *
 * Channels differ (CLI, dashboard, IM, trigger) but the rest of the system
 * must never branch on which one delivered the text. The gateway is also the
 * place where "untrusted" is decided once: text that contains quoted
 * external content is flagged, never inferred later.
 *
 * @module @piagent/personal/runtime/gateway
 */

import { CHANNEL, PERMISSION_MODE } from '../core/contracts.mjs';
import { ConfigError, ValidationError } from '../core/errors.mjs';
import { newId } from '../core/ids.mjs';

const CHANNELS = Object.values(CHANNEL);
const MODES = Object.values(PERMISSION_MODE);

/**
 * @param {{clock: Object, profile: Object}} opts
 */
export function createGateway({ clock, profile }) {
  if (!clock) throw new ConfigError('gateway requires a clock');
  if (!profile) throw new ConfigError('gateway requires a loaded profile');

  const defaultMode = profile.autonomy?.default_mode ?? PERMISSION_MODE.READ_ONLY;

  return {
    /**
     * @param {{text: string, channel?: string, threadId?: string, mode?: string,
     *          untrusted?: boolean, source?: string}} input
     * @returns {import('../core/contracts.mjs').Turn}
     */
    submit(input = {}) {
      const text = String(input.text ?? '').trim();
      if (!text) throw new ValidationError('turn text must not be empty');
      if (text.length > 8000) throw new ValidationError('turn text exceeds 8000 characters');

      const channel = input.channel ?? CHANNEL.CLI;
      if (!CHANNELS.includes(channel)) {
        throw new ValidationError(`unknown channel "${channel}" (expected ${CHANNELS.join('|')})`);
      }
      const mode = input.mode ?? defaultMode;
      if (!MODES.includes(mode)) {
        throw new ValidationError(`unknown permission mode "${mode}" (expected ${MODES.join('|')})`);
      }

      /** @type {import('../core/contracts.mjs').Turn} */
      const turn = {
        id: newId('turn'),
        channel,
        text,
        at: clock.iso(),
        threadId: input.threadId ?? null,
        untrusted: input.untrusted === true,
        mode,
        source: input.source ?? channel
      };
      return turn;
    },

    /**
     * Explicit operator confirmation, represented as a system turn so it is
     * auditable like any other input.
     * @param {{text: string, runId: string}} input
     */
    confirm(input) {
      return {
        id: newId('turn'),
        channel: CHANNEL.SYSTEM,
        text: String(input.text ?? '确认执行'),
        at: clock.iso(),
        threadId: input.runId,
        untrusted: false,
        mode: PERMISSION_MODE.FULL_ACCESS,
        source: 'confirmation'
      };
    }
  };
}
