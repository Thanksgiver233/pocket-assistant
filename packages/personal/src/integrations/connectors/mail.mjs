/**
 * Mail connector — the reference implementation of an *irreversible, egress*
 * action (R2) next to a reversible local one (R1).
 *
 * `mail.send` is irreversible and sends data out, so the manifest declares
 * `reversible: false` + `egress: true`, which raises its derived risk and
 * forces per-action confirmation. `mail.draft` never leaves the machine and
 * stays R1. This is the shape every future "act on my behalf" connector
 * should copy.
 *
 * @module @piagent/personal/integrations/connectors/mail
 */

import { DATA_CLASS, RISK } from '../../core/contracts.mjs';
import { digestOf } from '../../core/canonical.mjs';

/**
 * @param {{messages?: Object[], clock: Object, failHealth?: boolean, outbox?: Object[]}} opts
 */
export function createMailConnector({ messages, clock, failHealth = false, outbox } = {}) {
  /** @type {Object[]} */
  const store = structuredClone(messages ?? defaultMessages());
  /** @type {Object[]} */
  const sent = outbox ?? [];
  /** @type {Object[]} */
  const drafts = [];

  const tools = [
    {
      manifest: {
        id: 'mail.list',
        connector: 'gmail',
        kind: 'native',
        risk: RISK.R1,
        reversible: true,
        data_in: [DATA_CLASS.D2],
        data_out: DATA_CLASS.D1,
        egress: false,
        idempotent: true,
        summary: '读取邮件列表（高敏数据，需显式授权）',
        cost_hint: { tokens: 500, usd: 0 },
        approval: { default: 'auto' },
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' }, limit: { type: 'number' } },
          additionalProperties: false
        }
      },
      async invoke(args) {
        const limit = Math.min(args.limit ?? 10, 50);
        const items = store.slice(0, limit).map((message) => ({
          id: message.id,
          from: message.from,
          subject: message.subject,
          unread: message.unread
        }));
        return { items, summary: `${items.length} 封邮件`, cost: { usd: 0, tokens: 300 } };
      }
    },
    {
      manifest: {
        id: 'mail.draft',
        connector: 'gmail',
        kind: 'native',
        risk: RISK.R1,
        reversible: true,
        data_in: [DATA_CLASS.D2],
        data_out: DATA_CLASS.D2,
        egress: false,
        idempotent: false,
        summary: '起草邮件（只生成草稿，不发送）',
        cost_hint: { tokens: 400, usd: 0.002 },
        approval: { default: 'confirm', standing_grant: { max_ttl_h: 24 } },
        parameters: {
          type: 'object',
          properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } },
          required: ['to'],
          additionalProperties: false
        }
      },
      async invoke(args) {
        if (!args.to) throw new TypeError('mail.draft requires a recipient');
        const draft = { id: `draft_${drafts.length + 1}`, to: args.to, subject: args.subject ?? '', body: args.body ?? '', at: clock.iso() };
        drafts.push(draft);
        return {
          summary: `已起草给 ${args.to} 的邮件（未发送）`,
          artifact: { kind: 'draft', draft },
          cost: { usd: 0.002, tokens: 200 }
        };
      }
    },
    {
      manifest: {
        id: 'mail.send',
        connector: 'gmail',
        kind: 'native',
        risk: RISK.R2,
        reversible: false,
        data_in: [DATA_CLASS.D2],
        data_out: DATA_CLASS.D2,
        egress: true,
        idempotent: false,
        summary: '发送邮件（对外、不可撤回）',
        cost_hint: { tokens: 300, usd: 0.002 },
        approval: { default: 'confirm' },
        parameters: {
          type: 'object',
          properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } },
          required: ['to'],
          additionalProperties: false
        }
      },
      async invoke(args) {
        if (!args.to) throw new TypeError('mail.send requires a recipient');
        const message = { id: `sent_${sent.length + 1}`, to: args.to, subject: args.subject ?? '', body: args.body ?? '', at: clock.iso() };
        sent.push(message);
        return {
          summary: `已发送给 ${args.to}（不可撤回）`,
          artifact: { kind: 'sent', message },
          cost: { usd: 0.002, tokens: 120 }
        };
      }
    }
  ];

  return {
    id: 'gmail',
    kind: 'native',
    digest: digestOf(tools.map((tool) => tool.manifest)),
    dataClasses: [DATA_CLASS.D2],
    tools,
    async healthCheck() {
      if (failHealth) return { ok: false, error: 'fixture: gmail MCP unreachable' };
      return { ok: true, messages: store.length };
    },
    /** test-only view */
    _outbox: () => structuredClone(sent),
    _drafts: () => structuredClone(drafts)
  };
}

function defaultMessages() {
  return [
    { id: 'm1', from: 'boss@example.com', subject: '季度评审安排', unread: true },
    { id: 'm2', from: 'noreply@bank.example', subject: '对账单已生成', unread: false }
  ];
}
