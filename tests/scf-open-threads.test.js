import { describe, expect, it } from "vitest";
import {
  activeOpenThreads,
  applyOpenThreadUpdates,
  emptyOpenThreads,
  openThreadsForPrompt,
  prioritizeOpenThreads,
} from "../scf-runtime/shared/open-threads.js";
import {
  autonomyActionFamily,
  autonomySelectionDirective,
  evaluateAutonomyCandidate,
} from "../scf-runtime/shared/autonomy-selection.js";

describe("Open Threads", () => {
  it("persists a complete observed to resolved lifecycle with evidence", () => {
    let state = emptyOpenThreads("2026-08-01T01:00:00.000Z");
    const event = (id, activity, nextIntention = "") => ({
      id,
      occurred_at: `2026-08-0${id.slice(-1)}T01:00:00.000Z`,
      location: "小镇植物园外的小路",
      activity,
      narrative: activity,
      next_intention: nextIntention,
    });

    state = applyOpenThreadUpdates(state, event("event-1", "发现植物园门口的蓝色小花", "弄清蓝色小花的名字"), [], "2026-08-01T01:00:00.000Z");
    const threadId = activeOpenThreads(state)[0].id;
    expect(activeOpenThreads(state)[0]).toMatchObject({ stage: "observed", attempt_count: 0 });

    state = applyOpenThreadUpdates(state, event("event-2", "向花店老板询问蓝色小花"), [
      { thread_id: threadId, operation: "consider", evidence: "决定去花店问一问" },
    ], "2026-08-02T01:00:00.000Z");
    expect(activeOpenThreads(state)[0].stage).toBe("considered");

    state = applyOpenThreadUpdates(state, event("event-3", "拿图鉴和实物比对"), [
      { thread_id: threadId, operation: "attempt", evidence: "第一次认真比对叶片" },
    ], "2026-08-03T01:00:00.000Z");
    expect(activeOpenThreads(state)[0]).toMatchObject({ stage: "attempted", attempt_count: 1 });

    state = applyOpenThreadUpdates(state, event("event-4", "确认它叫溪畔蓝星花"), [
      { thread_id: threadId, operation: "resolve", evidence: "从图鉴和花店老板处得到一致答案" },
    ], "2026-08-04T01:00:00.000Z");
    expect(activeOpenThreads(state)).toHaveLength(0);
    expect(state.items[0]).toMatchObject({ stage: "resolved", status: "closed", attempt_count: 1 });
    expect(state.items[0].evidence.map((item) => item.event_id)).toEqual(["event-1", "event-2", "event-3", "event-4"]);
  });

  it("prioritizes the current intention without exposing closed threads", () => {
    let state = emptyOpenThreads();
    state = applyOpenThreadUpdates(state, { id: "e1", location: "书店", next_intention: "去书店寻找旧地图" });
    state = applyOpenThreadUpdates(state, { id: "e2", location: "湖边", next_intention: "观察湖边的候鸟" });
    const ranked = prioritizeOpenThreads(state, { currentIntention: "明天去书店找地图", location: "旅馆" });
    expect(ranked[0].title).toContain("旧地图");
    expect(openThreadsForPrompt(state, { currentIntention: "找地图" })[0]).not.toHaveProperty("content");
  });

  it("counts every explicit attempt even after the thread already reached attempted", () => {
    let state = emptyOpenThreads("2026-08-01T00:00:00.000Z");
    state = applyOpenThreadUpdates(state, {
      id: "attempt-event-1",
      occurred_at: "2026-08-01T01:00:00.000Z",
      location: "town path",
      next_intention: "identify the blue flower",
    });
    const id = activeOpenThreads(state)[0].id;

    state = applyOpenThreadUpdates(state, {
      id: "attempt-event-2",
      occurred_at: "2026-08-02T01:00:00.000Z",
      location: "flower shop",
      activity: "compare the petals",
    }, [{ thread_id: id, operation: "attempt" }], "2026-08-02T01:00:00.000Z");
    state = applyOpenThreadUpdates(state, {
      id: "attempt-event-3",
      occurred_at: "2026-08-03T01:00:00.000Z",
      location: "library",
      activity: "compare the plant guide",
    }, [{ thread_id: id, operation: "advance" }], "2026-08-03T01:00:00.000Z");

    expect(activeOpenThreads(state)[0]).toMatchObject({ stage: "attempted", attempt_count: 2 });
  });
});

describe("autonomy repetition gates", () => {
  const event = (location, activity, narrative = activity) => ({ location, activity, narrative });

  it("classifies concrete action families", () => {
    expect(autonomyActionFamily(event("面包店", "去面包店买早餐"))).toBe("shop_errand");
    expect(autonomyActionFamily(event("旅馆门口", "离开车站后到达旅馆门口"))).toBe("travel");
    expect(autonomyActionFamily(event("房间", "坐在窗边看雨"))).toBe("observe");
    expect(autonomyActionFamily(event("花店", "观察花店窗边的叶片"))).toBe("observe");
    expect(autonomyActionFamily(event("旧书店", "读完旧书店里的一页小册子"))).toBe("read");
  });

  it("prioritizes the actual action over incidental venue and narrative words", () => {
    expect(autonomyActionFamily(event(
      "花店",
      "离开面包店后沿路到达花店",
      "小云把沿途看到的路标记录下来。",
    ))).toBe("travel");
    expect(autonomyActionFamily(event(
      "面包店",
      "探索柜台旁一张旧地图标出的角落",
      "最后把水井的位置记录在地图边缘。",
    ))).toBe("explore");
  });

  it("blocks same-place same-action cooldown repeats", () => {
    const recent = [
      event("旅馆二楼房间", "坐在窗边看雨"),
      event("早餐厅", "和客栈掌柜聊了几句"),
    ];
    const gate = evaluateAutonomyCandidate(event("旅馆二楼房间", "又在窗边观察雨滴"), recent);
    expect(gate).toMatchObject({ accepted: false, cooldown_violation: true });
  });

  it("detects collapsed location and action distributions", () => {
    const recent = Array.from({ length: 8 }, (_, index) => event(
      index < 6 ? "旅馆二楼房间" : "旅馆走廊",
      index < 5 ? "整理旧皮箱里的东西" : "坐着休息",
    ));
    const directive = autonomySelectionDirective(recent);
    expect(directive.collapsed_location).toBe(true);
    const gate = evaluateAutonomyCandidate(event("旅馆二楼房间", "继续整理旧皮箱"), recent);
    expect(gate.accepted).toBe(false);
    expect(gate.reasons).toContain("distribution_collapse");
  });

  it("detects a location collapse after four consecutive stays", () => {
    const recent = Array.from({ length: 4 }, (_, index) => event(
      "旅馆二楼房间",
      index % 2 === 0 ? "观察窗外的云" : "整理随身物品",
    ));

    expect(autonomySelectionDirective(recent).collapsed_location).toBe(true);
  });

  it("does not let an open thread bypass the four-event location run limit", () => {
    const recent = Array.from({ length: 4 }, () => event("花店", "观察不同的花瓣"));
    const gate = evaluateAutonomyCandidate({
      ...event("花店", "确认花瓣的名字"),
      selected_thread_id: "thread-flower",
      thread_updates: [{ thread_id: "thread-flower", operation: "attempt" }],
    }, recent, [{ id: "thread-flower", title: "确认花瓣的名字" }], { currentLocation: "花店" });

    expect(gate.accepted).toBe(false);
    expect(gate.location_run_violation).toBe(true);
    expect(gate.reasons).toContain("location_run_limit");
  });

  it("lets a plausible move escape the location run limit despite novelty pressure", () => {
    const recent = [
      event("房间", "沿着窗边寻找新线索"),
      event("房间", "观察桌下的新痕迹"),
      event("房间", "沿着墙边寻找新线索"),
      event("房间", "观察门边的新痕迹"),
      event("房间", "沿着书架寻找新线索"),
      event("房间", "观察床边的新痕迹"),
    ];
    const gate = evaluateAutonomyCandidate(
      event("走廊", "离开房间走到走廊", "小云走出房间，在走廊发现了一扇以前没留意的小窗。"),
      recent,
      [],
      { currentLocation: "房间" },
    );

    expect(gate.accepted).toBe(true);
    expect(gate.novelty_violation).toBe(false);
    expect(gate.location_transition_violation).toBe(false);
  });

  it("lets a required inn departure bypass novelty, including impulsive location changes", () => {
    const recent = [
      event("旧书店", "离开花店后到达旧书店"),
      event("邮局", "离开旧书店后到达邮局"),
      event("旅馆二楼房间", "回到旅馆二楼房间"),
    ];
    const validMove = evaluateAutonomyCandidate(
      event("小镇青石路", "离开旅馆后走到小镇青石路"),
      recent,
      [],
      { currentLocation: "旅馆二楼房间", forceMovement: true },
    );
    const unexplainedJump = evaluateAutonomyCandidate(
      event("湖边", "忽然看见湖水"),
      recent,
      [],
      { currentLocation: "旅馆二楼房间", forceMovement: true },
    );

    expect(validMove.novelty_violation).toBe(false);
    expect(validMove.accepted).toBe(true);
    expect(unexplainedJump.location_transition_violation).toBe(false);
    expect(unexplainedJump.accepted).toBe(true);
  });

  it("allows a genuinely different location and action", () => {
    const recent = Array.from({ length: 6 }, () => event("旅馆二楼房间", "坐在窗边看雨"));
    const gate = evaluateAutonomyCandidate(event("小镇邮局", "第一次寄出写给磨坊主人的信"), recent);
    expect(gate.accepted).toBe(true);
  });

  it("allows movement to break a location collapse even when travel is also frequent", () => {
    const recent = [
      event("房间", "离开走廊后回到房间"),
      event("房间", "观察窗外的云"),
      event("房间", "离开门廊后回到房间"),
      event("房间", "整理花草图册"),
      event("房间", "离开早餐厅后回到房间"),
      event("房间", "读完图鉴的一页"),
    ];
    const candidate = event(
      "旅馆门廊",
      "离开房间后走到旅馆门廊",
      "小云沿楼梯下楼，在门廊停下来观察街道。",
    );
    const gate = evaluateAutonomyCandidate(candidate, recent, [], { currentLocation: "房间" });

    expect(gate).toMatchObject({
      accepted: true,
      distribution_violation: false,
      novelty_violation: false,
      location_transition_violation: false,
    });
  });

  it("allows a location change without movement narration as an impulsive arrival", () => {
    const recent = [event("旅馆房间", "收好花草图册")];
    const gate = evaluateAutonomyCandidate(
      event("湖边", "坐在长椅上继续看花草图册"),
      recent,
      [],
      { currentLocation: "旅馆房间" },
    );
    expect(gate).toMatchObject({ accepted: true, location_transition_violation: false });
    expect(gate.reasons).not.toContain("location_transition_without_movement");
  });

  it("allows a location change when the event narrates the journey", () => {
    const recent = [event("旅馆房间", "收好花草图册")];
    const gate = evaluateAutonomyCandidate(
      event("湖边", "离开旅馆后沿小路走到湖边"),
      recent,
      [],
      { currentLocation: "旅馆房间" },
    );
    expect(gate.location_transition_violation).toBe(false);
  });

  it("permits explicit progress on an open thread despite distribution pressure", () => {
    const recent = Array.from({ length: 6 }, () => event("小镇花店", "向花店老板询问蓝色小花"));
    const gate = evaluateAutonomyCandidate({
      ...event("小镇花店", "用图鉴确认蓝色小花的名字"),
      selected_thread_id: "thread-blue-flower",
      thread_updates: [{ thread_id: "thread-blue-flower", operation: "resolve" }],
    }, recent, [{ id: "thread-blue-flower", title: "弄清蓝色小花的名字" }]);
    expect(gate.thread_progress).toBe(true);
    expect(gate.distribution_violation).toBe(false);
    expect(gate.novelty_violation).toBe(false);
  });
});
