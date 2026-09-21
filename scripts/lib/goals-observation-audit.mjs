import { createHash } from "node:crypto";
import { dailyActivityTarget } from "../../scf-runtime/processor/autonomy.js";
import { localDate } from "../../scf-runtime/shared/agent.js";
import { autonomyActionFamily } from "../../scf-runtime/shared/autonomy-selection.js";
import { needsIndoorPlan } from "../../scf-runtime/shared/life-director.js";

const list = (value) => Array.isArray(value) ? value : [];
const compact = (value) => String(value || "").replace(/[\s\p{P}\p{S}]+/gu, "");
const DAY_MS = 86400000;

export function observationDates(startDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate || "")) throw new Error("startDate must be YYYY-MM-DD");
  const start = Date.parse(`${startDate}T00:00:00Z`);
  if (!Number.isFinite(start) || new Date(start).toISOString().slice(0, 10) !== startDate) throw new Error("Invalid start date");
  return [0, 1, 2].map((offset) => new Date(start + offset * DAY_MS).toISOString().slice(0, 10));
}

// A read-only evidence audit. A mechanically valid log still needs a person to
// review the actual narration: regular expressions do not prove a stable persona.
export function auditGoalsObservation(snapshot, { startDate, nowIso = new Date().toISOString() } = {}) {
  const dates = observationDates(startDate);
  const start = Date.parse(`${startDate}T00:00:00+08:00`);
  const end = start + 3 * DAY_MS;
  const events = list(snapshot?.events).filter((event) => dates.includes(event.local_date)
    || (Date.parse(event.occurred_at) >= start && Date.parse(event.occurred_at) < end))
    .sort((a, b) => String(a.occurred_at).localeCompare(String(b.occurred_at)));
  const checks = [];
  const add = (id, status, details) => checks.push({ id, status, ...details });
  const coverageComplete = Number.isFinite(Date.parse(nowIso)) && Date.parse(nowIso) >= end;
  add("three_complete_local_days", coverageComplete ? "pass" : "insufficient", { dates, observation_ends_at: new Date(end).toISOString() });

  const seenIds = new Set();
  const invalidIds = [];
  for (const event of events) {
    const at = Date.parse(event.occurred_at);
    if (!event.id || seenIds.has(event.id) || !Number.isFinite(at)
      || at < start || at >= end || localDate("Asia/Shanghai", new Date(at)) !== event.local_date) invalidIds.push(event.id || "missing_id");
    seenIds.add(event.id);
  }
  add("event_identity_and_time", events.length && !invalidIds.length ? "pass" : "fail", { invalid_event_ids: invalidIds });

  const days = dates.map((date) => {
    const items = events.filter((event) => event.local_date === date);
    return { date, events: items.length, expected_events: dailyActivityTarget(date),
      locations: [...new Set(items.map((event) => event.location))],
      actions: [...new Set(items.map(autonomyActionFamily))],
      progress: items.filter((event) => event.director_outcome?.status === "advanced").length,
    };
  });
  add("daily_life_cadence", days.every((day) => day.events >= day.expected_events) ? "pass" : "insufficient", { days });
  add("daily_goal_progress", days.every((day) => day.progress >= 1) ? "pass" : "fail", { progress_by_date: days.map(({ date, progress }) => ({ date, progress })) });
  const routes = new Set(days.map((day) => [...day.locations].sort().join("|")));
  add("behavior_changes", days.every((day) => day.actions.length >= 2) && routes.size >= 2 ? "pass" : "fail", { distinct_daily_routes: routes.size });

  const duplicates = [];
  for (const field of ["narrative", "message_to_user"]) {
    const seen = new Map();
    for (const event of events) {
      const value = compact(event[field]);
      if (value.length < 12) continue;
      if (seen.has(value)) duplicates.push({ field, event_id: event.id, repeats: seen.get(value) });
      seen.set(value, event.id);
    }
  }
  add("no_repeated_three_day_text", duplicates.length ? "fail" : "pass", { duplicates });

  const invalidProgress = [];
  const progressedSteps = new Set();
  const progressedDays = new Set();
  const goals = list(snapshot?.lifePlan?.goals);
  for (const event of events.filter((item) => item.director_outcome?.status === "advanced")) {
    const outcome = event.director_outcome;
    const selected = event.life_context_snapshot?.director?.selected;
    const goal = goals.find((item) => item.id === outcome.goal_id);
    const step = list(goal?.milestones).find((item) => item.id === outcome.step_id);
    const evidence = list(goal?.evidence).find((item) => item.event_id === event.id && item.step_id === outcome.step_id);
    const stepKey = `${outcome.goal_id}:${outcome.step_id}`;
    const dayKey = `${outcome.goal_id}:${event.local_date}`;
    const excerpt = String(outcome.evidence || "");
    if (!goal || !excerpt || !String(event.narrative).includes(excerpt)
      || /打算|准备|明天|还没|没有|没能|未能|假装|想象/.test(excerpt)
      || selected?.goal_id !== outcome.goal_id || selected?.step_id !== outcome.step_id
      || event.goal_update?.operation !== "advance"
      || event.goal_update?.goal_id !== outcome.goal_id || event.goal_update?.step_id !== outcome.step_id
      || event.location !== selected?.location || autonomyActionFamily(event) !== selected?.action
      || step?.status !== "completed" || step?.event_id !== event.id
      || evidence?.result !== excerpt || progressedSteps.has(stepKey) || progressedDays.has(dayKey)) invalidProgress.push(event.id);
    progressedSteps.add(stepKey);
    progressedDays.add(dayKey);
  }
  add("progress_has_committed_evidence", goals.length && !invalidProgress.length ? "pass" : "fail", { invalid_event_ids: invalidProgress });
  const progressByGoal = new Map();
  const primaryTopics = dates.map((date) => events.find((event) => event.local_date === date && event.director_outcome?.status === "advanced")?.director_outcome?.topic);
  for (const event of events.filter((item) => item.director_outcome?.status === "advanced")) {
    const goalId = event.director_outcome.goal_id;
    if (!progressByGoal.has(goalId)) progressByGoal.set(goalId, new Set());
    progressByGoal.get(goalId).add(event.local_date);
  }
  add("wish_continues_across_days", [...progressByGoal.values()].some((days) => days.size >= 2) ? "pass" : "fail", {});
  add("primary_topic_rotation", primaryTopics.every(Boolean) && new Set(primaryTopics).size >= 2 ? "pass" : "fail", { primary_topics: primaryTopics });

  const wetEvents = events.filter((event) => needsIndoorPlan(event.world_tick_snapshot?.weather));
  const weatherViolations = wetEvents.filter((event) => event.life_context_snapshot?.director?.mode !== "promise"
    && (!/房间|厅|店|馆|邮局|磨坊|屋内/.test(event.location) || /门口|外|院|花园/.test(event.location))).map((event) => event.id);
  add("weather_appropriate_actions", weatherViolations.length ? "fail" : "pass", { wet_events: wetEvents.length, invalid_event_ids: weatherViolations });

  const invalidGovernance = events.filter((event) => !event.life_context_snapshot?.director
    || event.constitution_snapshot?.accepted !== true || event.world_tick_snapshot?.local_date !== event.local_date).map((event) => event.id);
  add("governed_director_events", events.length && !invalidGovernance.length ? "pass" : "fail", { invalid_event_ids: invalidGovernance });
  const projectionIds = new Set(list(snapshot?.lifePlan?.days).flatMap((day) => list(day.events)).map((event) => event.event_id));
  const missingProjection = events.filter((event) => !projectionIds.has(event.id)).map((event) => event.id);
  add("event_projection_complete", events.length && !missingProjection.length ? "pass" : "fail", { missing_event_ids: missingProjection });

  const mechanicalStatus = checks.some((item) => item.status === "fail") ? "fail"
    : checks.some((item) => item.status === "insufficient") ? "insufficient" : "pass";
  return {
    schema_version: 1, mechanical_status: mechanicalStatus,
    overall: mechanicalStatus === "pass" ? "persona_review_required" : mechanicalStatus,
    checks,
    persona_review: {
      status: "required", rule: "逐条审阅实际叙事、日记和消息：安静敏感、善良好奇、不过度社交、不以用户为中心；核对来源为已部署版本的真实事件。",
      events: events.map((event) => ({
        event_id: event.id, local_date: event.local_date,
        content_sha256: createHash("sha256").update(JSON.stringify([event.activity, event.narrative, event.diary, event.message_to_user])).digest("hex"),
      })),
    },
  };
}
