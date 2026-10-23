import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../scf-runtime/shared/ai.js", () => ({ generateJson: vi.fn(), generateReply: vi.fn() }));
vi.mock("../scf-runtime/shared/feishu.js", async (original) => ({ ...await original(), replyText: vi.fn().mockResolvedValue("reply") }));
import { generateJson, generateReply } from "../scf-runtime/shared/ai.js";
import { processEnvelope } from "../scf-runtime/processor/index.js";
import { historicalEventsForPrompt, buildDialogueEvidence, dialogueForPrompt } from "../scf-runtime/shared/conversation-context.js";

const nowIso = "2026-10-12T16:23:00Z"; // Beijing October 13, just after midnight.
const meal = { id: "meal-oct11", occurred_at: "2026-10-11T14:00:00Z", location: "面馆", narrative: "我吃完一碗面，结账后离开。" };
const claim = { role: "assistant", message_id: "old-reply", event_id: "chat-explanation", observed_at: "2026-10-11T11:19:00Z", content: "前天中午我吃完才出来。" };
beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(nowIso)); });
afterEach(() => { vi.useRealTimers(); });

describe("historical event dates and statement provenance", () => {
  it("projects the local date across UTC midnight, and never dates an old meal by its latest retelling", () => {
    const event = historicalEventsForPrompt([meal], "Asia/Shanghai", nowIso)[0];
    expect(event).toMatchObject({ local_date: "2026-10-11", local_time: "22:00", day_reference: "前天", narrative: meal.narrative });
    expect(historicalEventsForPrompt([meal], "Asia/Shanghai", "2026-10-12T15:59:00Z")[0].day_reference).toBe("昨天");
    expect(historicalEventsForPrompt([meal], "America/Los_Angeles", nowIso)[0]).toMatchObject({ local_date: "2026-10-11", day_reference: "昨天" });
  });
  it("does not invent a time for an undated event", () => {
    expect(historicalEventsForPrompt([{ id: "undated", narrative: "我坐了一会儿。" }], "Asia/Shanghai", nowIso)[0])
      .toMatchObject({ local_date: null, local_time: null, day_reference: "日期未知" });
  });
  it("separates a delivered self-explanation from independent events while preserving quote access", () => {
    const evidence = buildDialogueEvidence({ history: [claim] }, { parent_id: "old-reply" }, "到底哪一天", {}, [meal], { nowIso });
    expect(evidence.quoted_message.status).toBe("resolved");
    expect(evidence.delivered_messages[0]).toMatchObject({ source_kind: "delivered_statement_not_event_proof", linked_life_event_id: null });
    expect(evidence.historical_events).toHaveLength(1);
    expect(evidence.historical_events[0]).toMatchObject({ id: meal.id, narrative: meal.narrative, local_date: "2026-10-11" });
    expect(dialogueForPrompt([claim], "小云")[0]).toMatchObject({ observed_at: claim.observed_at, source_kind: "delivered_statement_not_event_proof" });
  });
  it.each(["structured", "fallback"])("provides independent full event text and local date to %s, not just old self-reports", async (path) => {
    const data = new Map([
      ["contacts/owner.json", { history: [claim] }],
      ["state/recent-events.json", { events: [meal] }],
    ]);
    const store = { getJson: async (key, fallback) => data.get(key) ?? fallback,
      putJson: async (key, value) => data.set(key, value), exists: async (key) => data.has(key),
      tryAcquireLock: async () => true, releaseLock: async () => {} };
    if (path === "fallback") generateJson.mockRejectedValueOnce(new Error("bad JSON"));
    generateJson.mockResolvedValueOnce({ reply: "能确认的是十月十一号晚上的那次。" });
    const envelope = { header: { event_id: "query" }, event: { sender: { sender_id: { open_id: "owner" } },
      message: { message_id: "query", chat_type: "p2p", message_type: "text", content: JSON.stringify({ text: "到底是哪天" }) } } };
    await processEnvelope(store, envelope, {});
    const prompt = generateJson.mock.calls[path === "fallback" ? 1 : 0][1];
    expect(prompt).toContain('"local_date":"2026-10-11"');
    expect(prompt).toContain('"day_reference":"前天"');
    expect(prompt).toContain(meal.narrative);
    expect(prompt).toContain('"date":"2026-10-13"');
    expect(prompt).toContain('"source_kind":"delivered_statement_not_event_proof"');
    expect(generateReply).not.toHaveBeenCalled();
    expect(data.get("processed/query.json")).toBeDefined();
  });
});
