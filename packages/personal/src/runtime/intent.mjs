/**
 * Intent Router (M1/L1) — deterministic, model-free action extraction.
 *
 * P0 deliberately uses rules, not a model. Two reasons:
 *  1. Security checks must be testable without a model. If the action list
 *     came from an LLM, every consent test would need a model stub and the
 *     tests would drift from reality.
 *  2. The Pi loop owns "what to do"; this router only has to produce a
 *     conservative first cut that the loop may refine. Rules that
 *     *under*-promise are safe (the user gets a clarification), rules that
 *     over-promise are not.
 *
 * Every action carries an `origin`: text flagged as untrusted by the gateway
 * taints all actions derived from it, which is what makes the
 * "tainted egress" rule in consent.mjs reachable.
 *
 * @module @piagent/personal/runtime/intent
 */

import { RISK, DATA_CLASS } from '../core/contracts.mjs';
import { newId } from '../core/ids.mjs';
import { ValidationError } from '../core/errors.mjs';

/**
 * Rule shape:
 *  { id, kind, risk, dataIn, egress, reversible, toolIds, summary,
 *    test: RegExp | (text)=>boolean, match?: {recipient?: RegExp, date?: RegExp} }
 * Rules are evaluated top-down; the first match wins. Order matters:
 * write rules must come before read rules for the same domain, otherwise
 * "把会议挪到周五" would be classified as a read.
 */
const RULES = [
  {
    id: 'calendar.update',
    kind: 'calendar.update_event',
    risk: RISK.R1,
    dataIn: [DATA_CLASS.D1],
    egress: false,
    reversible: true,
    toolIds: ['calendar.update_event'],
    summary: '修改日历事件',
    test: /(挪|改期|调整|推迟|提前|移到|改到)/u,
    guard: /(会|日程|日历|meeting|事件)/u
  },
  {
    id: 'calendar.create',
    kind: 'calendar.create_event',
    risk: RISK.R1,
    dataIn: [DATA_CLASS.D1],
    egress: false,
    reversible: true,
    toolIds: ['calendar.create_event'],
    summary: '新建日历事件',
    test: /(安排|创建|新建|加个|定个).*(会|日程|日历)/u
  },
  {
    id: 'calendar.list',
    kind: 'calendar.list_events',
    risk: RISK.R0,
    dataIn: [DATA_CLASS.D1],
    egress: false,
    reversible: true,
    toolIds: ['calendar.list_events'],
    summary: '查看日程',
    test: /(日程|日历|安排|有什么会)/u
  },
  {
    id: 'mail.send',
    kind: 'mail.send',
    risk: RISK.R2,
    dataIn: [DATA_CLASS.D2],
    egress: true,
    reversible: false,
    toolIds: ['mail.send'],
    summary: '发送邮件（对外、不可撤回）',
    test: /(发|寄|发送|回).*(邮件|mail)/u
  },
  {
    id: 'mail.draft',
    kind: 'mail.draft',
    risk: RISK.R1,
    dataIn: [DATA_CLASS.D2],
    egress: false,
    reversible: true,
    toolIds: ['mail.draft'],
    summary: '起草邮件草稿（不发送）',
    test: /(起草|写|拟).*(邮件|mail)/u
  },
  {
    id: 'mail.list',
    kind: 'mail.list',
    risk: RISK.R0,
    dataIn: [DATA_CLASS.D2],
    egress: false,
    reversible: true,
    toolIds: ['mail.list'],
    summary: '读取邮件列表',
    test: /(邮件|收件箱|未读|inbox)/u
  },
  {
    id: 'im.send',
    kind: 'im.send',
    risk: RISK.R2,
    dataIn: [DATA_CLASS.D1],
    egress: true,
    reversible: false,
    toolIds: ['im.send'],
    summary: '对外发送消息（不可撤回）',
    test: /(发消息|通知|转告|告诉他们|发个消息)/u
  },
  {
    id: 'files.read',
    kind: 'files.read',
    risk: RISK.R0,
    dataIn: [DATA_CLASS.D1],
    egress: false,
    reversible: true,
    toolIds: ['files.read'],
    summary: '读取本地文件',
    test: /(读|看|打开|查).*(文件|文档|合同|保单)/u
  },
  {
    id: 'files.list',
    kind: 'files.list',
    risk: RISK.R0,
    dataIn: [DATA_CLASS.D1],
    egress: false,
    reversible: true,
    toolIds: ['files.list'],
    summary: '列出本地文件',
    test: /(列|有哪些|找).*(文件|文档)/u
  },
  {
    id: 'payment.transfer',
    kind: 'payment.transfer',
    risk: RISK.R3,
    dataIn: [DATA_CLASS.D2],
    egress: true,
    reversible: false,
    toolIds: [],
    summary: '支付/转账（P0 未接入任何支付能力）',
    test: /(转账|付款|支付|打钱|汇款)/u
  },
  {
    id: 'reminder.create',
    kind: 'reminder.create',
    risk: RISK.R1,
    dataIn: [DATA_CLASS.D1],
    egress: false,
    reversible: true,
    toolIds: ['reminder.create'],
    summary: '创建提醒',
    test: /(提醒我|提醒一下|别忘了|记得要)/u
  },
  {
    id: 'diary.create',
    kind: 'diary.create',
    risk: RISK.R1,
    dataIn: [DATA_CLASS.D1],
    egress: false,
    reversible: true,
    toolIds: ['diary.create'],
    summary: '记一条工作笔记',
    test: /(记一下|记录一下|随手记|帮我记|记一笔)/u
  },
  {
    id: 'diary.today',
    kind: 'diary.today',
    risk: RISK.R0,
    dataIn: [DATA_CLASS.D1],
    egress: false,
    reversible: true,
    toolIds: ['diary.today'],
    summary: '整理今天的日记',
    test: /(今天做了什么|今日日记|整理.*日记|看看日记|写日记)/u
  },
  {
    id: 'suggestions.list',
    kind: 'suggestions.list',
    risk: RISK.R0,
    dataIn: [DATA_CLASS.D0],
    egress: false,
    reversible: true,
    toolIds: ['suggestions.list'],
    summary: '看看现在有什么值得做的事',
    test: /(有什么建议|给点建议|来点灵感|推荐点|有什么值得)/u
  },
  {
    id: 'assistant.summarize',
    kind: 'assistant.summarize',
    risk: RISK.R0,
    dataIn: [DATA_CLASS.D0],
    egress: false,
    reversible: true,
    toolIds: [],
    summary: '整理与总结',
    test: /(总结|整理|汇总|归纳|复盘)/u
  }
];

const FALLBACK = {
  id: 'assistant.reply',
  kind: 'assistant.reply',
  risk: RISK.R0,
  dataIn: [DATA_CLASS.D0],
  egress: false,
  reversible: true,
  toolIds: [],
  summary: '对话回答（不触碰外部系统）'
};

/**
 * @param {{clock: Object, rules?: Object[]}} [opts]
 */
export function createIntentRouter(opts = {}) {
  const rules = opts.rules ?? RULES;

  return {
    /**
     * @param {import('../core/contracts.mjs').Turn} turn
     * @returns {{actions: import('../core/contracts.mjs').Action[], clarification: string|null}}
     */
    parse(turn) {
      if (!turn || typeof turn.text !== 'string') {
        throw new ValidationError('intent.parse requires a Turn with text');
      }
      const text = turn.text;
      const origin = turn.untrusted ? 'untrusted_content' : 'user';
      const matchedAll = rules.filter((rule) => matches(rule, text));
      if (matchedAll.length === 0) {
        return {
          actions: [materialise(FALLBACK, turn, origin)],
          clarification: null
        };
      }

      // One sentence must not become "send + list": when a write rule fires
      // for a domain, the read rule for the same domain is redundant (and
      // would add a second approval / a second tool call).
      const writeDomains = new Set(
        matchedAll.filter((rule) => rule.risk !== RISK.R0).map((rule) => rule.id.split('.')[0])
      );
      const matched = matchedAll.filter(
        (rule) => !(rule.risk === RISK.R0 && writeDomains.has(rule.id.split('.')[0]))
      );

      // Deduplicate by kind (a sentence can trigger the same rule twice).
      const now = typeof opts.clock?.now === 'function' ? opts.clock.now() : Date.now();
      const seen = new Set();
      const actions = [];
      for (const rule of matched) {
        if (seen.has(rule.kind)) continue;
        seen.add(rule.kind);
        actions.push(materialise(rule, turn, origin, now));
      }
      return { actions, clarification: null };
    },

    /** Rules are exposed for tests and for `pa-doctor --rules`. */
    rules
  };
}

/**
 * @param {Object} rule
 * @param {string} text
 */
function matches(rule, text) {
  if (!rule.test.test(text)) return false;
  if (rule.guard && !rule.guard.test(text)) return false;
  return true;
}

/**
 * @param {Object} rule
 * @param {import('../core/contracts.mjs').Turn} turn
 * @param {'user'|'untrusted_content'} origin
 * @param {number} now reference time for relative-date resolution
 * @returns {import('../core/contracts.mjs').Action}
 */
function materialise(rule, turn, origin, now = Date.now()) {
  const params = extractParams(turn.text, now);
  return {
    id: newId('action'),
    kind: rule.kind,
    toolIds: [...(rule.toolIds ?? [])],
    risk: rule.risk,
    dataIn: [...(rule.dataIn ?? [])],
    egress: rule.egress === true,
    reversible: rule.reversible !== false,
    summary: rule.summary,
    params: applyParamAliases(params, rule.toolIds, turn.text, now),
    origin,
    ruleId: rule.id,
    turnId: turn.id
  };
}

/**
 * The extractor produces sentence-shaped hints; tools want argument names.
 * Keeping the translation here (instead of teaching the extractor about every
 * tool) means a new connector adds one line, not a new regex.
 */
const TOOL_PARAM_ALIASES = Object.freeze({
  'mail.send': { email: 'to' },
  'mail.draft': { email: 'to' },
  'im.send': { target: 'to' }
});

/**
 * @param {Record<string, unknown>} params
 * @param {string[]|undefined} toolIds
 * @param {string} [text] original sentence, for tools that store it verbatim
 * @param {number} [now] reference time, for "今晚八点" without a date
 * @returns {Record<string, unknown>}
 */
function applyParamAliases(params, toolIds = [], text = '', now = Date.now()) {
  /** @type {Record<string, unknown>} */
  const out = { ...params };
  for (const toolId of toolIds) {
    const aliases = TOOL_PARAM_ALIASES[toolId];
    if (aliases) {
      for (const [from, to] of Object.entries(aliases)) {
        if (out[to] === undefined && out[from] !== undefined) out[to] = out[from];
      }
    }
    if (toolId === 'reminder.create') {
      // "明天 9 点提醒我交周报" → at = 2026-10-25T09:00:00
      // "晚上八点吃药"（没说哪天）→ 今天该时刻已过则顺延到明天
      if (out.at === undefined) {
        const time = typeof out.time === 'string' ? out.time : '09:00';
        const day = typeof out.date === 'string' ? out.date : defaultReminderDay(now, time);
        out.at = `${day}T${time}:00`;
      }
      if (out.text === undefined) out.text = stripReminderText(text);
    }
    if (toolId === 'diary.create' && out.text === undefined) {
      out.text = stripLead(text);
    }
  }
  return out;
}

/**
 * Pull a clock time out of a Chinese sentence.
 * Handles 14:30 / 9 点 / 下午三点半 / 晚上八点.
 * @param {string} text
 * @returns {string|null} HH:MM
 */
function parseClock(text) {
  const colon = /(\d{1,2}):(\d{2})/u.exec(text);
  if (colon) {
    const hour = Number(colon[1]);
    const minute = Number(colon[2]);
    if (hour <= 23 && minute <= 59) return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }

  const point = /(上午|早上|早晨|中午|下午|傍晚|晚上)?\s*([一二三四五六七八九十]{1,3}|\d{1,2})\s*点(半)?/u.exec(text);
  if (!point) return null;
  const period = point[1] ?? '';
  let hour = chineseNumber(point[2]);
  if (!Number.isFinite(hour) || hour > 24) return null;
  const minute = point[3] ? 30 : 0;

  if (period === '中午' && hour < 12) hour = 12;
  if ((period === '下午' || period === '傍晚' || period === '晚上') && hour < 12) hour += 12;
  if (hour === 24) hour = 0;
  if (hour > 23) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** 三 → 3, 十 → 10, 十一 → 11, 二十三 → 23. */
function chineseNumber(raw) {
  const value = String(raw ?? '');
  if (/^\d+$/u.test(value)) return Number(value);
  const digits = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (value === '十') return 10;
  if (value.startsWith('十')) return 10 + (digits[value.slice(1)] ?? 0);
  if (value.includes('十')) {
    const [tens, ones] = value.split('十');
    return (digits[tens] ?? 0) * 10 + (digits[ones] ?? 0);
  }
  return digits[value] ?? Number.NaN;
}

/** No date given: today if the clock time is still ahead, otherwise tomorrow. */
function defaultReminderDay(now, time) {
  const date = new Date(now);
  const [hour, minute] = String(time).split(':').map(Number);
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, minute, 0, 0);
  if (target.getTime() <= now) target.setDate(target.getDate() + 1);
  return `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, '0')}-${String(target.getDate()).padStart(2, '0')}`;
}

/**
 * A reminder's payload is the *thing to remember*, not the sentence that asked
 * for it: "明天9点提醒我交周报" → "交周报".
 */
function stripReminderText(text) {
  return String(text ?? '')
    .replace(/\d{4}-\d{2}-\d{2}/gu, ' ')
    .replace(/\d{1,2}月\d{1,2}日/gu, ' ')
    .replace(/(大后天|后天|明天|今天|下周|本周|这周|周[一二三四五六日天]|星期[一二三四五六日天])/gu, ' ')
    .replace(/(上午|早上|早晨|中午|下午|傍晚|晚上)/gu, ' ')
    .replace(/([一二三四五六七八九十]{1,3}|\d{1,2})\s*点(半)?/gu, ' ')
    .replace(/\d{1,2}:\d{2}/gu, ' ')
    .replace(/(请|麻烦|帮我|帮忙)?\s*(提醒我|提醒一下|别忘了|记得要)/gu, ' ')
    .replace(/^[\s:：,，的]+/u, '')
    .replace(/[\s]+/gu, ' ')
    .trim();
}

/** Drop the instruction prefix so the stored note is the fact, not the command. */
function stripLead(text) {
  return String(text ?? '')
    .replace(/^(请|麻烦|帮我|帮忙)?\s*(记一下|记录一下|随手记|记一笔|提醒我|提醒一下)\s*[:：,，]?\s*/u, '')
    .replace(/^(别忘了|记得要)\s*/u, '')
    .trim();
}

/**
 * Best-effort structured hints for the confirmation card and for tools.
 *
 * Deliberately shallow, but it must resolve the two things every calendar
 * sentence carries: *when* ("周五", "下周三", "明天") and *what* ("周会").
 * Without them the action reaches the tool with empty params and the run
 * fails at invoke time — a rule engine that only classifies is not enough
 * to complete a turn.
 *
 * @param {string} text
 * @param {number} [now]
 */
export function extractParams(text, now = Date.now()) {
  /** @type {Record<string, unknown>} */
  const params = {};

  const iso = /(\d{4}-\d{2}-\d{2})/u.exec(text);
  const monthDay = /(\d{1,2})月(\d{1,2})日/u.exec(text);
  const relative = resolveRelativeDate(text, now);
  if (iso) params.date = iso[1];
  else if (monthDay) params.date = formatDate(new Date(new Date(now).getFullYear(), Number(monthDay[1]) - 1, Number(monthDay[2])));
  else if (relative) params.date = relative;

  const clock = parseClock(text);
  if (clock) params.time = clock;

  const email = /[\w.+-]+@[\w-]+\.[\w.]+/u.exec(text);
  if (email) params.email = email[0];

  const quoted = /["“”『「]([^"“”『」]{1,40})["“”』」]/u.exec(text);
  if (quoted) params.target = quoted[1];

  // "把周会挪到周五" → title = 周会. Only when the sentence names something
  // specific: generic words ("会议"/"日程") are not an identity, and a title
  // that matches several events would make the tool refuse anyway.
  if (params.target === undefined) {
    const beforeVerb = /(?:把|将)\s*([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9]{0,9})\s*(?:挪|改期|调整|推迟|提前|移到|改到|取消)/u.exec(text);
    const afterDe = /的([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9]{0,9})\s*(?:挪|改期|调整|推迟|提前|移到|改到|取消)/u.exec(text);
    const found = beforeVerb?.[1] ?? afterDe?.[1];
    const generic = new Set(['我', '你', '它', '这', '那', '会议', '日程', '事件', '安排', '事情']);
    if (found && !generic.has(found)) params.title = found;
  }

  return params;
}

/**
 * Resolve 今天/明天/后天/周X/星期X/下周三 to YYYY-MM-DD in local time.
 * @param {string} text
 * @param {number} now
 * @returns {string|null}
 */
function resolveRelativeDate(text, now) {
  const base = new Date(now);
  const offset = /大后天/u.test(text) ? 3 : /后天/u.test(text) ? 2 : /明天|明日/u.test(text) ? 1 : /今天|今日/u.test(text) ? 0 : null;
  if (offset !== null) return formatDate(addDays(base, offset));

  const weekday = /(下下|下|这|本)?(?:周|星期|礼拜)([一二三四五六日天])/u.exec(text);
  if (!weekday) return null;
  const target = '一二三四五六日'.indexOf(weekday[2] === '天' ? '日' : weekday[2]) + 1;
  const current = base.getDay() === 0 ? 7 : base.getDay();
  let delta = target - current;
  if (weekday[1] === '下') delta += 7;
  else if (weekday[1] === '下下') delta += 14;
  else if (delta < 0) delta += 7; // 无前缀且已过：指下一个
  return formatDate(addDays(base, delta));
}

/** @param {Date} date @param {number} days */
function addDays(date, days) {
  const next = new Date(date.getTime());
  next.setDate(next.getDate() + days);
  return next;
}

/** @param {Date} date */
function formatDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export { RULES as DEFAULT_RULES };
