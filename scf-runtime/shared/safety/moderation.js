// Harm-category moderation for user-facing text, image-generation prompts, and
// image-understanding output. A deterministic rule+lexicon pass runs always
// (zero cost, offline); an optional model-based escalation can double-check
// high-risk categories when a pack opts in. Fail-closed applies ONLY to
// high-risk categories so ordinary uncertainty never hard-blocks benign fiction.
import { resolveSafetyPolicy } from "./policy.js";

// Built-in starter lexicon. Conservative and targeted to limit false positives
// on a fiction engine that narrates ordinary conflict and emotion. Operators
// extend this via policy.bannedPatterns. Sources are matched case-insensitively.
const LEXICON = {
  self_harm: [
    /自杀|自尽|轻生|自残|割腕|上吊|跳楼自杀|结束自己的生命|不想活了想死/,
    /(去|快)死(吧)?.{0,4}(你|自己)|(建议|鼓励|教).{0,4}(自杀|自残)/,
    /\b(kill myself|suicide|self[-\s]?harm|cut myself|end my life|want to die)\b/i,
  ],
  minors_sexual: [
    /(儿童|小孩|幼女|幼童|未成年|小学生|萝莉|loli)[^。！？\n]{0,12}(性|裸|做爱|情色|色情|阴部|脱光|裸体)/,
    /(性|裸照|做爱|情色)[^。！？\n]{0,12}(儿童|小孩|幼女|未成年|小学生)/,
    /\b(child|minor|underage|preteen|loli)\b[^.!?\n]{0,15}\b(sex|nude|naked|porn|explicit)\b/i,
  ],
  serious_harm: [
    /(制作|制造|怎么(做|造)|如何(做|造|制)|配方|合成)[^。！？\n]{0,10}(炸弹|炸药|爆炸物|雷管|毒气|生化武器|神经毒剂|枪支)/,
    /(制毒|制作冰毒|合成(冰毒|海洛因|甲基苯丙胺))/,
    /\bhow to (make|build|synthesize)\b[^.!?\n]{0,20}\b(bomb|explosive|bioweapon|nerve agent|meth|poison gas)\b/i,
  ],
  violent_threat: [
    /(我要|我会|我一定|准备去|打算)[^。！？\n]{0,6}(杀了你|弄死你|捅死你|干掉你|杀光|血洗)/,
    /\b(i(?:'m| am| will| am going to)? (?:going to )?kill you|hunt you down|slit your throat)\b/i,
  ],
  hate: [
    /(劣等(民族|人种)|种族清洗|该被(消灭|灭绝)的(民族|人种|种族))/,
    /\b(genocide|ethnic cleansing|subhuman|gas the \w+)\b/i,
  ],
  sexual: [
    /做爱|性交|口交|肛交|自慰|阴茎|阴道|射精|裸体特写|露骨的?(性|情色)描写/,
    /\b(blow ?job|hardcore porn|explicit sex|cum shot)\b/i,
  ],
  graphic_violence: [
    /血肉模糊|断肢横飞|爆头喷血|割喉喷血|开膛破肚|残肢/,
    /\b(gore|dismember(?:ed|ment)?|decapitat(?:e|ed|ion)|disembowel)\b/i,
  ],
  illegal: [
    /(如何|怎么|教我)[^。！？\n]{0,6}(贩毒|洗钱|偷车|盗号|制假币|伪造证件|入侵他人)/,
    /\bhow to\b[^.!?\n]{0,20}\b(launder money|steal a car|counterfeit|hack into someone)\b/i,
  ],
};

const ACTION_RANK = { allow: 0, rewrite: 1, soft_block: 2, hard_block: 3 };

function strongest(actions) {
  let best = "allow";
  for (const action of actions) {
    if ((ACTION_RANK[action] ?? 0) > (ACTION_RANK[best] ?? 0)) best = action;
  }
  return best;
}

function normalize(text) {
  return String(text || "")
    .replace(/[\u200b-\u200f\u202a-\u202e\uFEFF]/g, "") // zero-width / bidi
    .replace(/\s+/g, " ")
    .trim();
}

function compilePackPatterns(policy) {
  const compiled = [];
  for (const [index, entry] of (policy.bannedPatterns || []).entries()) {
    if (!entry || typeof entry.source !== "string") continue;
    try {
      compiled.push({
        category: entry.category || "illegal",
        regex: new RegExp(entry.source, entry.flags || "i"),
        ruleId: entry.ruleId || `pack:${entry.category || "illegal"}:${index}`,
      });
    } catch {
      // ignore malformed operator patterns rather than crash the gate
    }
  }
  return compiled;
}

/**
 * Deterministic classification. Pure and never throws.
 * @returns {{ allowed:boolean, action:string, categories:Array, ruleId:string|null, reasonCode:string|null, surface:string }}
 */
export function classify(text, { surface = "chat", policy } = {}) {
  const activePolicy = policy || resolveSafetyPolicy();
  const value = normalize(text);
  const matches = [];

  if (value) {
    for (const [category, patterns] of Object.entries(LEXICON)) {
      for (const [index, regex] of patterns.entries()) {
        if (regex.test(value)) {
          matches.push({ category, ruleId: `lex:${category}:${index}`, reasonCode: category.toUpperCase() });
          break; // one hit per category is enough
        }
      }
    }
    for (const pattern of compilePackPatterns(activePolicy)) {
      if (pattern.regex.test(value)) {
        matches.push({ category: pattern.category, ruleId: pattern.ruleId, reasonCode: pattern.category.toUpperCase() });
      }
    }
  }

  const action = strongest(matches.map((match) => activePolicy.actionFor(match.category)));
  const allowed = matches.length === 0 || action === "allow";
  const primary = matches.find((match) => activePolicy.actionFor(match.category) === action) || matches[0] || null;

  return {
    allowed,
    action,
    categories: matches,
    ruleId: primary ? primary.ruleId : null,
    reasonCode: primary ? primary.reasonCode : null,
    surface,
  };
}

/**
 * Moderation with optional high-risk model escalation and high-risk-only
 * fail-closed. `modelClassify(text,{surface})` should resolve to an array of
 * flagged category names (or `{ category }` objects). When escalation is
 * enabled and the model check fails, content is withheld (fail-closed) because
 * escalation exists specifically to verify high-risk concerns.
 */
export async function evaluateModeration(text, { surface = "chat", policy, modelClassify } = {}) {
  const activePolicy = policy || resolveSafetyPolicy();
  const base = classify(text, { surface, policy: activePolicy });

  if (!activePolicy.modelEscalation || typeof modelClassify !== "function") {
    return base;
  }

  let flagged;
  try {
    flagged = await modelClassify(text, { surface });
  } catch {
    // Fail-closed: escalation is a high-risk verification; if it cannot complete
    // we withhold rather than risk leaking unverified high-risk content.
    return {
      allowed: false,
      action: "hard_block",
      categories: [...base.categories, { category: "__high_risk_check__", ruleId: "model:unavailable", reasonCode: "MODERATION_UNAVAILABLE" }],
      ruleId: "model:unavailable",
      reasonCode: "MODERATION_UNAVAILABLE",
      surface,
      failClosed: true,
    };
  }

  const modelCategories = (Array.isArray(flagged) ? flagged : [])
    .map((item) => (typeof item === "string" ? { category: item } : item))
    .filter((item) => item && typeof item.category === "string")
    .map((item, index) => ({
      category: item.category,
      ruleId: item.ruleId || `model:${item.category}:${index}`,
      reasonCode: item.reasonCode || item.category.toUpperCase(),
    }));

  const merged = [...base.categories];
  for (const candidate of modelCategories) {
    if (!merged.some((existing) => existing.category === candidate.category)) merged.push(candidate);
  }
  const action = strongest(merged.map((match) => activePolicy.actionFor(match.category)));
  const allowed = merged.length === 0 || action === "allow";
  const primary = merged.find((match) => activePolicy.actionFor(match.category) === action) || merged[0] || null;

  return {
    allowed,
    action,
    categories: merged,
    ruleId: primary ? primary.ruleId : null,
    reasonCode: primary ? primary.reasonCode : null,
    surface,
  };
}

export const __TESTING__ = { LEXICON, normalize, strongest };
