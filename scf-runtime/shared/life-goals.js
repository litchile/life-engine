// Wishes are durable, small, and grounded in facts the character already knows.
// Only the event commit path may advance them; conversation plans are not evidence.
import { DEFAULT_LIFE_ENGINE_CONFIG, isHomeLocation } from "./life-engine-config.js";
export const LIFE_PLAN_KEY = "state/life-plan.json";
export const LIFE_PLAN_PENDING_KEY = "state/life-plan-pending.json";
export const LIFE_GOAL_CATEGORIES = Object.freeze([
  "daily_life", "interest_exploration", "relationship", "environment_opportunity",
  "temporary_matter", "inner_change", "user_commitment",
]);
const list = (value) => Array.isArray(value) ? value : [];
const text = (value, max = 180) => String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
const hash = (value) => {
  let result = 2166136261;
  for (const ch of String(value)) result = Math.imul(result ^ ch.charCodeAt(0), 16777619);
  return (result >>> 0).toString(16);
};

export function goalSubjectAliases(subject) {
  const original = text(subject, 120);
  if (!original) return [];
  const aliases = new Set([original]);
  const withoutTown = original.replace(/^(?:温暖)?小镇(?:的)?/, "");
  const withoutInn = original.replace(/^云杉客栈(?:的)?/, "旅馆");
  const withoutColor = original.replace(/^(?:棕色|米色色?|灰白色?|浅色)/, "");
  for (const candidate of [withoutTown, withoutInn, withoutColor]) {
    if (candidate.length >= 3) aliases.add(candidate);
  }
  if (/旧皮箱$/.test(original)) aliases.add("皮箱");
  return [...aliases];
}

export function emptyLifePlan() {
  return {
    schema_version: 2,
    goal_lanes: Object.fromEntries(LIFE_GOAL_CATEGORIES.map((category) => [category, { status: "available", active_goal_ids: [] }])),
    goals: [], days: [], applied_event_ids: [], updated_at: null,
  };
}

export function normalizeLifePlan(saved) {
  return {
    ...emptyLifePlan(),
    ...saved,
    schema_version: 2,
    goal_lanes: { ...emptyLifePlan().goal_lanes, ...saved?.goal_lanes },
    goals: list(saved?.goals).map((goal) => ({
      ...goal,
      category: goal.category || ({ atlas: "interest_exploration", relationship: "relationship", comfort: "daily_life" }[goal.kind] || "temporary_matter"),
      subject_aliases: goalSubjectAliases(goal.subject),
      milestones: list(goal.milestones),
      evidence: list(goal.evidence),
    })),
    days: list(saved?.days).slice(-14),
    applied_event_ids: list(saved?.applied_event_ids).slice(-256),
  };
}

export async function reconcileLifePlan(store) {
  const pending = await store.getJson(LIFE_PLAN_PENDING_KEY, null);
  if (!pending?.event_key || !/^events\/\d{4}-\d{2}-\d{2}\/autonomy-[a-zA-Z0-9_-]+\.json$/.test(pending.event_key)) return;
  const event = await store.getJson(pending.event_key, null);
  if (event?.life_plan_effect) {
    const saved = await store.getJson(LIFE_PLAN_KEY, emptyLifePlan());
    await store.putJson(LIFE_PLAN_KEY, applyLifePlanEffect(saved, event.life_plan_effect));
  }
  await store.putJson(LIFE_PLAN_PENDING_KEY, null);
}

export function knownLifeEntities(worldCanon) {
  return list(worldCanon?.entities)
    .filter((item) => (item.lifecycle_status || "canonical") === "canonical")
    .map((item) => ({
      id: text(item.id || item.entity_id), name: text(item.name || item.canonical_name),
      type: item.type || item.entity_type,
      location: text(list(item.history).slice().reverse().find((entry) => entry.location)?.location
        || item.last_seen_location || item.first_seen_location),
      facts: list(item.known_facts).map((fact) => text(fact)).join("；"),
    })).filter((item) => item.id && item.name);
}

const STEPS = {
  atlas: ["收下一条亲自知道的细节", "核对一个疑问", "整理成一页自己的图鉴"],
  relationship: ["完成一次轻轻的问候", "围绕已知小事再往来一次", "记下这段往来让自己理解的事"],
  comfort: ["选出一个需要整理的小角落", "尝试一次具体摆放", "用过之后调整到顺手的位置"],
  opportunity: ["亲自确认眼前发生了什么", "留下一个真实结果"],
  matter: ["确认这件事还需要什么", "完成一个能被事件证明的小步骤"],
  commitment: ["按已经答应的方式处理", "如实记录结果并决定是否需要告诉对方"],
  inner_change: ["在一件小事里尝试新的做法", "记下真实感受"],
};

export function seedLifeGoals(saved, { worldCanon = {}, layeredMemory = {}, agent = {}, worldTick = {}, openThreads = [], emotionState = {}, nowIso, config = DEFAULT_LIFE_ENGINE_CONFIG }) {
  const state = normalizeLifePlan(saved);
  const known = knownLifeEntities(worldCanon);
  const preferences = list(layeredMemory.reflections).filter((item) => item.reflection_type === "preference");
  const candidates = [];
  for (const entity of known.filter((item) => ["object", "place"].includes(item.type))) {
    candidates.push({
      kind: "atlas", category: "interest_exploration", source_id: entity.id, source_type: "canon", subject: entity.name,
      location: entity.type === "place" ? entity.name : entity.location,
      title: `给${entity.name}留一页自己的图鉴`,
      motivation: "我喜欢慢慢辨认细节，想把亲自知道的东西留下来。",
    });
  }
  for (const entity of known.filter((item) => item.type === "character")) {
    // A known name without location evidence must not turn into a scheduled encounter.
    if (!entity.location) continue;
    candidates.push({
      kind: "relationship", category: "relationship", source_id: entity.id, source_type: "canon", subject: entity.name,
      location: entity.location, title: `慢慢熟悉${entity.name}`,
      motivation: "想让下次碰面比这次少一点拘谨，不用勉强热闹。",
    });
  }
  const room = known.find((item) => item.type === "place" && (item.name === config.world.home.location
    || (item.name.length >= 4 && config.world.home.location.includes(item.name))));
  for (const possession of list(agent.possessions).slice(0, 8)) {
    if (!room || !text(possession)) continue;
    candidates.push({
      kind: "comfort", category: "daily_life", source_id: `possession:${text(possession)}`, source_type: "possession",
      subject: text(possession), location: room.name, title: `让${text(possession)}放得更顺手`,
      motivation: "想让暂住的小房间一点点有自己的习惯。",
    });
  }
  for (const opportunity of list(worldTick.perceivable_opportunities).filter((item) => item?.id && item?.location).slice(0, 3)) {
    candidates.push({
      kind: "opportunity", category: "environment_opportunity", source_id: opportunity.id,
      source_type: "persisted_world_opportunity", subject: text(opportunity.subject || opportunity.description || "眼前的小事"),
      location: text(opportunity.location), title: `去看看${text(opportunity.subject || opportunity.description || "眼前的小事")}`,
      motivation: "它正好出现在今天的路边，我想亲自确认一下，不急着先下结论。",
    });
  }
  for (const thread of list(openThreads).filter((item) => item?.id && item.status !== "closed").slice(0, 4)) {
    const committed = Boolean(thread.report_to_user);
    candidates.push({
      kind: committed ? "commitment" : "matter",
      category: committed ? "user_commitment" : "temporary_matter",
      source_id: thread.id, source_type: "persisted_open_thread",
      subject: text(thread.title || thread.subject || "还没处理完的小事"),
      location: text(thread.location || agent.location),
      title: committed ? `把答应的“${text(thread.title || thread.subject || "那件事")}”处理好` : `继续处理${text(thread.title || thread.subject || "一件未完的小事")}`,
      motivation: committed ? "既然已经答应了，就想认真做完；做不到也要诚实说明。" : "这件事还没有结束，我想给它一个真实的下一步。",
    });
  }
  for (const candidate of candidates) {
    candidate.preference = preferences.find((item) => text(item.content).includes(candidate.subject));
    candidate.id = `wish-${hash(`${candidate.kind}:${candidate.source_id}`)}`;
  }
  // References follow current canonical memory; evidence keeps the original name
  // and location of past events. A revoked source cannot schedule new encounters.
  state.goals = state.goals.map((goal) => {
    if (["completed", "abandoned", "failed", "changed"].includes(goal.status)) return goal;
    const current = candidates.find((candidate) => candidate.id === goal.id);
    if (!current) return {
      ...goal, status: "paused", source_unavailable: true,
      status_before_source_loss: goal.status_before_source_loss || goal.status,
      updated_at: goal.source_unavailable ? goal.updated_at : nowIso,
    };
    const changed = goal.source_unavailable || ["subject", "location", "title"].some((key) => goal[key] !== current[key]);
    if (!changed) return goal;
    return {
      ...goal, subject: current.subject, location: current.location, title: current.title,
      status: goal.source_unavailable ? (goal.status_before_source_loss || "active") : goal.status,
      source_unavailable: false, status_before_source_loss: null, updated_at: nowIso,
    };
  });
  candidates.sort((a, b) => Number(Boolean(b.preference)) - Number(Boolean(a.preference))
    || Number(b.kind === "atlas" && !isHomeLocation(b.location, config)) - Number(a.kind === "atlas" && !isHomeLocation(a.location, config))
    || a.id.localeCompare(b.id));
  const activeKinds = new Set(state.goals.filter((goal) => !["completed", "abandoned", "failed", "changed"].includes(goal.status)).map((goal) => goal.kind));
  for (const candidate of candidates) {
    if (activeKinds.size >= 7) break;
    if (activeKinds.has(candidate.kind) || state.goals.some((goal) => goal.id === candidate.id)) continue;
    const { preference, ...base } = candidate;
    state.goals.push({
      ...base, status: "active", created_at: nowIso, updated_at: nowIso,
      subject_aliases: goalSubjectAliases(base.subject),
      preference_source_id: preference?.id || null,
      source_memory: preference ? text(preference.content) : null,
      milestones: (STEPS[candidate.kind] || STEPS.matter).map((title, index) => ({ id: `${candidate.id}-step-${index + 1}`, title, status: "pending" })),
      evidence: [], last_progress_date: null, last_progress_at: null, paused_until: null,
    });
    activeKinds.add(candidate.kind);
  }
  for (const category of LIFE_GOAL_CATEGORIES) {
    state.goal_lanes[category] = {
      ...(state.goal_lanes[category] || { status: "available" }),
      active_goal_ids: state.goals.filter((goal) => goal.category === category
        && !["completed", "abandoned", "failed", "changed"].includes(goal.status)).map((goal) => goal.id),
    };
  }
  // Retain completed identities so a finished wish cannot silently restart.
  return state;
}

export function nextGoalStep(goal) {
  return list(goal?.milestones).find((step) => step.status !== "completed") || null;
}

export function goalFactsForChat(saved, date = "") {
  const state = normalizeLifePlan(saved);
  const day = state.days.find((item) => item.date === date);
  return {
    wishes: state.goals.filter((goal) => !goal.source_unavailable && (goal.status === "active" || goal.status === "paused")).slice(0, 3).map((goal) => ({
      title: goal.title, motivation: goal.motivation, status: goal.status,
      completed_steps: goal.milestones.filter((step) => step.status === "completed").map((step) => step.title),
      next_step: nextGoalStep(goal)?.title || null, last_result: goal.evidence.at(-1) || null,
    })),
    recent_results: state.goals.flatMap((goal) => goal.evidence.map((entry) => ({ goal: goal.title, ...entry })))
      .sort((a, b) => String(b.occurred_at).localeCompare(String(a.occurred_at))).slice(0, 4),
    today: day ? { main_goal_id: day.main_goal_id, last_choice: day.events.at(-1) || null } : null,
  };
}

// The effect lives on the event itself. Replaying after an interrupted COS write
// repairs this projection without asking the model again or counting twice.
export function applyLifePlanEffect(saved, effect) {
  const state = normalizeLifePlan(saved);
  if (!effect?.event_id || state.applied_event_ids.includes(effect.event_id)) return state;
  for (const goal of list(effect.goals)) {
    const index = state.goals.findIndex((item) => item.id === goal.id);
    if (index < 0) state.goals.push(structuredClone(goal));
    else if (String(state.goals[index].updated_at) <= String(goal.updated_at)) state.goals[index] = structuredClone(goal);
  }
  const dayIndex = state.days.findIndex((day) => day.date === effect.day.date);
  if (dayIndex < 0) state.days.push(structuredClone(effect.day));
  else {
    const day = state.days[dayIndex];
    const events = new Map([...list(day.events), ...list(effect.day.events)].map((event) => [event.event_id, event]));
    state.days[dayIndex] = { ...day, events: [...events.values()].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at)) };
  }
  state.days.sort((a, b) => a.date.localeCompare(b.date));
  state.days = state.days.slice(-14);
  state.applied_event_ids = [...state.applied_event_ids, effect.event_id].slice(-256);
  state.updated_at = [state.updated_at || "", effect.occurred_at].sort().at(-1);
  return state;
}

export function createLifePlanEffect(state, decision, event, outcome) {
  const goals = structuredClone(normalizeLifePlan(state).goals);
  const goal = goals.find((item) => item.id === outcome.goal_id);
  if (goal && outcome.status === "advanced") {
    const step = goal.milestones.find((item) => item.id === outcome.step_id);
    step.status = "completed";
    step.event_id = event.id;
    goal.last_progress_date = event.local_date;
    goal.last_progress_at = event.occurred_at;
    goal.updated_at = event.occurred_at;
    goal.status = nextGoalStep(goal) ? "active" : "completed";
    goal.evidence.push({ step_id: step.id, event_id: event.id, occurred_at: event.occurred_at, result: outcome.evidence });
  } else if (goal && ["paused", "abandoned", "failed", "changed"].includes(outcome.status)) {
    goal.status = outcome.status;
    goal.updated_at = event.occurred_at;
    goal.paused_until = outcome.status === "paused"
      ? new Date(Date.parse(`${event.local_date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10) : null;
    if (outcome.status === "changed") goal.changed_to = outcome.changed_to || null;
    goal.evidence.push({ event_id: event.id, occurred_at: event.occurred_at, result: outcome.evidence, status: outcome.status });
  }
  const existing = state.days.find((day) => day.date === event.local_date);
  const day = structuredClone(existing || decision.day_plan);
  day.events = [...list(day.events), {
    event_id: event.id, occurred_at: event.occurred_at, location: event.location,
    action: outcome.action, topic: outcome.topic, goal_id: outcome.goal_id,
    narrative: text(event.narrative, 400), message: text(event.message_to_user, 300),
    status: outcome.status, reason: outcome.reason, evidence: outcome.evidence || null,
    mode: decision.mode,
  }];
  return { event_id: event.id, occurred_at: event.occurred_at, goals, day };
}
