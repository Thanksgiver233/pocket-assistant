/**
 * HTTP surface — a thin adapter over the composed agent, nothing more.
 *
 * The rule this file must not break: **no policy lives here**. Every decision
 * still goes through `consent` / `budget` / `registry`; this layer only
 * authenticates the caller, bounds the request, and projects the result for a
 * browser. If a check is needed for correctness, it belongs in the library.
 *
 * Deliberate choices for a ¥68/year box:
 *  - `node:http` only (no Express/Koa): one less dependency, one less CVE feed;
 *  - single-user bearer token (no session store, no Redis);
 *  - in-process token bucket (no rate-limit service);
 *  - static files served from disk with a small allowlist (no directory walk).
 *
 * @module @piagent/personal/server/http-server
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';

import { CHANNEL, RUN_STATUS } from '../core/contracts.mjs';

const MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_RATE = { windowMs: 60_000, max: 30 };

const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.ico': 'image/x-icon'
});

/**
 * @param {{api: Object, token: string, webRoot?: string|null, logger?: Object,
 *          rate?: {windowMs: number, max: number}}} opts
 */
export function createHttpServer({ api, token, webRoot = null, logger = silent(), rate = DEFAULT_RATE }) {
  if (!api) throw new TypeError('http server requires a composed api');
  if (typeof token !== 'string' || token.length < 16) {
    throw new TypeError('http server requires an access token of at least 16 characters');
  }

  const buckets = new Map();

  /** @param {string} ip @returns {boolean} true = allowed */
  function allow(ip) {
    const now = Date.now();
    const entry = buckets.get(ip) ?? { count: 0, resetAt: now + rate.windowMs };
    if (now > entry.resetAt) {
      entry.count = 0;
      entry.resetAt = now + rate.windowMs;
    }
    entry.count += 1;
    buckets.set(ip, entry);
    return entry.count <= rate.max;
  }

  const server = createServer(async (req, res) => {
    const started = Date.now();
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname;

      if (path === '/healthz') return await healthz(api, res);
      if (path.startsWith('/api/')) return await apiRoute({ req, res, url, path, api, token, allow });

      if (webRoot && (req.method === 'GET' || req.method === 'HEAD')) {
        return await serveStatic(webRoot, path, res, req.method === 'HEAD');
      }
      return json(res, 404, { ok: false, error: 'not_found' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error?.(`${req.method} ${req.url} -> 500: ${message}`);
      return json(res, 500, { ok: false, error: 'internal_error' });
    } finally {
      logger.info?.(`${req.method} ${req.url} ${res.statusCode} ${Date.now() - started}ms`);
    }
  });

  return {
    server,
    /** @param {number} port @param {string} [host] */
    listen(port, host = '127.0.0.1') {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolve(server.address()));
      });
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve(undefined)));
    }
  };
}

/**
 * `/healthz` is intentionally unauthenticated: a load balancer or an uptime
 * check must be able to ask "are you alive" without holding a secret. It
 * exposes counts only, never content.
 */
async function healthz(api, res) {
  let report;
  try {
    report = await api.doctor();
  } catch {
    return json(res, 503, { ok: false, status: 'degraded' });
  }
  const failing = report.checks.filter((check) => check.status === 'fail');
  return json(res, failing.length === 0 ? 200 : 503, {
    ok: failing.length === 0,
    status: failing.length === 0 ? 'ok' : 'degraded',
    checks: report.checks.map((check) => ({ id: check.id, status: check.status }))
  });
}

/**
 * @param {{req: Object, res: Object, url: URL, path: string, api: Object, token: string,
 *          allow: (ip: string) => boolean}} ctx
 */
async function apiRoute({ req, res, url, path, api, token, allow }) {
  const ip = req.socket?.remoteAddress ?? 'unknown';
  if (!allow(ip)) return json(res, 429, { ok: false, error: 'rate_limited' });
  if (!authorised(req, token)) return json(res, 401, { ok: false, error: 'unauthorised' });

  const method = req.method ?? 'GET';

  if (path === '/api/state' && method === 'GET') {
    const budget = await api.services.budget.status();
    const incomplete = await api.services.journal.latestIncomplete();
    const reminderStat = await api.services.reminders.stat();
    const diaryStat = await api.services.diary.stat();
    const attention = await api.services.proactive.status();
    return json(res, 200, {
      ok: true,
      persona: api.profile.persona?.name ?? null,
      mode: api.profile.autonomy?.default_mode ?? null,
      budget,
      grants: api.services.consent.list().length,
      pendingRun: incomplete ? { runId: incomplete.run_id, status: incomplete.status } : null,
      // Which brain is answering: a configured model, or the offline responder.
      chat: { mode: api.services.chat?.available ? 'llm' : 'local', model: api.services.chat?.model ?? null },
      reminders: { pending: reminderStat.pending, total: reminderStat.total },
      diary: { total: diaryStat.total, days: diaryStat.days },
      attention: { quota: attention.quota, remaining: attention.remaining, sent: attention.sent }
    });
  }

  if (path === '/api/reminders' && method === 'GET') {
    const items = await api.services.reminders.list({ includeDone: url.searchParams.get('all') === '1' });
    return json(res, 200, { ok: true, reminders: items });
  }

  if (path === '/api/reminders' && method === 'POST') {
    const body = await readJson(req);
    try {
      const reminder = await api.services.reminders.add({ text: body.text, at: body.at });
      return json(res, 201, { ok: true, reminder });
    } catch (err) {
      return json(res, 400, { ok: false, error: 'invalid_reminder', message: messageOf(err) });
    }
  }

  if (path.startsWith('/api/reminders/') && method === 'POST') {
    const rest = path.slice('/api/reminders/'.length);
    const [id, verb] = rest.split('/');
    if (verb === 'done') {
      const ok = await api.services.reminders.complete(decodeURIComponent(id));
      return json(res, ok ? 200 : 404, { ok });
    }
    if (verb === 'cancel') {
      const ok = await api.services.reminders.cancel(decodeURIComponent(id));
      return json(res, ok ? 200 : 404, { ok });
    }
    return json(res, 404, { ok: false, error: 'not_found' });
  }

  if (path === '/api/diary' && method === 'GET') {
    const day = url.searchParams.get('day') ?? undefined;
    const entries = await api.services.diary.list({ day, limit: 200 });
    return json(res, 200, { ok: true, entries });
  }

  if (path === '/api/diary' && method === 'POST') {
    const body = await readJson(req);
    try {
      const entry = await api.services.diary.add({ text: body.text, tags: body.tags });
      return json(res, 201, { ok: true, entry });
    } catch (err) {
      return json(res, 400, { ok: false, error: 'invalid_note', message: messageOf(err) });
    }
  }

  if (path === '/api/diary/digest' && method === 'GET') {
    const day = url.searchParams.get('day') ?? undefined;
    const digest = await api.services.diary.digest(day);
    return json(res, 200, { ok: true, digest });
  }

  if (path === '/api/suggestions' && method === 'GET') {
    const due = await api.services.reminders.due();
    const entries = await api.services.diary.list({ limit: 200 });
    const today = localDay(new Date());
    const candidates = await api.services.proactive.candidates({
      reminders: due,
      diary: { todayCount: entries.filter((entry) => entry.day === today).length }
    });
    const attention = await api.services.proactive.status();
    return json(res, 200, { ok: true, suggestions: candidates, attention });
  }

  if (path === '/api/suggestions/dismiss' && method === 'POST') {
    const body = await readJson(req);
    const result = await api.services.proactive.dismiss(String(body.id ?? ''));
    return json(res, 200, { ok: true, ...result });
  }

  if (path === '/api/turn' && method === 'POST') {
    const body = await readJson(req);
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) return json(res, 400, { ok: false, error: 'empty_text' });
    if (text.length > 8000) return json(res, 413, { ok: false, error: 'text_too_long' });

    const mode = typeof body.mode === 'string' ? body.mode : undefined;
    const result = await api.turn(text, { channel: CHANNEL.DASHBOARD, mode });
    return json(res, 200, projectTurn(result));
  }

  if (path === '/api/pending' && method === 'GET') {
    const run = await api.services.journal.latestIncomplete();
    if (!run || !run.pending) return json(res, 200, { ok: true, pending: null });
    return json(res, 200, { ok: true, pending: projectPending(run) });
  }

  if (path === '/api/approve' && method === 'POST') {
    const body = await readJson(req);
    const runId = typeof body.runId === 'string' ? body.runId : '';
    if (!runId) return json(res, 400, { ok: false, error: 'missing_run_id' });
    const result = await api.approve(runId, {
      approve: body.approve === true,
      identity: body.identity === true
    });
    return json(res, 200, projectTurn(result));
  }

  if (path === '/api/receipts' && method === 'GET') {
    const limit = clampInt(url.searchParams.get('limit'), 1, 50, 20);
    const { records } = await api.services.audit.readAll();
    // Projection, not passthrough: the ledger's `outcome` may hold summaries,
    // and a receipt is a UI artefact — it should not become a data export API.
    const receipts = records.slice(-limit).reverse().map((record) => ({
      at: record.ts,
      kind: record.kind,
      tool: record.tool ?? null,
      risk: record.risk ?? null,
      verdict: record.decision?.verdict ?? record.outcome?.status ?? null,
      reason: record.decision?.reason ?? record.outcome?.code ?? null,
      cost: record.cost?.usd ?? null
    }));
    return json(res, 200, { ok: true, receipts });
  }

  if (path === '/api/grants' && method === 'GET') {
    return json(res, 200, {
      ok: true,
      grants: api.services.consent.list().map((grant) => ({
        id: grant.grant_id,
        connector: grant.connector,
        actions: grant.actions,
        dataClasses: grant.data_classes,
        expiresAt: grant.expires_at
      }))
    });
  }

  if (path === '/api/grants' && method === 'POST') {
    const body = await readJson(req);
    const connector = typeof body.connector === 'string' ? body.connector : '';
    const digest = api.services.registry.digests()[connector];
    if (!digest) return json(res, 400, { ok: false, error: 'unknown_connector' });
    const grant = await api.services.consent.grant({
      connector,
      actions: asArray(body.actions),
      data_classes: asArray(body.dataClasses),
      ttlHours: Number.isFinite(body.ttlHours) ? body.ttlHours : undefined,
      connectorDigest: digest,
      issuedBy: 'user'
    });
    return json(res, 201, { ok: true, id: grant.grant_id, expiresAt: grant.expires_at });
  }

  if (path.startsWith('/api/grants/') && method === 'DELETE') {
    const id = decodeURIComponent(path.slice('/api/grants/'.length));
    const revoked = await api.services.consent.revoke(id);
    return json(res, revoked ? 200 : 404, { ok: revoked, id });
  }

  if (path === '/api/forget' && method === 'POST') {
    const body = await readJson(req);
    const scope = typeof body.scope === 'string' ? body.scope : 'all';
    const result = await api.forget({ scope });
    return json(res, 200, { ok: true, removed: result.removed, removedEpisodes: result.removedEpisodes });
  }

  return json(res, 404, { ok: false, error: 'not_found' });
}

/**
 * @param {Object} req
 * @param {string} token
 */
function authorised(req, token) {
  const header = req.headers?.authorization ?? '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const headerToken = typeof req.headers?.['x-pa-token'] === 'string' ? req.headers['x-pa-token'] : '';
  const presented = bearer || headerToken;
  if (presented.length !== token.length) return false;
  // Constant-time compare: token length is public, content is not.
  let diff = 0;
  for (let i = 0; i < token.length; i += 1) diff |= presented.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}

/** @param {Object} req @returns {Promise<Object>} */
async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('body too large');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Project a RunResult for the browser. D2 payloads never leave the machine
 * through this function — the artifact text is dropped, only its kind stays.
 * @param {Object} result
 */
export function projectTurn(result) {
  // The artifact carries its own classification (stamped by the loop), so a
  // resumed run — whose `decisions` array is empty — is still redacted.
  const touchesD2 =
    (result.artifacts ?? []).some((artifact) => artifact.dataClass === 'D2') ||
    (result.decisions ?? []).some((decision) => decision.dataClasses?.includes?.('D2'));
  const artifacts = (result.artifacts ?? []).map((artifact) => {
    const d2 = artifact.dataClass === 'D2' || touchesD2;
    return {
      kind: artifact.kind ?? 'text',
      // A D2 artifact's body is the user's mail/medical content; the UI shows a
      // placeholder and the user opens it locally.
      text: d2 ? null : truncate(artifact.text, 2000),
      redacted: d2
    };
  });
  return {
    ok: result.status === RUN_STATUS.DONE,
    runId: result.runId,
    status: result.status,
    decision: result.decision
      ? { verdict: result.decision.verdict, reason: result.decision.reason, requires: result.decision.requires }
      : null,
    pending: result.pending ? projectPending({ pending: result.pending, run_id: result.runId }) : null,
    artifacts,
    redacted: touchesD2
  };
}

/** @param {Object} run */
function projectPending(run) {
  const pending = run.pending;
  return {
    runId: run.run_id ?? run.runId ?? null,
    actionId: pending.actionId ?? null,
    cardType: pending.card?.cardType ?? 'action',
    title: pending.card?.title ?? pending.reason ?? '',
    reason: pending.reason ?? null,
    requires: pending.requires ?? 'user',
    risk: pending.risk ?? null,
    dataClasses: pending.card?.dataIn ?? [],
    reasons: pending.card?.reasons ?? null
  };
}

function localDay(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** @param {unknown} err */
function messageOf(err) {
  return err instanceof Error ? err.message : String(err);
}

/** @param {unknown} value @param {number} max */
function truncate(value, max) {
  if (typeof value !== 'string') return null;
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** @param {unknown} value @returns {string[]} */
function asArray(value) {
  if (Array.isArray(value)) return value.filter((entry) => typeof entry === 'string');
  if (typeof value === 'string' && value.trim()) return value.split(',').map((entry) => entry.trim()).filter(Boolean);
  return [];
}

/** @param {unknown} value @param {number} min @param {number} max @param {number} fallback */
function clampInt(value, min, max, fallback) {
  const number = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

/** @param {Object} res @param {number} status @param {Object} body */
function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer'
  });
  res.end(payload);
}

/**
 * Serve only files that resolve inside `root`, only with a known extension.
 * Path traversal is rejected lexically *and* by prefix check after normalise.
 * @param {string} root @param {string} path @param {Object} res @param {boolean} headOnly
 */
async function serveStatic(root, path, res, headOnly) {
  const relative = path === '/' ? 'index.html' : path.replace(/^\/+/, '');
  const target = normalize(join(root, relative));
  if (!target.startsWith(normalize(root) + sep) && target !== normalize(root)) {
    return json(res, 403, { ok: false, error: 'forbidden' });
  }
  const type = MIME[extname(target).toLowerCase()];
  if (!type) return json(res, 404, { ok: false, error: 'not_found' });

  let body;
  try {
    body = await readFile(target);
  } catch {
    return json(res, 404, { ok: false, error: 'not_found' });
  }
  res.writeHead(200, {
    'content-type': type,
    'content-length': body.length,
    'cache-control': type.startsWith('text/html') ? 'no-cache' : 'public, max-age=3600',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    // The UI is a single self-contained page; no third-party origins at all.
    'content-security-policy':
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'"
  });
  res.end(headOnly ? undefined : body);
}

function silent() {
  return { info() {}, warn() {}, error() {} };
}
