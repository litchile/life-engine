import { describe, expect, it } from "vitest";
import { runAgentLifeSimulation } from "../scripts/simulate-agent-life.mjs";

describe("14-day autonomous life simulation", () => {
  it("commits 100 continuous, varied events and survives injected failures", () => {
    const report = runAgentLifeSimulation();
    expect(report).toMatchObject({
      committed_events: 100,
      unique_event_ids: 100,
      canonical_entities: 18,
      discovered_canonical_entities: 4,
      frontier_items: 4,
    });
    expect(report.local_days).toBeGreaterThanOrEqual(14);
    expect(report.open_threads_resolved).toBeGreaterThanOrEqual(1);
    expect(report.failures_with_later_life_progress).toBeGreaterThanOrEqual(7);
    expect(report.temporary_world_events).toBeGreaterThan(0);
  });
});
