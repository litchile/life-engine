import { describe, expect, it } from "vitest";
import { auditPhase1Observation } from "../scripts/lib/phase1-observation-audit.mjs";

function fixture(hours = 84) {
  const start = new Date("2026-08-01T00:00:00.000Z");
  const events = [];
  for (let offset = 0; offset <= hours; offset += 6) {
    const occurred = new Date(start.getTime() + offset * 3600000);
    const id = `event-${offset}`;
    events.push({
      id,
      occurred_at: occurred.toISOString(),
      local_date: `2026-08-${String(1 + Math.floor(offset / 24)).padStart(2, "0")}`,
      heartbeat_tick_id: `tick-${offset}`,
      world_tick_snapshot: { tick_id: `tick-${offset}` },
      discovery_snapshot: { decisions: [] },
      constitution_snapshot: { accepted: true },
    });
  }
  const outboxes = ["2026-08-02", "2026-08-03"].flatMap((date) => [1, 2].map((index) => ({
    event_id: `${date}-${index}`,
    local_date: date,
    created_at: `${date}T0${index}:00:00.000Z`,
    status: "sent",
    text_status: "sent",
  })));
  const latest = events.at(-1).id;
  return {
    events,
    outboxes,
    canon: { entities: [{ id: "cat", name: "花花", lifecycle_status: "canonical", first_seen_event_id: "event-6", last_seen_event_id: "event-30", history: [] }] },
    frontiers: { decisions: [{ id: "decision-1" }, { id: "decision-2" }] },
    worldTick: { committed_event_id: latest },
    lifeContext: { committed_event_id: latest },
  };
}

describe("phase 1 production observation audit", () => {
  it("passes a continuous governed 72-hour export", () => {
    const report = auditPhase1Observation(fixture(), { hours: 72 });
    expect(report.overall).toBe("pass");
    expect(report.summary.checks_failed).toBe(0);
  });

  it("fails duplicate decisions, weak canon, and dead letters", () => {
    const snapshot = fixture();
    snapshot.frontiers.decisions.push({ id: "decision-1" });
    snapshot.canon.entities[0].last_seen_event_id = "event-6";
    snapshot.outboxes.push({ status: "dead_letter", local_date: "2026-08-03", created_at: "2026-08-03T03:00:00.000Z" });
    const report = auditPhase1Observation(snapshot, { hours: 72 });
    expect(report.overall).toBe("fail");
    expect(report.checks.find((item) => item.id === "frontier_decision_idempotency").status).toBe("fail");
    expect(report.checks.find((item) => item.id === "notification_delivery_health").status).toBe("fail");
  });

  it("reports insufficient evidence before the observation window is complete", () => {
    const report = auditPhase1Observation(fixture(24), { hours: 72 });
    expect(report.overall).toBe("insufficient");
    expect(report.checks.find((item) => item.id === "observation_coverage").status).toBe("insufficient");
  });
});
