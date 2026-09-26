import { describe, expect, it, vi } from "vitest";
import { runAutonomousHeartbeat, dailyActivityTarget, autonomyPacingDirective, violatesAutonomyPacing, isDuplicateEvent } from "../scf-runtime/processor/autonomy.js";
import { evaluateAutonomyCandidate } from "../scf-runtime/shared/autonomy-selection.js";
import { evaluateDirectedEvent } from "../scf-runtime/shared/life-director.js";
import { LIFE_PLAN_KEY, LIFE_PLAN_PENDING_KEY, emptyLifePlan, seedLifeGoals, goalFactsForChat } from "../scf-runtime/shared/life-goals.js";
import { OPEN_THREADS_KEY, emptyOpenThreads, upsertUserSuggestionThreads } from "../scf-runtime/shared/open-threads.js";
import { sharedExperienceFacts } from "../scf-runtime/shared/chat-promises.js";
import { DEFAULT_AGENT } from "../scf-runtime/shared/agent.js";
import { auditGoalsObservation } from "../scripts/lib/goals-observation-audit.mjs";

const places = ["云杉客栈二楼房间", "云杉客栈早餐厅", "小镇青石路", "花园", "咖啡馆", "旧书店", "邮局", "面包店"];
const worldCanon = { entities: [
  ...places.map((name, index) => ({ id: `place-${index}`, type: "place", name, lifecycle_status: "canonical", known_facts: ["亲自到过"] })),
  { id: "lily", type: "object", name: "月见草", lifecycle_status: "canonical", first_seen_location: "花园", known_facts: ["在花园亲眼见过"] },
  { id: "rong", type: "character", name: "花花", lifecycle_status: "canonical", first_seen_location: "旧书店", known_facts: ["灰白短绒猫"] },
] };
const reflections = [{ id: "preference-lily", reflection_type: "preference", content: "喜欢辨认月见草的细节" }];

function memoryStore() {
  const values = new Map(Object.entries({
    "state/world-canon.json": structuredClone(worldCanon),
    "state/memory/reflections.json": { items: reflections },
  }));
  return {
    values, failOnce: null,
    async getJson(key, fallback) { return structuredClone(values.has(key) ? values.get(key) : fallback); },
    async putJson(key, value) {
      if (this.failOnce === key) { this.failOnce = null; throw new Error("injected projection write failure"); }
      values.set(key, structuredClone(value));
    },
    async listKeys(prefix, limit = 100) { return [...values.keys()].filter((key) => key.startsWith(prefix)).sort().slice(0, limit); },
  };
}

function contextFromPrompt(prompt) {
  return JSON.parse(prompt.split("Deterministic Life Context for this heartbeat: ")[1].split("\n")[0]);
}

// A synthetic model follows the supplied decision, with varied but bounded prose.
// This exercises the real heartbeat and persistence, not an actual paid model.
function modelFixture(store, { modify = (event) => event } = {}) {
  return async (prompt) => {
    const context = contextFromPrompt(prompt);
    const decision = context.director;
    const selected = decision.selected;
    const recent = store.values.get("state/recent-events.json")?.events || [];
    const agent = store.values.get("state/agent.json") || DEFAULT_AGENT;
    const state = seedLifeGoals(store.values.get(LIFE_PLAN_KEY) || emptyLifePlan(), {
      worldCanon, agent, layeredMemory: { reflections }, nowIso: context.tick.observed_at,
    });
    const candidates = [];
    if (selected) {
      const subject = selected.subject;
      const activity = { observe: `观察${subject}`, learn: `研究${subject}`, write: `写日记记下${subject}`, organize: `整理${subject}`, social: `问候${subject}` }[selected.action];
      const narrative = {
        observe: `我观察了${subject}朝向光的一面，记下了细细的纹路。`,
        learn: `我对照了${subject}的旧记录，圈出了一个还不确定的地方。纸角有点卷，我轻轻压平了。`,
        write: `我把${subject}确认过的细节写成了一页，旁边的空白先留着。`,
        organize: `我把${subject}挪到顺手的位置，整理好了旁边的空处。看起来松快了一点。`,
        social: `我向${subject}轻声打了个招呼，交谈两句就告别了。走开后才觉得没那么紧张。`,
      }[selected.action];
      candidates.push({ location: selected.location, activity, narrative,
        goal_update: { goal_id: selected.goal_id, step_id: selected.step_id, operation: "advance", evidence: narrative } });
    } else {
      const ideas = [
        ["吃一块小点心", "我掰开了点心。边角先碎下来，刚好落在纸上。"],
        ["坐下休息片刻", "我坐了一会儿，脚底松快了些。杯子里的水还温着。"],
        ["读完一页旧记录", "我读完了旧纸上的一页。最后一行有个歪歪的字，原来是自己写的。"],
        ["整理随身地图", "我把折起的地图重新收好。原来夹住的是一小段线头。"],
        ["观察窗边的木纹", "我看见木头上有一道浅浅的弯纹。手指停在那里一会儿。"],
        ["沿着门边散步一圈", "我慢慢绕了一小圈，鞋边蹭了一点灰。回来把它拍掉了。"],
        ["练习把纸折整齐", "我沿着旧纸的折痕试了一遍。这回两边差不多齐了。"],
        ["写下一段小记", "我写下了门边听见的声音。写到最后，才发现漏了自己的脚步。"],
        ["探索墙角的影子", "我沿着墙角找到了影子的起点。原来是门框的一处缺口。"],
        ["喝茶歇歇脚", "我吹了吹茶，尝了一小口。热气把眼前遮白了一下。"],
        ["把围巾松开重新系好", "我松开了围巾，重新把歪着的一边系好。脖子松快了。"],
        ["辨认地图上的记号", "我对照旧路线辨认了一下记号。那条弯线确实是自己走过的转角。"],
        ["画下门框的轮廓", "我画了一小段门框。边线没能画直，却认得出那个转角。"],
        ["坐着打个短盹", "我把手拢起来打了个短盹。醒来时，桌面的亮处挪开了一点。"],
        ["沿窗边走走活动脚掌", "我慢慢走到窗边，又走回来。脚掌没刚才那么僵了。"],
        ["寻找外套上的线头", "我找到了衣边翘起的线头。轻轻拈了一下，就把手收回来了。"],
        ["把随身小物归置好", "我把钥匙和纸片分开放回口袋。摸了一遍，终于不用再翻找。"],
        ["吃完剩下的小饼", "我把剩下的小饼吃完了，碎屑拢在一起。最后一点倒进了纸包。"],
        ["看一会儿玻璃上的光", "我望着玻璃上的光斑。头偏过一点，它就不见了。"],
        ["学习理平卷起的纸角", "我把卷起的纸角压平，试着沿折痕轻轻抚了一遍。纸终于服帖些。"],
        ["读一遍自己的路线小记", "我重新读了一段路线小记。看到有个岔口还留着问号，便把那里记住。"],
        ["把今天的颜色记下来", "我在旧纸边画了一个浅浅的小方块。颜色和面前的木头还有点差别。"],
      ];
      for (const location of decision.allowed_locations) for (const [activity, narrative] of ideas) candidates.push({ location, activity, narrative });
    }
    const pacing = autonomyPacingDirective(recent, agent.location);
    const chosen = candidates.find((entry) => !isDuplicateEvent(entry, recent)
      && (!pacing.must_leave_inn || decision.mode === "rest" || !violatesAutonomyPacing(entry, pacing))
      && evaluateAutonomyCandidate(entry, recent, [], { currentLocation: agent.location, forceMovement: pacing.must_leave_inn }).accepted
      && evaluateDirectedEvent(entry, decision, state).accepted);
    if (!chosen) throw new Error(`No fixture candidate: ${JSON.stringify({ decision, recent: recent.map((item) => [item.location, item.activity]) })}`);
    return modify({ ...chosen, mood: "安静而满足", diary: chosen.narrative, message_to_user: chosen.narrative,
      next_intention: "留意下一件小事", photo_worthy: false, world_changes: {}, agent_changes: {}, world_observations: [] }, context);
  };
}

const env = { BOT_TIMEZONE: "Asia/Shanghai", IMAGE_MODE: "disabled", FEISHU_OWNER_OPEN_ID: "ou_test_owner" };
const eventAt = (now) => ({ Type: "Timer", TriggerName: "agent-heartbeat", Time: now.toISOString() });
const eventsIn = (store) => [...store.values.entries()].filter(([key]) => key.startsWith("events/")).map(([, event]) => event);

describe("default director through production heartbeat", () => {
  it("lives three consecutive days, advances remembered wishes, changes rain plans and preserves persona", async () => {
    const store = memoryStore();
    const sendText = vi.fn();
    const generateJson = vi.fn(modelFixture(store));
    const initialCharacter = structuredClone(DEFAULT_AGENT);
    for (const [day, weather] of [["2026-09-03", "晴朗"], ["2026-09-04", "正在下雨"], ["2026-09-05", "晴朗"]]) {
      // External environment input for the fixture; the director cannot change it.
      store.values.set("state/world.json", { date: day, weather, season: "初秋" });
      for (let slot = 0; slot < dailyActivityTarget(day); slot += 1) {
        const now = new Date(Date.parse(`${day}T07:00:00+08:00`) + slot * 135 * 60000);
        const result = await runAutonomousHeartbeat(store, eventAt(now), env, { now, generateJson, sendText });
        expect(result.event_id, JSON.stringify(result)).toBeTruthy();
        const beforeReplay = structuredClone(store.values.get(LIFE_PLAN_KEY));
        const duplicate = await runAutonomousHeartbeat(store, eventAt(now), env, { now, generateJson, sendText });
        expect(["not_due", "duplicate_heartbeat"]).toContain(duplicate.skipped);
        expect(store.values.get(LIFE_PLAN_KEY)).toEqual(beforeReplay);
      }
    }
    const events = eventsIn(store);
    const total = ["2026-09-03", "2026-09-04", "2026-09-05"].reduce((sum, day) => sum + dailyActivityTarget(day), 0);
    expect(events).toHaveLength(total);
    const ledger = store.values.get(LIFE_PLAN_KEY);
    expect(ledger.days.map((day) => day.date)).toEqual(["2026-09-03", "2026-09-04", "2026-09-05"]);
    const advances = events.filter((event) => event.director_outcome.status === "advanced");
    expect(advances).toHaveLength(3);
    expect(advances[0].director_outcome.goal_id).toBe(advances[1].director_outcome.goal_id);
    expect(advances[0].location).toBe("花园");
    expect(advances[1].location).not.toBe("花园");
    expect(new Set(advances.map((event) => event.activity)).size).toBe(3);
    expect(advances[2].director_outcome.topic).not.toBe("plants");
    expect(ledger.days.every((day) => new Set(day.events.map((event) => event.action)).size >= 2)).toBe(true);
    expect(events.every((event) => event.constitution_snapshot.accepted)).toBe(true);
    expect(events.every((event) => event.life_context_snapshot.director.persona_rule.includes("稍微社恐"))).toBe(true);
    expect(events.every((event) => Number(event.activity_duration_minutes) > 0)).toBe(true);
    expect(events.every((event) => Date.parse(event.activity_ends_at) > Date.parse(event.activity_started_at))).toBe(true);
    expect(events.every((event) => event.world_tick_snapshot.weather_state?.scope_id === "spruce-town")).toBe(true);
    expect(events.every((event) => event.life_context_snapshot.runtime_profile?.ownership?.mode === "single_owner")).toBe(true);
    expect(generateJson.mock.calls.every(([prompt]) => prompt.includes("安静、敏感、善良、好奇"))).toBe(true);
    expect(generateJson.mock.calls.some(([prompt]) => prompt.includes('"director_result":{"status":"done"'))).toBe(true);
    expect(generateJson.mock.calls.every(([prompt]) => !prompt.includes('"goal_update":null'))).toBe(true);
    expect(store.values.get("state/agent.json").possessions).toEqual(initialCharacter.possessions);
    expect(store.values.get("state/agent.json").relationships).toEqual(initialCharacter.relationships);
    for (const goal of ledger.goals) for (const evidence of goal.evidence) {
      const source = events.find((event) => event.id === evidence.event_id);
      expect(source.narrative).toContain(evidence.result);
    }
    expect(goalFactsForChat(ledger, "2026-09-05").recent_results).toHaveLength(3);
    expect(new Set(events.map((event) => event.narrative)).size).toBe(total);
    const audit = auditGoalsObservation({ events, lifePlan: ledger }, {
      startDate: "2026-09-03", nowIso: "2026-09-06T00:00:00+08:00",
    });
    expect(audit.mechanical_status, JSON.stringify(audit.checks.filter((check) => check.status !== "pass"))).toBe("pass");
    expect(audit.overall).toBe("persona_review_required");
  });

  it("falls back to ordinary life after a fabricated completion without advancing a goal", async () => {
    const store = memoryStore();
    const now = new Date("2026-09-03T02:00:00.000Z");
    const generateJson = vi.fn(modelFixture(store, { modify: (event) => ({ ...event,
      narrative: "我打算明天再去看看。", goal_update: { ...event.goal_update, evidence: "我打算明天再去看看。" } }) }));
    const result = await runAutonomousHeartbeat(store, eventAt(now), env, { now, generateJson, sendText: vi.fn() });
    expect(result.event_id).toBeTruthy();
    expect(generateJson).toHaveBeenCalledTimes(2);
    expect(generateJson.mock.calls[1][1]).toContain("Repair the supplied event result");
    expect(eventsIn(store)).toHaveLength(1);
    expect(eventsIn(store)[0].life_context_snapshot.director.fallback.reason).toBe("director_contract_rejected");
    expect(eventsIn(store)[0].director_outcome.status).toBe("unrelated");
    expect(eventsIn(store)[0].fallback_kind).toBe("director_safe");
    expect(eventsIn(store)[0].notified).toBe(false);
    expect(eventsIn(store)[0].message_to_user).toBe("");
    expect(store.values.get(LIFE_PLAN_KEY).goals.every((goal) => goal.evidence.length === 0)).toBe(true);
  });

  it("keeps a full fallback day moving without repeated text or fabricated goal progress", async () => {
    const store = memoryStore();
    const generateJson = vi.fn(modelFixture(store, { modify: (event) => ({ ...event,
      narrative: "我打算明天再去看看。", director_result: { status: "completed", evidence_sentence: "我打算明天再去看看。" },
    }) }));
    const narratives = [];
    const target = dailyActivityTarget("2026-09-03");
    for (let slot = 0; slot < target; slot += 1) {
      const now = new Date(Date.parse("2026-09-03T07:00:00+08:00") + slot * 135 * 60000);
      const result = await runAutonomousHeartbeat(store, eventAt(now), env, { now, generateJson, sendText: vi.fn() });
      expect(result.event_id, JSON.stringify(result)).toBeTruthy();
      narratives.push(eventsIn(store).at(-1).narrative);
    }
    expect(narratives).toHaveLength(target);
    expect(new Set(narratives).size).toBe(target);
    expect(eventsIn(store).every((event) => event.director_outcome.status === "unrelated")).toBe(true);
    expect(eventsIn(store).every((event) => event.notified === false)).toBe(true);
    expect(eventsIn(store).every((event) => event.fallback_kind === "director_safe")).toBe(true);
    expect(store.values.get(LIFE_PLAN_KEY).goals.every((goal) => goal.evidence.length === 0)).toBe(true);
  });

  it("repairs an interrupted wish write from the committed event on the next heartbeat, exactly once", async () => {
    const store = memoryStore();
    const now = new Date("2026-09-03T02:00:00.000Z");
    store.values.set(LIFE_PLAN_KEY, seedLifeGoals(emptyLifePlan(), {
      worldCanon, agent: DEFAULT_AGENT, layeredMemory: { reflections }, nowIso: now.toISOString(),
    }));
    store.failOnce = LIFE_PLAN_KEY;
    const generateJson = vi.fn(modelFixture(store));
    await expect(runAutonomousHeartbeat(store, eventAt(now), env, { now, generateJson, sendText: vi.fn() })).rejects.toThrow("projection write failure");
    expect(eventsIn(store)).toHaveLength(1);
    expect(store.values.get(LIFE_PLAN_PENDING_KEY).event_key).toBeTruthy();
    const later = new Date("2026-09-03T02:30:00.000Z");
    const result = await runAutonomousHeartbeat(store, eventAt(later), env, { now: later, generateJson, sendText: vi.fn() });
    expect(result.skipped).toBe("not_due");
    expect(generateJson).toHaveBeenCalledTimes(1);
    expect(store.values.get(LIFE_PLAN_KEY).goals.flatMap((goal) => goal.evidence)).toHaveLength(1);
    expect(store.values.get(LIFE_PLAN_PENDING_KEY)).toBeNull();
    await runAutonomousHeartbeat(store, eventAt(later), env, { now: later, generateJson, sendText: vi.fn() });
    expect(store.values.get(LIFE_PLAN_KEY).goals.flatMap((goal) => goal.evidence)).toHaveLength(1);
  });

  it.each(["ou_owner", "ou_test_owner"])("reports a shared experience without misattributing its author %s", async (author) => {
    const store = memoryStore();
    const now = new Date("2026-09-03T02:00:00.000Z");
    store.values.set(OPEN_THREADS_KEY, upsertUserSuggestionThreads(emptyOpenThreads(), [{
      title: "去旧书店看看月见草的图鉴",
      stance: "accepted",
      suggested_by: author,
    }], { eventId: "chat-suggest", location: "旅馆房间", nowIso: now.toISOString() }));
    const sendText = vi.fn();
    const generateJson = vi.fn(async () => ({
      location: "旧书店",
      activity: "去旧书店翻月见草图鉴",
      narrative: "我按你说的去旧书店看了月见草那一页。",
      diary: "我按你说的去旧书店看了月见草那一页。",
      message_to_user: "",
      notify_user: false,
      photo_worthy: false,
      world_changes: {},
      agent_changes: {},
      world_observations: [],
    }));
    const result = await runAutonomousHeartbeat(store, eventAt(now), {
      ...env,
      AUTONOMY_GOALS_ENABLED: "false",
    }, { now, generateJson, sendText });
    expect(result.event_id, JSON.stringify(result)).toBeTruthy();
    const event = eventsIn(store)[0];
    expect(event.selected_thread_id).toBeTruthy();
    const receipts = [...store.values.values()].filter((value) => value?.shared_experience_ids);
    const facts = sharedExperienceFacts(store.values.get(OPEN_THREADS_KEY), [event], receipts);
    expect(facts[0].influenced_later).toBe(true);
    expect(facts[0].result_event_ids).toContain(event.id);
    expect(facts[0].suggested_by).toBe(author);
    expect(facts[0].reported_back).toBe(author === env.FEISHU_OWNER_OPEN_ID);
    const attribution = author === env.FEISHU_OWNER_OPEN_ID ? /你说过/ : /之前有人建议/;
    expect(event.message_to_user).toMatch(attribution);
    expect(sendText).toHaveBeenCalled();
    expect(String(sendText.mock.calls[0][1])).toMatch(attribution);
    expect(event.memory_updates?.some((item) => item.predicate === "user_suggestion_result")
      || store.values.get("state/agent-memories.json")?.memories?.some((item) => (
        String(item.content || "").includes("来自用户")
      ))).toBe(true);
  });
});
