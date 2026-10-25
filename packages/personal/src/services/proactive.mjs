/**
 * Proactive suggestions — with an interruption budget.
 *
 * The industry norm is to push until the user turns notifications off. This
 * module treats attention as a scarce resource with a daily quota, and every
 * candidate must earn its slot:
 *
 *     score = value × urgency − interruption cost
 *
 * A candidate below the threshold is not "queued for later"; it is dropped.
 * Queuing is how a quiet product becomes a noisy one at 23:50.
 *
 * The quota is per day and resets at local midnight. When it is exhausted the
 * module returns nothing — including for "important" items. That is the point.
 *
 * @module @piagent/personal/services/proactive
 */

import { join } from 'node:path';
import { readJson, writeJsonAtomic, ensureDir } from '../core/jsonl.mjs';
import { newId } from '../core/ids.mjs';

const DEFAULT_QUOTA = 2;
const THRESHOLD = 0.55;

/**
 * @param {{stateDir: string, clock: Object, profile?: Object}} opts
 */
export function createProactive({ stateDir, clock, profile }) {
  if (!stateDir) throw new TypeError('proactive requires stateDir');
  const file = join(stateDir, 'proactive.json');
  const configured = Number(profile?.autonomy?.proactive?.daily_quota);
  const quota = Number.isFinite(configured) && configured >= 0 ? Math.min(10, Math.floor(configured)) : DEFAULT_QUOTA;
  const enabled = profile?.autonomy?.proactive?.enabled !== false;

  let state = { day: dayKey(clock.now()), sent: 0, dismissed: 0, lastSentAt: null };
  let loaded = false;

  async function load() {
    if (loaded) return;
    const raw = await readJson(file, null);
    if (raw && raw.day === dayKey(clock.now())) {
      state = {
        day: raw.day,
        sent: Number(raw.sent ?? 0),
        dismissed: Number(raw.dismissed ?? 0),
        lastSentAt: raw.lastSentAt ?? null
      };
    }
    loaded = true;
  }

  async function persist() {
    await ensureDir(stateDir);
    await writeJsonAtomic(file, { version: 1, ...state, updated_at: clock.iso() });
  }

  function rollIfNeeded(now) {
    const today = dayKey(now);
    if (state.day !== today) {
      state = { day: today, sent: 0, dismissed: 0, lastSentAt: null };
    }
  }

  return {
    /**
     * Build the ranked candidate list for *now*, without consuming quota.
     * @param {{reminders?: Object[], diary?: Object, calendar?: Object[], now?: number}} input
     */
    async candidates(input = {}) {
      await load();
      const now = input.now ?? clock.now();
      rollIfNeeded(now);

      /** @type {{id:string,kind:string,title:string,why:string,score:number}[]} */
      const items = [];
      const dueReminders = Array.isArray(input.reminders) ? input.reminders : [];

      for (const reminder of dueReminders.slice(0, 3)) {
        items.push({
          id: reminder.id ?? newId('suggestion'),
          kind: 'reminder_due',
          title: reminder.text,
          why: `你设的提醒到点了（${formatTime(reminder.at)}）`,
          // Due reminders are the only thing that may outrank the quota.
          score: 1.0
        });
      }

      const hour = new Date(now).getHours();
      const diaryCount = Number(input.diary?.todayCount ?? 0);

      if (hour >= 7 && hour <= 9) {
        const events = Array.isArray(input.calendar) ? input.calendar : [];
        if (events.length > 0) {
          items.push({
            id: newId('suggestion'),
            kind: 'morning_brief',
            title: `今天有 ${events.length} 个日程，最近一个是「${events[0].title ?? '未命名'}」`,
            why: '早间简报：只在你开始一天时出现一次',
            score: 0.8
          });
        }
      }

      if (hour >= 20 && diaryCount === 0) {
        items.push({
          id: newId('suggestion'),
          kind: 'diary_gap',
          title: '今天还没记一笔，补一句话就行',
          why: '连续记录比记得详细更重要',
          score: 0.62
        });
      }

      if (diaryCount >= 3 && hour >= 18) {
        items.push({
          id: newId('suggestion'),
          kind: 'diary_digest',
          title: `今天记了 ${diaryCount} 条，要不要现在整理成日记`,
          why: '整理放在当天做，第二天就想不起来了',
          score: 0.7
        });
      }

      return items
        .map((item) => ({ ...item, score: round(item.score - interruptionCost(now, state)) }))
        .filter((item) => item.score >= THRESHOLD)
        .sort((a, b) => b.score - a.score);
    },

    /**
     * Consume quota for the top candidates. Returns what was actually "sent".
     * @param {{candidates: Object[], max?: number}} input
     */
    async take({ candidates = [], max = 1 } = {}) {
      await load();
      const now = clock.now();
      rollIfNeeded(now);

      if (!enabled) {
        return { sent: [], reason: 'proactive_disabled', remaining: 0, quota };
      }
      const remaining = Math.max(0, quota - state.sent);
      if (remaining === 0) {
        return { sent: [], reason: 'quota_exhausted', remaining: 0, quota };
      }
      // A hard quiet period: nothing between 23:00 and 07:00 unless it is a
      // due reminder, which the caller passes with score 1.0.
      const hour = new Date(now).getHours();
      if (hour >= 23 || hour < 7) {
        const urgent = candidates.filter((item) => item.kind === 'reminder_due');
        if (urgent.length === 0) {
          return { sent: [], reason: 'quiet_hours', remaining, quota };
        }
      }

      const picked = candidates.slice(0, Math.min(max, remaining));
      if (picked.length === 0) {
        return { sent: [], reason: 'nothing_worth_sending', remaining, quota };
      }
      state.sent += picked.length;
      state.lastSentAt = clock.iso();
      await persist();
      return { sent: picked, reason: null, remaining: quota - state.sent, quota };
    },

    async dismiss(id) {
      await load();
      state.dismissed += 1;
      await persist();
      return { dismissed: state.dismissed, id };
    },

    async status(now = clock.now()) {
      await load();
      rollIfNeeded(now);
      return {
        enabled,
        quota,
        sent: state.sent,
        remaining: Math.max(0, quota - state.sent),
        dismissed: state.dismissed,
        lastSentAt: state.lastSentAt,
        day: state.day,
        file
      };
    }
  };
}

/**
 * Being late costs value: a suggestion at 22:40 is worth less than at 09:00.
 * Being repetitive costs more: after one message today, the next one must be
 * clearly better.
 */
function interruptionCost(now, state) {
  const hour = new Date(now).getHours();
  let cost = 0;
  if (hour >= 22 || hour < 7) cost += 0.25;
  else if (hour >= 19) cost += 0.1;
  cost += state.sent * 0.08;
  return cost;
}

function dayKey(ms) {
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '刚刚';
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function round(value) {
  return Math.round(value * 100) / 100;
}
