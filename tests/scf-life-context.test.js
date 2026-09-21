import { describe, expect, it } from "vitest";
import { defaultEmotionState } from "../scf-runtime/shared/emotion.js";
import { buildLifeContext } from "../scf-runtime/shared/life-context.js";

function baseInput(overrides = {}) {
  return {
    world: {
      date: "2026-08-09",
      season: "初秋",
      weather: "雨后转晴",
    },
    agent: {
      location: "云杉客栈二楼房间",
    },
    emotionState: defaultEmotionState("2026-08-09T02:15:00.000Z"),
    recentEvents: [
      { location: "云杉客栈二楼房间", activity: "整理地图" },
      { location: "云杉客栈二楼房间", activity: "对照花草图册" },
    ],
    openThreads: [],
    worldCanon: { entities: [] },
    timeContext: {
      date: "2026-08-09",
      time: "10:15",
      period: "上午",
    },
    nowIso: "2026-08-09T02:15:00.000Z",
    ...overrides,
  };
}

describe("deterministic autonomous life context", () => {
  it("builds the same planning context for the same world tick", () => {
    const input = baseInput();
    expect(buildLifeContext(input)).toEqual(buildLifeContext(input));
    expect(buildLifeContext(input)).toMatchObject({
      tick: {
        local_date: "2026-08-09",
        local_time: "10:15",
        period: "上午",
        current_location: "云杉客栈二楼房间",
      },
      world_signals: {
        same_location_run: 2,
      },
    });
  });

  it("turns an attempted open thread into a concrete inner goal and closure motivation", () => {
    const context = buildLifeContext(baseInput({
      openThreads: [{
        id: "thread-bakery",
        title: "把借来的面包篮还回去",
        stage: "attempted",
        priority: 4,
      }],
    }));

    expect(context.motivations[0]).toMatchObject({ id: "closure" });
    expect(context.goal_stack[0]).toMatchObject({
      layer: "inner",
      source: "open_thread",
      source_id: "thread-bakery",
    });
    expect(context.goal_stack[0].goal).toContain("把借来的面包篮还回去");
  });

  it("uses only canonical characters for stable relationship goals", () => {
    const context = buildLifeContext(baseInput({
      worldCanon: {
        entities: [
          {
            id: "character-rabbit",
            type: "character",
            name: "路过的兔子",
            lifecycle_status: "provisional",
          },
          {
            id: "character-fox",
            type: "character",
            name: "狐狸旅馆老板",
            lifecycle_status: "canonical",
          },
        ],
      },
    }));

    expect(context.world_signals.canonical_entity_count).toBe(1);
    expect(context.goal_stack.find((goal) => goal.layer === "relationship")).toMatchObject({
      source: "canonical_relationship",
      source_id: "character-fox",
    });
    expect(context.goal_stack.map((goal) => goal.goal).join(" ")).toContain("狐狸旅馆老板");
    expect(context.goal_stack.map((goal) => goal.goal).join(" ")).not.toContain("路过的兔子");
  });

  it("prioritizes restoration only when energy and security are genuinely low", () => {
    const emotionState = defaultEmotionState("2026-08-09T02:15:00.000Z");
    emotionState.current.energy = 0.08;
    emotionState.current.security = 0.12;
    const context = buildLifeContext(baseInput({ emotionState }));

    expect(context.motivations[0]).toMatchObject({ id: "restoration" });
    expect(context.goal_stack.find((goal) => goal.layer === "daily")).toMatchObject({
      source: "energy_need",
    });
  });

  it("creates a movement goal after repeated life inside the inn", () => {
    const context = buildLifeContext(baseInput());
    const dailyGoal = context.goal_stack.find((goal) => goal.layer === "daily");

    expect(dailyGoal.source).toBe("world_tick");
    expect(dailyGoal.goal).toContain("离开当前小范围");
    expect(context.planning_rule).toContain("已经发生的具体结果");
  });
});
