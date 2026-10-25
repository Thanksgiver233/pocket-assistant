#!/usr/bin/env node
/**
 * budget-check — make "总开销 ≤ 抵扣券" a testable claim instead of a slide.
 *
 * It reads `deploy/budget.json`, recomputes every line from `qty × unitPrice`
 * (never trusting the stored `amount`), and fails when:
 *   - a line's arithmetic disagrees with its declared amount;
 *   - the sum exceeds the voucher;
 *   - the reserve is negative or unaccounted for;
 *   - an item is missing a price basis (an unsourced number is a guess).
 *
 * Usage:
 *   node deploy/budget-check.mjs            # human table + exit code
 *   node deploy/budget-check.mjs --json     # machine readable
 *
 * @module deploy/budget-check
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOLERANCE = 0.01;

const budget = JSON.parse(await readFile(join(HERE, 'budget.json'), 'utf8'));
const problems = [];

let total = 0;
const rows = budget.items.map((item) => {
  const computed = round(item.qty * item.unitPrice);
  total = round(total + computed);

  if (Math.abs(computed - item.amount) > TOLERANCE) {
    problems.push(`${item.id}: 数量×单价=${computed}，但声明为 ${item.amount}`);
  }
  if (!item.basis || String(item.basis).trim() === '') {
    problems.push(`${item.id}: 缺少价格依据（basis），不允许出现无来源的数字`);
  }
  if (!Number.isFinite(item.unitPrice) || item.unitPrice < 0) {
    problems.push(`${item.id}: 单价非法（${item.unitPrice}）`);
  }
  return { ...item, computed };
});

const reserve = round(budget.reserve?.amount ?? 0);
if (reserve < 0) problems.push('reserve 不能为负');
if (round(total + reserve) > budget.voucher + TOLERANCE) {
  problems.push(`合计 ${round(total + reserve)} 超过抵扣券 ${budget.voucher}`);
}

const fixed = round(rows.filter((row) => row.kind === 'fixed').reduce((sum, row) => sum + row.computed, 0));
const variable = round(rows.filter((row) => row.kind === 'variable').reduce((sum, row) => sum + row.computed, 0));
const grand = round(total + reserve);
const headroom = round(budget.voucher - grand);

const payload = {
  ok: problems.length === 0,
  currency: budget.currency,
  voucher: budget.voucher,
  fixed,
  variable,
  subtotal: total,
  reserve,
  total: grand,
  headroom,
  utilisation: round((grand / budget.voucher) * 100),
  rows,
  problems
};

if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
} else {
  print(payload);
}

process.exitCode = payload.ok ? 0 : 1;

/** @param {Object} p */
function print(p) {
  const lines = [];
  lines.push('');
  lines.push(`预算校验 · ${budget.scenario} · 基准日 ${budget.asOf}`);
  lines.push('─'.repeat(78));
  lines.push(pad('项目', 22) + pad('规格', 30) + pad('金额', 10) + '类型');
  lines.push('─'.repeat(78));
  for (const row of p.rows) {
    lines.push(pad(row.name, 22) + pad(trim(row.spec, 28), 30) + pad(`${row.computed}`, 10) + row.kind);
  }
  lines.push('─'.repeat(78));
  lines.push(pad('固定支出', 52) + pad(`${p.fixed}`, 10));
  lines.push(pad('可变支出（模型）', 52) + pad(`${p.variable}`, 10));
  lines.push(pad('风险缓冲', 52) + pad(`${p.reserve}`, 10));
  lines.push(pad('合计', 52) + pad(`${p.total}`, 10));
  lines.push(pad('抵扣券', 52) + pad(`${p.voucher}`, 10));
  lines.push(pad('剩余', 52) + pad(`${p.headroom}`, 10));
  lines.push('');
  lines.push(`额度使用率 ${p.utilisation}%`);

  if (p.problems.length > 0) {
    lines.push('');
    for (const problem of p.problems) lines.push(`✗ ${problem}`);
    lines.push('');
    lines.push('结论：不通过');
  } else {
    lines.push('结论：通过（全部数字可复算，总开销在抵扣券之内）');
  }
  lines.push('');
  process.stdout.write(`${lines.join('\n')}\n`);
}

/** @param {string} text @param {number} width */
function pad(text, width) {
  const value = String(text);
  let visible = 0;
  for (const char of value) visible += /[\u4e00-\u9fa5]/.test(char) ? 2 : 1;
  const filler = Math.max(0, width - visible);
  return value + ' '.repeat(filler);
}

/** Trim by *display* width so CJK and ASCII columns line up. */
function trim(text, max) {
  let out = '';
  let width = 0;
  for (const char of String(text)) {
    const w = /[\u4e00-\u9fa5]/.test(char) ? 2 : 1;
    if (width + w > max) return `${out}…`;
    out += char;
    width += w;
  }
  return out;
}

/** @param {number} value */
function round(value) {
  return Math.round(value * 100) / 100;
}
