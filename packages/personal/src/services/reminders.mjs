/**
 * Reminders — the smallest complete "life scheduling" primitive.
 *
 * Scope discipline: this is *not* a calendar. It stores one-shot reminders the
 * user asked for in their own words, fires them once, and never invents one.
 * Recurring events belong to the calendar connector, which already exists.
 *
 * Everything is local (D1) and reversible: a reminder can be cancelled, and a
 * fired reminder leaves a record so "为什么提醒我" is answerable.
 *
 * @module @piagent/personal/services/reminders
 */

import { join } from 'node:path';
import { readJson, writeJsonAtomic, ensureDir } from '../core/jsonl.mjs';
import { newId } from '../core/ids.mjs';
import { ValidationError } from '../core/errors.mjs';

const MAX_TEXT = 200;

/**
 * @param {{stateDir: string, clock: Object, profile?: Object}} opts
 */
export function createReminders({ stateDir, clock, profile }) {
  if (!stateDir) throw new TypeError('reminders requires stateDir');
  const file = join(stateDir, 'reminders.json');
  /** @type {{id:string,text:string,at:string,status:string,created_at:string,fired_at?:string,done_at?:string}[]} */
  let items = [];
  let loaded = false;

  async function load() {
    if (loaded) return;
    const raw = await readJson(file, null);
    if (raw && Array.isArray(raw.items)) {
      items = raw.items.filter((item) => item && typeof item.text === 'string' && typeof item.at === 'string');
    }
    loaded = true;
  }

  async function persist() {
    await ensureDir(stateDir);
    await writeJsonAtomic(file, { version: 1, updated_at: clock.iso(), items });
  }

  return {
    async add({ text, at, source = 'user' } = {}) {
      await load();
      const body = String(text ?? '').trim();
      if (!body) throw new ValidationError('提醒内容不能为空');
      if (body.length > MAX_TEXT) throw new ValidationError(`提醒内容不能超过 ${MAX_TEXT} 字`);
      const when = parseWhen(at, clock.now());
      if (!when) throw new ValidationError('提醒时间无法解析，请给出具体时间（如 2026-10-25T09:00）');
      if (Date.parse(when) <= clock.now()) throw new ValidationError('提醒时间必须晚于现在');

      const reminder = {
        id: newId('reminder'),
        text: body,
        at: when,
        status: 'pending',
        source,
        created_at: clock.iso()
      };
      items.push(reminder);
      items.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
      await persist();
      return { ...reminder };
    },

    async list({ includeDone = false } = {}) {
      await load();
      return items
        .filter((item) => (includeDone ? true : item.status !== 'done' && item.status !== 'cancelled'))
        .map((item) => ({ ...item }));
    },

    /** Reminders whose time has arrived and that have not fired yet. */
    async due(now = clock.now()) {
      await load();
      return items
        .filter((item) => item.status === 'pending' && Date.parse(item.at) <= now)
        .map((item) => ({ ...item }));
    },

    /** Mark fired (called by the proactive sweep). */
    async fire(id) {
      await load();
      const item = items.find((candidate) => candidate.id === id);
      if (!item || item.status !== 'pending') return false;
      item.status = 'fired';
      item.fired_at = clock.iso();
      await persist();
      return true;
    },

    async complete(id) {
      await load();
      const item = items.find((candidate) => candidate.id === id);
      if (!item) return false;
      item.status = 'done';
      item.done_at = clock.iso();
      await persist();
      return true;
    },

    async cancel(id) {
      await load();
      const item = items.find((candidate) => candidate.id === id);
      if (!item || item.status === 'done') return false;
      item.status = 'cancelled';
      await persist();
      return true;
    },

    async stat() {
      await load();
      const pending = items.filter((item) => item.status === 'pending').length;
      const fired = items.filter((item) => item.status === 'fired').length;
      return { total: items.length, pending, fired, file };
    }
  };
}

/**
 * Accept an ISO string, or a `+Nm` / `+Nh` / `+Nd` offset (minutes/hours/days).
 * Relative parsing of "明天九点" happens in the intent layer, which owns
 * language; this layer only accepts unambiguous values.
 * @param {unknown} value
 * @param {number} now
 * @returns {string|null}
 */
export function parseWhen(value, now) {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value !== 'string' || value.trim() === '') return null;
  const raw = value.trim();

  const offset = /^\+(\d+)([mhd])$/i.exec(raw);
  if (offset) {
    const amount = Number(offset[1]);
    const unit = offset[2].toLowerCase();
    const ms = unit === 'm' ? amount * 60_000 : unit === 'h' ? amount * 3_600_000 : amount * 86_400_000;
    return new Date(now + ms).toISOString();
  }

  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString();
}
