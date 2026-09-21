export const ACTIVITY_PLANS_KEY = "state/activity-plans.json";
const list = (value) => Array.isArray(value) ? value : [];
const TERMINAL = new Set(["completed", "cancelled", "failed"]);

function localDate(timeZone, now) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

export const ACTIVITY_DURATION_MINUTES = Object.freeze({
  meal: [25, 60], errand: [30, 90], organize: [45, 180], walk: [60, 180], social: [60, 180],
  observe: [60, 240], learn: [90, 360], write: [60, 360], craft: [240, 2880], relationship: [10080, 30240], habit: [10080, 30240], rest: [20, 120],
});

export function normalizeActivityPlans(saved) {
  return { schema_version: 1, items: list(saved?.items).slice(-128), updated_at: saved?.updated_at || null };
}

function normalizeConditions(conditions) {
  return list(conditions).slice(0, 6).map((condition) => {
    if (condition && typeof condition === "object" && !Array.isArray(condition)) {
      return {
        on_overdue: ["delay", "cancel", "fail"].includes(condition.on_overdue) ? condition.on_overdue : undefined,
        delay_minutes: Math.max(15, Math.min(1440, Number(condition.delay_minutes || 60))),
        maximum_delays: Math.max(1, Math.min(3, Number(condition.maximum_delays || 1))),
        reason: String(condition.reason || "").slice(0, 160),
      };
    }
    return { note: String(condition || "").slice(0, 160) };
  });
}

export function activityDurationRange(action) {
  return ACTIVITY_DURATION_MINUTES[action] || [60, 180];
}

export function createActivityPlan({ id, sourceEventId, action, title, location, startedAt, durationMinutes, conditions = [] }) {
  const range = activityDurationRange(action);
  const duration = Math.max(range[0], Math.min(range[1], Number(durationMinutes) || range[0]));
  return {
    id, source_event_id: sourceEventId, action, title, location,
    started_at: startedAt, duration_minutes: duration,
    expected_end_at: new Date(Date.parse(startedAt) + duration * 60_000).toISOString(),
    phase: "active", conditions: normalizeConditions(conditions), delay_reason: null, terminal_state: null,
    transition_event_id: null, updated_at: startedAt,
  };
}

function transitionNarrative(plan, nextState, reason) {
  if (nextState === "delayed") return `${plan.title}还没有结束，因${reason || "条件尚未满足"}延后了一段时间。`;
  if (nextState === "cancelled") return `${plan.title}因${reason || "条件发生变化"}取消了。`;
  if (nextState === "failed") return `${plan.title}因${reason || "没有顺利完成"}停了下来。`;
  return `${plan.title}按预计时长结束。`;
}

export function activeActivityPlan(saved, now = new Date()) {
  return normalizeActivityPlans(saved).items.find((plan) => (
    !TERMINAL.has(plan.phase) && plan.phase !== "delayed" && Date.parse(plan.expected_end_at || 0) > now.getTime()
  )) || normalizeActivityPlans(saved).items.find((plan) => (
    plan.phase === "delayed" && Date.parse(plan.expected_end_at || 0) > now.getTime()
  )) || null;
}

export async function reconcileActivityPlans(store, { now = new Date(), timeZone = "Asia/Shanghai" } = {}) {
  const saved = normalizeActivityPlans(await store.getJson(ACTIVITY_PLANS_KEY, null));
  const transitions = [];
  for (const plan of saved.items) {
    if (TERMINAL.has(plan.phase) || Date.parse(plan.expected_end_at || 0) > now.getTime()) continue;
    const overdueRule = list(plan.conditions).find((condition) => condition?.on_overdue);
    const requested = overdueRule?.on_overdue;
    const transitionCount = Number(plan.transition_count || 0) + 1;
    const delayAllowed = requested === "delay" && Number(plan.delay_count || 0) < Number(overdueRule?.maximum_delays || 1);
    const nextState = requested === "cancel" || (requested === "delay" && !delayAllowed) ? "cancelled"
      : requested === "fail" ? "failed" : delayAllowed ? "delayed" : "completed";
    const eventId = `plan-${plan.id}-${nextState}-${transitionCount}`;
    const date = localDate(timeZone, now);
    const key = `events/${date}/${eventId}.json`;
    const reason = overdueRule?.reason || (nextState === "completed" ? "expected_duration_elapsed" : "condition_not_ready");
    const existing = await store.getJson(key, null);
    if (!existing) {
      await store.putJson(key, {
        id: eventId, event_type: "activity_plan_transition", source: "activity_plan_reconciler",
        occurred_at: now.toISOString(), local_date: date, plan_id: plan.id,
        location: plan.location, activity: plan.title, narrative: transitionNarrative(plan, nextState, reason),
        transition: { from: plan.phase, to: nextState, reason },
        fact_status: "committed", life_plan_effect: null, memory_effect: null, npc_effect: null,
      });
    }
    plan.phase = nextState;
    plan.transition_count = transitionCount;
    plan.transition_event_id = eventId;
    plan.updated_at = now.toISOString();
    if (nextState === "delayed") {
      plan.delay_count = Number(plan.delay_count || 0) + 1;
      plan.delay_reason = reason;
      plan.expected_end_at = new Date(now.getTime() + Number(overdueRule?.delay_minutes || 60) * 60_000).toISOString();
      plan.terminal_state = null;
    } else plan.terminal_state = nextState;
    transitions.push({ plan_id: plan.id, event_id: eventId, status: nextState });
  }
  if (transitions.length) {
    saved.updated_at = now.toISOString();
    await store.putJson(ACTIVITY_PLANS_KEY, saved);
  }
  return { state: saved, transitions };
}

export function appendActivityPlan(saved, plan) {
  const state = normalizeActivityPlans(saved);
  const index = state.items.findIndex((item) => item.id === plan.id);
  if (index < 0) state.items.push(plan);
  else state.items[index] = plan;
  state.items = state.items.slice(-128);
  state.updated_at = plan.updated_at;
  return state;
}
