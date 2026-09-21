// Auditable, layer-typed safety decision records. Every safety decision is
// recorded with policyVersion/ruleId/decision/reasonCode (+ surface, category)
// so a later policy change can be reconciled against past decisions, and typed
// by layer so operators can tell input vs output vs action vs rate-limit apart.

// Layer-typed decision kinds (spec: "Layers are distinguishable in telemetry").
export const DECISION_TYPES = Object.freeze({
  INPUT_BLOCKED: "input_blocked",
  OUTPUT_BLOCKED: "output_blocked",
  ACTION_DENIED: "action_denied",
  RATE_LIMITED: "rate_limited",
});

const DECISION_TYPE_VALUES = new Set(Object.values(DECISION_TYPES));

/**
 * Build a normalized, auditable safety record. `type` MUST be one of DECISION_TYPES.
 */
export function buildSafetyRecord({
  type,
  policyVersion,
  ruleId = null,
  decision,
  reasonCode = null,
  surface = null,
  category = null,
  detail = null,
  recordedAt = null,
} = {}) {
  if (!DECISION_TYPE_VALUES.has(type)) {
    throw new Error(`Unknown safety decision type: ${type}`);
  }
  return {
    schema_version: 1,
    type,
    policyVersion: String(policyVersion || "unknown"),
    ruleId: ruleId || null,
    decision: decision || null,
    reasonCode: reasonCode || null,
    surface: surface || null,
    category: category || null,
    ...(detail ? { detail } : {}),
    recorded_at: recordedAt || new Date().toISOString(),
  };
}

function randomId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Persist a safety record under diagnostics/safety/<date>/<id>.json. Best-effort:
 * a storage failure must never break the safety decision itself.
 * @returns the record that was written (or attempted)
 */
export async function recordSafetyDecision(store, record, { id } = {}) {
  const date = String(record?.recorded_at || new Date().toISOString()).slice(0, 10);
  const key = `diagnostics/safety/${date}/${id || randomId()}.json`;
  if (store && typeof store.putJson === "function") {
    try {
      await store.putJson(key, record);
    } catch {
      // best-effort: observability must not block enforcement
    }
  }
  return record;
}
