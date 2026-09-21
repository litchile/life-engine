import { describe, expect, it } from "vitest";
import {
  autonomyPacingDirective,
  isDuplicateEvent,
  runAutonomousHeartbeat,
  violatesAutonomyPacing,
} from "../scf-runtime/processor/autonomy.js";
import { evaluateAutonomyCandidate } from "../scf-runtime/shared/autonomy-selection.js";

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

const LOCATIONS = [
  "云杉客栈二楼房间",
  "小镇青石路",
  "面包店",
  "花店",
  "旧书店",
  "邮局",
  "河边小路",
  "旧石桥",
  "湖边",
  "旧磨坊",
  "小镇广场",
];

const STAY_EVENTS = [
  ["向附近的镇民问候并听到一条新消息", "对方告诉小云钟楼旁新挂了一块手写告示。"],
  ["对照图鉴辨认一种以前没见过的叶片", "叶缘的细齿让小云排除了书里最相似的那一页。"],
  ["吃一份符合当前时段的小点心", "刚出炉的薄饼外沿很脆，里面带一点苹果香。"],
  ["把今天的新发现写进随身日记", "墨水在旧纸上慢慢晕开，最后留下三行简短记录。"],
  ["读完小册子的下一页并找到一个线索", "页脚画着一座石桥，旁边标出退潮后才看得见的路。"],
  ["整理这段路真正需要的随身物品", "小云留下地图和水壶，把不需要的东西收回皮箱。"],
  ["观察此处今天不同的光线和声音", "风把门铃吹响两次，屋檐下的影子也比上午短了。"],
  ["坐下休息片刻再重新出发", "短暂打盹后，小云把围巾重新系好。"],
  ["沿着附近的小路散步一圈", "石缝里的苔藓在背阴处颜色更深，脚步声也变轻了。"],
  ["探索柜台旁一张旧地图标出的角落", "地图上褪色的蓝点原来对应一口仍能使用的水井。"],
  ["帮忙把一只歪掉的木牌扶正", "木牌重新站稳后，路过的镇民朝小云点了点头。"],
  ["去窗口取回一封刚到的小信", "信封边缘沾着一片细小的银杏叶。"],
];

function committedEvents(store) {
  return [...store.values.entries()]
    .filter(([key]) => /^events\/\d{4}-\d{2}-\d{2}\//.test(key))
    .map(([, value]) => value)
    .sort((left, right) => left.occurred_at.localeCompare(right.occurred_at));
}

function generatedEvent(store) {
  const recent = store.values.get("state/recent-events.json")?.events || [];
  const currentLocation = store.values.get("state/agent.json")?.location || LOCATIONS[0];
  const index = committedEvents(store).length;
  const currentIndex = Math.max(0, LOCATIONS.indexOf(currentLocation));
  const candidates = [];

  for (let offset = 0; offset < STAY_EVENTS.length; offset += 1) {
    const [activity, result] = STAY_EVENTS[(index + offset) % STAY_EVENTS.length];
    candidates.push({
      location: currentLocation,
      activity,
      narrative: `${result} 记录编号${index + 1}-${offset + 1}。`,
    });
  }
  for (const step of [1, 2, 3]) {
    const destination = LOCATIONS[(currentIndex + step) % LOCATIONS.length];
    candidates.push({
      location: destination,
      activity: `离开${currentLocation}后沿路到达${destination}`,
      narrative: `从${currentLocation}走向${destination}时，路标背后新露出一道窄石阶；本次路线编号${index + 1}-${step}。`,
    });
  }

  const pacing = autonomyPacingDirective(recent, currentLocation);
  const candidate = candidates.find((entry) => (
    !isDuplicateEvent(entry, recent)
    && !violatesAutonomyPacing(entry, pacing)
    && evaluateAutonomyCandidate(entry, recent, [], {
      currentLocation,
      forceMovement: pacing.must_leave_inn,
    }).accepted
  ));
  if (!candidate) {
    const diagnostics = candidates.map((entry) => ({
      location: entry.location,
      activity: entry.activity,
      duplicate: isDuplicateEvent(entry, recent),
      pacing: violatesAutonomyPacing(entry, pacing),
      gate: evaluateAutonomyCandidate(entry, recent, [], {
        currentLocation,
        forceMovement: pacing.must_leave_inn,
      }).reasons,
      action: evaluateAutonomyCandidate(entry, recent, [], {
        currentLocation,
        forceMovement: pacing.must_leave_inn,
      }).candidate_action,
    }));
    throw new Error(`No full-heartbeat candidate passed at event ${index + 1}; recent=${JSON.stringify(recent.map((entry) => ({ location: entry.location, activity: entry.activity })))}; candidates=${JSON.stringify(diagnostics)}`);
  }

  const discoveryIndex = [12, 36, 60, 84].indexOf(index);
  const confirmationIndex = [13, 37, 61, 85].indexOf(index);
  const entityIndex = Math.max(discoveryIndex, confirmationIndex);
  const entity = ["兔子花店老板", "鹿邮差", "花猫旧书店客人", "水獭磨坊看守"][entityIndex];
  const entityType = "character";
  const worldObservations = entityIndex >= 0 ? [{
    entity_type: entityType,
    name: entity,
    observed_facts: [confirmationIndex >= 0 ? "另一次经过时再次确认" : "第一次直接看见"],
    visual_facts: ["穿着朴素的工作服", "是非松鼠的镇民"],
    relationship_note: "仍在慢慢熟悉",
    status_observed: "当前可见",
    knowledge_source: "direct_observation",
  }] : [];

  return {
    event_type: "daily_life",
    ...candidate,
    mood: index % 3 === 0 ? "安静而满足" : "好奇但不慌张",
    importance: 1 + (index % 3),
    notify_user: index % 9 === 0,
    message_to_user: `今天发生了第${index + 1}件小事。我确实往前走了一点。`,
    diary: candidate.narrative,
    photo_worthy: false,
    photo_description: "",
    image_prompt_zh: "",
    image_prompt_en: "",
    next_intention: `继续弄清${candidate.location}附近的一件具体小事`,
    selected_thread_id: null,
    thread_updates: [],
    world_changes: {},
    agent_changes: {},
    memory_updates: [],
    world_observations: worldObservations,
  };
}

describe("SCF full autonomous heartbeat long run", () => {
  it("commits 100 events through the production heartbeat path with retries and idempotency", async () => {
    const seedPlaces = LOCATIONS.map((name, index) => ({
      id: `seed-place-${index + 1}`,
      identity: `place:${name}`,
      type: "place",
      name,
      aliases: [],
      lifecycle_status: "canonical",
      known_facts: ["已确认可连续到达的小镇地点"],
      visual_facts: [],
      history: [],
    }));
    const store = memoryStore({
      "state/world-canon.json": { schema_version: 1, entities: seedPlaces, updated_at: null },
    });
    const env = {
      // Keep the prior-generation long run as rollback coverage; the default
      // director path is exercised separately with persisted multi-day wishes.
      AUTONOMY_GOALS_ENABLED: "false",
      BOT_TIMEZONE: "Asia/Shanghai",
      FEISHU_OWNER_OPEN_ID: "ou_test_owner",
      AUTONOMY_MIN_DAILY_MESSAGES: "2",
      AUTONOMY_MAX_DAILY_MESSAGES: "3",
      AUTONOMY_OUTBOX_REPLAY_LIMIT: "5",
      IMAGE_MODE: "disabled",
    };
    let sendAttempts = 0;
    const failedOnce = new Set([3, 11, 19]);
    const sendText = async () => {
      sendAttempts += 1;
      if (failedOnce.delete(sendAttempts)) throw new Error("injected temporary Feishu outage");
    };
    const generateJson = async () => generatedEvent(store);
    const start = Date.parse("2026-08-01T00:00:00.000Z");
    const results = [];

    for (let index = 0; index < 100; index += 1) {
      const now = new Date(start + index * 200 * 60_000);
      const event = {
        Type: "Timer",
        TriggerName: "agent-heartbeat",
        Time: now.toISOString(),
      };
      const result = await runAutonomousHeartbeat(store, event, env, {
        now,
        force: true,
        idempotencyKey: `longrun-${index}`,
        generateJson,
        sendText,
      });
      results.push(result);
      expect(result.ok).toBe(true);
      expect(result.event_id, `heartbeat ${index + 1} failed: ${JSON.stringify(result)}`).toBeTruthy();

      if (index % 13 === 0) {
        const frontierDecisionsBeforeReplay = store.values.get("state/frontiers.json")?.decisions?.length || 0;
        const worldTickBeforeReplay = structuredClone(store.values.get("state/world-tick.json"));
        const duplicate = await runAutonomousHeartbeat(store, event, env, {
          now,
          force: true,
          idempotencyKey: `longrun-${index}`,
          generateJson,
          sendText,
        });
        expect(duplicate.skipped).toBe("duplicate_heartbeat");
        expect(committedEvents(store)).toHaveLength(index + 1);
        expect(store.values.get("state/frontiers.json")?.decisions?.length || 0).toBe(frontierDecisionsBeforeReplay);
        expect(store.values.get("state/world-tick.json")).toEqual(worldTickBeforeReplay);
      }
    }

    const events = committedEvents(store);
    const locations = new Set(events.map((event) => event.location));
    const outboxes = [...store.values.entries()]
      .filter(([key]) => key.startsWith("outbox/notifications/"))
      .map(([, value]) => value);
    const workflows = [...store.values.entries()]
      .filter(([key]) => key.startsWith("workflows/autonomy/"))
      .map(([, value]) => value);
    const canon = store.values.get("state/world-canon.json");
    const lifeContext = store.values.get("state/life-context.json");
    const worldTick = store.values.get("state/world-tick.json");

    expect(events).toHaveLength(100);
    expect(new Set(events.map((event) => event.id)).size).toBe(100);
    expect(locations.size).toBeGreaterThanOrEqual(8);
    expect(events.filter((event) => /旅馆/.test(event.location)).length).toBeLessThan(45);
    expect(workflows.filter((workflow) => workflow.status === "completed")).toHaveLength(100);
    expect(outboxes.length).toBeGreaterThanOrEqual(20);
    expect(outboxes.every((outbox) => outbox.status === "sent")).toBe(true);
    expect(store.values.get("state/autonomy.json").daily_activity_count).toBeGreaterThan(0);
    const discoveredCanon = canon.entities.filter((entity) => (
      entity.lifecycle_status === "canonical" && entity.discovery_evidence?.frontier_id
    ));
    const frontierRegistry = store.values.get("state/frontiers.json");
    expect(discoveredCanon).toHaveLength(4);
    expect(frontierRegistry.items.filter((item) => item.state === "discovered")).toHaveLength(4);
    expect(new Set(frontierRegistry.decisions.map((decision) => decision.id)).size).toBe(frontierRegistry.decisions.length);
    expect(events.every((event) => event.discovery_snapshot?.schema_version === 1)).toBe(true);
    expect(events.every((event) => event.world_tick_snapshot?.tick_id)).toBe(true);
    expect(events.every((event) => event.constitution_snapshot?.accepted === true)).toBe(true);
    expect(events.every((event) => event.constitution_snapshot?.constitution_version === "phase1-v5")).toBe(true);
    expect(events.some((event) => event.world_tick_snapshot?.temporary_events?.length > 0)).toBe(true);
    expect(worldTick).toMatchObject({
      schema_version: 1,
      committed_event_id: events.at(-1).id,
    });
    expect(lifeContext).toMatchObject({
      schema_version: 1,
      committed_event_id: events.at(-1).id,
    });
    expect(lifeContext.motivations.length).toBeGreaterThanOrEqual(4);
    expect(lifeContext.goal_stack.length).toBeGreaterThanOrEqual(2);
    expect(events.every((event) => event.life_context_snapshot?.tick?.observed_at)).toBe(true);
    expect(results.every((result) => result.notification_status !== "dead_letter")).toBe(true);
  }, 30_000);
});
