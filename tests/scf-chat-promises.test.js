import { describe, expect, it } from "vitest";
import {
  extractReportablePromises,
  looksLikeNearTermUserFacingPromise,
  promiseFactsForChat,
  isPromiseProgressQuestion,
} from "../scf-runtime/shared/chat-promises.js";
import {
  activeOpenThreads,
  applyOpenThreadUpdates,
  emptyOpenThreads,
  prioritizeOpenThreads,
  reconcileReportablePromiseClosures,
  upsertChatPromiseThreads,
} from "../scf-runtime/shared/open-threads.js";
import { normalizeChatTurn } from "../scf-runtime/shared/chat-memory.js";
import { buildLifeContext } from "../scf-runtime/shared/life-context.js";

describe("chat promise capture", () => {
  it("captures structured and near-term reply promises", () => {
    const structured = extractReportablePromises({
      reply: "好。",
      reportable_promise: {
        title: "现在就去问客栈掌柜哪家有吃的",
        report_to_user: true,
      },
    });
    expect(structured[0].title).toContain("客栈掌柜");
    expect(structured[0].report_to_user).toBe(true);

    const fromReply = extractReportablePromises({
      reply: "你说得对。我现在就去问问她，顺便看看杂货铺。",
      new_intention: "去问客栈掌柜",
      memory_updates: [],
    });
    expect(fromReply.length).toBeGreaterThan(0);
    expect(looksLikeNearTermUserFacingPromise(fromReply[0].title)).toBe(true);
  });

  it("does not over-promote soft musings", () => {
    expect(looksLikeNearTermUserFacingPromise("以后有空再去别处看看吧")).toBe(false);
    expect(extractReportablePromises({
      reply: "以后有机会再慢慢认识更多朋友。",
      new_intention: "以后再认识朋友",
      memory_updates: [{ kind: "intention", content: "以后再认识朋友" }],
    })).toEqual([]);
  });

  it("keeps 一会儿去 as intention-only scene and still extracts a reportable promise", () => {
    const turn = normalizeChatTurn({
      reply: "那我一会儿去吃饭。",
      new_intention: "一会儿去吃饭",
      reportable_promise: { title: "一会儿去吃饭", report_to_user: true },
      scene_transition: { occurred: false },
      memory_updates: [{ kind: "promise", content: "一会儿去吃饭", report_to_user: true }],
    }, {
      location: "旅馆房间",
      activity: "看书",
      current_intention: "看书",
      environment: "indoors",
      present_characters: ["小云"],
    });
    expect(turn.scene_transition.occurred).toBe(false);
    expect(turn.reportable_promise.title).toContain("吃饭");
    const promises = extractReportablePromises(turn);
    expect(promises[0].title).toContain("吃饭");
  });
});

describe("chat promise threads and closure", () => {
  it("upserts chat promises with report_to_user and prioritizes them", () => {
    let state = emptyOpenThreads("2026-08-11T12:00:00.000Z");
    state = upsertChatPromiseThreads(state, [{
      title: "现在就去问客栈掌柜",
      content: "现在就去问客栈掌柜哪家有吃的",
    }], { eventId: "chat-1", location: "青石路", nowIso: "2026-08-11T12:00:00.000Z" });
    state = applyOpenThreadUpdates(state, {
      id: "e-low",
      location: "旅馆",
      next_intention: "整理一下围巾",
    }, [], "2026-08-11T12:02:00.000Z");

    const active = activeOpenThreads(state);
    expect(active.some((thread) => thread.report_to_user && thread.source === "chat_promise")).toBe(true);
    const ranked = prioritizeOpenThreads(state, { currentIntention: "整理一下围巾", nowIso: "2026-08-11T12:03:00.000Z" });
    expect(ranked[0].report_to_user).toBe(true);
    expect(ranked[0].title).toContain("客栈掌柜");
  });

  it("closes fulfilled and redirected promises with lived evidence", () => {
    let before = upsertChatPromiseThreads(emptyOpenThreads(), [{
      title: "一会儿去吃饭",
      content: "一会儿去吃饭",
    }], { eventId: "chat-meal", nowIso: "2026-08-11T12:00:00.000Z" });
    const threadId = activeOpenThreads(before)[0].id;

    const fulfilledEvent = {
      id: "event-eat",
      activity: "去早餐厅吃了一碗热汤面",
      narrative: "小云兑现了一会儿去吃饭的约定，认真吃完了一碗面。",
      location: "早餐厅",
    };
    let after = before;
    const fulfilled = reconcileReportablePromiseClosures(before, after, fulfilledEvent, {
      selectedThreadId: threadId,
      nowIso: "2026-08-11T12:40:00.000Z",
    });
    expect(fulfilled.closed[0].stage).toBe("resolved");
    expect(fulfilled.closed[0].evidence.at(-1).event_id).toBe("event-eat");

    before = upsertChatPromiseThreads(emptyOpenThreads(), [{
      title: "一会儿去吃饭",
    }], { eventId: "chat-meal-2", nowIso: "2026-08-11T13:00:00.000Z" });
    const redirectId = activeOpenThreads(before)[0].id;
    const redirectEvent = {
      id: "event-read",
      activity: "和花花在旅馆一起看书",
      narrative: "本来打算去吃饭，后来和花花留在旅馆看书。",
      location: "旅馆房间",
    };
    const redirected = reconcileReportablePromiseClosures(before, before, redirectEvent, {
      selectedThreadId: redirectId,
      nowIso: "2026-08-11T13:30:00.000Z",
    });
    expect(redirected.closed[0].stage).toBe("abandoned");
    expect(redirected.closed[0].evidence.at(-1).note).toContain("看书");
  });

  it("boosts life-context closure motivation for reportable promises", () => {
    const context = buildLifeContext({
      agent: { location: "青石路", activity: "站着" },
      emotionState: { current: { energy: 0.7, security: 0.7 }, long_term: {} },
      recentEvents: [],
      openThreads: [{
        id: "t1",
        title: "现在就去问客栈掌柜",
        stage: "observed",
        priority: 4,
        report_to_user: true,
      }],
      worldCanon: { entities: [] },
      timeContext: { period: "晚间", time: "19:10", date: "2026-08-11" },
    });
    expect(context.motivations[0].id).toBe("closure");
    expect(context.goal_stack[0].source).toBe("chat_promise");
  });

  it("grounds chase questions with promise ledger facts", () => {
    expect(isPromiseProgressQuestion("咋样了？")).toBe(true);
    let state = upsertChatPromiseThreads(emptyOpenThreads(), [{
      title: "一会儿去吃饭",
    }], { eventId: "chat-3", nowIso: "2026-08-11T14:00:00.000Z" });
    const id = activeOpenThreads(state)[0].id;
    const closed = reconcileReportablePromiseClosures(state, state, {
      id: "event-read-2",
      activity: "和花花在旅馆一起看书",
      narrative: "改主意了",
      location: "旅馆房间",
    }, { selectedThreadId: id, nowIso: "2026-08-11T14:20:00.000Z" });
    const facts = promiseFactsForChat(closed.threads, [{
      id: "event-read-2",
      activity: "和花花在旅馆一起看书",
      location: "旅馆房间",
      narrative: "改主意了",
    }], "咋样了？");
    expect(facts[0].status).toBe("closed");
    expect(facts[0].stage).toBe("abandoned");
    expect(facts[0].related_events[0].activity).toContain("花花");
  });
});
