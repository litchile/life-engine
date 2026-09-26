import { describe, expect, it } from "vitest";
import { defaultEmotionState } from "../scf-runtime/shared/emotion.js";
import { DEFAULT_AGENT, systemPrompt } from "../scf-runtime/shared/agent.js";
import { structuredChatPrompt } from "../scf-runtime/shared/chat-memory.js";
import { emptyLifePlan, seedLifeGoals, nextGoalStep, createLifePlanEffect, applyLifePlanEffect, goalFactsForChat } from "../scf-runtime/shared/life-goals.js";
import { adaptDirectedEvent, buildLifeDirector, evaluateDirectedEvent, needsIndoorPlan } from "../scf-runtime/shared/life-director.js";
import { autonomyActionFamily } from "../scf-runtime/shared/autonomy-selection.js";

export const canonFixture = { entities: [
  ...["云杉客栈二楼房间", "云杉客栈早餐厅", "小镇青石路", "花园", "咖啡馆", "旧书店", "邮局"].map((name, index) => ({
    id: `place-${index}`, type: "place", name, lifecycle_status: "canonical", known_facts: ["亲自到过"],
  })),
  { id: "plant-lily", type: "object", name: "月见草", lifecycle_status: "canonical", first_seen_location: "花园", known_facts: ["在花园亲眼见过"] },
  { id: "cat-rong", type: "character", name: "花花", lifecycle_status: "canonical", first_seen_location: "旧书店", known_facts: ["灰白短绒猫"] },
  { id: "unknown-rabbit", type: "character", name: "陌生兔子", lifecycle_status: "provisional", first_seen_location: "咖啡馆" },
] };

export function directorInput(overrides = {}) {
  const nowIso = "2026-09-03T02:00:00.000Z";
  const agent = { ...DEFAULT_AGENT };
  const worldCanon = structuredClone(canonFixture);
  const layeredMemory = { reflections: [{ id: "memory-lily-interest", reflection_type: "preference", content: "喜欢慢慢辨认月见草的细节" }] };
  return {
    state: seedLifeGoals(emptyLifePlan(), { worldCanon, agent, layeredMemory, nowIso }),
    worldTick: { local_date: "2026-09-03", local_time: "10:00", observed_at: nowIso, weather: "晴朗" },
    agent, worldCanon, emotionState: defaultEmotionState(nowIso), recentEvents: [], openThreads: [],
    ...overrides,
  };
}

export function eventForSelection(selected, overrides = {}) {
  const subject = selected.subject;
  const actionText = { observe: `观察${subject}`, learn: `研究${subject}`, write: `写日记记下${subject}`, social: `轻声问候${subject}`, organize: `整理${subject}` }[selected.action];
  const stepIndex = Number(selected.step_id.slice(-1));
  const resultText = { observe: `我观察了${subject}朝向光的一面，记下了一条细节`,
    learn: stepIndex === 1 ? `我整理了${subject}已有的记录，把散落的细节归到一起` : `我对照了${subject}已有的记录，把一个未确认的地方圈了出来`,
    write: `我把${subject}核实过的细节写成了一页，空白的地方先留着`,
    social: stepIndex === 1 ? `我向${subject}轻声打了个招呼，交谈了两句就告别了` : `我和${subject}又聊了两句先前的见闻，这次告别时不那么拘谨了`,
    organize: [null, `我整理了${subject}附近的小角落，把挤在一起的东西分开`, `我把${subject}挪到顺手的位置，整理好了旁边的一小块空处`, `我用过了${subject}，又调整了它的位置，拿取时方便了一点`][stepIndex],
  }[selected.action];
  return {
    location: selected.location, activity: actionText, narrative: resultText,
    mood: "安静而满足", diary: resultText, message_to_user: resultText, next_intention: "留意下一件小事",
    goal_update: { goal_id: selected.goal_id, step_id: selected.step_id, operation: "advance", evidence: resultText },
    ...overrides,
  };
}

describe("persistent wishes and daily director", () => {
  it("grounds wishes in canonical memories and possessions, with preference provenance and no duplicate reseeding", () => {
    const input = directorInput();
    const goals = input.state.goals;
    expect(goals).toHaveLength(3);
    expect(goals.find((goal) => goal.kind === "atlas")).toMatchObject({ subject: "月见草", preference_source_id: "memory-lily-interest" });
    expect(goals.some((goal) => goal.subject === "陌生兔子")).toBe(false);
    expect(seedLifeGoals(input.state, { worldCanon: input.worldCanon, agent: input.agent, nowIso: "2026-09-04T02:00:00Z" }).goals).toEqual(goals);
    expect(seedLifeGoals(null, { worldCanon: {}, agent: {}, nowIso: "2026-09-03" }).goals).toEqual([]);
  });

  it("makes a weather-dependent decision while keeping the wish and distinguishes rain from rain having ended", () => {
    const input = directorInput();
    const dry = buildLifeDirector(input);
    const wet = buildLifeDirector({ ...input, worldTick: { ...input.worldTick, weather: "正在下雨" } });
    expect(dry.selected).toMatchObject({ subject: "月见草", location: "花园", action: "observe" });
    expect(wet.selected.goal_id).toBe(dry.selected.goal_id);
    expect(wet.selected.action).toBe("learn");
    expect(wet.selected.location).not.toBe("花园");
    expect(needsIndoorPlan("雨后空气清透")).toBe(false);
    expect(needsIndoorPlan("晨雾后转晴")).toBe(false);
    expect(needsIndoorPlan("雷阵雨")).toBe(true);
  });

  it("refreshes an existing wish when canonical memory changes, without resetting its progress", () => {
    const input = directorInput();
    const priorWish = input.state.goals.find((goal) => goal.kind === "relationship");
    priorWish.milestones[0].status = "completed";
    priorWish.evidence.push({ event_id: "earlier-encounter", result: "我向花花问了好" });
    const changed = structuredClone(input.worldCanon);
    const cat = changed.entities.find((entity) => entity.id === "cat-rong");
    cat.name = "花花的新名字";
    cat.history = [{ location: "咖啡馆" }];
    const refreshed = seedLifeGoals(input.state, { worldCanon: changed, agent: input.agent, nowIso: "2026-09-04T02:00:00Z" });
    const wish = refreshed.goals.find((goal) => goal.id === priorWish.id);
    expect(wish).toMatchObject({ subject: "花花的新名字", location: "咖啡馆" });
    expect(wish.evidence).toEqual(priorWish.evidence);
    expect(wish.milestones[0].status).toBe("completed");
    cat.lifecycle_status = "provisional";
    const unconfirmed = seedLifeGoals(refreshed, { worldCanon: changed, agent: input.agent, nowIso: "2026-09-05T02:00:00Z" });
    expect(unconfirmed.goals.find((goal) => goal.id === wish.id)).toMatchObject({ status: "paused", source_unavailable: true });
    expect(goalFactsForChat(unconfirmed).wishes.some((goal) => goal.title.includes("花花的新名字"))).toBe(false);
    cat.lifecycle_status = "canonical";
    const restored = seedLifeGoals(unconfirmed, { worldCanon: changed, agent: input.agent, nowIso: "2026-09-06T02:00:00Z" });
    expect(restored.goals.find((goal) => goal.id === wish.id)).toMatchObject({ status: "active", source_unavailable: false });
    expect(restored.goals).toHaveLength(3);
  });

  it("will not count intention, invented evidence, the wrong wish or a skipped milestone as progress", () => {
    const input = directorInput();
    const decision = buildLifeDirector(input);
    const valid = eventForSelection(decision.selected);
    expect(evaluateDirectedEvent(valid, decision, input.state).accepted).toBe(true);
    const future = "我打算明天观察月见草，记下新的细节";
    expect(evaluateDirectedEvent({ ...valid, narrative: future, goal_update: { ...valid.goal_update, evidence: future } }, decision, input.state).reasons).toContain("unbacked_goal_progress");
    expect(evaluateDirectedEvent({ ...valid, goal_update: { ...valid.goal_update, evidence: "已经完成图鉴" } }, decision, input.state).accepted).toBe(false);
    expect(evaluateDirectedEvent({ ...valid, goal_update: { ...valid.goal_update, goal_id: "invented" } }, decision, input.state).accepted).toBe(false);
    expect(evaluateDirectedEvent({ ...valid, goal_update: { ...valid.goal_update, step_id: "last-step" } }, decision, input.state).accepted).toBe(false);
    expect(evaluateDirectedEvent({ ...valid, goal_update: null }, decision, input.state).accepted).toBe(false);
    expect(evaluateDirectedEvent({ ...valid, narrative: "我没有观察月见草的细节。", goal_update: { ...valid.goal_update, evidence: "观察月见草的细节" } }, decision, input.state).accepted).toBe(false);
  });

  it("adapts natural model result words and repairs evidence without trusting model IDs", () => {
    const input = directorInput();
    const decision = buildLifeDirector(input);
    const selected = decision.selected;
    const narrative = `我在${selected.location}观察了${selected.subject}朝向光的一面，记下了一条细节。`;
    const adapted = adaptDirectedEvent({
      location: selected.location,
      activity: `把${selected.subject}记进小本子`,
      narrative,
      director_result: { status: "completed", evidence_sentence: `我留意了${selected.subject}。` },
      goal_update: { goal_id: "模型抄错的目标", step_id: "模型抄错的步骤", operation: "complete" },
    }, decision);
    expect(adapted.event.goal_update).toEqual({
      goal_id: selected.goal_id, step_id: selected.step_id, operation: "advance", evidence: narrative,
    });
    expect(adapted.diagnostic).toMatchObject({ normalized_operation: "advance", evidence_repaired: true, evidence_found: true });
    expect(evaluateDirectedEvent(adapted.event, decision, input.state).accepted).toBe(true);
  });

  it("normalizes a natural blocked result and extracts an exact detour sentence", () => {
    const input = directorInput();
    const decision = buildLifeDirector(input);
    const narrative = "我走到门边才发现外面下雨了，只好先停下来。";
    const adapted = adaptDirectedEvent({
      location: decision.selected.location,
      activity: "停下来想别的办法",
      narrative,
      director_result: { status: "blocked", evidence_sentence: "外面天气不好" },
    }, decision);
    expect(adapted.event.goal_update).toMatchObject({
      goal_id: decision.selected.goal_id, step_id: decision.selected.step_id, operation: "pause", reason: narrative,
    });
    expect(evaluateDirectedEvent(adapted.event, decision, input.state).accepted).toBe(true);
  });

  it("accepts an explicit organize action when the goal name contains 图鉴 and the evidence uses a controlled short name", () => {
    const input = directorInput();
    const goal = {
      id: "wish-production-regression", kind: "comfort", source_id: "possession:小镇花草图册",
      source_type: "possession", subject: "小镇花草图册", location: "云杉客栈二楼房间",
      title: "让小镇花草图册放得更顺手", motivation: "想把房间整理得顺手一点。",
      status: "active", created_at: input.worldTick.observed_at, updated_at: input.worldTick.observed_at,
      milestones: [{ id: "wish-production-regression-step-1", title: "选出一个需要整理的小角落", status: "pending" }],
      evidence: [], last_progress_date: null, paused_until: null,
    };
    input.state.goals = [goal];
    const decision = buildLifeDirector(input);
    const evidence = "我把花草图册挪到桌角，整理好了旁边的纸片。";
    const event = {
      location: decision.selected.location,
      activity: "整理小镇花草图册",
      narrative: evidence,
      goal_update: { goal_id: goal.id, step_id: goal.milestones[0].id, operation: "advance", evidence },
    };
    expect(autonomyActionFamily(event)).toBe("organize");
    expect(evaluateDirectedEvent(event, decision, input.state)).toMatchObject({ accepted: true, reasons: [] });
  });

  it("uses a real cooldown after a committed event, keeps the next step and replays idempotently", () => {
    const input = directorInput();
    const decision = buildLifeDirector(input);
    const event = { ...eventForSelection(decision.selected), id: "event-1", local_date: "2026-09-03", occurred_at: input.worldTick.observed_at };
    const outcome = evaluateDirectedEvent(event, decision, input.state).outcome;
    const effect = createLifePlanEffect(input.state, decision, event, outcome);
    const committed = applyLifePlanEffect(input.state, effect);
    expect(applyLifePlanEffect(committed, effect)).toEqual(committed);
    const wish = committed.goals.find((goal) => goal.id === decision.selected.goal_id);
    expect(wish.milestones.filter((step) => step.status === "completed")).toHaveLength(1);
    expect(nextGoalStep(wish).id).toBe(wish.milestones[1].id);
    expect(buildLifeDirector({ ...input, state: committed }).mode).toBe("free");
    expect(evaluateDirectedEvent(event, decision, committed).reasons).toContain("goal_cooldown_active");
    expect(goalFactsForChat(committed, "2026-09-03").recent_results[0].event_id).toBe("event-1");
    expect(goalFactsForChat(input.state).recent_results).toEqual([]);
  });

  it("rotates repeated daily subjects and routes even when the 12-event buffer no longer contains them", () => {
    const input = directorInput();
    input.state.days = ["2026-09-01", "2026-09-02"].map((date) => ({ date, events: [{ topic: "plants", location: "花园" }] }));
    const decision = buildLifeDirector(input);
    expect(decision.avoid_topics).toContain("plants");
    expect(decision.avoid_locations).toContain("花园");
    expect(decision.selected.topic).not.toBe("plants");
    expect(decision.selected.location).not.toBe("花园");
    const repeat = { activity: "画月见草", narrative: "我给月见草换个角度画了一遍。", location: "花园" };
    expect(evaluateDirectedEvent(repeat, decision, input.state).reasons).toEqual(expect.arrayContaining(["repeated_daily_route", "repeated_daily_topic"]));
  });

  it("eventually completes a multi-day wish without reseeding the same finished wish", () => {
    const input = directorInput();
    let state = input.state;
    const firstWish = state.goals.find((goal) => goal.kind === "atlas").id;
    for (let offset = 0; offset < 12; offset += 1) {
      const date = `2026-09-${String(3 + offset).padStart(2, "0")}`;
      const nowIso = `${date}T02:00:00.000Z`;
      state = seedLifeGoals(state, { worldCanon: input.worldCanon, agent: input.agent, nowIso });
      const decision = buildLifeDirector({ ...input, state, worldTick: { ...input.worldTick, local_date: date, observed_at: nowIso } });
      if (!decision.selected) continue;
      const event = { ...eventForSelection(decision.selected), id: `event-${offset}`, local_date: date, occurred_at: nowIso };
      const gate = evaluateDirectedEvent(event, decision, state);
      expect(gate.accepted, JSON.stringify(gate.reasons)).toBe(true);
      state = applyLifePlanEffect(state, createLifePlanEffect(state, decision, event, gate.outcome));
    }
    const wish = state.goals.find((goal) => goal.id === firstWish);
    expect(wish.status).toBe("completed");
    expect(wish.evidence).toHaveLength(3);
    expect(new Set(wish.evidence.map((entry) => entry.occurred_at.slice(0, 10))).size).toBe(3);
    expect(state.goals.filter((goal) => goal.id === firstWish)).toHaveLength(1);
  });

  it("pauses on an evidenced obstacle and permits resumption the next day without completing a step", () => {
    const input = directorInput();
    const decision = buildLifeDirector(input);
    const reason = "我累了，改主意先回去";
    const event = { location: "咖啡馆", activity: "休息", narrative: reason, id: "pause-1", local_date: "2026-09-03", occurred_at: input.worldTick.observed_at,
      goal_update: { goal_id: decision.selected.goal_id, operation: "pause", reason } };
    const gate = evaluateDirectedEvent(event, decision, input.state);
    expect(gate.accepted).toBe(true);
    const saved = applyLifePlanEffect(input.state, createLifePlanEffect(input.state, decision, event, gate.outcome));
    const goal = saved.goals.find((item) => item.id === decision.selected.goal_id);
    expect(goal.status).toBe("paused");
    expect(goal.milestones.every((step) => step.status === "pending")).toBe(true);
    expect(buildLifeDirector({ ...input, state: saved }).selected?.goal_id).not.toBe(goal.id);
    const tomorrow = buildLifeDirector({ ...input, state: saved, worldTick: { ...input.worldTick, local_date: "2026-09-04", observed_at: "2026-09-04T02:00:00Z" } });
    expect(tomorrow.selected?.goal_id).toBe(goal.id);
  });

  it("respects low energy and reportable promises without treating them as wish progress", () => {
    const input = directorInput();
    input.emotionState.current.energy = 0.1;
    expect(buildLifeDirector(input).mode).toBe("rest");
    expect(buildLifeDirector({ ...input, openThreads: [{ id: "promise", report_to_user: true }] }).mode).toBe("promise");
    const suggestionOnly = buildLifeDirector({
      ...input,
      emotionState: defaultEmotionState("2026-09-03T02:00:00.000Z"),
      openThreads: [{
        id: "suggest-1",
        source: "user_suggestion",
        stance: "accepted",
        report_to_user: true,
        title: "去旧书店看看月见草的图鉴",
      }],
    });
    expect(suggestionOnly.mode).not.toBe("promise");
    expect(suggestionOnly.shared_experience[0].title).toContain("旧书店");
    expect(suggestionOnly.reasons.join("")).toMatch(/用户建议可选用/);
    const rest = buildLifeDirector(input);
    expect(evaluateDirectedEvent({ activity: "休息", narrative: "我坐了一会儿。", location: "咖啡馆" }, rest, input.state).outcome.status).toBe("unrelated");
  });

  it("keeps character constraints and supplies chat with evidence rather than an instruction to fabricate completion", () => {
    const input = directorInput();
    expect(buildLifeDirector(input).persona_rule).toContain("稍微社恐");
    expect(systemPrompt({}, input.agent)).toContain("安静、敏感、善良、好奇");
    const prompt = structuredChatPrompt({ world: {}, agent: input.agent, currentScene: {}, worldCanon: [], recentEvents: [], memories: [], goalFacts: goalFactsForChat(input.state) });
    expect(prompt).toContain("月见草");
    expect(prompt).toContain("聊天本身不推进这份账本");
    const decision = buildLifeDirector(input);
    const drifting = eventForSelection(decision.selected, { agent_changes: { personality: "变成外向" } });
    expect(evaluateDirectedEvent(drifting, decision, input.state).reasons).toContain("fixed_identity_mutation");
  });
});
