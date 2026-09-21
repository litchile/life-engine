import { describe, expect, it } from "vitest";
import { systemPrompt } from "../scf-runtime/shared/agent.js";
import { structuredChatPrompt } from "../scf-runtime/shared/chat-memory.js";
import {
  DEFAULT_LIFE_ENGINE_CONFIG, characterDefaults, normalizeLifeEngineConfig,
  validateLifeEngineConfig,
} from "../scf-runtime/shared/life-engine-config.js";
import { resolveWeatherState } from "../scf-runtime/shared/weather-state.js";
import { buildWorldTick, npcRelationshipTier } from "../scf-runtime/shared/world-tick.js";
import { validateWorldConstitution } from "../scf-runtime/shared/world-constitution.js";
import { buildCharacterImagePrompt } from "../scf-runtime/shared/media.js";
import { buildConversationPhotoPrompt } from "../scf-runtime/processor/chat-photo.js";
import {
  ACTIVITY_PLANS_KEY, activeActivityPlan, createActivityPlan, reconcileActivityPlans,
} from "../scf-runtime/shared/activity-plans.js";
import { LIFE_GOAL_CATEGORIES, emptyLifePlan, normalizeLifePlan, seedLifeGoals } from "../scf-runtime/shared/life-goals.js";

function alternateConfig() {
  return normalizeLifeEngineConfig({
    instance: { user_id: "user-2", character_id: "mian", storage_prefix: "instances/user-2/mian" },
    character: {
      name: "绵绵", species: "兔子", origin: "北方丘陵", core_personality: ["稳重", "细心", "有点慢热"],
      default_state: { activity: "整理船票", mood: "平静", current_intention: "去看看潮汐", possessions: ["绿色雨衣"], relationships: {} },
    },
    world: {
      name: "潮声港", summary: "一座会随潮汐和现实时间变化的虚构港镇。", initial_location: "旧灯塔客房",
      current_location: "旧灯塔客房", seed_places: ["旧灯塔客房", "码头"], timezone: "Asia/Tokyo",
      weather: { anchor: { id: "jp-yokohama", name: "横滨", timezone: "Asia/Tokyo" } },
    },
    visual: {
      identity_markers: ["灰白垂耳", "绿色雨衣"], signature_items: ["绿色雨衣"], stable_rules: ["纸雕般的柔和拟真"],
      unique_species: { species: "兔子", only_character_name: "绵绵", maximum_visible: 1 },
    },
  });
}

describe("configurable life engine and scheduler", () => {
  it("keeps Agent compatible and supports a second character without engine edits", () => {
    expect(validateLifeEngineConfig(DEFAULT_LIFE_ENGINE_CONFIG)).toEqual({ valid: true, errors: [] });
    const config = alternateConfig();
    const character = characterDefaults(config);
    expect(systemPrompt({ weather: "多云" }, character, [], config)).toContain("你是绵绵");
    expect(structuredChatPrompt({ world: {}, agent: character, currentScene: {}, worldCanon: [], recentEvents: [], memories: [], config }))
      .toContain("当前绵绵状态");
    const visual = buildCharacterImagePrompt({
      prompt: "绵绵站在码头", config, referenceImages: ["data:image/png;base64,AA=="], referenceRoles: ["identity"],
    });
    expect(visual).toContain("绵绵的身份参考");
    expect(visual).toContain("潮声港");
    expect(visual).not.toContain("小云唯一身份母版");
    const photo = buildConversationPhotoPrompt({
      agent_visible: true, agent_action: "看潮水", capture_timing: "now", current_location: "码头", location: "码头",
      subject: "潮水", requested_subject: "潮水", weather: "多云", local_time: "10:00", local_period: "上午",
      viewpoint: "第一视角", composition: "潮水居中", props: [], characters: ["绵绵"], required_character_count: 1,
      must_show: ["潮水"], must_not_show: [], continuity_notes: [], image_prompt_zh: "绵绵站在码头看潮水", request_type: "scene",
    }, config);
    expect(photo).toContain("绵绵在潮声港");
    expect(photo).toContain("灰白垂耳");
    expect(photo).not.toContain("云杉镇里只有这一只松鼠");
  });

  it("migrates seven lanes and creates real goals from persisted opportunities and unfinished matters", () => {
    const migrated = normalizeLifePlan({ schema_version: 1, goals: [{ id: "legacy", kind: "atlas", subject: "月见草", milestones: [], evidence: [] }] });
    expect(Object.keys(migrated.goal_lanes)).toEqual(LIFE_GOAL_CATEGORIES);
    expect(migrated.goals[0].category).toBe("interest_exploration");
    const seeded = seedLifeGoals(emptyLifePlan(), {
      agent: { location: "花园" }, worldCanon: {}, layeredMemory: {}, nowIso: "2026-09-08T02:00:00Z",
      worldTick: { perceivable_opportunities: [{ id: "rain-trace", location: "花园", description: "叶片上的雨珠" }] },
      openThreads: [{ id: "thread-1", status: "active", title: "归还地图", location: "邮局" },
        { id: "thread-2", status: "active", report_to_user: true, title: "看看花园" }],
    });
    expect(new Set(seeded.goals.map((goal) => goal.category))).toEqual(new Set([
      "environment_opportunity", "temporary_matter", "user_commitment",
    ]));
  });

  it("keys weather by fictional place/date and exposes the real anchor only as metadata", () => {
    const first = resolveWeatherState({ date: "2026-09-07", place: "花园", condition: "短时秋雨", now: new Date("2026-09-07T02:00:00Z") });
    const moved = resolveWeatherState({ saved: first, date: "2026-09-07", place: "咖啡馆", condition: "晴朗", now: new Date("2026-09-07T03:00:00Z") });
    expect(first).toMatchObject({ world_location: "云杉镇", place: "花园", condition: "短时秋雨" });
    expect(first.anchor.name).toBe("上海");
    expect(moved).toMatchObject({ place: "咖啡馆", condition: "晴朗", cache_status: "refreshed" });
    expect(first.world_location).not.toBe(first.anchor.name);
  });

  it("keeps ongoing work active and closes overdue plans with an event that cannot advance memory or goals", async () => {
    const values = new Map();
    const store = {
      async getJson(key, fallback) { return structuredClone(values.has(key) ? values.get(key) : fallback); },
      async putJson(key, value) { values.set(key, structuredClone(value)); },
    };
    const plan = createActivityPlan({ id: "meal-1", sourceEventId: "start", action: "meal", title: "吃午饭", location: "小店",
      startedAt: "2026-09-07T02:00:00Z", durationMinutes: 40 });
    values.set(ACTIVITY_PLANS_KEY, { items: [plan] });
    expect(activeActivityPlan(values.get(ACTIVITY_PLANS_KEY), new Date("2026-09-07T02:20:00Z"))?.id).toBe("meal-1");
    const result = await reconcileActivityPlans(store, { now: new Date("2026-09-07T03:00:00Z") });
    expect(result.transitions[0].status).toBe("completed");
    expect(values.get("events/2026-09-07/plan-meal-1-completed-1.json")).toMatchObject({
      life_plan_effect: null, memory_effect: null, npc_effect: null, fact_status: "committed",
    });
  });

  it("derives NPC tiers from persisted encounters and applies configured unique-species rules", () => {
    expect(npcRelationshipTier({})).toBe("background_resident");
    expect(npcRelationshipTier({ history: [{ event_id: "event-1" }] })).toBe("encountered_resident");
    expect(npcRelationshipTier({ relationship_note: "重要朋友" })).toBe("important_relationship");
    const tick = buildWorldTick({
      world: { date: "2026-09-07", season: "初秋", weather: "晴朗" }, agent: { location: "码头" },
      timeContext: { date: "2026-09-07", time: "10:00", period: "上午" }, nowIso: "2026-09-07T02:00:00Z",
      openThreads: [{ id: "thread-1", title: "归还地图", status: "active" }],
    });
    expect(tick.perceivable_opportunities.some((item) => item.source_type === "unfinished_matter")).toBe(true);
    expect(validateWorldConstitution({ candidate: { activity: "遇见另一只兔子", location: "码头" }, config: alternateConfig() }).violation_codes)
      .toContain("SECOND_UNIQUE_SPECIES");
  });
});
