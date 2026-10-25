/**
 * Personal-core connector — the three product lines as first-class tools.
 *
 * These are not "connector to an external service": they are local capabilities
 * that still go through the same registry, the same risk derivation and the
 * same consent gate as `mail.send`. That uniformity is the point — a reminder
 * is a write, so it is R1 and it asks once, exactly like a calendar change.
 *
 * Tool surface:
 *   reminder.create / reminder.list / reminder.done
 *   diary.create    / diary.today
 *   suggestions.list
 *
 * @module @piagent/personal/integrations/connectors/personal-core
 */

import { DATA_CLASS, RISK } from '../../core/contracts.mjs';
import { digestOf } from '../../core/canonical.mjs';

/**
 * @param {{reminders: Object, diary: Object, proactive: Object, clock: Object,
 *          calendarApi?: Object}} deps
 */
export function createPersonalCoreConnector({ reminders, diary, proactive, clock, calendarApi }) {
  if (!reminders || !diary || !proactive) {
    throw new TypeError('personal-core connector requires reminders, diary and proactive services');
  }

  const tools = [
    {
      manifest: {
        id: 'reminder.create',
        connector: 'personal-core',
        kind: 'native',
        risk: RISK.R1,
        reversible: true,
        data_in: [DATA_CLASS.D1],
        data_out: DATA_CLASS.D1,
        egress: false,
        idempotent: false,
        summary: '创建一条提醒',
        cost_hint: { tokens: 0, usd: 0 },
        approval: { default: 'confirm', standing_grant: { max_ttl_h: 168 } },
        parameters: {
          type: 'object',
          properties: { text: { type: 'string' }, at: { type: 'string' } },
          required: ['text', 'at'],
          additionalProperties: true
        }
      },
      async invoke(args) {
        const reminder = await reminders.add({ text: args.text, at: args.at });
        return {
          summary: `已记下：${reminder.text}（${formatTime(reminder.at)}）`,
          artifact: { kind: 'reminder', reminder },
          cost: { usd: 0, tokens: 0 }
        };
      }
    },
    {
      manifest: {
        id: 'reminder.list',
        connector: 'personal-core',
        kind: 'native',
        risk: RISK.R0,
        reversible: true,
        data_in: [DATA_CLASS.D1],
        data_out: DATA_CLASS.D1,
        egress: false,
        idempotent: true,
        summary: '查看待触发的提醒',
        cost_hint: { tokens: 0, usd: 0 },
        approval: { default: 'auto' },
        parameters: { type: 'object', properties: {}, additionalProperties: false }
      },
      async invoke() {
        const items = await reminders.list();
        return {
          items,
          summary: items.length === 0 ? '没有待触发的提醒' : `${items.length} 条待触发`,
          cost: { usd: 0, tokens: 0 }
        };
      }
    },
    {
      manifest: {
        id: 'reminder.done',
        connector: 'personal-core',
        kind: 'native',
        risk: RISK.R1,
        reversible: true,
        data_in: [DATA_CLASS.D1],
        data_out: DATA_CLASS.D1,
        egress: false,
        idempotent: true,
        summary: '把一条提醒标记为完成',
        cost_hint: { tokens: 0, usd: 0 },
        approval: { default: 'auto', standing_grant: { max_ttl_h: 168 } },
        parameters: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
          additionalProperties: false
        }
      },
      async invoke(args) {
        const ok = await reminders.complete(String(args.id ?? ''));
        return {
          summary: ok ? '已标记完成' : '没有找到这条提醒',
          artifact: { kind: 'reminder_done', id: args.id ?? null, ok },
          cost: { usd: 0, tokens: 0 }
        };
      }
    },
    {
      manifest: {
        id: 'diary.create',
        connector: 'personal-core',
        kind: 'native',
        risk: RISK.R1,
        reversible: true,
        data_in: [DATA_CLASS.D1],
        data_out: DATA_CLASS.D1,
        egress: false,
        idempotent: false,
        summary: '记一条工作笔记',
        cost_hint: { tokens: 0, usd: 0 },
        approval: { default: 'confirm', standing_grant: { max_ttl_h: 168 } },
        parameters: {
          type: 'object',
          properties: { text: { type: 'string' }, tags: { type: 'array' } },
          required: ['text'],
          additionalProperties: true
        }
      },
      async invoke(args) {
        const entry = await diary.add({ text: args.text, tags: args.tags });
        return {
          summary: `记下了（${formatTime(entry.at)}）`,
          artifact: { kind: 'note', note: entry },
          cost: { usd: 0, tokens: 0 }
        };
      }
    },
    {
      manifest: {
        id: 'diary.today',
        connector: 'personal-core',
        kind: 'native',
        risk: RISK.R0,
        reversible: true,
        data_in: [DATA_CLASS.D1],
        data_out: DATA_CLASS.D1,
        egress: false,
        idempotent: true,
        summary: '把今天的记录整理成日记草稿',
        cost_hint: { tokens: 0, usd: 0 },
        approval: { default: 'auto' },
        parameters: {
          type: 'object',
          properties: { day: { type: 'string' } },
          additionalProperties: false
        }
      },
      async invoke(args) {
        const digest = await diary.digest(args.day);
        return {
          summary: digest.count === 0 ? `${digest.day} 还没有记录` : `${digest.day}：${digest.count} 条记录已整理`,
          artifact: { kind: 'diary', digest },
          text: digest.text,
          cost: { usd: 0, tokens: 0 }
        };
      }
    },
    {
      manifest: {
        id: 'suggestions.list',
        connector: 'personal-core',
        kind: 'native',
        risk: RISK.R0,
        reversible: true,
        data_in: [DATA_CLASS.D0],
        data_out: DATA_CLASS.D0,
        egress: false,
        idempotent: true,
        summary: '看看现在有什么值得做的事（受打扰预算约束）',
        cost_hint: { tokens: 0, usd: 0 },
        approval: { default: 'auto' },
        parameters: { type: 'object', properties: {}, additionalProperties: false }
      },
      async invoke() {
        const due = await reminders.due();
        const diaryStat = await diary.stat();
        const today = await diary.list({ limit: 200 });
        const todayKey = localDay(new Date(clock.now()));
        const todayCount = today.filter((entry) => entry.day === todayKey).length;
        const events = calendarApi ? await calendarApi.list().catch(() => []) : [];

        const candidates = await proactive.candidates({
          reminders: due,
          diary: { todayCount, total: diaryStat.total },
          calendar: events
        });
        const status = await proactive.status();
        return {
          items: candidates,
          summary:
            candidates.length === 0
              ? `现在没有值得打扰你的事（今日配额 ${status.remaining}/${status.quota}）`
              : `${candidates.length} 条候选，今日剩余配额 ${status.remaining}`,
          artifact: { kind: 'suggestions', candidates, quota: status },
          cost: { usd: 0, tokens: 0 }
        };
      }
    }
  ];

  return {
    id: 'personal-core',
    kind: 'native',
    digest: digestOf(tools.map((tool) => tool.manifest)),
    dataClasses: [DATA_CLASS.D1],
    tools,
    async healthCheck() {
      const stat = await reminders.stat();
      return { ok: true, pending: stat.pending };
    },
    _tools: () => tools.map((tool) => tool.manifest.id)
  };
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function localDay(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
