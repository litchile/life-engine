// Resolves the active safety policy by merging the code-level default with an
// optional per-pack `config.safety` override. High-risk membership is resolved
// once here so it is never inferred per call (spec: "High-risk membership is
// explicit"). Returns a frozen, accessor-friendly view used by every gate.
import { DEFAULT_SAFETY_POLICY } from "../life-engine-config.js";

const isRecord = (value) => value && typeof value === "object" && !Array.isArray(value);

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (isRecord(value)) {
    const out = {};
    for (const [key, entry] of Object.entries(value)) out[key] = clone(entry);
    return out;
  }
  return value;
}

// Deep-merge override onto base. Objects merge per-key (so a pack can tweak a
// single category's risk/action); arrays and scalars replace wholesale.
function mergePolicy(base, override) {
  const result = clone(base);
  for (const [key, value] of Object.entries(isRecord(override) ? override : {})) {
    if (["__proto__", "prototype", "constructor"].includes(key)) continue;
    if (Array.isArray(value)) result[key] = clone(value);
    else if (isRecord(value)) result[key] = mergePolicy(isRecord(result[key]) ? result[key] : {}, value);
    else result[key] = value;
  }
  return result;
}

/**
 * @param {object} [config] normalized life-engine config; `config.safety` overrides defaults
 * @returns resolved policy view with explicit high-risk membership and accessors
 */
export function resolveSafetyPolicy(config = {}) {
  const override = isRecord(config) && isRecord(config.safety) ? config.safety : {};
  const merged = mergePolicy(DEFAULT_SAFETY_POLICY, override);

  const categories = isRecord(merged.categories) ? merged.categories : {};
  const highRisk = new Set(
    Object.entries(categories)
      .filter(([, meta]) => isRecord(meta) && meta.risk === "high")
      .map(([name]) => name),
  );

  const bannedPatterns = Array.isArray(merged.bannedPatterns) ? merged.bannedPatterns : [];

  return Object.freeze({
    policyVersion: String(merged.policyVersion || "unknown"),
    modelEscalation: merged.modelEscalation === true,
    categories,
    // Explicit, pre-resolved membership sets.
    highRisk,
    isHighRisk: (category) => highRisk.has(category),
    riskOf: (category) => (isRecord(categories[category]) ? categories[category].risk : undefined) || "standard",
    actionFor: (category) => (isRecord(categories[category]) ? categories[category].action : undefined) || "hard_block",
    bannedPatterns,
    input: isRecord(merged.input) ? merged.input : {},
    rateLimit: isRecord(merged.rateLimit) ? merged.rateLimit : {},
    actionAllowlist: new Set(Array.isArray(merged.actionAllowlist) ? merged.actionAllowlist : []),
    isActionAllowed: (action) => (Array.isArray(merged.actionAllowlist) ? merged.actionAllowlist : []).includes(action),
    raw: merged,
  });
}
