/**
 * Deterministic, dependency-free ids and time helpers.
 *
 * Ids are ULID-flavoured: 48-bit millisecond timestamp + 80 bits of
 * randomness, Crockford base32, prefixed with a short type tag. Sortable by
 * time, unique across processes without coordination.
 * @module @piagent/personal/core/ids
 */

import { randomBytes } from 'node:crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ID_PREFIXES = Object.freeze({
  run: 'r',
  turn: 'turn',
  action: 'a',
  grant: 'g',
  memory: 'm',
  event: 'e',
  trigger: 't',
  tool: 'tool',
  reminder: 'rem',
  note: 'note',
  suggestion: 'sug'
});

let lastTime = -1;
let lastRandom = null;

/**
 * @param {'run'|'turn'|'action'|'grant'|'memory'|'event'|'trigger'|'tool'|'reminder'|'note'|'suggestion'} kind
 * @param {number} [now] epoch millis (injectable for tests)
 * @returns {string} e.g. `r_01JABCDEF...`
 */
export function newId(kind, now = Date.now()) {
  const prefix = ID_PREFIXES[kind];
  if (!prefix) throw new TypeError(`unknown id kind: ${kind}`);
  if (now === lastTime && lastRandom) {
    // monotonic within the same millisecond
    increment(lastRandom);
  } else {
    lastTime = now;
    lastRandom = randomBytes(10);
  }
  return `${prefix}_${encodeTime(now)}${encodeRandom(lastRandom)}`;
}

/**
 * @param {Buffer} bytes
 */
function increment(bytes) {
  for (let i = bytes.length - 1; i >= 0; i -= 1) {
    if (bytes[i] < 255) {
      bytes[i] += 1;
      return;
    }
    bytes[i] = 0;
  }
}

/** @param {number} time 48-bit millis */
function encodeTime(time) {
  let out = '';
  let remaining = time;
  for (let i = 0; i < 10; i += 1) {
    out = CROCKFORD[remaining % 32] + out;
    remaining = Math.floor(remaining / 32);
  }
  return out;
}

/** @param {Buffer} bytes 10 random bytes -> 16 chars */
function encodeRandom(bytes) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += CROCKFORD[(value << (5 - bits)) & 31];
  return out.slice(0, 16);
}

/**
 * Parse the timestamp out of an id created by `newId`.
 * @param {string} id
 * @returns {number} epoch millis
 */
export function timestampOf(id) {
  const body = id.includes('_') ? id.slice(id.indexOf('_') + 1) : id;
  let time = 0;
  for (const char of body.slice(0, 10)) {
    const idx = CROCKFORD.indexOf(char);
    if (idx < 0) throw new TypeError(`bad id: ${id}`);
    time = time * 32 + idx;
  }
  return time;
}

/**
 * ISO-8601 timestamp with an explicit offset. The whole system stores
 * timezone-aware strings, never bare epoch numbers.
 * @param {Date} [date]
 * @returns {string}
 */
export function nowIso(date = new Date()) {
  return toIsoWithOffset(date);
}

/**
 * @param {Date} date
 * @returns {string} e.g. 2026-10-23T22:16:54+08:00
 */
export function toIsoWithOffset(date) {
  const pad = (n, w = 2) => String(Math.abs(n)).padStart(w, '0');
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/**
 * @param {string} iso
 * @returns {number} epoch millis
 */
export function epochOf(iso) {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new TypeError(`bad timestamp: ${iso}`);
  return ms;
}

/**
 * Add hours to an ISO timestamp, preserving the original offset.
 * @param {string} iso
 * @param {number} hours
 * @returns {string}
 */
export function addHoursIso(iso, hours) {
  return toIsoWithOffset(new Date(epochOf(iso) + hours * 3600_000));
}

/**
 * True when `iso` is strictly in the past relative to `now`.
 * @param {string} iso
 * @param {number} now epoch millis
 */
export function isExpired(iso, now) {
  return epochOf(iso) <= now;
}

/**
 * Evaluate a cron-ish "HH:MM-HH:MM" quiet-hours window against a timestamp.
 * Handles windows that wrap midnight.
 * @param {string} iso
 * @param {string[]} windows e.g. ['22:00-08:00']
 * @returns {boolean}
 */
export function inQuietHours(iso, windows) {
  if (!windows || windows.length === 0) return false;
  const date = new Date(epochOf(iso));
  const minutes = date.getHours() * 60 + date.getMinutes();
  for (const window of windows) {
    const match = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(window);
    if (!match) continue;
    const start = Number(match[1]) * 60 + Number(match[2]);
    const end = Number(match[3]) * 60 + Number(match[4]);
    if (start <= end) {
      if (minutes >= start && minutes < end) return true;
    } else if (minutes >= start || minutes < end) {
      return true;
    }
  }
  return false;
}
