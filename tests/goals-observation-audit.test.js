import { describe, expect, it } from "vitest";
import { auditGoalsObservation, observationDates } from "../scripts/lib/goals-observation-audit.mjs";
import { dailyActivityTarget } from "../scf-runtime/processor/autonomy.js";

const options = { startDate: "2026-09-03", nowIso: "2026-09-06T00:00:00+08:00" };
function fixture() {
  const events = [];
  const goals = [
    { id: "atlas", milestones: [], evidence: [] },
    { id: "comfort", milestones: [], evidence: [] },
  ];
  const days = [];
  for (const [day, date] of observationDates(options.startDate).entries()) {
    const daily = { date, events: [] };
    for (let i = 0; i < dailyActivityTarget(date); i += 1) {
      const id = `autonomy-${date}-${i}`;
      const action = i === 0 ? ["observe", "learn", "organize"][day] : "rest";
      const activity = i === 0 ? ["观察月见草", "研究月见草", "整理棕色旧背包"][day] : "休息片刻";
      const location = i === 0 ? ["花园", "咖啡馆", "云杉客栈二楼房间"][day] : "旧书店";
      const narrative = `${date}的第${i}条独立测试记录：我${activity}，留下一点实际的生活痕迹。`;
      const goal = goals[day < 2 ? 0 : 1];
      const stepId = `${goal.id}-${day}`;
      const selected = i === 0 ? { goal_id: goal.id, step_id: stepId, action, location } : null;
      const event = {
        id, local_date: date, occurred_at: new Date(Date.parse(`${date}T07:00:00+08:00`) + i * 135 * 60000).toISOString(),
        activity, narrative, message_to_user: narrative, diary: narrative, location,
        director_outcome: { status: i === 0 ? "advanced" : "unrelated", topic: day < 2 ? "plants" : "comfort", goal_id: i === 0 ? goal.id : null, step_id: stepId, evidence: narrative },
        goal_update: i === 0 ? { goal_id: goal.id, step_id: stepId, operation: "advance" } : null,
        life_context_snapshot: { director: { mode: i === 0 ? "goal" : "free", selected } },
        constitution_snapshot: { accepted: true }, world_tick_snapshot: { local_date: date, weather: day === 1 ? "下雨" : "晴" },
      };
      if (i === 0) {
        goal.milestones.push({ id: stepId, status: "completed", event_id: id });
        goal.evidence.push({ event_id: id, step_id: stepId, result: narrative });
      }
      events.push(event);
      daily.events.push({ event_id: id });
    }
    days.push(daily);
  }
  return { events, lifePlan: { goals, days } };
}

describe("real three-day evidence audit", () => {
  it("requires a complete window and leaves persona review explicitly unproven", () => {
    const report = auditGoalsObservation(fixture(), options);
    expect(report.mechanical_status).toBe("pass");
    expect(report.overall).toBe("persona_review_required");
    expect(report.persona_review.events).toHaveLength(21);
    expect(report.persona_review.events[0].content_sha256).toMatch(/^[a-f0-9]{64}$/);
    const early = auditGoalsObservation(fixture(), { ...options, nowIso: "2026-09-05T21:00:00+08:00" });
    expect(early.mechanical_status).toBe("insufficient");
  });
  it("does not pass empty, missing-day or missing-projection data", () => {
    expect(auditGoalsObservation({}, options).mechanical_status).not.toBe("pass");
    const input = fixture();
    input.events = input.events.filter((event) => event.local_date !== "2026-09-04");
    expect(auditGoalsObservation(input, options).mechanical_status).not.toBe("pass");
    const missingProjection = fixture();
    missingProjection.lifePlan.days[0].events.pop();
    expect(auditGoalsObservation(missingProjection, options).checks.find((check) => check.id === "event_projection_complete").status).toBe("fail");
  });
  it("rejects fabricated goal evidence and duplicate event identities", () => {
    const input = fixture();
    input.lifePlan.goals[0].evidence[0].result = "只是打算明天观察";
    expect(auditGoalsObservation(input, options).checks.find((check) => check.id === "progress_has_committed_evidence").status).toBe("fail");
    input.events.push(input.events[0]);
    expect(auditGoalsObservation(input, options).checks.find((check) => check.id === "event_identity_and_time").status).toBe("fail");
  });
  it("detects repeated text, inappropriate rain routes, and changed review content", () => {
    const input = fixture();
    const before = auditGoalsObservation(input, options);
    input.events[1].message_to_user = input.events[0].message_to_user;
    input.events.find((event) => event.local_date === "2026-09-04").location = "花园";
    const after = auditGoalsObservation(input, options);
    expect(after.checks.find((check) => check.id === "no_repeated_three_day_text").status).toBe("fail");
    expect(after.checks.find((check) => check.id === "weather_appropriate_actions").status).toBe("fail");
    expect(after.persona_review.events[1].content_sha256).not.toBe(before.persona_review.events[1].content_sha256);
  });
  it("refuses impossible or path-like dates", () => {
    expect(() => observationDates("2026-02-30")).toThrow();
    expect(() => observationDates("../state")).toThrow();
  });
});
