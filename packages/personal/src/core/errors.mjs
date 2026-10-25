/**
 * Typed errors. Every failure in PIA has a stable machine code so that
 * `pa-doctor`, the audit ledger and tests can assert on it instead of on
 * English strings.
 * @module @piagent/personal/core/errors
 */

export class PaError extends Error {
  /**
   * @param {string} code stable machine code, e.g. 'PROFILE_INVALID'
   * @param {string} message human readable
   * @param {{cause?: unknown, details?: Object}} [opts]
   */
  constructor(code, message, opts = {}) {
    super(message, opts.cause ? { cause: opts.cause } : undefined);
    this.name = 'PaError';
    this.code = code;
    this.details = opts.details ?? {};
    /** Fail-closed by default: unknown errors are treated as blocking. */
    this.failClosed = true;
  }
}

export class ConfigError extends PaError {
  constructor(message, opts) {
    super('CONFIG_INVALID', message, opts);
    this.name = 'ConfigError';
  }
}

export class ValidationError extends PaError {
  /**
   * @param {string} message
   * @param {{path?: string, details?: Object}} [opts]
   */
  constructor(message, opts = {}) {
    super('VALIDATION_FAILED', message, opts);
    this.name = 'ValidationError';
    this.path = opts.path ?? '';
  }
}

export class PolicyError extends PaError {
  constructor(code, message, details = {}) {
    super(code, message, { details });
    this.name = 'PolicyError';
  }
}

export class BudgetError extends PaError {
  constructor(message, details = {}) {
    super('BUDGET_EXCEEDED', message, { details });
    this.name = 'BudgetError';
  }
}

export class ResumeError extends PaError {
  constructor(message, details = {}) {
    super('RESUME_FAILED', message, { details });
    this.name = 'ResumeError';
  }
}

export class ConnectorError extends PaError {
  constructor(message, details = {}) {
    super('CONNECTOR_UNAVAILABLE', message, { details });
    this.name = 'ConnectorError';
  }
}

/**
 * Normalise any thrown value into a PaError. Unknown errors become
 * `INTERNAL_ERROR` and stay fail-closed.
 * @param {unknown} err
 * @returns {PaError}
 */
export function toPaError(err) {
  if (err instanceof PaError) return err;
  const message = err instanceof Error ? err.message : String(err);
  const wrapped = new PaError('INTERNAL_ERROR', message, { cause: err });
  return wrapped;
}

/** True when an error is an explicit policy denial (as opposed to a bug). */
export function isPolicyDenial(err) {
  return (
    err instanceof PaError &&
    (err.code === 'POLICY_DENIED' || err.code === 'CONSENT_REQUIRED' || err.code === 'DATA_CLASS_BLOCKED')
  );
}
