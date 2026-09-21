import { DEFAULT_LIFE_ENGINE_CONFIG } from "./life-engine-config.js";

const CONSTITUTION_VERSION = "phase1-v5";
const SCHEMA_VERSION = 1;

function list(value) {
  return Array.isArray(value) ? value : [];
}

function text(value, limit = 4000) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function candidateText(candidate) {
  return [
    candidate?.activity,
    candidate?.narrative,
    candidate?.diary,
    candidate?.message_to_user,
    candidate?.next_intention,
    ...list(candidate?.world_observations).flatMap((observation) => [
      observation?.name,
      ...list(observation?.observed_facts),
      ...list(observation?.visual_facts),
      observation?.relationship_note,
      observation?.status_observed,
    ]),
  ].map((item) => text(item)).filter(Boolean).join(" ");
}

function hasAny(value, patterns) {
  return patterns.some((pattern) => pattern.test(value));
}

function violation(code, path, detail) {
  return { code, path, detail };
}

function validatesMovement(candidate) {
  const target = text(candidate?.location, 120);
  if (!target) return [];
  const prose = `${text(candidate?.activity)} ${text(candidate?.narrative)}`;
  const instantWords = /瞬间|一眨眼|突然已经|凭空|传送|闪现/;
  // Impulsive arrivals are allowed. Only explicit teleport language is rejected.
  if (instantWords.test(prose)) {
    return [violation(
      "MOVEMENT_DISCONTINUITY",
      "location",
      `目标地点“${target}”的叙述含传送或瞬移，不被允许`,
    )];
  }
  return [];
}

function skyDescriptionProse(prose) {
  // Plant names like 月见草 must not count as night-sky "月光".
  return text(prose).replace(/月见草/g, "植物专名");
}

function validatesTime(candidate, worldTick) {
  const prose = `${text(candidate?.activity)} ${text(candidate?.narrative)} ${text(candidate?.diary)}`;
  const skyProse = skyDescriptionProse(prose);
  const hour = Number(String(worldTick?.local_time || "").split(":")[0]);
  if (!Number.isFinite(hour)) return [];
  const violations = [];
  if (/早餐|早饭|刚起床|清晨醒来/.test(prose) && (hour < 5 || hour >= 11)) {
    violations.push(violation("TIME_CONFLICT", "activity", `当地 ${worldTick.local_time} 不应被写成早餐或刚起床`));
  }
  if (/午餐|午饭/.test(prose) && (hour < 10 || hour >= 15)) {
    violations.push(violation("TIME_CONFLICT", "activity", `当地 ${worldTick.local_time} 不应被写成午餐`));
  }
  if (/晚餐|晚饭/.test(prose) && (hour < 16 || hour >= 23)) {
    violations.push(violation("TIME_CONFLICT", "activity", `当地 ${worldTick.local_time} 不应被写成晚餐`));
  }
  if (/准备睡觉|上床睡觉|深夜入睡/.test(prose) && hour >= 7 && hour < 21) {
    violations.push(violation("TIME_CONFLICT", "activity", `当地 ${worldTick.local_time} 不应无理由进入夜间睡眠`));
  }
  if (/天亮了|阳光照进|日出/.test(prose) && (hour < 5 || hour >= 19)) {
    violations.push(violation("TIME_CONFLICT", "narrative", `当地 ${worldTick.local_time} 的天色描述冲突`));
  }
  // Late afternoon may describe dusk/sunset; only block them before 16:00.
  if (/日落|暮色|黄昏|晚霞/.test(skyProse) && hour >= 5 && hour < 16) {
    violations.push(violation("TIME_CONFLICT", "narrative", `当地 ${worldTick.local_time} 的黄昏描述过早`));
  }
  // True night-sky cues stay blocked until evening; 月见草 already stripped above.
  if (/天黑了|夜色|月光|满月/.test(skyProse) && hour >= 5 && hour < 18) {
    violations.push(violation("TIME_CONFLICT", "narrative", `当地 ${worldTick.local_time} 的夜间描述冲突`));
  }
  return violations;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function validatesSpecies(candidate, config) {
  const prose = candidateText(candidate);
  const violations = [];
  const species = text(config.visual?.unique_species?.species || config.character.species, 40);
  const characterName = text(config.visual?.unique_species?.only_character_name || config.character.name, 40);
  const speciesPattern = new RegExp(`第二只${escapeRegExp(species)}|另一只${escapeRegExp(species)}|其他${escapeRegExp(species)}|一群${escapeRegExp(species)}|两只${escapeRegExp(species)}|多只${escapeRegExp(species)}`);
  if (speciesPattern.test(prose)) {
    violations.push(violation(species === "松鼠" ? "SECOND_UNIQUE_SPECIES" : "SECOND_UNIQUE_SPECIES", "candidate",
      `${config.world.name}里只能有${characterName}这一只${species}`));
  }
  for (const [index, observation] of list(candidate?.world_observations).entries()) {
    if (observation?.entity_type !== "character") continue;
    const identity = `${text(observation?.name)} ${list(observation?.visual_facts).map((item) => text(item)).join(" ")}`
      .replace(new RegExp(`非${escapeRegExp(species)}`, "g"), "");
    if (new RegExp(escapeRegExp(species)).test(identity) && !new RegExp(escapeRegExp(characterName)).test(identity)) {
      violations.push(violation(species === "松鼠" ? "NPC_MUST_NOT_USE_UNIQUE_SPECIES" : "NPC_MUST_NOT_USE_UNIQUE_SPECIES",
        `world_observations[${index}]`, `新镇民必须是非${species}动物`));
    }
  }
  return violations;
}

function validatesDiscovery(candidate, discoveryGate) {
  const decisions = list(discoveryGate?.decisions);
  const violations = [];
  // Deferred discoveries (budget / cooldown / per-event limit) stay uncanonized but must
  // not abort an otherwise valid life event. Only hard rejections block commit.
  if (decisions.some((decision) => decision.outcome === "rejected")) {
    violations.push(violation(
      "DISCOVERY_NOT_ALLOWED",
      "world_observations",
      "至少一项候选发现缺少合法来源或违背世界规则",
    ));
  }
  if (decisions.filter((decision) => decision.consumed_growth_budget && !decision.replayed).length > 1) {
    violations.push(violation("WORLD_GROWTH_EXCEEDED", "world_observations", "单个生活事件最多揭示一个新永久实体候选"));
  }
  return violations;
}

function validatesWorldChanges(candidate) {
  const changes = candidate?.world_changes && typeof candidate.world_changes === "object"
    ? candidate.world_changes
    : {};
  const governedKeys = Object.keys(changes).filter((key) => (
    /weather|season|time|date|new.?character|new.?place|resident|population|crisis|economy/i.test(key)
  ));
  return governedKeys.length
    ? [violation("UNAUTHORIZED_WORLD_MUTATION", "world_changes", `不得直接修改受治理世界字段：${governedKeys.join(", ")}`)]
    : [];
}

function validatesTone(candidate) {
  const prose = candidateText(candidate);
  const violations = [];
  if (hasAny(prose, [/世界末日/, /战争爆发/, /毁灭小镇/, /重大灾难/, /绑架/, /死亡威胁/, /拯救全世界/])) {
    violations.push(violation("TONE_MACRO_CRISIS", "candidate", "当前引擎只允许世界中的有限日常事件"));
  }
  if (hasAny(prose, [/必须充值/, /必须付费/, /不给钱就/, /不投喂就/, /花钱才能/])) {
    violations.push(violation("TONE_ECONOMIC_COERCION", "candidate", "不得制造付费、投喂或生存压力"));
  }
  if (hasAny(prose, [/因为你没有回复/, /一直等你回复/, /没有你就/, /等你来决定/, /一切都是为了你/])) {
    violations.push(violation("USER_CENTERED_EVENT", "candidate", "用户不是角色生活与世界变化的中心"));
  }
  return violations;
}

export function validateWorldConstitution({
  candidate,
  currentState = {},
  worldTick = {},
  worldCanon = {},
  discoveryGate = {},
  config = DEFAULT_LIFE_ENGINE_CONFIG,
  checkedAt = null,
} = {}) {
  const violations = [
    ...validatesSpecies(candidate, config),
    ...validatesDiscovery(candidate, discoveryGate),
    ...validatesMovement(candidate),
    ...validatesTime(candidate, worldTick),
    ...validatesWorldChanges(candidate),
    ...validatesTone(candidate),
  ];
  const unique = [];
  const seen = new Set();
  for (const item of violations) {
    const key = `${item.code}:${item.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return {
    schema_version: SCHEMA_VERSION,
    constitution_version: CONSTITUTION_VERSION,
    checked_at: checkedAt || null,
    accepted: unique.length === 0,
    violation_codes: unique.map((item) => item.code),
    violations: unique,
    checks: {
      unique_squirrel: !unique.some((item) => ["SECOND_UNIQUE_SPECIES", "NPC_MUST_NOT_USE_UNIQUE_SPECIES"].includes(item.code)),
      legal_discovery: !unique.some((item) => ["DISCOVERY_NOT_ALLOWED", "WORLD_GROWTH_EXCEEDED"].includes(item.code)),
      movement_continuity: !unique.some((item) => item.code === "MOVEMENT_DISCONTINUITY"),
      time_consistency: !unique.some((item) => item.code === "TIME_CONFLICT"),
      bounded_world_mutation: !unique.some((item) => item.code === "UNAUTHORIZED_WORLD_MUTATION"),
      tone: !unique.some((item) => item.code.startsWith("TONE_") || item.code === "USER_CENTERED_EVENT"),
    },
  };
}

export function constitutionVersion() {
  return CONSTITUTION_VERSION;
}
