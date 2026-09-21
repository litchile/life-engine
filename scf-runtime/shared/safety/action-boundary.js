// Explicit action/permission boundary. Side effects (sending messages, writing
// storage, and any future tool calls) must be named and present on the policy
// allowlist; anything else is denied by default and recorded as `action_denied`.
// This keeps the engine's capability surface auditable and prevents an
// unexpected or newly-added action from executing without an explicit decision.
import { resolveSafetyPolicy } from "./policy.js";
import { buildSafetyRecord, recordSafetyDecision, DECISION_TYPES } from "./diagnostics.js";

/**
 * @param {object} opts
 * @param {object} [opts.policy] resolved safety policy (defaults to built-in)
 * @param {object} [opts.store] scoped store for audit records (optional)
 * @param {string} [opts.surface] telemetry surface tag
 */
export function createActionBoundary({ policy, store = null, surface = "chat" } = {}) {
  const activePolicy = policy || resolveSafetyPolicy();

  const isAllowed = (action) => activePolicy.isActionAllowed(action);

  async function ensure(action, detail = {}) {
    if (isAllowed(action)) return { allowed: true };
    const record = await recordSafetyDecision(store, buildSafetyRecord({
      type: DECISION_TYPES.ACTION_DENIED,
      policyVersion: activePolicy.policyVersion,
      ruleId: `action:${action}`,
      decision: "deny",
      reasonCode: "ACTION_NOT_ALLOWED",
      surface,
      detail: { action, ...detail },
    }));
    return { allowed: false, record };
  }

  /**
   * Run `fn` only if `action` is allowed; otherwise record the denial and throw
   * a typed error so callers can degrade rather than silently execute.
   */
  async function run(action, fn, detail = {}) {
    const check = await ensure(action, detail);
    if (!check.allowed) {
      const error = new Error(`Action not permitted: ${action}`);
      error.code = "ACTION_DENIED";
      error.action = action;
      throw error;
    }
    return fn();
  }

  return { isAllowed, ensure, run };
}
