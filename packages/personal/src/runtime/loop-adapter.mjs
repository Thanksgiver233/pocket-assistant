/**
 * Loop Adapter (M3) — the only place that turns a plan into tool calls.
 *
 * It does NOT own the agent loop. Pi owns planning and reflection; PIA owns
 * the *authorisation and evidence* around every step. This adapter is the
 * seam: it asks consent, spends budget, calls the tool through the registry,
 * runs the hook chain, writes the journal and the ledger — in that order,
 * for every single action.
 *
 * Invariants enforced here (docs/04 §6; asserted in test/):
 *  I1 every action gets a consent decision before any tool runs;
 *  I2 every decision is in the ledger before the tool result;
 *  I3 a denial stops the run — no "try the next tool instead" fallback;
 *  I4 a confirmation returns control to the user, never auto-approves;
 *  I5 no tool runs without a journal entry and a budget reservation;
 *  I6 hook handlers can veto a call by throwing, and that veto is audited;
 *  I7 the tool you run cannot be more capable than the action you approved:
 *     the action is enriched from the manifest *before* consent, and the
 *     registry verifies the expectation again at invoke time.
 *
 * @module @piagent/personal/runtime/loop-adapter
 */

import { RISK, RISK_RANK, RUN_STATUS, VERDICT } from '../core/contracts.mjs';
import { isPolicyDenial, toPaError } from '../core/errors.mjs';
import { maxDataClassOf } from '../services/risk.mjs';

/**
 * @param {{host: Object, consent: Object, audit: Object, budget: Object, journal: Object,
 *          registry: Object, delivery: Object, clock: Object, profile: Object,
 *          responder?: Object}} deps `responder` answers `assistant.*` actions;
 *          without it those actions fall back to the legacy echo (tests/CLI).
 */
export function createLoopAdapter(deps) {
  const { host, consent, audit, journal, budget, registry, delivery, clock, profile, responder } = deps;
  for (const [name, value] of Object.entries({ host, consent, audit, budget, journal, registry, clock })) {
    if (!value) throw new TypeError(`loop adapter requires ${name}`);
  }

  /**
   * Merge what the action claims with what its declared tools actually do.
   * Consent must judge the union, never the weaker of the two (P0-2).
   * @param {import('../core/contracts.mjs').Action} action
   */
  function enrichAction(action) {
    const dataIn = new Set(action.dataIn ?? []);
    let egress = action.egress === true;
    let risk = action.risk ?? RISK.R0;
    for (const toolId of action.toolIds ?? []) {
      const manifest = registry.get(toolId);
      if (!manifest) continue; // a missing tool is reported later, by executeAction
      for (const cls of manifest.data_in ?? []) dataIn.add(cls);
      if (manifest.egress === true) egress = true;
      if (RISK_RANK[manifest.risk] > RISK_RANK[risk]) risk = manifest.risk;
    }
    return { ...action, dataIn: [...dataIn], egress, risk };
  }

  /**
   * @param {import('../core/contracts.mjs').Turn} turn
   * @param {{actions: import('../core/contracts.mjs').Action[]}} proposal
   * @param {{mode?: string, runId?: string, urgency?: string}} [opts]
   */
  async function execute(turn, proposal, opts = {}) {
    const mode = opts.mode ?? turn.mode;
    const actions = (proposal?.actions ?? []).map(enrichAction);
    if (actions.length === 0) throw new TypeError('proposal has no actions');

    const run = await journal.startRun({
      turnId: turn.id,
      // Journal keeps kinds, never the raw prompt (P1-7).
      intent: actions.map((action) => action.kind).join('+'),
      mode,
      actions
    });

    await host.emitHook('agent_start', { turn, runId: run.run_id, mode });

    await audit.append({
      run_id: run.run_id,
      turn_id: turn.id,
      kind: 'intent',
      channel: turn.channel,
      chars: turn.text.length,
      untrusted: turn.untrusted === true,
      kinds: actions.map((action) => action.kind)
    });

    const context = { mode, connectorDigests: registry.digests?.() ?? {} };
    const steps = [];
    const decisions = [];
    const artifacts = [];

    for (const action of actions) {
      const decision = consent.check(action, context);
      decisions.push({ actionId: action.id, kind: action.kind, ...decision });

      await audit.append({
        run_id: run.run_id,
        turn_id: turn.id,
        kind: 'decision',
        tool: action.toolIds.join(',') || null,
        risk: action.risk,
        data_classes: action.dataIn,
        egress: action.egress,
        decision: {
          verdict: decision.verdict,
          reason: decision.reason,
          grant_id: decision.grantId ?? null,
          requires: decision.requires
        }
      });

      if (decision.verdict === VERDICT.DENY) {
        await journal.appendStep(run.run_id, { actionId: action.id, status: 'denied', decision: decision.reason });
        await journal.checkpoint(run.run_id, { status: RUN_STATUS.DENIED, error: decision.reason });
        await finishHook(turn, run.run_id, RUN_STATUS.DENIED, artifacts);
        return result(run.run_id, RUN_STATUS.DENIED, artifacts, decisions, steps, null, decision);
      }

      if (decision.verdict === VERDICT.CONFIRM) {
        const pending = {
          actionId: action.id,
          risk: action.risk,
          reason: decision.reason,
          requires: decision.requires,
          card: buildCard(action, decision),
          // Full snapshot so a later resume runs exactly what was shown.
          action: snapshotAction(action),
          at: clock.iso()
        };
        await journal.appendStep(run.run_id, { actionId: action.id, status: 'awaiting_approval' });
        await journal.checkpoint(run.run_id, { status: RUN_STATUS.AWAITING_APPROVAL, pending });
        await audit.append({
          run_id: run.run_id,
          turn_id: turn.id,
          kind: 'decision',
          decision: { verdict: 'awaiting_approval', reason: decision.reason, requires: decision.requires }
        });
        return result(run.run_id, RUN_STATUS.AWAITING_APPROVAL, artifacts, decisions, steps, pending, decision);
      }

      const stepResult = await executeAction(run, turn, action, mode);
      steps.push(stepResult.step);
      if (stepResult.artifacts.length > 0) artifacts.push(...stepResult.artifacts);
      if (stepResult.status !== RUN_STATUS.DONE) {
        await journal.checkpoint(run.run_id, {
          status: stepResult.status,
          error: stepResult.error ?? null,
          artifacts: stepResult.artifacts
        });
        await finishHook(turn, run.run_id, stepResult.status, artifacts);
        // `pending` must reach the caller: a budget prompt that only exists in
        // the journal is invisible to whoever has to answer it (SUSPECT-L3).
        return result(
          run.run_id,
          stepResult.status,
          artifacts,
          decisions,
          steps,
          stepResult.pending ?? null,
          stepResult.decision ?? null
        );
      }
      await journal.checkpoint(run.run_id, { artifacts: stepResult.artifacts });
    }

    await journal.checkpoint(run.run_id, { status: RUN_STATUS.DONE });
    await finishHook(turn, run.run_id, RUN_STATUS.DONE, artifacts);

    if (delivery && artifacts.length > 0) {
      // D2 content never goes into the delivery queue: only a summary line.
      const touchesD2 = actions.some((action) => (action.dataIn ?? []).includes('D2'));
      const summary = touchesD2
        ? `已完成 ${artifacts.length} 个动作（含高敏数据，内容不投递；请在本地查看）`
        : artifacts
            .map((artifact) => artifact.text ?? artifact.summary ?? '')
            .filter(Boolean)
            .join('\n');
      if (summary) {
        const delivered = await delivery.deliver(
          { runId: run.run_id, text: summary, artifacts },
          { urgency: opts.urgency ?? 'digest', channel: turn.channel }
        );
        await audit.append({
          run_id: run.run_id,
          turn_id: turn.id,
          kind: 'delivery',
          outcome: { delivered: delivered.delivered, urgency: delivered.urgency, reason: delivered.reason ?? null }
        });
      }
    }

    return result(run.run_id, RUN_STATUS.DONE, artifacts, decisions, steps, null, null);
  }

  /**
   * Execute one action's tools, in order. Stops at the first failure.
   * @param {Object} run
   * @param {import('../core/contracts.mjs').Turn} turn
   * @param {import('../core/contracts.mjs').Action} action
   * @param {string} mode
   * @param {{budgetOverride?: boolean}} [execOpts] a human already approved
   *   this one spend; without the override the same cap would stop the run
   *   again and the approval would be a no-op.
   */
  async function executeAction(run, turn, action, mode, execOpts = {}) {
    /** @type {Object[]} */
    const artifacts = [];
    /** @type {Object[]} */
    const toolResults = [];

    if ((action.toolIds ?? []).length === 0) {
      if (action.risk !== 'R0') {
        const error = { code: 'NO_TOOL_REGISTERED', message: `动作 ${action.kind} 需要一个工具，但没有任何已注册工具` };
        await journal.appendStep(run.run_id, { actionId: action.id, status: 'blocked', error: error.message });
        await audit.append({
          run_id: run.run_id,
          turn_id: turn.id,
          kind: 'tool_result',
          outcome: { status: 'blocked', code: error.code }
        });
        return { step: { actionId: action.id, status: 'blocked', error }, status: RUN_STATUS.BLOCKED, artifacts, error };
      }
      // `assistant.*` actions are answered, not echoed. A responder that is
      // unavailable or errors degrades to the local answer — never to a crash.
      if (responder && typeof responder.reply === 'function' && String(action.kind).startsWith('assistant.')) {
        return answerWithChat(run, turn, action, execOpts);
      }

      const text = `${action.summary}：${turn.text ?? ''}`;
      artifacts.push({ kind: 'text', text, actionId: action.id, dataClass: 'D0' });
      await journal.appendStep(run.run_id, { actionId: action.id, status: 'done', tools: [] });
      return { step: { actionId: action.id, status: 'done', tools: [] }, status: RUN_STATUS.DONE, artifacts };
    }

    for (const toolId of action.toolIds) {
      const manifest = registry.get(toolId);
      if (!manifest) {
        const error = { code: 'TOOL_NOT_FOUND', message: `工具未注册: ${toolId}` };
        await journal.appendStep(run.run_id, { actionId: action.id, status: 'blocked', error: error.message });
        return { step: { actionId: action.id, status: 'blocked', error }, status: RUN_STATUS.BLOCKED, artifacts, error };
      }

      const reservation = await budget.reserve({
        kind: 'passive',
        estimateUsd: manifest.cost_hint?.usd ?? 0,
        estimateTokens: manifest.cost_hint?.tokens ?? 0,
        label: action.kind
      });
      if (!reservation.ok && execOpts.budgetOverride === true) {
        // Approved once, by a human, for this action. Spend is still recorded
        // (settle below) so the day total stays truthful.
        await audit.append({
          run_id: run.run_id,
          turn_id: turn.id,
          kind: 'budget',
          decision: { verdict: 'approved_override', reasons: reservation.reasons }
        });
      }
      if (!reservation.ok && execOpts.budgetOverride !== true) {
        const pending = {
          actionId: action.id,
          risk: action.risk,
          reason: 'budget_requires_approval',
          requires: 'user',
          card: buildBudgetCard(action, manifest, reservation),
          action: snapshotAction(action),
          at: clock.iso()
        };
        await audit.append({
          run_id: run.run_id,
          turn_id: turn.id,
          kind: 'budget',
          decision: { verdict: 'awaiting_approval', reason: 'budget_requires_approval', reasons: reservation.reasons }
        });
        await journal.appendStep(run.run_id, { actionId: action.id, status: 'awaiting_approval', decision: 'budget' });
        await journal.checkpoint(run.run_id, { status: RUN_STATUS.AWAITING_APPROVAL, pending });
        return {
          step: { actionId: action.id, status: 'awaiting_approval', decision: 'budget' },
          status: RUN_STATUS.AWAITING_APPROVAL,
          artifacts,
          pending
        };
      }

      /** @type {boolean} */
      let settled = false;
      const settle = async (actual = {}) => {
        if (settled) return;
        settled = true;
        // A refused reservation has no id; there is nothing to settle.
        if (!reservation.reservationId) return;
        await budget.settle({
          reservationId: reservation.reservationId,
          actualUsd: actual.usd ?? 0,
          actualTokens: actual.tokens ?? 0
        });
      };

      // Hook chain = PIagent guard + our checkers. A throw is a veto.
      try {
        await host.emitHook('tool_call', {
          runId: run.run_id,
          turnId: turn.id,
          actionId: action.id,
          tool: toolId,
          manifest,
          args: { ...action.params, actionKind: action.kind },
          risk: action.risk,
          dataClasses: action.dataIn
        });
      } catch (err) {
        await settle(); // never leak a reservation on a veto (P1-6)
        const paError = toPaError(err);
        await audit.append({
          run_id: run.run_id,
          turn_id: turn.id,
          kind: 'tool_call',
          tool: toolId,
          risk: action.risk,
          decision: { verdict: 'vetoed', code: paError.code }
        });
        await journal.appendStep(run.run_id, { actionId: action.id, status: 'vetoed', error: paError.code });
        return {
          step: { actionId: action.id, status: 'vetoed', error: paError.code },
          status: isPolicyDenial(paError) ? RUN_STATUS.DENIED : RUN_STATUS.BLOCKED,
          artifacts,
          error: paError
        };
      }

      await audit.append({
        run_id: run.run_id,
        turn_id: turn.id,
        kind: 'tool_call',
        tool: toolId,
        risk: action.risk,
        data_classes: action.dataIn,
        egress: action.egress,
        outcome: { status: 'started', degraded: reservation.degraded === true }
      });

      let output;
      try {
        output = await registry.invoke(
          toolId,
          { ...action.params, actionKind: action.kind },
          { runId: run.run_id, turnId: turn.id, actionId: action.id, mode },
          { risk: action.risk, dataIn: action.dataIn, egress: action.egress }
        );
      } catch (err) {
        await settle();
        const paError = toPaError(err);
        await audit.append({
          run_id: run.run_id,
          turn_id: turn.id,
          kind: 'tool_result',
          tool: toolId,
          outcome: { status: 'error', code: paError.code, message: paError.message }
        });
        await journal.appendStep(run.run_id, { actionId: action.id, status: 'failed', error: paError.code });
        await host.emitHook('tool_result', { runId: run.run_id, tool: toolId, ok: false, error: paError.code });
        return {
          step: { actionId: action.id, status: 'failed', error: paError.code },
          status: RUN_STATUS.FAILED,
          artifacts,
          error: paError
        };
      }

      await settle({ usd: output.cost?.usd ?? 0, tokens: output.cost?.tokens ?? 0 });
      await host.emitHook('tool_result', { runId: run.run_id, tool: toolId, ok: true, output });
      await audit.append({
        run_id: run.run_id,
        turn_id: turn.id,
        kind: 'tool_result',
        tool: toolId,
        outcome: { status: 'ok', summary: summariseOutput(output) },
        cost: output.cost ?? null
      });

      toolResults.push({ toolId, output, undoableUntil: output.undoableUntil ?? null });
      if (output.artifact) {
        // Stamp the artifact with the data class of the action that produced
        // it. Downstream (delivery, HTTP projection, UI) can then decide how
        // to treat it without re-deriving from decisions that a resumed run
        // no longer carries.
        artifacts.push({
          ...output.artifact,
          actionId: action.id,
          toolId,
          dataClass: maxDataClassOf(action.dataIn ?? [])
        });
      }
    }

    await journal.appendStep(run.run_id, {
      actionId: action.id,
      status: 'done',
      tools: action.toolIds,
      results: toolResults.map((entry) => ({ toolId: entry.toolId, summary: summariseOutput(entry.output) }))
    });
    return { step: { actionId: action.id, status: 'done', tools: action.toolIds }, status: RUN_STATUS.DONE, artifacts };
  }

  /**
   * Answer an `assistant.*` action through the chat responder.
   *
   * Chat costs money when a model is configured, so it reserves budget like
   * any tool call — "花费可见" is a product claim, and a free-looking chat that
   * silently burns tokens would make the daily budget a lie.
   *
   * @param {Object} run
   * @param {import('../core/contracts.mjs').Turn} turn
   * @param {import('../core/contracts.mjs').Action} action
   * @param {{budgetOverride?: boolean, history?: Object[]}} execOpts
   */
  async function answerWithChat(run, turn, action, execOpts) {
    const estimate = Number(responder.estimateUsd ?? 0);
    let reservation = null;

    if (estimate > 0) {
      reservation = await budget.reserve({ kind: 'passive', estimateUsd: estimate, label: action.kind });
      if (!reservation.ok && execOpts.budgetOverride !== true) {
        const pending = {
          actionId: action.id,
          risk: action.risk,
          reason: 'budget_requires_approval',
          requires: 'user',
          card: buildBudgetCard(action, { cost_hint: { usd: estimate } }, reservation),
          action: snapshotAction(action),
          at: clock.iso()
        };
        await audit.append({
          run_id: run.run_id,
          turn_id: turn.id,
          kind: 'budget',
          decision: { verdict: 'awaiting_approval', reason: 'budget_requires_approval', reasons: reservation.reasons }
        });
        await journal.appendStep(run.run_id, { actionId: action.id, status: 'awaiting_approval', decision: 'budget' });
        await journal.checkpoint(run.run_id, { status: RUN_STATUS.AWAITING_APPROVAL, pending });
        return {
          step: { actionId: action.id, status: 'awaiting_approval', decision: 'budget' },
          status: RUN_STATUS.AWAITING_APPROVAL,
          artifacts: [],
          pending
        };
      }
    }

    let answer;
    try {
      answer = await responder.reply({
        text: turn.text ?? '',
        kind: action.kind,
        history: execOpts.history ?? [],
        context: { runId: run.run_id, mode: turn.mode }
      });
    } catch (err) {
      if (reservation?.reservationId) {
        await budget.settle({ reservationId: reservation.reservationId, actualUsd: 0, actualTokens: 0 });
      }
      const paError = toPaError(err);
      await audit.append({
        run_id: run.run_id,
        turn_id: turn.id,
        kind: 'tool_result',
        outcome: { status: 'error', code: paError.code }
      });
      await journal.appendStep(run.run_id, { actionId: action.id, status: 'failed', error: paError.code });
      return { step: { actionId: action.id, status: 'failed', error: paError.code }, status: RUN_STATUS.FAILED, artifacts: [], error: paError };
    }

    if (reservation?.reservationId) {
      await budget.settle({
        reservationId: reservation.reservationId,
        actualUsd: answer.usd ?? 0,
        actualTokens: answer.tokens ?? 0
      });
    }

    const artifact = {
      kind: 'text',
      text: answer.text,
      actionId: action.id,
      dataClass: 'D0',
      source: answer.source
    };
    await audit.append({
      run_id: run.run_id,
      turn_id: turn.id,
      kind: 'tool_result',
      outcome: {
        status: 'ok',
        kind: 'chat',
        source: answer.source,
        chars: answer.text.length,
        degraded: answer.degraded ?? null
      },
      cost: answer.usd ? { usd: answer.usd, tokens: answer.tokens } : null
    });
    await journal.appendStep(run.run_id, {
      actionId: action.id,
      status: 'done',
      tools: [],
      results: [{ toolId: 'assistant', summary: `${answer.source} · ${answer.text.length} 字` }]
    });
    return {
      step: { actionId: action.id, status: 'done', tools: [] },
      status: RUN_STATUS.DONE,
      artifacts: [artifact]
    };
  }

  /**
   * Resume an interrupted run.
   * @param {string} runId
   * @param {{approve?: boolean, identity?: boolean}} [opts] `identity` must be
   *   true for actions whose decision required an identity check (R3).
   */
  async function resume(runId, opts = {}) {
    const run = await journal.load(runId);
    if (run.status !== RUN_STATUS.AWAITING_APPROVAL || !run.pending) {
      throw new TypeError(`run ${runId} is not awaiting approval (status=${run.status})`);
    }
    const pending = run.pending;

    if (opts.approve !== true) {
      await audit.append({
        run_id: runId,
        turn_id: run.turn_id,
        kind: 'decision',
        decision: { verdict: VERDICT.DENY, reason: 'user_rejected', action_id: pending.actionId }
      });
      await journal.checkpoint(runId, { status: RUN_STATUS.DENIED, pending: null, error: 'user_rejected' });
      return result(runId, RUN_STATUS.DENIED, [], [], [], null, { verdict: VERDICT.DENY, reason: 'user_rejected' });
    }

    if (pending.requires === 'identity' && opts.identity !== true) {
      // R3 cannot be approved with a plain "yes": keep waiting.
      await audit.append({
        run_id: runId,
        turn_id: run.turn_id,
        kind: 'decision',
        decision: { verdict: 'identity_required', action_id: pending.actionId }
      });
      return result(runId, RUN_STATUS.AWAITING_APPROVAL, [], [], [], pending, {
        verdict: VERDICT.CONFIRM,
        reason: 'identity_required',
        requires: 'identity'
      });
    }

    const action = pending.action ?? rebuildFromCard(pending);
    const recheck = consent.check(action, { mode: run.mode, connectorDigests: registry.digests?.() ?? {} });
    if (recheck.verdict === VERDICT.DENY) {
      await audit.append({
        run_id: runId,
        turn_id: run.turn_id,
        kind: 'decision',
        decision: { verdict: VERDICT.DENY, reason: `resume_${recheck.reason}`, action_id: action.id }
      });
      await journal.checkpoint(runId, { status: RUN_STATUS.DENIED, pending: null, error: `resume_${recheck.reason}` });
      return result(runId, RUN_STATUS.DENIED, [], [], [], null, recheck);
    }

    await audit.append({
      run_id: runId,
      turn_id: run.turn_id,
      kind: 'decision',
      decision: {
        verdict: 'user_confirmed',
        reason: pending.reason,
        action_id: action.id,
        identity_checked: pending.requires === 'identity' ? opts.identity === true : null
      }
    });
    await journal.checkpoint(runId, { status: RUN_STATUS.RUNNING, pending: null });

    const confirmedTurn = {
      id: run.turn_id,
      channel: 'system',
      text: '(confirmed)',
      at: clock.iso(),
      mode: run.mode
    };
    const stepResult = await executeAction(run, confirmedTurn, action, run.mode, {
      budgetOverride: pending.reason === 'budget_requires_approval'
    });
    const finalStatus = stepResult.status === RUN_STATUS.DONE ? RUN_STATUS.DONE : stepResult.status;
    await journal.checkpoint(runId, { status: finalStatus, artifacts: stepResult.artifacts ?? [], error: stepResult.error ?? null });
    await finishHook(confirmedTurn, runId, finalStatus, stepResult.artifacts ?? []);
    return result(runId, finalStatus, stepResult.artifacts ?? [], [], [stepResult.step], null, null);
  }

  async function finishHook(turn, runId, status, artifacts) {
    try {
      await host.emitHook('completion', { turn, runId, status, artifactCount: artifacts.length });
    } catch {
      // A completion hook must never turn a finished run into a failure.
    }
  }

  return { execute, resume };
}

/**
 * @param {string} runId
 * @param {string} status
 */
function result(runId, status, artifacts, decisions, steps, pending, decision) {
  return { runId, status, artifacts, decisions, steps, pending, decision };
}

/**
 * Freeze exactly what the user is about to approve.
 * @param {import('../core/contracts.mjs').Action} action
 */
function snapshotAction(action) {
  return {
    id: action.id,
    kind: action.kind,
    toolIds: [...(action.toolIds ?? [])],
    risk: action.risk,
    dataIn: [...(action.dataIn ?? [])],
    egress: action.egress === true,
    reversible: action.reversible !== false,
    summary: action.summary,
    params: { ...(action.params ?? {}) },
    origin: action.origin ?? 'user'
  };
}

/**
 * @param {Object} pending
 * @returns {import('../core/contracts.mjs').Action}
 */
function rebuildFromCard(pending) {
  const card = pending.card ?? {};
  return {
    id: pending.actionId,
    kind: card.kind ?? 'unknown',
    toolIds: card.toolIds ?? [],
    risk: card.risk ?? pending.risk,
    dataIn: card.dataIn ?? [],
    egress: card.egress === true,
    reversible: card.reversible !== false,
    summary: card.summary ?? '',
    params: card.params ?? {},
    origin: card.origin ?? 'user'
  };
}

/**
 * The confirmation card is a product surface, not a log line.
 * @param {import('../core/contracts.mjs').Action} action
 * @param {import('../core/contracts.mjs').Decision} decision
 */
export function buildCard(action, decision) {
  return {
    // `cardType` says what kind of prompt this is; `kind` says which action
    // it is about. Conflating the two made a budget prompt indistinguishable
    // from an action prompt (P1-2).
    cardType: 'action',
    actionId: action.id,
    kind: action.kind,
    title: action.summary,
    risk: action.risk,
    reason: decision.reason,
    detail: decision.detail,
    requires: decision.requires,
    dataIn: action.dataIn,
    egress: action.egress,
    reversible: action.reversible,
    origin: action.origin ?? 'user',
    undoWindowSeconds: action.reversible ? 60 : 0,
    toolIds: action.toolIds,
    params: action.params ?? {},
    options: ['approve', 'reject']
  };
}

/**
 * Budget cards must carry the action too, otherwise approving the budget
 * cannot actually run anything (P1-2).
 * @param {import('../core/contracts.mjs').Action} action
 * @param {Object} manifest
 * @param {Object} reservation
 */
function buildBudgetCard(action, manifest, reservation) {
  return {
    cardType: 'budget',
    actionId: action.id,
    kind: action.kind,
    title: `本次调用超出预算（${(reservation.reasons ?? []).join(', ')}）`,
    risk: action.risk,
    requires: 'user',
    dataIn: action.dataIn,
    egress: action.egress,
    toolIds: action.toolIds,
    params: action.params ?? {},
    reasons: reservation.reasons ?? [],
    remainingUsd: reservation.remainingUsd,
    estimatedUsd: manifest?.cost_hint?.usd ?? 0,
    options: ['approve', 'reject']
  };
}

/** @param {Object} output */
function summariseOutput(output) {
  if (!output) return null;
  if (typeof output.summary === 'string') return output.summary.slice(0, 200);
  if (output.items && Array.isArray(output.items)) return `${output.items.length} 条结果`;
  return null;
}
