import { autonomyActionFamily, autonomyLocationKey, evaluateAutonomyCandidate } from "./autonomy-selection.js";
import { goalSubjectAliases, knownLifeEntities, nextGoalStep } from "./life-goals.js";
import { activityDurationMinutes, DEFAULT_LIFE_PROFILE } from "./life-profile.js";
import { DEFAULT_LIFE_ENGINE_CONFIG, isHomeLocation } from "./life-engine-config.js";

const list = (value) => Array.isArray(value) ? value : [];
const text = (value) => String(value || "").trim();
const SPECULATIVE_RESULT = /打算|准备|想要|明天|改天|以后|还没|没有|没能|未能|计划|希望|假装|想象/;
const DETOUR_REASON = /雨|雪|累|困|关门|休息|打烊|没遇|不在|不合适|改主意|改变|不想|失败|坏了|找不到|没找到/;
const indoor = (location) => /房间|厅|店|馆|邮局|磨坊|屋内/.test(location) && !/门口|外|院|花园/.test(location);
export const needsIndoorPlan = (weather) => /雨|雪|暴风|雷/.test(String(weather).replace(/雨后[^，；]*|雪后[^，；]*|[^，；]*转晴/g, ""));
const samePlace = (a, b) => autonomyLocationKey(a) === autonomyLocationKey(b);
const GOAL_CADENCE_MINUTES = {
  daily_life: 45, interest_exploration: 120, environment_opportunity: 90,
  temporary_matter: 60, user_commitment: 60, inner_change: 1440, relationship: 10080,
};

const RESULT_OPERATIONS = new Map([
  ["advance", "advance"], ["advanced", "advance"], ["done", "advance"], ["complete", "advance"], ["completed", "advance"],
  ["finish", "advance"], ["finished", "advance"], ["success", "advance"], ["succeeded", "advance"], ["完成", "advance"], ["已完成", "advance"], ["推进", "advance"],
  ["pause", "pause"], ["paused", "pause"], ["blocked", "pause"], ["postpone", "pause"], ["postponed", "pause"], ["deferred", "pause"], ["受阻", "pause"], ["暂停", "pause"], ["延后", "pause"],
  ["change", "change"], ["changed", "change"], ["changed_mind", "change"], ["change_mind", "change"], ["改主意", "change"], ["改变", "change"],
  ["abandon", "abandon"], ["abandoned", "abandon"], ["cancel", "abandon"], ["cancelled", "abandon"], ["canceled", "abandon"], ["放弃", "abandon"], ["取消", "abandon"],
  ["fail", "fail"], ["failed", "fail"], ["failure", "fail"], ["失败", "fail"],
]);

function narrativeSentences(value) {
  return text(value).match(/[^。！？!?\n]+[。！？!?]?/g)?.map((sentence) => sentence.trim()).filter(Boolean) || [];
}

function exactNarrativeExcerpt(narrative, proposed, predicate) {
  const source = text(narrative);
  const candidate = text(proposed);
  if (candidate && source.includes(candidate) && predicate(candidate)) return candidate;
  return narrativeSentences(source).find(predicate) || "";
}

export function adaptDirectedEvent(event, decision) {
  if (!decision || decision.mode !== "goal" || !decision.selected) {
    return { event, diagnostic: { adapted: false, reason: "not_goal_mode" } };
  }
  const selected = decision.selected;
  const reported = event?.director_result && typeof event.director_result === "object" ? event.director_result : {};
  const legacy = event?.goal_update && typeof event.goal_update === "object" ? event.goal_update : {};
  const rawStatus = text(reported.status || legacy.operation).toLowerCase();
  const operation = RESULT_OPERATIONS.get(rawStatus) || rawStatus;
  const aliases = selected.subject_aliases?.length ? selected.subject_aliases : goalSubjectAliases(selected.subject);
  const actionPattern = new RegExp(selected.evidence_pattern || "(?!)");
  const evidence = exactNarrativeExcerpt(event?.narrative, reported.evidence_sentence || legacy.evidence,
    (sentence) => aliases.some((alias) => sentence.includes(alias)) && actionPattern.test(sentence) && !SPECULATIVE_RESULT.test(sentence));
  const reason = exactNarrativeExcerpt(event?.narrative, reported.evidence_sentence || reported.reason || legacy.reason,
    (sentence) => DETOUR_REASON.test(sentence));
  const binding = { goal_id: selected.goal_id, step_id: selected.step_id, action: selected.action, location: selected.location };
  let goalUpdate = legacy;
  if (operation === "advance") goalUpdate = { goal_id: selected.goal_id, step_id: selected.step_id, operation, evidence };
  else if (["pause", "abandon", "fail", "change"].includes(operation)) goalUpdate = {
    goal_id: selected.goal_id, step_id: selected.step_id, operation, reason,
    ...(operation === "change" && (reported.changed_to || legacy.changed_to) ? { changed_to: text(reported.changed_to || legacy.changed_to) } : {}),
  };
  else goalUpdate = { goal_id: selected.goal_id, step_id: selected.step_id, operation };
  return {
    event: { ...event, director_binding: binding, goal_update: goalUpdate },
    diagnostic: {
      adapted: true, reported_status: rawStatus || null, normalized_operation: operation || null,
      evidence_repaired: Boolean(evidence && evidence !== text(reported.evidence_sentence || legacy.evidence)),
      evidence_found: Boolean(evidence), reason_found: Boolean(reason),
    },
  };
}

function ageDays(date, previous) {
  return Math.max(0, Math.floor((Date.parse(`${date}T00:00:00Z`) - Date.parse(previous || `${date}T00:00:00Z`)) / 86400000));
}

function goalCooldownActive(goal, observedAt) {
  const last = goal?.last_progress_at || list(goal?.evidence).at(-1)?.occurred_at;
  if (!last || !observedAt) return false;
  return Date.parse(observedAt) - Date.parse(last) < (GOAL_CADENCE_MINUTES[goal.category] || 120) * 60_000;
}

export function lifeTopic(event, goals = []) {
  const prose = `${event.activity || ""} ${event.narrative || ""}`;
  if (/花|月见草|植物|叶片|花瓣/.test(prose)) return "plants";
  if (/拍照|摄影|照片|拍下/.test(prose)) return "photography";
  if (goals.some((goal) => goal.kind === "relationship" && prose.includes(goal.subject))) return "relationship";
  return ({ social: "relationship", organize: "comfort", rest: "rest", meal: "meal", travel: "exploration", explore: "exploration", walk: "exploration" })[autonomyActionFamily(event)] || "study";
}

function repeatedDailyValues(days, field) {
  if (days.length < 2) return [];
  const dominant = (day) => {
    const counts = new Map();
    const progress = list(day.events).filter((event) => event.status === "advanced");
    const relevant = field === "topic" && progress.length ? progress : list(day.events);
    for (const event of relevant) counts.set(event[field], (counts.get(event[field]) || 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  };
  const [a, b] = days.slice(-2).map(dominant);
  return a && a === b ? [a] : [];
}

function goalOptions(goal, places, wet) {
  const step = nextGoalStep(goal);
  if (!step) return [];
  const index = goal.milestones.indexOf(step);
  const make = (location, action, instruction, evidencePattern) => ({
    goal_id: goal.id, step_id: step.id, subject: goal.subject, location, action,
    subject_aliases: goalSubjectAliases(goal.subject),
    instruction, evidence_pattern: evidencePattern,
    topic: lifeTopic({ activity: `${{ observe: "观察", learn: "研究", write: "写日记", social: "问候", organize: "整理" }[action]}${goal.subject}` }, [goal]),
  });
  if (goal.kind === "comfort") return [make(goal.location, "organize",
    `${step.title}：只使用已有的${goal.subject}，不凭空添置物品`, "整理|收拾|归置|摆|放|移|挪|调整|腾|留出")];
  if (goal.kind === "relationship") {
    if (index < 2) return [make(goal.location, "social",
      `${step.title}：若自然遇到${goal.subject}，轻声往来；位置记录不保证对方在场，未遇到就如实改道`, "问候|交谈|打招呼|说了|聊|递|归还|帮|点头")];
    return places.filter(indoor).map((location) => make(location, "write",
      `根据此前与${goal.subject}的真实往来，${step.title}；不虚构对方现在的动作`, "写|记下|记录|留下|整理"));
  }
  if (["opportunity", "matter", "commitment", "inner_change"].includes(goal.kind)) {
    const preferred = goal.location && (!wet || indoor(goal.location)) ? [goal.location] : places.filter(indoor);
    return preferred.map((location) => make(location, "observe",
      `${step.title}：只依据眼前可确认的事实处理“${goal.subject}”，不能把计划写成已经发生`,
      "看见|观察|确认|发现|留意|记下|完成|处理"));
  }
  if (index === 0 && !wet && goal.location) return [make(goal.location, "observe",
    `在${goal.location}亲自观察${goal.subject}，${step.title}`, "看见|观察|发现|辨认|记下|留意|注意到")];
  return places.filter(indoor).map((location) => make(location, index === 2 ? "write" : "learn",
    index === 2 ? `把已核实的${goal.subject}细节写成一页自己的记录，未知的部分仍保留疑问`
      : `对照已有记忆，核对${goal.subject}的已知细节和疑问；不假装在室内完成户外观察，也不虚构参考书内容`,
    index === 2 ? "写|记录|记下|画|留下" : "对照|核对|比较|辨认|圈出|标出"));
}

export function buildLifeDirector({ state, worldTick, agent, emotionState, worldCanon, recentEvents = [], openThreads = [], forceMovement = false, lifeProfile = DEFAULT_LIFE_PROFILE, config = DEFAULT_LIFE_ENGINE_CONFIG }) {
  const date = worldTick.local_date;
  const known = knownLifeEntities(worldCanon);
  const places = [...new Set(known.filter((item) => item.type === "place").map((item) => item.name))];
  const wet = needsIndoorPlan(worldTick.weather);
  const previousDays = state.days.filter((day) => day.date < date && ageDays(date, `${day.date}T00:00:00Z`) <= 3);
  const avoidTopics = repeatedDailyValues(previousDays, "topic").filter((value) => !["rest", "meal"].includes(value));
  const avoidLocations = repeatedDailyValues(previousDays, "location");
  const today = state.days.find((day) => day.date === date);
  const progressedToday = list(today?.events).filter((event) => event.status === "advanced");
  const lowEnergy = Number(emotionState?.current?.energy ?? 1) < 0.25;
  const restrictedPlaces = places.filter((place) => (!wet || indoor(place))
    && !avoidLocations.some((previous) => samePlace(previous, place))
    && (!forceMovement || lowEnergy || !isHomeLocation(place, config)));
  const usablePlaces = restrictedPlaces.length ? restrictedPlaces : places.filter((place) => !wet || indoor(place));
  const available = state.goals.filter((goal) => !goal.source_unavailable && !["completed", "abandoned", "failed", "changed"].includes(goal.status)
    && (goal.status !== "paused" || goal.paused_until <= date));
  const ranked = available.map((goal) => {
    const dormantDays = Math.min(5, ageDays(date, goal.last_progress_date ? `${goal.last_progress_date}T00:00:00Z` : goal.created_at));
    return { goal, score: dormantDays * 2 + (goal.preference_source_id ? 2 : 0)
      + (today?.main_goal_id === goal.id ? 3 : 0) - (goalCooldownActive(goal, worldTick.observed_at) ? 100 : 0)
      + (goal.kind === "atlas" ? 1 : 0) };
  }).sort((a, b) => b.score - a.score || a.goal.id.localeCompare(b.goal.id));
  const options = ranked.flatMap(({ goal, score }) => goalOptions(goal, usablePlaces, wet).map((option) => ({ ...option, score })))
    .filter((option) => usablePlaces.includes(option.location)
      && !avoidTopics.includes(option.topic)
      && !goalCooldownActive(available.find((goal) => goal.id === option.goal_id), worldTick.observed_at))
    .filter((option) => {
      const activity = { observe: "观察", learn: "研究", write: "写日记", social: "问候", organize: "整理" }[option.action];
      return evaluateAutonomyCandidate({ location: option.location, activity }, recentEvents, [], { currentLocation: agent.location, forceMovement }).accepted;
    });
  const selected = options[0]
    ? { ...options[0], planned_duration_minutes: activityDurationMinutes(options[0].action, `${worldTick.tick_id || date}:${options[0].goal_id}`, lifeProfile) }
    : null;
  const promise = openThreads.find((thread) => thread.report_to_user);
  const suggestedOpportunity = list(worldTick.perceivable_opportunities).find((item) => (
    !avoidLocations.some((location) => samePlace(location, item.location))
  )) || list(worldTick.perceivable_opportunities)[0] || null;
  const freeDue = progressedToday.length >= 1 || list(today?.events).at(-1)?.mode === "goal";
  const mode = promise ? "promise" : lowEnergy ? "rest" : selected && !freeDue ? "goal" : "free";
  const dayPlan = today || {
    date, main_goal_id: selected?.goal_id || ranked[0]?.goal.id || null,
    backup_goal_id: options.find((option) => option.goal_id !== selected?.goal_id)?.goal_id || null,
    created_at: worldTick.observed_at, events: [],
  };
  const reasons = [wet ? "天气适合室内推进" : "结合当前位置与已知经历", lowEnergy ? "精力低，先恢复" : "",
    avoidTopics.length ? `近两天主题重复，今天换开${avoidTopics.join("、")}` : "",
    avoidLocations.length ? `近两天路线集中，今天换开${avoidLocations.join("、")}` : "",
    promise ? "先处理已有聊天承诺" : "", freeDue ? "今日已有推进，留出自由生活" : ""].filter(Boolean);
  return {
    schema_version: 2, local_date: date, observed_at: worldTick.observed_at, mode, day_plan: dayPlan,
    selected: mode === "goal" ? selected : null,
    backup: options.find((option) => option.goal_id !== selected?.goal_id) || null,
    allowed_locations: usablePlaces,
    avoid_topics: avoidTopics, avoid_locations: restrictedPlaces.length ? avoidLocations : [],
    suggested_opportunity: suggestedOpportunity,
    indoor_required: wet && mode !== "promise", reasons,
    time_budget: selected ? {
      duration_minutes: selected.planned_duration_minutes,
      interpretation: "从事件发生时刻起占用的现实时间；下一次活动不得早于结束时刻",
    } : null,
    instruction: mode === "goal" ? `${selected.instruction}。完成后返回准确的goal_update；也可因现场阻碍暂停，须说明真实原因。`
      : mode === "rest" ? "做一件低负担的恢复活动；不用推进目标，不改变安静敏感的人格。"
        : mode === "promise" ? "按既有承诺规则兑现或诚实改主意。不要因此伪造长期愿望进展。"
          : `留出一次自己的小念头、休息或探索；避开连续两天的重复主题，不能用换说法伪造新进展。${suggestedOpportunity ? `可参考但不必强行采用的当下机会：${suggestedOpportunity.description}` : ""}`,
    persona_rule: `${config.character.core_personality.join("、")}；愿望可慢慢推进，禁止任务打卡口吻和为了凑进度强行社交。`,
  };
}

export function evaluateDirectedEvent(event, decision, state) {
  const reasons = [];
  const compact = (value) => text(value).replace(/[\s\p{P}\p{S}]+/gu, "");
  const recent = state.days.filter((day) => day.date <= decision.local_date
    && ageDays(decision.local_date, `${day.date}T00:00:00Z`) <= 2).flatMap((day) => list(day.events));
  for (const [field, current] of [["narrative", event.narrative], ["message", event.message_to_user]]) {
    const value = compact(current);
    if (value.length >= 12 && recent.some((entry) => compact(entry[field]) === value)) reasons.push(`repeated_three_day_${field}`);
  }
  const update = event.goal_update && typeof event.goal_update === "object" ? event.goal_update : null;
  const topic = lifeTopic(event, state.goals);
  const trustedBinding = event.director_binding && typeof event.director_binding === "object" ? event.director_binding : null;
  const action = trustedBinding?.action || autonomyActionFamily(event);
  const personaProse = `${event.activity || ""} ${event.narrative || ""} ${event.message_to_user || ""} ${JSON.stringify(event.agent_changes || {})}`;
  if (/不再(?:安静|敏感|善良|社恐)|变成(?:外向|狂热)|强迫.*(?:聊天|交朋友)|完成KPI|刷任务|任务打卡/.test(personaProse)) reasons.push("persona_drift");
  if (Object.keys(event.agent_changes || {}).some((key) => /persona|personality|species|identity/i.test(key))) reasons.push("fixed_identity_mutation");
  if (decision.indoor_required && !indoor(event.location)) reasons.push("weather_requires_indoor_alternative");
  if (decision.mode !== "promise" && decision.avoid_locations.some((location) => samePlace(location, event.location))) reasons.push("repeated_daily_route");
  if (decision.mode !== "promise" && decision.avoid_topics.includes(topic)) reasons.push("repeated_daily_topic");
  if (decision.mode === "rest" && !["rest", "meal", "read", "observe", "organize"].includes(action)) reasons.push("low_energy_requires_small_action");
  let outcome = { status: "unrelated", goal_id: null, step_id: null, evidence: null, topic, action, reason: decision.reasons.join("；") };
  if (decision.mode === "goal" && !update) reasons.push("missing_goal_result_or_detour");
  if (update) {
    const goal = state.goals.find((item) => item.id === update.goal_id);
    const selected = decision.selected;
    const step = nextGoalStep(goal);
    const evidence = text(update.evidence);
    const evidenceSentence = text(event.narrative).split(/[。！？!?\n]/).find((sentence) => sentence.includes(evidence.replace(/[。！？!?]+$/, "")));
    // Exact event excerpt, independent of next_intention and model-claimed scores.
    const evidenced = evidence.length >= 4 && text(event.narrative).includes(evidence)
      && !SPECULATIVE_RESULT.test(evidence) && (!evidenceSentence || !SPECULATIVE_RESULT.test(evidenceSentence));
    if (!goal || ["completed", "abandoned", "failed", "changed"].includes(goal.status)) reasons.push("unknown_or_closed_goal");
    else if (update.operation === "advance") {
      if (!selected || selected.goal_id !== goal.id || selected.step_id !== update.step_id || step?.id !== update.step_id) reasons.push("unselected_or_out_of_order_step");
      if (goalCooldownActive(goal, event.occurred_at || decision.observed_at || decision.day_plan?.created_at)) reasons.push("goal_cooldown_active");
      const subjectAliases = selected?.subject_aliases?.length
        ? selected.subject_aliases
        : goalSubjectAliases(goal.subject);
      const namesSubject = subjectAliases.some((alias) => evidence.includes(alias));
      if (!evidenced || !namesSubject || !new RegExp(selected?.evidence_pattern || "(?!)").test(evidence)) reasons.push("unbacked_goal_progress");
      if (selected && (!samePlace(event.location, selected.location) || action !== selected.action)) reasons.push("goal_action_mismatch");
      outcome = { ...outcome, status: "advanced", goal_id: goal.id, step_id: update.step_id, evidence, topic: selected?.topic || topic };
    } else if (["pause", "abandon", "fail", "change"].includes(update.operation)) {
      const reason = text(update.reason);
      if (!selected || selected.goal_id !== goal.id || !reason || !text(event.narrative).includes(reason)
        || !DETOUR_REASON.test(reason)) reasons.push("unbacked_goal_detour");
      const status = { pause: "paused", abandon: "abandoned", fail: "failed", change: "changed" }[update.operation];
      outcome = { ...outcome, status, goal_id: goal.id, evidence: reason, reason, changed_to: status === "changed" ? text(update.changed_to) : null };
    } else reasons.push("invalid_goal_operation");
  }
  return { accepted: !reasons.length, reasons, outcome };
}
