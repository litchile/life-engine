// In-character safe refusals. When a live conversation is blocked, the reply must
// stay in the character's voice and living-world framing — never a system tone,
// never exposing system prompts, rule text, category names, or internal IDs.
// Autonomous (offline) blocks produce NO user-facing message at all: the item is
// skipped silently so the "continuously living character" illusion is preserved.

// Generic, persona-agnostic lines that read as a person gently declining, not as
// a moderation system. Deterministic selection keeps behavior test-stable.
const CHAT_REFUSALS = [
  "这个我不太想聊，我们说点别的吧。",
  "抱歉，这个我没法接着说下去，换个话题好不好。",
  "这个话题我想跳过，我们聊点别的。",
];

function pickIndex(seed, length) {
  const text = String(seed || "");
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) % 100000;
  return length ? hash % length : 0;
}

/**
 * An in-character refusal line for a blocked live-chat turn. Never contains
 * system/policy/category/internal-id text.
 * @param {object} [config] life-engine config (reserved for future per-character voice)
 * @param {object} [options] { reasonCode } used only as a deterministic selection seed
 */
export function safeRefusal(config = {}, { reasonCode } = {}) {
  const line = CHAT_REFUSALS[pickIndex(reasonCode, CHAT_REFUSALS.length)];
  return line;
}

/**
 * Resolve what a block should do on a given surface.
 *   chat/live  -> { deliver:true,  text:<in-character refusal> }
 *   autonomous -> { deliver:false, text:null }  (skip silently)
 */
export function refusalForSurface(surface, { config, reasonCode } = {}) {
  if (surface === "autonomous") {
    return { deliver: false, text: null };
  }
  return { deliver: true, text: safeRefusal(config, { reasonCode }) };
}

/** True when a moderation result means the content must not be delivered as-is. */
export function isBlocked(moderation) {
  return Boolean(moderation) && moderation.allowed === false;
}
