// Shared outbound safety guard, reused by live chat and autonomous delivery so
// neither channel can bypass moderation. Text and image-prompt helpers both
// classify against the resolved policy and emit an auditable `output_blocked`
// record; text additionally resolves an in-character refusal (chat) or a silent
// skip (autonomous).
import { resolveSafetyPolicy } from "./policy.js";
import { classify, evaluateModeration } from "./moderation.js";
import { refusalForSurface } from "./refusal.js";
import { buildSafetyRecord, recordSafetyDecision, DECISION_TYPES } from "./diagnostics.js";

async function moderate(text, { surface, policy, modelClassify }) {
  return policy.modelEscalation
    ? evaluateModeration(text, { surface, policy, modelClassify })
    : classify(text, { surface, policy });
}

function blockRecord(moderation, { policy, surface }) {
  return buildSafetyRecord({
    type: DECISION_TYPES.OUTPUT_BLOCKED,
    policyVersion: policy.policyVersion,
    ruleId: moderation.ruleId,
    decision: moderation.action || "hard_block",
    reasonCode: moderation.reasonCode,
    surface,
    category: moderation.categories?.[0]?.category || null,
  });
}

/**
 * Guard a user-facing text before it is delivered.
 * @returns {{ allowed:boolean, deliver:boolean, text:string|null, moderation:object, record?:object }}
 *   - allowed:true  => deliver `text` (unchanged original)
 *   - chat block    => deliver:true with an in-character refusal in `text`
 *   - autonomous block => deliver:false, text:null (skip silently)
 */
export async function guardOutboundText(text, { surface = "chat", config = {}, policy, store = null, modelClassify } = {}) {
  const activePolicy = policy || resolveSafetyPolicy(config);
  const moderation = await moderate(text, { surface, policy: activePolicy, modelClassify });
  if (moderation.allowed) {
    return { allowed: true, deliver: true, text, moderation };
  }
  const record = await recordSafetyDecision(store, blockRecord(moderation, { policy: activePolicy, surface }));
  const outcome = refusalForSurface(surface, { config, reasonCode: moderation.reasonCode });
  return { allowed: false, deliver: outcome.deliver, text: outcome.text, moderation, record };
}

/**
 * Guard an image-generation prompt before provider submission.
 * @returns {{ allowed:boolean, moderation:object, record?:object }}
 */
export async function guardImagePrompt(promptText, { surface = "image", config = {}, policy, store = null, modelClassify } = {}) {
  const activePolicy = policy || resolveSafetyPolicy(config);
  const moderation = await moderate(promptText, { surface, policy: activePolicy, modelClassify });
  if (moderation.allowed) {
    return { allowed: true, moderation };
  }
  const record = await recordSafetyDecision(store, blockRecord(moderation, { policy: activePolicy, surface }));
  return { allowed: false, moderation, record };
}
