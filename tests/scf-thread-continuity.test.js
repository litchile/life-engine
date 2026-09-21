import { describe, expect, it, vi } from "vitest";
import { runAutonomousHeartbeat } from "../scf-runtime/processor/autonomy.js";
import { applyOpenThreadUpdates, normalizeOpenThreads, openThreadsForPrompt, reconcileReportablePromiseClosures, threadContinuityFacts } from "../scf-runtime/shared/open-threads.js";
import { promiseFactsForChat } from "../scf-runtime/shared/chat-promises.js";

const start = "2026-09-16T00:00:00.000Z";
function initial() {
  return normalizeOpenThreads({ items: [{ id: "route", title: "整理雨后路线", stage: "considered", source: "chat_promise", report_to_user: true }] }, start);
}
function transition(state, status, evidence, now = start, extras = {}) {
  const operations = { submitted: "wait", answered: "attempt", refused: "block", unknown: "block", no_reply: "block", failed: "block", succeeded: "resolve" };
  const event = { id: `${status}-${now}`, narrative: evidence, activity: evidence, occurred_at: now };
  const update = { thread_id: "route", operation: operations[status], action_result: { status, evidence, actor: "花花" }, ...extras };
  return { event, state: applyOpenThreadUpdates(state, event, [update], now) };
}
const waiting = () => transition(initial(), "submitted", "我把雨后路线的问题交给花花，等她有空回复。").state;

describe("cross-day thread continuity", () => {
  it("persists waits across reloads and only schedules a check when due", () => {
    const state = normalizeOpenThreads(JSON.parse(JSON.stringify(waiting())), "2026-09-17T00:00:00.000Z");
    expect(state.items[0]).toMatchObject({ stage: "waiting", status: "active", waiting_for: "花花", next_check_at: "2026-09-18T00:00:00.000Z" });
    expect(openThreadsForPrompt(state, { nowIso: "2026-09-17T00:00:00Z" })).toEqual([]);
    expect(openThreadsForPrompt(state, { nowIso: "2026-09-18T00:00:00Z" })).toHaveLength(1);
    expect(state.items[0].last_result.status).toBe("submitted");
  });
  it("does not extend the deadline when a reminder mentions the same matter", () => {
    const state = waiting();
    const next = applyOpenThreadUpdates(state, { id: "reminder", next_intention: "整理雨后路线" }, [{ thread_id: "route", operation: "observe" }], "2026-09-17T00:00:00.000Z");
    expect(next.items[0].next_check_at).toBe(state.items[0].next_check_at);
  });
  it("rejects repeated submission and premature no-reply claims", () => {
    const state = waiting();
    expect(transition(state, "submitted", "我又把问题交给花花。", "2026-09-17T00:00:00.000Z").state.items).toEqual(state.items);
    expect(transition(state, "no_reply", "花花还没有回复。", "2026-09-17T00:00:00.000Z").state.items).toEqual(state.items);
  });
  it.each(["answered", "refused", "unknown", "no_reply"])("keeps %s separate from fulfillment", (status) => {
    const prior = waiting();
    const now = "2026-09-18T00:00:00.000Z";
    const result = transition(prior, status, `花花的本次反馈是${status}。`, now);
    const closure = reconcileReportablePromiseClosures(prior, result.state, result.event, { selectedThreadId: "route", nowIso: now });
    expect(closure.closed).toEqual([]);
    expect(closure.threads.items[0].last_result.status).toBe(status);
    expect(closure.threads.items[0].status).toBe("active");
  });
  it("allows changing the helper after a refusal and preserves both receipts", () => {
    let state = transition(waiting(), "refused", "花花忙着整理店铺，暂时不能帮忙。", "2026-09-17T00:00:00Z").state;
    state = transition(state, "submitted", "我把路线问题交给客栈掌柜。", "2026-09-17T02:00:00Z", { action_result: { status: "submitted", actor: "客栈掌柜", evidence: "我把路线问题交给客栈掌柜。" } }).state;
    expect(state.items[0].waiting_for).toBe("客栈掌柜");
    expect(state.items[0].evidence.map((item) => item.result?.status)).toContain("refused");
  });
  it("does not accept a different helper's answer for the pending request", () => {
    const state = waiting();
    const after = transition(state, "answered", "客栈掌柜回复了。", "2026-09-17T00:00:00Z", { action_result: { status: "answered", actor: "客栈掌柜", evidence: "客栈掌柜回复了。" } }).state;
    expect(after.items).toEqual(state.items);
  });
  it("rejects missing narrative evidence and planned success", () => {
    const state = waiting();
    const after = transition(state, "answered", "我在窗边休息。", start, { action_result: { status: "answered", actor: "花花", evidence: "花花回复了。" } }).state;
    expect(after.items).toEqual(state.items);
    expect(transition(state, "succeeded", "我打算完成路线记录。", start).state.items).toEqual(state.items);
    expect(transition(state, "succeeded", "我很开心。", start).state.items).toEqual(state.items);
  });
  it("requires a completion receipt and keeps terminal outcomes immutable", () => {
    const answered = transition(waiting(), "answered", "花花回复了雨后通路的位置。", "2026-09-17T00:00:00Z").state;
    const legacy = applyOpenThreadUpdates(answered, { id: "fake", narrative: "我想写路线" }, [{ thread_id: "route", operation: "resolve" }], start);
    expect(legacy.items[0].stage).toBe("attempted");
    const done = transition(answered, "succeeded", "我完成了雨后路线记录，把地图交给花花。", "2026-09-18T00:00:00Z").state;
    expect(done.items[0]).toMatchObject({ stage: "resolved", status: "closed" });
    expect(transition(done, "submitted", "我再问花花。", "2026-09-19T00:00:00Z").state.items).toEqual(done.items);
  });
  it("exposes wait and evidence to chat without changing persisted state", () => {
    const state = waiting();
    const before = structuredClone(state);
    expect(threadContinuityFacts(state)[0]).toMatchObject({ waiting_for: "花花", last_result: { status: "submitted" } });
    expect(promiseFactsForChat(state, [], "怎么样了")[0]).toMatchObject({ stage: "waiting", next_check_at: "2026-09-18T00:00:00.000Z" });
    expect(state).toEqual(before);
  });
});

describe("production heartbeat continuity wiring", () => {
  it.each([
    ["submitted", "wait", "我把雨后路线的问题交给花花，等她有空回复。", "waiting"],
    ["refused", "block", "花花忙着整理店铺，暂时不能帮忙。", "blocked"],
    ["succeeded", "resolve", "我完成了雨后路线记录，把地图交给花花。", "resolved"],
  ])("persists %s in the real heartbeat event and ledger", async (status, operation, sentence, stage) => {
    const now = new Date("2026-09-18T02:00:00.000Z");
    const values = new Map(Object.entries({
      "state/open-threads.json": status === "submitted" ? initial() : waiting(),
      "state/world-canon.json": { entities: [
        { id: "shop", type: "place", name: "旧书店", lifecycle_status: "canonical" },
        { id: "rong", type: "character", name: "花花", lifecycle_status: "canonical", first_seen_location: "旧书店" },
      ] },
    }));
    const store = {
      async getJson(key, fallback) { return structuredClone(values.has(key) ? values.get(key) : fallback); },
      async putJson(key, value) { values.set(key, structuredClone(value)); },
      async listKeys(prefix) { return [...values.keys()].filter((key) => key.startsWith(prefix)); },
    };
    const generateJson = vi.fn(async (prompt) => {
      expect(prompt).toContain("thread_continuity");
      return { location: "旧书店", activity: "向花花询问雨后路线", narrative: sentence, diary: sentence,
        selected_thread_id: "route", thread_updates: [{ thread_id: "route", operation, action_result: { status, actor: "花花", evidence: sentence } }],
        next_intention: "", photo_worthy: false, notify_user: false, world_observations: [], memory_updates: [] };
    });
    const result = await runAutonomousHeartbeat(store, { Type: "Timer", TriggerName: "agent-heartbeat", Time: now.toISOString() },
      { BOT_TIMEZONE: "Asia/Shanghai", IMAGE_MODE: "disabled", AUTONOMY_GOALS_ENABLED: "false" }, { now, generateJson, sendText: vi.fn() });
    expect(result.event_id, JSON.stringify(result)).toBeTruthy();
    const ledger = values.get("state/open-threads.json");
    expect(ledger.items.find((item) => item.id === "route").stage).toBe(stage);
    const event = [...values.entries()].find(([key, value]) => key.startsWith("events/") && value.id === result.event_id)?.[1];
    expect(event.thread_results).toEqual([expect.objectContaining({ thread_id: "route", status, event_id: result.event_id })]);
  });
});
