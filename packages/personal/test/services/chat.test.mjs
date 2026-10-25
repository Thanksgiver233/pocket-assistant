/**
 * Chat responder tests — the difference between "answering" and "echoing".
 *
 * The bug this file guards against: the previous implementation replied with
 * `对话回答（不触碰外部系统）：<用户原话>`, which looks like a conversation in a
 * screenshot and is useless in practice. Every local answer is asserted to be
 * *not* the input.
 *
 * @module @piagent/personal/test/services/chat
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createChatResponder, localAnswer } from '../../src/services/chat.mjs';
import { createClock } from '../../src/core/clock.mjs';

const START = '2026-10-23T09:00:00+08:00';
const clock = createClock({ start: START });

function responder(env = {}, fetchImpl) {
  return createChatResponder({ clock, env, fetchImpl, profile: { persona: { name: '随身', tone: 'concise' } } });
}

test('TC-A01 没有 API key 时可用但走本地回答', async () => {
  const chat = responder({});
  assert.equal(chat.available, false);
  const answer = await chat.reply({ text: '你是谁' });
  assert.equal(answer.source, 'local');
  assert.equal(answer.usd, 0);
  assert.equal(answer.degraded, 'no_api_key');
});

test('TC-A02 本地回答不是回显：身份/能力/问候/兜底四种输入都不复读原文', async () => {
  const cases = ['你是谁', '你能做什么', '你好', '帮我看看这个季度的增长情况'];
  for (const text of cases) {
    const answer = await localAnswer(text, { persona: '随身', tone: 'concise', clock });
    assert.ok(answer.text.length > 8, `${text}: 回答太短`);
    assert.notEqual(answer.text.trim(), text, `${text}: 不得原样回显`);
    assert.doesNotMatch(answer.text, /^对话回答（不触碰外部系统）：/, `${text}: 不得使用旧模板`);
  }
});

test('TC-A03 身份问题给出定位与时间，而不是套话', async () => {
  const answer = await localAnswer('你是谁', { persona: '随身', tone: 'concise', clock });
  assert.match(answer.text, /随身/);
  assert.match(answer.text, /2026-10-23/);
  assert.match(answer.text, /小票|撤销|机器/);
});

test('TC-A04 能力问题列出可执行示例', async () => {
  const answer = await localAnswer('你能做什么', { persona: '随身', tone: 'concise', clock });
  assert.match(answer.text, /挪到周五/);
  assert.match(answer.text, /记一下/);
});

test('TC-A05 兜底回答给出三种可用说法（引导而不是装懂）', async () => {
  const answer = await localAnswer('随便说点什么吧', { persona: '随身', tone: 'concise', clock });
  assert.match(answer.text, /没完全听懂/);
  assert.match(answer.text, /改日程/);
  assert.match(answer.text, /记一笔/);
  assert.match(answer.text, /问建议/);
});

test('TC-A06 配置 key 后走模型：带鉴权头、计算 token 与费用、截断超长回答', async () => {
  let captured = null;
  const fakeFetch = async (url, init) => {
    captured = { url, init };
    return {
      ok: true,
      async json() {
        return {
          choices: [{ message: { content: '这是模型回答。'.repeat(200) } }],
          usage: { prompt_tokens: 1000, completion_tokens: 500 }
        };
      }
    };
  };

  const chat = responder({ PA_LLM_API_KEY: 'test-key-123', PA_LLM_MODEL: 'qwen3.8-flash' }, fakeFetch);
  assert.equal(chat.available, true);

  const answer = await chat.reply({ text: '解释一下什么是注意力机制' });
  assert.equal(answer.source, 'llm');
  assert.equal(answer.tokens, 1500);
  // 1000×0.8e-6 + 500×2.4e-6 = 0.002
  assert.equal(answer.usd, 0.002);
  assert.ok(answer.text.length <= 1201, '回答必须截断');

  assert.match(captured.url, /\/chat\/completions$/);
  assert.equal(captured.init.headers.authorization, 'Bearer test-key-123');
  const body = JSON.parse(captured.init.body);
  assert.equal(body.model, 'qwen3.8-flash');
  assert.equal(body.messages.at(-1).role, 'user');
});

test('TC-A07 模型失败时降级为本地回答，并标记原因', async () => {
  const failing = async () => ({ ok: false, status: 429, async text() { return 'rate limited'; } });
  const chat = responder({ PA_LLM_API_KEY: 'k' }, failing);
  const answer = await chat.reply({ text: '你好' });
  assert.equal(answer.source, 'local');
  assert.equal(answer.degraded, 'llm_error');
  assert.ok(answer.text.length > 4);
});

test('TC-A08 空输入也能得到一句有用的引导', async () => {
  const answer = await localAnswer('', { persona: '随身', tone: 'concise', clock });
  assert.match(answer.text, /我在/);
});
