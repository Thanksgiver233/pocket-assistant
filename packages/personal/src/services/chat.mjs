/**
 * Chat responder — turns a sentence into an answer, not an echo.
 *
 * Before this module the `assistant.reply` action produced
 * `对话回答（不触碰外部系统）：<原文>`, which is a template, not a
 * conversation. Two paths now:
 *
 *  1. **LLM** (when `PA_LLM_API_KEY` / `DASHSCOPE_API_KEY` is set): an
 *     OpenAI-compatible call to 百炼. Cost is metered and settled through the
 *     budget governor like any other spend.
 *  2. **Local** (no key, or the call fails): a deterministic responder that
 *     still answers identity / capability / greeting / time questions and
 *     otherwise asks a clarifying question with concrete examples. It never
 *     repeats the user's sentence back at them.
 *
 * The local path is not a placeholder — it is the offline mode. A personal
 * agent that becomes mute without an API key is not usable on a plane, and
 * "断网可用" is a product claim (docs/10 D7).
 *
 * @module @piagent/personal/services/chat
 */

const DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const DEFAULT_MODEL = 'qwen3.8-flash';
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_ANSWER_CHARS = 1200;

/** What the assistant is allowed to claim about itself. */
const CAPABILITIES = [
  '改日程：把周会挪到周五',
  '记一笔：记一下 王工说接口周三给',
  '看日记：今天做了什么',
  '要建议：有什么建议'
];

const SYSTEM_PROMPT = `你是「随身」，一个运行在用户自己机器上的个人助理。

规则（必须遵守）：
1. 你没有执行任何动作。若用户想要"改日程/发邮件/记笔记"，告诉他直接说出指令，例如「把周会挪到周五」，系统会走审批后执行。
2. 不要编造已经完成的操作，也不要声称看过用户的文件、邮件或日历。
3. 回答简短、具体，中文，最多 3 段。不要用"作为一个AI"这类套话。
4. 不确定就说不确定，并给出下一步建议。
5. 不要输出 Markdown 标题或代码块，纯文本即可。

你能做的事：${CAPABILITIES.join('；')}。`;

/**
 * @param {{profile?: Object, clock: Object, env?: Object, fetchImpl?: Function, logger?: Object}} opts
 */
export function createChatResponder({ profile, clock, env = process.env, fetchImpl, logger = silent() } = {}) {
  const apiKey = String(env.PA_LLM_API_KEY ?? env.DASHSCOPE_API_KEY ?? '').trim();
  const baseUrl = String(env.PA_LLM_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const model = String(env.PA_LLM_MODEL ?? DEFAULT_MODEL);
  const timeoutMs = clampInt(env.PA_LLM_TIMEOUT_MS, 2_000, 60_000, DEFAULT_TIMEOUT_MS);
  const persona = profile?.persona?.name ?? '随身';
  const tone = profile?.persona?.tone ?? 'concise';
  const fetchFn = fetchImpl ?? globalThis.fetch;

  /** Rough per-answer cost so the budget governor can reserve before spending. */
  const estimateUsd = 0.002;

  return {
    available: Boolean(apiKey) && typeof fetchFn === 'function',
    model,
    estimateUsd,

    /**
     * @param {{text: string, kind?: string, history?: {role: string, content: string}[], context?: Object}} input
     * @returns {Promise<{text: string, source: 'llm'|'local', tokens: number, usd: number, degraded?: string}>}
     */
    async reply(input) {
      const text = String(input?.text ?? '').trim();
      if (!text) return localAnswer('', { persona, tone, clock, kind: input?.kind });

      if (!apiKey || typeof fetchFn !== 'function') {
        return localAnswer(text, { persona, tone, clock, kind: input?.kind, reason: 'no_api_key' });
      }

      try {
        return await callModel({
          fetchFn,
          baseUrl,
          apiKey,
          model,
          timeoutMs,
          text,
          kind: input?.kind,
          history: input?.history ?? [],
          persona,
          tone
        });
      } catch (err) {
        // Degrade, don't fail the turn: a model outage should not make the
        // assistant unusable, and the user should know why the answer is basic.
        const message = err instanceof Error ? err.message : String(err);
        logger.warn?.(`chat: LLM 调用失败，降级到本地回答（${message}）`);
        return localAnswer(text, { persona, tone, clock, kind: input?.kind, reason: 'llm_error' });
      }
    }
  };
}

/**
 * @param {{fetchFn: Function, baseUrl: string, apiKey: string, model: string, timeoutMs: number,
 *          text: string, kind?: string, history: Object[], persona: string, tone: string}} opts
 */
async function callModel(opts) {
  const { fetchFn, baseUrl, apiKey, model, timeoutMs, text, kind, history, persona, tone } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();

  try {
    const response = await fetchFn(`${baseUrl}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        temperature: 0.6,
        max_tokens: 700,
        messages: [
          { role: 'system', content: `${SYSTEM_PROMPT}\n你的名字是「${persona}」，语气：${tone}。` },
          ...trimHistory(history),
          { role: 'user', content: kind === 'assistant.summarize' ? `请把下面内容整理成要点：\n${text}` : text }
        ]
      })
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status} ${body.slice(0, 160)}`);
    }
    const payload = await response.json();
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim() === '') {
      throw new Error('empty completion');
    }
    const usage = payload?.usage ?? {};
    const promptTokens = Number(usage.prompt_tokens ?? 0);
    const completionTokens = Number(usage.completion_tokens ?? 0);

    return {
      text: clampText(content.trim()),
      source: 'llm',
      tokens: promptTokens + completionTokens,
      usd: round(promptTokens * 0.8e-6 + completionTokens * 2.4e-6),
      latencyMs: Date.now() - started
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Keep the last few turns; a personal assistant does not need a long window. */
function trimHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((entry) => entry && (entry.role === 'user' || entry.role === 'assistant') && typeof entry.content === 'string')
    .slice(-6)
    .map((entry) => ({ role: entry.role, content: clampText(entry.content, 600) }));
}

/**
 * Deterministic offline answer. Order matters: identity before capability
 * (people ask "who are you" before "what can you do").
 *
 * @param {string} text
 * @param {{persona: string, tone: string, clock: Object, kind?: string, reason?: string}} ctx
 */
export function localAnswer(text, ctx) {
  const { persona, clock, kind, reason } = ctx;
  const time = formatNow(clock);
  const base = { source: 'local', tokens: 0, usd: 0 };
  if (reason) base.degraded = reason;

  if (!text) {
    return { ...base, text: `我在。你可以直接说要做的事，比如「把周会挪到周五」。` };
  }

  if (/(你是谁|你叫什么|你的名字|介绍.*自己|who are you)/i.test(text)) {
    return {
      ...base,
      text:
        `我是${persona}，跑在你自己的机器上。` +
        `我的特点是：动手前先问你、动完给你一张可撤销的小票、花费随时可见。` +
        `现在的时间是 ${time}。`
    };
  }

  if (/(能做什么|会做什么|有什么功能|怎么用|帮助|help|capabilit)/i.test(text)) {
    return {
      ...base,
      text: `我能做四类事：\n1) ${CAPABILITIES[0]}\n2) ${CAPABILITIES[1]}\n3) ${CAPABILITIES[2]}\n4) ${CAPABILITIES[3]}\n直接说句子就行，不用记命令。`
    };
  }

  if (/(几点|现在时间|今天几号|日期|星期几)/.test(text)) {
    return { ...base, text: `现在是 ${time}。` };
  }

  if (/(你好|您好|hi|hello|在吗|在不在)/i.test(text)) {
    return { ...base, text: `在。${greetingByHour(clock)}，今天想先处理哪件事？` };
  }

  if (/(谢谢|多谢|thanks|thank you)/i.test(text)) {
    return { ...base, text: '不客气。有需要随时说。' };
  }

  if (/(提醒|别忘了|记得)/.test(text)) {
    return {
      ...base,
      text: '要建提醒的话，直接说「明天 9 点提醒我交周报」，我会先跟你确认再落库。'
    };
  }

  if (/(日记|今天做了什么|记录一下|记一下)/.test(text)) {
    return {
      ...base,
      text: '想记东西就说「记一下 王工说接口周三给」，我原样存下来，晚上再整理成日记。'
    };
  }

  if (kind === 'assistant.summarize') {
    return {
      ...base,
      text: `我先按字面整理：${firstSentences(text, 2)}\n（离线模式只能做浅整理；接上模型后会给出真正的归纳。）`
    };
  }

  // The important part: never echo. Ask a question that moves the turn forward.
  return {
    ...base,
    text:
      `我没完全听懂「${shorten(text, 18)}」。你可以换成这三种说法之一：\n` +
      `· 改日程：把周会挪到周五\n` +
      `· 记一笔：记一下 下午和王工对齐接口\n` +
      `· 问建议：有什么建议`
  };
}

function greetingByHour(clock) {
  const hour = new Date(clock?.now?.() ?? Date.now()).getHours();
  if (hour < 6) return '这么晚还没睡';
  if (hour < 11) return '早上好';
  if (hour < 14) return '中午好';
  if (hour < 18) return '下午好';
  return '晚上好';
}

function formatNow(clock) {
  const ms = clock?.now?.() ?? Date.now();
  const date = new Date(ms);
  const pad = (value) => String(value).padStart(2, '0');
  const weekday = ['日', '一', '二', '三', '四', '五', '六'][date.getDay()];
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())} 周${weekday}`;
}

/** @param {string} text @param {number} count */
function firstSentences(text, count) {
  const parts = text.split(/[。！？\n]/).map((part) => part.trim()).filter(Boolean);
  return parts.slice(0, count).join('；') || text;
}

/** @param {string} text @param {number} max */
function shorten(text, max) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** @param {string} text */
function clampText(text, max = MAX_ANSWER_CHARS) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** @param {unknown} value @param {number} min @param {number} max @param {number} fallback */
function clampInt(value, min, max, fallback) {
  const number = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

/** @param {number} value */
function round(value) {
  return Math.round(value * 1e6) / 1e6;
}

function silent() {
  return { warn() {}, info() {}, error() {} };
}
