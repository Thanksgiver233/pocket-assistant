/**
 * Injectable clock. Everything that writes a timestamp or evaluates an
 * expiry goes through a clock, so tests can travel in time and `pa-doctor`
 * can replay a ledger against the time it was written.
 * @module @piagent/personal/core/clock
 */

import { nowIso } from './ids.mjs';

/**
 * @param {{start?: string|number}} [opts]
 * @returns {{now: () => number, iso: () => string, advance: (ms: number) => void, set: (ms: number) => void}}
 */
export function createClock(opts = {}) {
  let current =
    typeof opts.start === 'number'
      ? opts.start
      : typeof opts.start === 'string'
        ? Date.parse(opts.start)
        : Date.now();
  if (Number.isNaN(current)) throw new TypeError(`bad clock start: ${opts.start}`);
  return {
    now: () => current,
    iso: () => nowIso(new Date(current)),
    advance: (ms) => {
      current += ms;
    },
    set: (ms) => {
      current = ms;
    }
  };
}

/** Real clock, for production wiring. */
export const systemClock = createClock();
