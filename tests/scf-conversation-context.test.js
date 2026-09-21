import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../scf-runtime/shared/ai.js", () => ({ generateJson: vi.fn(), generateReply: vi.fn() }));
vi.mock("../scf-runtime/shared/feishu.js", async (original) => ({ ...await original(), replyText: vi.fn().mockResolvedValue("bot-message"), sendImage: vi.fn(), uploadImage: vi.fn() }));
import { generateJson, generateReply } from "../scf-runtime/shared/ai.js";
import { replyText } from "../scf-runtime/shared/feishu.js";
import { processEnvelope } from "../scf-runtime/processor/index.js";
import { conversationContext, conversationDecision } from "../scf-runtime/shared/conversation-context.js";
import { DEFAULT_LIFE_ENGINE_CONFIG } from "../scf-runtime/shared/life-engine-config.js";
import { queueGroundedCuriosity } from "../scf-runtime/shared/open-threads.js";
import { deriveConversationCorrections } from "../scf-runtime/shared/chat-memory.js";

function store() {
  const data = new Map();
  return { data, getJson: async (k, fallback) => data.get(k) ?? fallback,
    putJson: async (k, value) => data.set(k, value), exists: async (k) => data.has(k),
    tryAcquireLock: async () => true, releaseLock: async () => {} };
}
function envelope(id, sender, text, group = true) {
  return { header: { event_id: id }, event: { sender: { sender_id: { open_id: sender } }, message: {
    message_id: id, chat_id: "group-one", chat_type: group ? "group" : "p2p", message_type: "text", content: JSON.stringify({ text }),
  } } };
}
beforeEach(() => { vi.clearAllMocks(); generateJson.mockResolvedValue({ reply: "我听见了。", memory_updates: [] }); });
describe("conversation ownership and response decisions", () => {
  it("preserves the original speaker when recovering a correction from shared history", () => {
    const corrections = deriveConversationCorrections([
      { role: "user", content: "这就是你的房间", sender_id: "member-a", chat_id: "group-one", message_id: "old-message", event_id: "old-event" },
    ], "今天怎么样", DEFAULT_LIFE_ENGINE_CONFIG, { sender_id: "member-b", message_id: "current-message" });
    expect(corrections[0]).toMatchObject({ source_sender_id: "member-a", source_event_id: "old-event", source_message_id: "old-message" });
  });
  it("queues an evidenced question without a promise, deduplicates it and rejects invented sources", () => {
    const event = { id: "tide", location: "码头", narrative: "水位刻度比昨天低了一格。" };
    const question = { question: "水位为什么低了一格？", subject: "水位", source_event_id: "tide", evidence: event.narrative };
    const state = queueGroundedCuriosity({ items: [] }, question, [event]);
    expect(state.items[0]).toMatchObject({ source: "curiosity", report_to_user: false, stage: "observed", source_event_id: "tide" });
    expect(queueGroundedCuriosity(state, question, [event]).items).toHaveLength(1);
    expect(queueGroundedCuriosity({ items: [] }, { ...question, evidence: "远处有人打开了水闸" }, [event]).items).toEqual([]);
    expect(queueGroundedCuriosity({ items: [] }, question, []).items).toEqual([]);
  });
  it("observes member dialogue without replying, invoking a model, or writing world memories", async () => {
    const memory = store();
    const result = await processEnvelope(memory, envelope("first", "member-a", "明天你带书来"), {});
    expect(result).toMatchObject({ responded: false, decision: "group_background" });
    expect(generateJson).not.toHaveBeenCalled(); expect(replyText).not.toHaveBeenCalled();
    expect(memory.data.has("state/agent-memories.json")).toBe(false);
    expect(memory.data.get("conversations/group-one.json").history[0].sender_id).toBe("member-a");
  });
  it("keeps group speakers distinct and does not mix their private history or change the proactive recipient", async () => {
    const memory = store();
    memory.data.set("contacts/member-b.json", { history: [{ role: "user", content: "private-only-marker" }] });
    memory.data.set("state/latest-contact.json", { open_id: "private-owner" });
    await processEnvelope(memory, envelope("background", "member-a", "我喜欢山茶花"), {});
    await processEnvelope(memory, envelope("addressed", "member-b", "小云，你喜欢什么"), {});
    const prompt = generateJson.mock.calls[0][1];
    expect(prompt).toContain("member-a"); expect(prompt).toContain("member-b");
    expect(prompt).not.toContain("private-only-marker");
    expect(memory.data.get("state/latest-contact.json").open_id).toBe("private-owner");
    const followup = envelope("followup", "member-b", "再说一点");
    followup.event.message.parent_id = "bot-message";
    await processEnvelope(memory, followup, {});
    expect(replyText).toHaveBeenCalledTimes(2);
  });
  it("honors explicit silence privately without generating a fallback or changing character state", async () => {
    const memory = store();
    const result = await processEnvelope(memory, envelope("quiet", "owner", "不用回复", false), {});
    expect(result.decision).toBe("explicit_silence");
    expect(replyText).not.toHaveBeenCalled(); expect(generateReply).not.toHaveBeenCalled();
    expect(memory.data.has("state/agent.json")).toBe(false);
  });
  it("does not treat a mention of another member as a bot mention", () => {
    const event = envelope("mention", "owner", "你好");
    event.event.message.mentions = [{ name: "小云", id: { open_id: "other-member" } }];
    const incoming = { type: "text", text: "你好" };
    const context = conversationContext(event, incoming, DEFAULT_LIFE_ENGINE_CONFIG, { FEISHU_BOT_OPEN_ID: "bot" });
    expect(conversationDecision(context, incoming).respond).toBe(false);
  });
});
