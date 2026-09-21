import { describe, expect, it } from "vitest";
import { buildWorldTick, snapshotWorldTick } from "../scf-runtime/shared/world-tick.js";

function baseInput(overrides = {}) {
  return {
    world: { date: "2026-08-09", season: "初秋", weather: "雨后转晴" },
    agent: { location: "云杉客栈一楼早餐厅" },
    worldCanon: {
      entities: [{
        id: "character-fox",
        type: "character",
        name: "客栈掌柜",
        lifecycle_status: "canonical",
        first_seen_location: "云杉客栈一楼早餐厅",
      }, {
        id: "character-rabbit",
        type: "character",
        name: "路过的兔子",
        lifecycle_status: "provisional",
        first_seen_location: "云杉客栈一楼早餐厅",
      }],
    },
    previousTick: {},
    timeContext: { date: "2026-08-09", time: "10:15", period: "上午" },
    nowIso: "2026-08-09T02:15:00.000Z",
    ...overrides,
  };
}

describe("deterministic world tick", () => {
  it("replays identically for identical inputs", () => {
    const input = baseInput();
    expect(buildWorldTick(input)).toEqual(buildWorldTick(input));
  });

  it("advances its identity and clock when real time advances without user input", () => {
    const first = buildWorldTick(baseInput());
    const second = buildWorldTick(baseInput({
      previousTick: first,
      timeContext: { date: "2026-08-09", time: "14:15", period: "下午" },
      nowIso: "2026-08-09T06:15:00.000Z",
    }));
    expect(second.tick_id).not.toBe(first.tick_id);
    expect(second).toMatchObject({ local_time: "14:15", period: "下午" });
  });

  it("includes only canonical characters in NPC presence", () => {
    const tick = buildWorldTick(baseInput());
    expect(tick.npc_presence.map((entry) => entry.name)).toEqual(["客栈掌柜"]);
    expect(tick.npc_presence[0]).toMatchObject({ presence: "possible_here" });
  });

  it("expires old temporary events instead of promoting them into Canon", () => {
    const expired = {
      temporary_events: [{
        id: "old-event",
        expires_at: "2026-08-09T01:00:00.000Z",
        lifecycle_status: "temporary",
      }],
    };
    const tick = buildWorldTick(baseInput({ previousTick: expired }));
    expect(tick.temporary_events.map((entry) => entry.id)).not.toContain("old-event");
    expect(tick.temporary_events.every((entry) => entry.canon_effect === "none")).toBe(true);
  });

  it("returns an isolated immutable-style snapshot", () => {
    const tick = buildWorldTick(baseInput());
    const snapshot = snapshotWorldTick(tick);
    snapshot.perceivable_opportunities.push({ id: "mutated" });
    expect(tick.perceivable_opportunities.map((entry) => entry.id)).not.toContain("mutated");
  });
});
