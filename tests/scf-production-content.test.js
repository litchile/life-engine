import { describe, expect, it } from "vitest";
import { autonomyActionFamily, evaluateAutonomyCandidate, hesitationEvidence } from "../scf-runtime/shared/autonomy-selection.js";
import { summarizeAutonomyQuality } from "../scf-runtime/shared/autonomy-quality.js";

// Fictional generated content from the Sept 28/29 review; no user identifiers.
const first = { location: "街角面馆", activity: "走到街角面馆，在门口停了一会儿，没进去",
  narrative: "我没有推门，也没出声，就那样站着看了几秒钟，然后转身继续往小木桥那边走。" };
const second = { location: "街角面馆", activity: "在门槛外站了一小会儿，没进去，往青石路另一头走去",
  narrative: "我在门槛外站了一小会儿，没推门。这次脚没往前挪，也没觉得非进去不可。汤味从门缝里漏出来。我看了两眼，转身往青石路另一头走。" };

describe("production content regressions", () => {
  it("detects no-door-opening variants in either activity or narrative", () => {
    expect(hesitationEvidence(first)).not.toBeNull();
    expect(hesitationEvidence({ location: first.location, narrative: first.narrative })).not.toBeNull();
    expect(hesitationEvidence({ location: first.location, activity: first.activity })).not.toBeNull();
    expect(evaluateAutonomyCandidate(second, [first]).reasons).toContain("repeated_hesitation_without_change");
  });
  it("does not treat routine turning away as new progress but allows new observation", () => {
    const fresh = { ...second, narrative: "我没有推门。这回我看清推车上装着陶罐，罐口蒙着布。" };
    expect(evaluateAutonomyCandidate(fresh, [first]).reasons).not.toContain("repeated_hesitation_without_change");
    const future = { ...second, narrative: "我没推门。下次看清推车再说。" };
    expect(evaluateAutonomyCandidate(future, [first]).reasons).toContain("repeated_hesitation_without_change");
  });
  it.each([
    [{ activity: "靠在窗边听楼下的日常声响，顺手把书签上的干叶脉按平", narrative: "楼下传来碗碟碰在一起的轻响。" }, "organize"],
    [{ activity: "站在小茶馆阶前时，听到附近有推车声和开关门声经过，没看清来源" }, "observe"],
    [{ activity: "看清窗边坐着一个人低头吃面" }, "observe"],
    [{ activity: "站在小茶馆阶前，什么都没做" }, "other"],
    [{ activity: "在面馆吃了一碗面" }, "meal"],
    [{ activity: "向老板询问面条的做法" }, "social"],
    [{ activity: "和朋友聊天" }, "social"],
    [{ activity: "我没买面包，只在窗外看了两眼" }, "observe"],
  ])("classifies the character's action rather than incidental actors: %j", (event, family) => {
    expect(autonomyActionFamily(event)).toBe(family);
  });
  it("reports a 4-of-6 fallback day separately from generated life and goals", () => {
    const events = Array.from({ length: 6 }, (_, i) => ({ id: `e${i}`, occurred_at: `2026-09-28T0${i}:00:00Z`,
      fallback_kind: i < 4 ? "director_safe" : "", director_outcome: { status: i === 5 ? "advanced" : "unrelated" },
      life_context_snapshot: { director: { fallback: { rejection_reasons: ["unbacked_goal_progress"] } } } }));
    expect(summarizeAutonomyQuality([...events, events[0]])).toMatchObject({ status: "degraded", committed_events: 6,
      generated_events: 2, fallback_events: 4, advanced_goals: 1, longest_fallback_run: 4,
      fallback_rejection_reasons: { unbacked_goal_progress: 4 } });
    expect(summarizeAutonomyQuality([]).status).toBe("insufficient");
    expect(summarizeAutonomyQuality([...events, { ...events[0], id: "receipt", event_type: "activity_plan_transition" },
      { ...events[0], id: "bad-time", occurred_at: "invalid" }]).committed_events).toBe(6);
  });
});
