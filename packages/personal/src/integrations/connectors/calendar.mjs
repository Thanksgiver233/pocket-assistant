/**
 * Calendar connector — the reference implementation of a *reversible* write.
 *
 * Two things this file demonstrates for every future connector:
 *  1. a write ships with an `undo` that actually works (snapshot restore),
 *     which is what makes R1 actions cheap to approve;
 *  2. reads and writes are separate tools with separate risk, so the mode
 *     ceiling can allow the first and require confirmation for the second.
 *
 * The transport is in-memory by default; `transport` can be supplied to back
 * it with a real MCP server later without touching the manifests.
 *
 * @module @piagent/personal/integrations/connectors/calendar
 */

import { DATA_CLASS, RISK } from '../../core/contracts.mjs';
import { digestOf } from '../../core/canonical.mjs';

/**
 * @param {{events?: Object[], transport?: Object, clock: Object, failHealth?: boolean}} opts
 */
export function createCalendarConnector({ events, transport, clock, failHealth = false }) {
  /** @type {Object[]} */
  let store = structuredClone(events ?? defaultEvents());
  const snapshots = new Map();

  const api = transport ?? {
    async list(day) {
      return store.filter((event) => (day ? event.start.startsWith(day) : true));
    },
    async update(id, patch) {
      const index = store.findIndex((event) => event.id === id);
      if (index < 0) throw new Error(`event not found: ${id}`);
      store[index] = { ...store[index], ...patch, updated_at: clock.iso() };
      return store[index];
    },
    async create(event) {
      const created = { id: `evt_${store.length + 1}`, ...event, created_at: clock.iso() };
      store.push(created);
      return created;
    }
  };

  /**
   * Locate the event an action refers to. Exact id wins; otherwise a title
   * match must be unambiguous — "把周会挪到周五" is safe only because there
   * is exactly one 周会.
   * @param {{id?: string, title?: string}} args
   */
  function resolveEvent(args) {
    if (args.id) {
      const byId = store.find((event) => event.id === args.id);
      if (!byId) throw new Error(`event not found: ${args.id}`);
      return byId;
    }
    const wanted = typeof args.title === 'string' ? args.title.trim() : '';
    if (!wanted) throw new TypeError('calendar.update_event requires an event id or title');
    const matches = store.filter((event) => event.title.includes(wanted) || wanted.includes(event.title));
    if (matches.length === 0) throw new Error(`没有标题包含「${wanted}」的日程`);
    if (matches.length > 1) {
      throw new Error(`标题「${wanted}」匹配到 ${matches.length} 个日程，请指明具体是哪一个`);
    }
    return matches[0];
  }

  const tools = [
    {
      manifest: {
        id: 'calendar.list_events',
        connector: 'google-calendar',
        kind: 'native',
        risk: RISK.R0,
        reversible: true,
        data_in: [DATA_CLASS.D1],
        data_out: DATA_CLASS.D1,
        egress: false,
        idempotent: true,
        summary: '查看某天的日历事件',
        cost_hint: { tokens: 200, usd: 0 },
        approval: { default: 'auto' },
        parameters: {
          type: 'object',
          properties: { date: { type: 'string' } },
          additionalProperties: false
        }
      },
      async invoke(args) {
        const items = await api.list(args.date);
        return {
          items,
          summary: `${args.date ?? '全部'} 有 ${items.length} 个日程`,
          cost: { usd: 0, tokens: 120 }
        };
      }
    },
    {
      manifest: {
        id: 'calendar.update_event',
        connector: 'google-calendar',
        kind: 'native',
        risk: RISK.R1,
        reversible: true,
        undo: { tool: 'calendar.restore_event', strategy: 'snapshot_restore', window_s: 60 },
        data_in: [DATA_CLASS.D1],
        data_out: DATA_CLASS.D1,
        egress: false,
        idempotent: false,
        summary: '修改日历事件时间',
        cost_hint: { tokens: 200, usd: 0.001 },
        approval: { default: 'confirm', standing_grant: { max_ttl_h: 168 } },
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            start: { type: 'string' },
            date: { type: 'string' }
          },
          required: [],
          additionalProperties: true
        }
      },
      async invoke(args) {
        // `id` when the caller knows it, `title` when the sentence said
        // "把周会挪到周五". An ambiguous title is a refusal, not a guess.
        const before = resolveEvent(args);
        snapshots.set(before.id, structuredClone(before));
        const patch = {};
        if (args.date) patch.start = args.date;
        if (args.start) patch.start = args.start;
        const after = await api.update(before.id, patch);
        return {
          summary: `已修改「${before.title}」到 ${after.start}`,
          artifact: { kind: 'change', before, after },
          undoableUntil: new Date(clock.now() + 60_000).toISOString(),
          cost: { usd: 0.001, tokens: 80 }
        };
      }
    },
    {
      manifest: {
        id: 'calendar.restore_event',
        connector: 'google-calendar',
        kind: 'native',
        risk: RISK.R1,
        reversible: true,
        data_in: [DATA_CLASS.D1],
        data_out: DATA_CLASS.D1,
        egress: false,
        idempotent: true,
        summary: '撤销上一步日历修改',
        cost_hint: { tokens: 40, usd: 0 },
        approval: { default: 'auto' },
        parameters: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
          additionalProperties: false
        }
      },
      async invoke(args) {
        const snapshot = snapshots.get(args.id);
        if (!snapshot) throw new Error(`no snapshot for ${args.id}`);
        await api.update(args.id, { start: snapshot.start, title: snapshot.title });
        snapshots.delete(args.id);
        return { summary: `已恢复「${snapshot.title}」到 ${snapshot.start}`, cost: { usd: 0, tokens: 20 } };
      }
    }
  ];

  return {
    id: 'google-calendar',
    kind: 'native',
    digest: digestOf(tools.map((tool) => tool.manifest)),
    dataClasses: [DATA_CLASS.D1],
    tools,
    async healthCheck() {
      if (failHealth) return { ok: false, error: 'fixture: calendar MCP unreachable' };
      return { ok: true, events: store.length };
    },
    /** test-only view */
    _events: () => structuredClone(store)
  };
}

function defaultEvents() {
  return [
    { id: 'evt_1', title: '周会', start: '2026-10-28T10:00', attendees: ['me', 'team'] },
    { id: 'evt_2', title: '牙医', start: '2026-10-30T15:30', attendees: ['me'] }
  ];
}
