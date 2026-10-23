import { describe, expect, it } from "vitest";
import { evaluateAutonomyCandidate, autonomySelectionDirective, hesitationEvidence } from "../scf-runtime/shared/autonomy-selection.js";

const prior = { id: "visit-1", location: "街角面馆门口", activity: "看窗", narrative: "我站在门口，没敢进去。玻璃上有水汽。" };
const repeat = { location: "街角面馆窗外", activity: "数台阶", narrative: "我数了三下，还是没进去。只是还没到时候。" };
const rejected = (candidate, events = [prior]) => evaluateAutonomyCandidate(candidate, events).reasons.includes("repeated_hesitation_without_change");

describe("quiet personality without repeated stalled events", () => {
  it("permits an initial hesitation but rejects rewording it as a new event", () => {
    expect(rejected(repeat, [])).toBe(false);
    expect(rejected(repeat)).toBe(true);
  });
  it("does not let claimed thread progress bypass the stall guard", () => {
    expect(rejected({ ...repeat, selected_thread_id: "suggestion", thread_updates: [{ operation: "advance" }] })).toBe(true);
  });
  it("permits a concrete small step and a genuine decision to leave", () => {
    expect(rejected({ ...repeat, narrative: "还是没进去。我看了菜单，记下清汤面的价格。" })).toBe(false);
    expect(rejected({ ...repeat, narrative: "还是没进去。我离开面馆，回家煮面。" })).toBe(false);
    expect(rejected({ ...repeat, narrative: "我走进面馆，点了清汤面。" })).toBe(false);
  });
  it("does not count a future or negated small step as progress", () => {
    expect(rejected({ ...repeat, narrative: "还是没进去。下次如果看了菜单，就知道吃什么了。" })).toBe(true);
    expect(rejected({ ...repeat, narrative: "还是没进去。我没看了菜单就走。" })).toBe(true);
  });
  it("allows a new external obstacle but not repeated descriptions of the same obstacle", () => {
    const blocked = { ...repeat, narrative: "我没进去。店已经关门。" };
    expect(rejected(blocked)).toBe(false);
    expect(rejected(blocked, [blocked])).toBe(true);
  });
  it("keeps different places and ordinary rest separate and exposes sourced history", () => {
    expect(rejected({ ...repeat, location: "河边书店门口" })).toBe(false);
    expect(hesitationEvidence({ narrative: "我在窗边安静地喝茶。" })).toBeNull();
    expect(autonomySelectionDirective([prior]).recent_hesitations[0]).toMatchObject({ event_id: "visit-1", evidence: "我站在门口，没敢进去" });
  });
});
