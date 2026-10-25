/**
 * Composition root — the only file allowed to wire things together.
 *
 * Mirrors PIagent's discipline: `piagent-guard.ts` owns wiring, ordering and
 * shared state, and feature algorithms live elsewhere. Same here: no policy,
 * no retrieval, no formatting in this file, only construction and the
 * registration order.
 *
 * The order is a security property (docs/06 §9):
 *   profile.load -> consent.load -> guard.register -> connectors.init
 *   -> tools.register -> context.registerLane -> scheduler.start -> channels.start
 *
 * Anything that runs before `guard.register` would be unguarded; anything
 * that runs before `consent.load` would not know the grants. Changing the
 * order requires a test change, deliberately.
 *
 * @module @piagent/personal/compose
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { REGISTRATION_ORDER, RUN_STATUS } from './core/contracts.mjs';
import { ConfigError, PolicyError } from './core/errors.mjs';
import { stateLayout, machineLayout, ensureDir } from './core/jsonl.mjs';
import { systemClock } from './core/clock.mjs';
import { assertHostPort } from './host/host-port.mjs';
import { loadProfile } from './services/profile.mjs';
import { createConsent } from './services/consent.mjs';
import { createAudit } from './services/audit.mjs';
import { createBudget } from './services/budget.mjs';
import { createMemory } from './services/memory.mjs';
import { createChatResponder } from './services/chat.mjs';
import { createReminders } from './services/reminders.mjs';
import { createDiary } from './services/diary.mjs';
import { createProactive } from './services/proactive.mjs';
import { createToolRegistry } from './integrations/tool-registry.mjs';
import { createVault } from './integrations/vault.mjs';
import { createGateway } from './runtime/gateway.mjs';
import { createIntentRouter } from './runtime/intent.mjs';
import { createJournal } from './runtime/journal.mjs';
import { createLoopAdapter } from './runtime/loop-adapter.mjs';
import { createPersonalLane } from './runtime/context-lane.mjs';
import { createDelivery } from './runtime/delivery.mjs';
import { createFilesConnector } from './integrations/connectors/local-files.mjs';
import { createCalendarConnector } from './integrations/connectors/calendar.mjs';
import { createMailConnector } from './integrations/connectors/mail.mjs';
import { createPersonalCoreConnector } from './integrations/connectors/personal-core.mjs';

/** @param {string} name */
async function readSchema(name) {
  const url = new URL(`../schemas/${name}`, import.meta.url);
  return JSON.parse(await readFile(url, 'utf8'));
}

/**
 * @param {Object} opts
 * @param {Object} opts.host                    HostPort (Pi adapter or mock)
 * @param {string} opts.workspaceRoot           personal workspace root
 * @param {string} [opts.homeDir]               for machine-level state (grants/vault)
 * @param {Object} [opts.clock]                 injectable clock
 * @param {Buffer|string} [opts.masterKey]      vault master key from host keystore
 * @param {Object[]} [opts.connectors]          connector instances (defaults to the 3 P0 ones)
 * @param {Object[]} [opts.channels]            delivery channels
 * @param {string} [opts.profilePath]           default `<workspace>/.pi/pa-profile.json`
 * @param {string} [opts.grantsPath]            default `<home>/.pi/pa/grants.json`
 * @param {Object} [opts.logger]                minimal logger {info,warn,error}
 * @returns {Promise<Object>} the public API
 */
export async function composePersonalAgent(opts) {
  const host = assertHostPort(opts?.host);
  if (!opts?.workspaceRoot) throw new ConfigError('compose requires workspaceRoot');

  const clock = opts.clock ?? systemClock;
  const logger = opts.logger ?? silentLogger();
  const paths = stateLayout(opts.workspaceRoot);
  // Machine-level state (grants, vault) must live outside the workspace: a
  // cloned repository must never be able to authorise itself (P0-1).
  const homeDir = resolve(opts.homeDir ?? homedir());
  const machine = machineLayout(homeDir);
  const paDirRelToWorkspace = relative(resolve(opts.workspaceRoot), resolve(machine.paDir));
  if (paDirRelToWorkspace === '' || (!paDirRelToWorkspace.startsWith('..') && !isAbsolute(paDirRelToWorkspace))) {
    throw new ConfigError(
      `machine state dir (${machine.paDir}) must not live inside the workspace (${opts.workspaceRoot}); pass homeDir outside it`
    );
  }

  // ── 1. profile.load ────────────────────────────────────────────────
  const profileSchema = await readSchema('pa-profile.v1.json');
  const profilePath = opts.profilePath ?? paths.profilePath;
  const { profile } = await loadProfile(profilePath, profileSchema);
  const registered = ['profile.load'];

  // ── 2. consent.load ────────────────────────────────────────────────
  const consent = createConsent({ profile, grantsPath: opts.grantsPath ?? machine.grantsPath, clock });
  const consentLoad = await consent.load();
  if (consentLoad.dropped > 0) logger.warn(`dropped ${consentLoad.dropped} expired/revoked grants`);
  registered.push('consent.load');

  // ── 3. guard.register ──────────────────────────────────────────────
  const audit = createAudit({ dir: paths.auditDir, clock });
  await audit.init();
  const budget = createBudget({ profile, clock, stateDir: paths.stateDir });
  const registry = createToolRegistry({ manifestSchema: await readSchema('tool-manifest.v1.json'), clock });
  const memory = createMemory({ stateDir: paths.stateDir, profile, clock });
  const reminders = createReminders({ stateDir: paths.stateDir, clock, profile });
  const diary = createDiary({ stateDir: paths.stateDir, clock });
  const proactive = createProactive({ stateDir: paths.stateDir, clock, profile });
  const chat = createChatResponder({ profile, clock, logger });
  const lane = createPersonalLane({ stateDir: paths.stateDir, clock });
  const journal = createJournal({ dir: paths.journalDir, clock });
  const delivery = createDelivery({
    stateDir: paths.stateDir,
    clock,
    profile,
    channels: opts.channels ?? [consoleChannel(logger)]
  });
  const intent = createIntentRouter({ clock });
  const gateway = createGateway({ clock, profile });

  const guard = createGuard({ registry, clock, audit });
  for (const hook of ['session_start', 'input', 'agent_start', 'tool_call', 'tool_result', 'completion']) {
    host.registerHook(hook, (payload) => guard.handle(hook, payload));
  }
  // The host normally emits this; the mock host (CLI/tests) does not, so we
  // emit it once here to keep both paths identical.
  await host.emitHook('session_start', {
    workspaceRoot: opts.workspaceRoot,
    persona: profile.persona?.name ?? null,
    profileVersion: profile.version
  });
  registered.push('guard.register');

  // ── 4. connectors.init ─────────────────────────────────────────────
  const allowed = profile.connectors?.allow ?? [];
  const denied = profile.connectors?.deny ?? [];
  const declaredConnectors =
    opts.connectors ??
    defaultConnectors({
      workspaceRoot: opts.workspaceRoot,
      clock,
      services: { reminders, diary, proactive }
    });
  const connectors = declaredConnectors.filter((connector) => {
    if (denied.includes(connector.id)) {
      logger.warn(`connector "${connector.id}" is denied by profile.connectors.deny; skipped`);
      return false;
    }
    if (allowed.length > 0 && !allowed.includes(connector.id)) {
      logger.warn(`connector "${connector.id}" is not in profile.connectors.allow; skipped`);
      return false;
    }
    return true;
  });
  for (const connector of connectors) {
    try {
      registry.registerConnector(connector);
    } catch (err) {
      // A broken connector degrades locally: it must not take the agent down.
      logger.warn(`connector "${connector.id}" failed to register: ${err instanceof Error ? err.message : err}`);
    }
  }
  const health = await registry.health();
  for (const entry of health.filter((item) => !item.ok)) {
    logger.warn(`connector "${entry.connector}" unhealthy: ${entry.error}`);
  }
  registered.push('connectors.init');

  // ── 5. tools.register (manifests were validated during connector init) ──
  if (registry.stat().tools === 0) {
    throw new ConfigError('no tools registered: refusing to start an agent with an empty capability surface');
  }
  registered.push('tools.register');

  // ── 6. context.registerLane ────────────────────────────────────────
  const laneRegistration = lane.register(
    host.registerLane
      ? { registerLane: (name, fn) => host.registerLane(name, fn) }
      : undefined
  );
  registered.push('context.registerLane');

  // ── 7. scheduler.start (P2 — deliberately not started in P0) ───────
  const scheduler = {
    started: false,
    reason: 'P2: proactive scheduler is not implemented in P0',
    async status() {
      return { started: false, triggers: 0 };
    }
  };
  registered.push('scheduler.start');

  // ── 8. channels.start ──────────────────────────────────────────────
  await delivery.load();
  registered.push('channels.start');

  if (registered.join('>') !== REGISTRATION_ORDER.join('>')) {
    throw new ConfigError(`registration order drifted from the contract: ${registered.join('>')}`);
  }

  const loop = createLoopAdapter({
    host,
    consent,
    audit,
    budget,
    journal,
    registry,
    delivery,
    clock,
    profile,
    responder: chat
  });

  /** @type {Object|null} */
  let vault = null;
  if (opts.masterKey) {
    vault = createVault({ path: machine.vaultPath, masterKey: opts.masterKey, clock });
    await vault.load();
  }

  const api = {
    version: '0.1.0-p0',
    registered,
    profile,
    paths,
    machine,
    services: {
      consent,
      audit,
      budget,
      memory,
      lane,
      delivery,
      journal,
      registry,
      intent,
      gateway,
      vault,
      scheduler,
      chat,
      reminders,
      diary,
      proactive
    },
    health,
    laneRegistration,

    /**
     * Run one turn end-to-end.
     * @param {string} text
     * @param {{channel?: string, mode?: string, untrusted?: boolean, urgency?: string}} [turnOpts]
     */
    async turn(text, turnOpts = {}) {
      const turn = gateway.submit({
        text,
        channel: turnOpts.channel ?? 'cli',
        mode: turnOpts.mode,
        untrusted: turnOpts.untrusted === true
      });
      // The input hook runs BEFORE intent parsing: whatever the host decided
      // about untrusted content must be able to taint the derived actions
      // (P1-8). A hook may return a modified turn.
      const inputPayload = await host.emitHook('input', { turn });
      const effectiveTurn = inputPayload?.turn ?? turn;
      const proposal = intent.parse(effectiveTurn);
      const result = await loop.execute(effectiveTurn, proposal, {
        mode: effectiveTurn.mode,
        urgency: turnOpts.urgency,
        history: turnOpts.history
      });

      if (result.status === RUN_STATUS.DONE) {
        const kinds = proposal.actions.map((action) => action.kind);
        // Episodes store a reference + kinds, never the raw prompt (P1-7).
        await memory.rememberEpisode({
          turnId: effectiveTurn.id,
          summary: `${kinds.join('+')} -> ${result.artifacts.length} artifact(s)`,
          tags: kinds
        });
        const touchesD2 = proposal.actions.some((action) => (action.dataIn ?? []).includes('D2'));
        for (const artifact of result.artifacts) {
          if (artifact?.text) {
            await lane.index({
              id: `${effectiveTurn.id}:${artifact.actionId ?? 'a'}`,
              text: artifact.text,
              dataClass: touchesD2 ? 'D2' : 'D1',
              tags: kinds,
              citations: [{ kind: 'turn', ref: effectiveTurn.id }]
            });
          }
        }
      }
      return { turn: effectiveTurn, proposal, ...result };
    },

    /**
     * Approve or reject a pending action.
     * @param {string} runId
     * @param {{approve?: boolean}} [approveOpts]
     */
    async approve(runId, approveOpts = {}) {
      return loop.resume(runId, { approve: approveOpts.approve === true });
    },

    /** Delete memory + index entries, physically. */
    async forget(forgetOpts = {}) {
      const removed = await memory.forget(forgetOpts);
      const indexResult = await lane.remove(forgetOpts);
      await audit.append({
        run_id: 'maintenance',
        turn_id: '',
        kind: 'memory',
        outcome: { action: 'forget', scope: forgetOpts.scope ?? 'all', removed: removed.removed, indexRemoved: indexResult.removed }
      });
      return { ...removed, indexRemoved: indexResult.removed };
    },

    /** Aggregate health check. Exit semantics: 0 = operable, non-zero = not. */
    async doctor() {
      return runDoctor({
        api,
        consent,
        audit,
        registry,
        memory,
        lane,
        journal,
        budget,
        delivery,
        profile,
        paths,
        health,
        reminders,
        diary,
        proactive
      });
    },

    /** Dispose: unregister nothing on the host (Pi owns it), flush state. */
    async shutdown() {
      await delivery.load();
      return { ok: true };
    }
  };

  return api;
}

/**
 * Defense-in-depth hooks. The loop already asked consent; these handlers
 * exist for the case where *something else* (a Pi tool call, a subagent)
 * reaches a tool without going through our loop. Refusing there is the whole
 * point of running inside the host's hook pipeline.
 * @param {{registry: Object, clock: Object, audit: Object}} deps
 */
export function createGuard({ registry, clock, audit }) {
  return {
    /**
     * @param {string} hook
     * @param {Object} payload
     */
    async handle(hook, payload) {
      switch (hook) {
        case 'session_start':
          return payload;

        case 'input':
          if (payload?.turn && payload.turn.untrusted !== true && payload.untrusted === true) {
            return { ...payload, turn: { ...payload.turn, untrusted: true } };
          }
          return payload;

        case 'agent_start':
          return payload;

        case 'tool_call': {
          const toolId = payload?.tool;
          if (!toolId) throw new PolicyError('POLICY_DENIED', 'tool_call hook received no tool id');
          const manifest = registry.get(toolId);
          if (!manifest) {
            throw new PolicyError('POLICY_DENIED', `工具未注册，拒绝执行: ${toolId}`);
          }
          if (manifest.risk === 'R4') {
            throw new PolicyError('POLICY_DENIED', `工具 ${toolId} 属于 R4 禁止级`);
          }
          // Union of what the action claimed and what the tool declares: the
          // guard must never believe the weaker of the two (P0-2).
          const classes = new Set([...(manifest.data_in ?? []), ...(payload.dataClasses ?? [])]);
          if (classes.has('D3')) {
            throw new PolicyError('DATA_CLASS_BLOCKED', `工具 ${toolId} 不允许接触 D3 凭证`);
          }
          return payload;
        }

        case 'tool_result':
          // Never log payloads here: they may contain D2 content.
          return { ok: payload?.ok !== false };

        case 'completion':
          return payload;

        default:
          throw new PolicyError('POLICY_DENIED', `unknown hook: ${hook}`);
      }
    }
  };
}

/**
 * @param {{workspaceRoot: string, clock: Object}} opts
 */
export function defaultConnectors({ workspaceRoot, clock, services }) {
  const base = [
    createFilesConnector({ root: join(workspaceRoot, 'vault'), clock }),
    createCalendarConnector({ clock }),
    createMailConnector({ clock })
  ];
  if (!services) return base;
  return [
    ...base,
    createPersonalCoreConnector({
      reminders: services.reminders,
      diary: services.diary,
      proactive: services.proactive,
      clock,
      calendarApi: { list: async () => (await base[1].tools[0].invoke({})).items ?? [] }
    })
  ];
}

/** Minimal channel used when no UI is attached. */
function consoleChannel(logger) {
  return {
    id: 'console',
    async send(record) {
      logger.info(`[interrupt] ${record.text}`);
      return { ok: true };
    }
  };
}

function silentLogger() {
  return { info() {}, warn() {}, error() {} };
}

/**
 * @param {Object} deps
 * @returns {Promise<Object>} doctor report
 */
export async function runDoctor(deps) {
  const { consent, audit, registry, memory, lane, journal, budget, delivery, profile, paths, health } = deps;
  const { reminders, diary, proactive } = deps;
  /** @type {{id: string, status: 'pass'|'warn'|'fail', detail: string}[]} */
  const checks = [];
  const push = (id, status, detail) => checks.push({ id, status, detail });

  push('profile', 'pass', `mode=${profile.autonomy?.default_mode}, proactive=${profile.autonomy?.proactive?.enabled === true}`);
  push('grants', consent.list().length > 0 ? 'pass' : 'warn', `${consent.list().length} active grant(s)`);

  const chain = await audit.verifyChain();
  push('audit_chain', chain.ok ? 'pass' : 'fail', chain.ok ? `${chain.count} events, chain intact` : `broken at #${chain.brokenAt}: ${chain.reason}`);

  const tools = registry.stat();
  push('tools', tools.tools > 0 ? 'pass' : 'fail', `${tools.connectors} connectors / ${tools.tools} tools`);

  const unhealthy = (health ?? []).filter((entry) => !entry.ok);
  push('connectors', unhealthy.length === 0 ? 'pass' : 'warn', unhealthy.length === 0 ? 'all healthy' : unhealthy.map((entry) => `${entry.connector}: ${entry.error}`).join('; '));

  const memoryStat = await memory.stat();
  push('memory', 'pass', `${memoryStat.active} active facts, ${memoryStat.candidates} candidate(s)`);

  const laneStat = await lane.stat();
  push('context_lane', 'pass', `${laneStat.records} indexed record(s)`);

  const incomplete = await journal.latestIncomplete();
  push('journal', incomplete ? 'warn' : 'pass', incomplete ? `run ${incomplete.run_id} is ${incomplete.status} (resume with pa-run --resume)` : 'no interrupted runs');

  const reminderStat = await reminders.stat();
  const diaryStat = await diary.stat();
  const proactiveStatus = await proactive.status();
  push(
    'personal',
    'pass',
    `提醒 ${reminderStat.pending} 待触发 · 日记 ${diaryStat.total} 条 · 今日推送 ${proactiveStatus.sent}/${proactiveStatus.quota}`
  );

  const caps = budget.caps();
  push('budget', caps.perDayUsd > 0 ? 'pass' : 'fail', `$${caps.perTurnUsd}/turn, $${caps.perDayUsd}/day, on_exceed=${caps.onExceed}`);

  const deliveryStat = await delivery.stat();
  push('delivery', 'pass', `caps interrupt=${deliveryStat.caps.interrupt} digest=${deliveryStat.caps.digest}`);

  push('state_paths', paths.stateDir ? 'pass' : 'fail', paths.stateDir);

  const ok = checks.every((check) => check.status !== 'fail');
  return { ok, exitCode: ok ? 0 : 1, checks, at: new Date().toISOString() };
}
