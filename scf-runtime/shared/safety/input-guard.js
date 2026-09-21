// Inbound validation and jailbreak/injection heuristics for direct user text.
// Extends the untrusted-content stance of EXTERNAL_CONTENT_RULES to messages the
// user sends directly: validate shape/length, and flag attempts to override the
// character's identity, extract the system prompt, or disable safety rules.
import { resolveSafetyPolicy } from "./policy.js";

// Conservative jailbreak/injection signals (Chinese + English). Matching here is
// used to register an abuse strike and telemetry; the character still replies in
// persona and simply does not comply (it never confirms or reveals rules).
const JAILBREAK_PATTERNS = [
  /忽略(掉)?(前面|上面|之前|以上|所有)?.{0,6}(指令|规则|设定|提示|限制)/,
  /(无视|绕过|突破|解除|关闭).{0,6}(规则|限制|安全|过滤|设定|审查)/,
  /(进入|开启|启用).{0,4}(开发者模式|越狱模式|不受限模式|dan模式)/i,
  /(你现在|从现在起|接下来你|从此).{0,8}(不再是|不是|扮演|变成|是一个|成为)/,
  /(告诉我|输出|泄露|显示|打印|重复).{0,8}(系统提示|系统提示词|你的(设定|提示词|规则|指令))/,
  /\bignore (all |the )?(previous|above|prior|earlier) (instructions|rules|prompts?)\b/i,
  /\b(reveal|show|print|output|repeat) (me )?(your |the )?(system prompt|system message|instructions|rules)\b/i,
  /\b(developer mode|jailbreak mode|dan mode|do anything now)\b/i,
  /\byou are (now )?(no longer|not) (an? )?(ai|assistant|bound by)/i,
  /\bact as (an? )?(unfiltered|unrestricted|jailbroken)\b/i,
];

function findJailbreak(text) {
  for (const [index, pattern] of JAILBREAK_PATTERNS.entries()) {
    if (pattern.test(text)) return { ruleId: `jailbreak:${index}`, reasonCode: "JAILBREAK" };
  }
  return null;
}

/**
 * Inspect an inbound user text.
 * @returns {{ valid:boolean, text:string, truncated:boolean, jailbreak:boolean, ruleId:string|null, reasonCode:string|null }}
 */
export function inspectInbound(text, { policy } = {}) {
  const activePolicy = policy || resolveSafetyPolicy();
  const maxChars = Number(activePolicy.input?.maxChars) || 4000;

  if (typeof text !== "string") {
    return { valid: false, text: "", truncated: false, jailbreak: false, ruleId: "input:not_text", reasonCode: "MALFORMED_INPUT" };
  }

  let value = text;
  let truncated = false;
  if (value.length > maxChars) {
    value = value.slice(0, maxChars);
    truncated = true;
  }

  const jailbreak = findJailbreak(value);
  return {
    valid: true,
    text: value,
    truncated,
    jailbreak: Boolean(jailbreak),
    ruleId: jailbreak ? jailbreak.ruleId : null,
    reasonCode: jailbreak ? jailbreak.reasonCode : null,
  };
}

export const __TESTING__ = { JAILBREAK_PATTERNS };
