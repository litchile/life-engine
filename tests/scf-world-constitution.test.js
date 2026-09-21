import { describe, expect, it } from "vitest";
import { runAutonomousHeartbeat } from "../scf-runtime/processor/autonomy.js";
import { validateWorldConstitution } from "../scf-runtime/shared/world-constitution.js";

const room = {
  id: "place-room",
  identity: "place:云杉客栈二楼房间",
  type: "place",
  name: "云杉客栈二楼房间",
  aliases: [],
  lifecycle_status: "canonical",
};

const street = {
  id: "place-street",
  identity: "place:小镇青石路",
  type: "place",
  name: "小镇青石路",
  aliases: [],
  lifecycle_status: "canonical",
};

const baseCandidate = {
  event_type: "daily_life",
  location: room.name,
  activity: "整理花草图册的夹页",
  mood: "安静而专注",
  narrative: "小云把夹在图鉴里的叶片重新放平，并记下叶缘的形状。",
  importance: 1,
  notify_user: false,
  message_to_user: "",
  diary: "今天整理了一页图鉴。",
  photo_worthy: false,
  photo_description: "",
  image_prompt_zh: "",
  image_prompt_en: "",
  next_intention: "午后沿熟悉的路去看看植物",
  selected_thread_id: null,
  thread_updates: [],
  world_changes: {},
  agent_changes: {},
  memory_updates: [],
  world_observations: [],
};

function validate(candidate, overrides = {}) {
  return validateWorldConstitution({
    candidate,
    currentState: { location: room.name },
    worldTick: { local_time: "10:20", period: "上午" },
    worldCanon: { schema_version: 1, entities: [room, street] },
    discoveryGate: { accepted: [], decisions: [] },
    checkedAt: "2026-08-09T02:20:00.000Z",
    ...overrides,
  });
}

function memoryStore(initial = {}) {
  const values = new Map(Object.entries(initial).map(([key, value]) => [key, structuredClone(value)]));
  return {
    values,
    async getJson(key, fallback = null) {
      return values.has(key) ? structuredClone(values.get(key)) : structuredClone(fallback);
    },
    async putJson(key, value) {
      values.set(key, structuredClone(value));
    },
    async putObject(key, body, contentType = "application/octet-stream") {
      values.set(key, { body: Buffer.from(body), contentType });
    },
    async getObject(key) {
      const value = values.get(key);
      if (!value) throw new Error(`Missing object: ${key}`);
      return value;
    },
    async listKeys(prefix, limit = 100) {
      return [...values.keys()].filter((key) => key.startsWith(prefix)).sort().slice(0, limit);
    },
  };
}

describe("versioned mechanical world constitution", () => {
  it("rejects a second squirrel and a squirrel NPC with structured codes", () => {
    const result = validate({
      ...baseCandidate,
      activity: "和另一只松鼠一起看图鉴",
      narrative: "第二只松鼠从走廊过来，成为新的旅馆客人。",
      world_observations: [{
        entity_type: "character",
        name: "松鼠朋友",
        observed_facts: ["住在旅馆"],
        visual_facts: ["黑白松鼠"],
        knowledge_source: "direct_observation",
      }],
    });
    expect(result.accepted).toBe(false);
    expect(result.constitution_version).toBe("phase1-v5");
    expect(result.violation_codes).toEqual(expect.arrayContaining([
      "SECOND_UNIQUE_SPECIES",
      "NPC_MUST_NOT_USE_UNIQUE_SPECIES",
    ]));
    expect(result.violation_codes).not.toContain("UNAUTHORIZED_LOCATION_EXPANSION");
  });

  it("allows a continuous journey to a plausible new spruce-town place without a registered path", () => {
    const creek = validate({
      ...baseCandidate,
      location: "小镇溪边的草坪",
      activity: "离开房间，沿着石阶走到溪边的草坪坐下",
      narrative: "小云下楼走出旅馆，沿着熟悉的石阶慢慢走到小镇溪边的草坪，听流水声。",
      world_observations: [{
        entity_type: "place",
        name: "小镇溪边的草坪",
        observed_facts: ["溪水清亮", "草很软"],
        visual_facts: ["浅绿色草坪", "窄溪流"],
        knowledge_source: "direct_observation",
      }],
    }, {
      discoveryGate: {
        accepted: [{
          entity_type: "place",
          name: "小镇溪边的草坪",
        }],
        decisions: [{
          outcome: "allowed",
          consumed_growth_budget: false,
          replayed: false,
        }],
      },
    });
    expect(creek).toMatchObject({ accepted: true, violation_codes: [], constitution_version: "phase1-v5" });
  });

  it("does not abort a life event when a discovery is only deferred", () => {
    const result = validate({
      ...baseCandidate,
      location: street.name,
      activity: "离开房间，下楼后沿着门前石阶走到小镇青石路",
      narrative: "小云系好围巾，穿过旅馆前厅后沿熟悉的石阶慢慢走到青石路。",
      world_observations: [{
        entity_type: "object",
        name: "路边木牌",
        observed_facts: ["写着集市方向"],
        knowledge_source: "direct_observation",
      }],
    }, {
      discoveryGate: {
        accepted: [],
        decisions: [{
          outcome: "deferred",
          reasons: ["growth_budget_exhausted"],
          consumed_growth_budget: false,
          replayed: false,
        }],
      },
    });
    expect(result).toMatchObject({ accepted: true, violation_codes: [] });
  });

  it("rejects teleport language, but allows impulsive arrival without step-by-step movement verbs", () => {
    const impossible = validate({
      ...baseCandidate,
      location: "山外港口",
      activity: "瞬间出现在港口",
      narrative: "小云一眨眼就到了从未听说过的港口。",
    });
    expect(impossible.violation_codes).toEqual(expect.arrayContaining([
      "MOVEMENT_DISCONTINUITY",
    ]));
    expect(impossible.violation_codes).not.toContain("UNAUTHORIZED_LOCATION_EXPANSION");

    const impulsive = validate({
      ...baseCandidate,
      location: street.name,
      activity: "忽然想去青石路看看",
      narrative: "小云脑子里冒出一个念头，人已经在小镇青石路上了。",
    });
    expect(impulsive).toMatchObject({ accepted: true, violation_codes: [] });

    const corrected = validate({
      ...baseCandidate,
      location: street.name,
      activity: "离开房间，下楼后沿着门前石阶走到小镇青石路",
      narrative: "小云系好围巾，穿过旅馆前厅后沿熟悉的石阶慢慢走到青石路。",
    });
    expect(corrected).toMatchObject({ accepted: true, violation_codes: [] });
  });

  it("rejects time conflicts, macro crises, economic pressure and user-centered dependence", () => {
    const result = validate({
      ...baseCandidate,
      activity: "深夜入睡前吃早餐",
      narrative: "世界末日快到了。因为你没有回复，小云必须充值才能拯救全世界。",
    }, { worldTick: { local_time: "14:30", period: "下午" } });
    expect(result.violation_codes).toEqual(expect.arrayContaining([
      "TIME_CONFLICT",
      "TONE_MACRO_CRISIS",
      "TONE_ECONOMIC_COERCION",
      "USER_CENTERED_EVENT",
    ]));
  });

  it("allows afternoon mentions of 月见草 and late-afternoon dusk without treating them as night sky", () => {
    const flower = validate({
      ...baseCandidate,
      location: street.name,
      activity: "离开房间，沿着石阶走到青石路，想起图鉴里的月见草",
      narrative: "下午的青石路上风很轻。小云把月见草的开放规律又在心里过了一遍，决定先去书店看看。",
      diary: "今天又想到月见草。",
    }, { worldTick: { local_time: "17:00", period: "下午" } });
    expect(flower).toMatchObject({ accepted: true, violation_codes: [] });

    const dusk = validate({
      ...baseCandidate,
      location: street.name,
      activity: "离开房间，沿着石阶走到青石路看暮色",
      narrative: "接近傍晚，青石路尽头有一点晚霞，小云慢慢往前走。",
    }, { worldTick: { local_time: "17:00", period: "下午" } });
    expect(dusk).toMatchObject({ accepted: true, violation_codes: [] });

    const trueNight = validate({
      ...baseCandidate,
      activity: "站在窗边看夜色",
      narrative: "天黑了，月光很亮。",
    }, { worldTick: { local_time: "17:00", period: "下午" } });
    expect(trueNight.violation_codes).toContain("TIME_CONFLICT");
  });

  it("persists rejection diagnostics, creates no event or media task, and recovers on a later valid heartbeat", async () => {
    const store = memoryStore({
      "state/world-canon.json": { schema_version: 1, entities: [room, street], updated_at: null },
    });
    const env = {
      AUTONOMY_GOALS_ENABLED: "false", // Isolate constitution rejection from goal-result validation.
      BOT_TIMEZONE: "Asia/Shanghai",
      FEISHU_OWNER_OPEN_ID: "ou_test_owner",
      IMAGE_MODE: "manual",
    };
    const badCandidate = {
      ...baseCandidate,
      activity: "和另一只松鼠一起整理图鉴",
      narrative: "第二只松鼠坐在小云旁边。",
      photo_worthy: true,
      photo_description: "两只松鼠一起看书",
    };
    const firstNow = new Date("2026-08-09T02:20:00.000Z");
    const rejected = await runAutonomousHeartbeat(store, {
      Type: "Timer", TriggerName: "agent-heartbeat", Time: firstNow.toISOString(),
    }, env, {
      now: firstNow,
      force: true,
      idempotencyKey: "constitution-reject",
      generateJson: async () => badCandidate,
    });
    expect(rejected).toMatchObject({ ok: true, skipped: "constitution_rejected" });
    expect(rejected.violation_codes).toContain("SECOND_UNIQUE_SPECIES");
    expect([...store.values.keys()].filter((key) => key.startsWith("events/"))).toEqual([]);
    expect([...store.values.keys()].filter((key) => key.startsWith("image-tasks/"))).toEqual([]);
    expect(store.values.get(rejected.diagnostic_key)).toMatchObject({
      stage: "constitution",
      media_task_created: false,
      constitution_snapshot: { accepted: false },
    });

    const secondNow = new Date("2026-08-09T03:30:00.000Z");
    const recovered = await runAutonomousHeartbeat(store, {
      Type: "Timer", TriggerName: "agent-heartbeat", Time: secondNow.toISOString(),
    }, env, {
      now: secondNow,
      force: true,
      idempotencyKey: "constitution-recovery",
      generateJson: async () => baseCandidate,
    });
    expect(recovered.ok).toBe(true);
    expect(recovered.event_id).toBeTruthy();
    const committed = store.values.get(`events/2026-08-09/${recovered.event_id}.json`);
    expect(committed).toMatchObject({
      constitution_snapshot: { accepted: true, constitution_version: "phase1-v5" },
      discovery_snapshot: { schema_version: 1 },
    });
  });
});
