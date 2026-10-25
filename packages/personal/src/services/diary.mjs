/**
 * Diary — capture in one second, organise at night.
 *
 * The product promise (docs/10 §3.2) is "随手记 1 秒落盘，晚上自动整理".
 * That means two very different operations:
 *
 *  - `add()` must be cheap and dumb: no model call, no tagging decisions,
 *    just append with a timestamp. If capture costs a second of thinking,
 *    people stop capturing.
 *  - `digest()` does the organising: group by hour, pull the first clause of
 *    each note, and produce a three-part draft (做了什么 / 卡在哪 / 明天).
 *
 * Notes are D1 and never leave the machine; `digest()` is deterministic so it
 * works offline. An LLM can polish the draft later, but the structure is ours.
 *
 * @module @piagent/personal/services/diary
 */

import { join } from 'node:path';
import { readJson, writeJsonAtomic, ensureDir } from '../core/jsonl.mjs';
import { newId } from '../core/ids.mjs';
import { ValidationError } from '../core/errors.mjs';

const MAX_NOTE = 2000;

/**
 * @param {{stateDir: string, clock: Object}} opts
 */
export function createDiary({ stateDir, clock }) {
  if (!stateDir) throw new TypeError('diary requires stateDir');
  const file = join(stateDir, 'diary.json');
  /** @type {{id:string,text:string,at:string,day:string,tags:string[]}[]} */
  let entries = [];
  let loaded = false;

  async function load() {
    if (loaded) return;
    const raw = await readJson(file, null);
    if (raw && Array.isArray(raw.entries)) {
      entries = raw.entries.filter((entry) => entry && typeof entry.text === 'string' && typeof entry.at === 'string');
    }
    loaded = true;
  }

  async function persist() {
    await ensureDir(stateDir);
    await writeJsonAtomic(file, { version: 1, updated_at: clock.iso(), entries });
  }

  return {
    /** Append a note. Deliberately no interpretation. */
    async add({ text, tags = [], at } = {}) {
      await load();
      const body = String(text ?? '').trim();
      if (!body) throw new ValidationError('记录内容不能为空');
      if (body.length > MAX_NOTE) throw new ValidationError(`单条记录不能超过 ${MAX_NOTE} 字`);
      const stamp = at ? new Date(at) : new Date(clock.now());
      if (Number.isNaN(stamp.getTime())) throw new ValidationError('记录时间非法');

      const entry = {
        id: newId('note'),
        text: body,
        at: stamp.toISOString(),
        day: dayKey(stamp),
        tags: normaliseTags(tags)
      };
      entries.push(entry);
      await persist();
      return { ...entry };
    },

    async list({ day, limit = 50 } = {}) {
      await load();
      const filtered = day ? entries.filter((entry) => entry.day === day) : entries;
      return filtered.slice(-limit).map((entry) => ({ ...entry }));
    },

    async remove(id) {
      await load();
      const before = entries.length;
      entries = entries.filter((entry) => entry.id !== id);
      if (entries.length === before) return false;
      await persist();
      return true;
    },

    /**
     * Three-part draft for one day. Deterministic, offline, no model.
     * @param {string} [day] YYYY-MM-DD, defaults to today
     */
    async digest(day = dayKey(new Date(clock.now()))) {
      await load();
      const ofDay = entries.filter((entry) => entry.day === day);
      const groups = groupByHour(ofDay);

      const did = ofDay.map((entry) => firstClause(entry.text)).filter(Boolean);
      const blocked = ofDay
        .filter((entry) => /(卡|等|阻塞|失败|不行|问题|bug|缺)/i.test(entry.text))
        .map((entry) => firstClause(entry.text));
      const tomorrow = ofDay
        .filter((entry) => /(明天|下周|待办|todo|要|需要)/i.test(entry.text))
        .map((entry) => firstClause(entry.text));

      return {
        day,
        count: ofDay.length,
        groups,
        draft: {
          did: dedupe(did).slice(0, 6),
          blocked: dedupe(blocked).slice(0, 4),
          tomorrow: dedupe(tomorrow).slice(0, 4)
        },
        text: renderDraft(day, ofDay.length, did, blocked, tomorrow)
      };
    },

    async stat() {
      await load();
      const days = new Set(entries.map((entry) => entry.day));
      return { total: entries.length, days: days.size, file };
    }
  };
}

function dayKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function groupByHour(entries) {
  /** @type {Record<string, number>} */
  const buckets = {};
  for (const entry of entries) {
    const hour = new Date(entry.at).getHours();
    const key = `${String(hour).padStart(2, '0')}:00`;
    buckets[key] = (buckets[key] ?? 0) + 1;
  }
  return Object.entries(buckets)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([hour, count]) => ({ hour, count }));
}

/** First clause is usually the fact; the rest is commentary. */
function firstClause(text) {
  const clean = String(text).replace(/\s+/g, ' ').trim();
  const cut = clean.split(/[。；;！？!?\n]/)[0];
  return cut.length > 60 ? `${cut.slice(0, 60)}…` : cut;
}

function dedupe(list) {
  return [...new Set(list.filter(Boolean))];
}

function renderDraft(day, count, did, blocked, tomorrow) {
  if (count === 0) return `${day}：今天没有记录。想记的话直接说「记一下 ……」。`;
  const lines = [`${day} · 共 ${count} 条记录`, '', '做了什么'];
  for (const item of dedupe(did).slice(0, 6)) lines.push(`· ${item}`);
  if (blocked.length > 0) {
    lines.push('', '卡在哪');
    for (const item of dedupe(blocked).slice(0, 4)) lines.push(`· ${item}`);
  }
  lines.push('', '明天第一件事');
  const first = dedupe(tomorrow)[0] ?? '（还没写，明早补一句）';
  lines.push(`· ${first}`);
  return lines.join('\n');
}

function normaliseTags(tags) {
  if (!Array.isArray(tags)) return [];
  return [...new Set(tags.filter((tag) => typeof tag === 'string' && tag.trim()).map((tag) => tag.trim().slice(0, 24)))].slice(0, 6);
}
