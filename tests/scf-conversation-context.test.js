import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../scf-runtime/shared/ai.js", () => ({ generateJson: vi.fn(), generateReply: vi.fn() }));
vi.mock("../scf-runtime/shared/feishu.js", async (original) => ({ ...await original(), replyText: vi.fn().mockResolvedValue("bot-message"), sendImage: vi.fn(), uploadImage: vi.fn() }));
import { generateJson, generateReply } from "../scf-runtime/shared/ai.js";
import { replyText } from "../scf-runtime/shared/feishu.js";
import { processEnvelope } from "../scf-runtime/processor/index.js";
import { conversationContext, conversationDecision, buildDialogueEvidence, archiveConversationMessages,
  dialogueReplyIssues, sceneTransitionIssues, orderInboxEntries } from "../scf-runtime/shared/conversation-context.js";
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
  it("orders a delivery batch by transport time and flags late messages across invocations", () => {
    const first = envelope("first", "owner", "下次进去看看", false);
    const second = envelope("second", "owner", "吃碗小面", false);
    first.event.message.create_time = "1000";
    second.event.message.create_time = "2000";
    expect(orderInboxEntries([{ envelope: second }, { envelope: first }]).map((entry) => entry.envelope.header.event_id)).toEqual(["first", "second"]);
    const context = conversationContext(first, { type: "text", text: "下次进去看看" }, DEFAULT_LIFE_ENGINE_CONFIG);
    const evidence = buildDialogueEvidence({ history: [{ role: "user", message_created_at: 2000, content: "吃碗小面" }] }, context, "下次进去看看", {});
    expect(evidence.late_arrival).toBe(true);
    expect(sceneTransitionIssues({ scene_transition: { occurred: true } }, evidence)).toEqual(["late_message_cannot_rewind_scene"]);
  });
  it("resolves an older quoted bot reply after newer turns and preserves it outside the prompt window", async () => {
    const memory = store();
    generateJson.mockResolvedValueOnce({ reply: "先要一碗清汤面，坐着，不说话。" });
    replyText.mockResolvedValueOnce("noodles-bot");
    await processEnvelope(memory, envelope("noodles", "owner", "下次进去看看", false), {});
    for (let i = 0; i < 14; i++) {
      replyText.mockResolvedValueOnce(`later-bot-${i}`);
      await processEnvelope(memory, envelope(`later-${i}`, "owner", "嗯", false), {});
    }
    const quote = envelope("why", "owner", "为什么你不说话", false);
    quote.event.message.parent_id = "noodles-bot";
    await processEnvelope(memory, quote, {});
    const prompt = generateJson.mock.calls.at(-1)[1];
    expect(prompt).toContain('"status":"resolved"');
    expect(prompt).toContain('"message_id":"noodles-bot"');
    expect(prompt).toContain("先要一碗清汤面，坐着，不说话。");
    expect(memory.data.get("contacts/owner.json").history.at(-1)).toMatchObject({ message_id: "bot-message", parent_id: "why" });
  });
  it("responds to an older group bot quote but not to a quote of another member", () => {
    const saved = { message_archive: [{ role: "assistant", message_id: "old-bot", content: "坐着，不说话" },
      { role: "user", message_id: "member-msg", content: "你好" }] };
    const context = { is_group: true, directly_addressed: false, parent_id: "old-bot" };
    expect(conversationDecision(context, { type: "text", text: "为什么" }, saved).respond).toBe(true);
    expect(conversationDecision({ ...context, parent_id: "member-msg" }, { type: "text", text: "为什么" }, saved).respond).toBe(false);
  });
  it("does not guess missing legacy quotes or resolve another contact's private quote", async () => {
    const memory = store();
    memory.data.set("contacts/other.json", { message_archive: [{ role: "assistant", message_id: "private-id", content: "private-quote-secret" }] });
    const quote = envelope("missing", "owner", "为什么", false);
    quote.event.message.parent_id = "private-id";
    await processEnvelope(memory, quote, {});
    expect(generateJson.mock.calls[0][1]).toContain('"status":"unavailable"');
    expect(generateJson.mock.calls[0][1]).not.toContain("private-quote-secret");
  });
  it("carries the same resolved quote through the structured retry", async () => {
    const memory = store();
    memory.data.set("contacts/owner.json", { history: [], message_archive: [{ role: "assistant", message_id: "old", content: "坐着，不说话。" }] });
    generateJson.mockRejectedValueOnce(new Error("invalid JSON"));
    generateJson.mockResolvedValueOnce({ reply: "我是想安静吃面。" });
    const quote = envelope("fallback", "owner", "为什么不说话", false);
    quote.event.message.parent_id = "old";
    await processEnvelope(memory, quote, {});
    expect(generateJson.mock.calls[1][1]).toContain("坐着，不说话。");
    expect(generateJson.mock.calls[1][1]).toContain('"status":"resolved"');
  });
  it("rejects repeated delivery without committing discarded candidate memories or movement", async () => {
    const memory = store();
    const repeated = "玻璃上全是水汽，里面的人低着头慢慢吃面，我在窗外站着看了一会儿。雨后的斜光把石板缝照成细细的亮线，我又看了一会儿。";
    memory.data.set("contacts/owner.json", { history: [], message_archive: [{ role: "assistant", message_id: "sent", content: repeated }] });
    generateJson.mockResolvedValueOnce({ reply: repeated, memory_updates: [{ content: "discarded-memory-marker" }] });
    generateJson.mockResolvedValueOnce({ reply: repeated });
    await processEnvelope(memory, envelope("repeat", "owner", "我很爱吃面", false), {});
    expect(replyText.mock.calls.at(-1)[1]).not.toBe(repeated);
    expect(JSON.stringify(memory.data.get("state/agent-memories.json"))).not.toContain("discarded-memory-marker");
    expect(memory.data.get("observations/repeat.json").dialogue).toMatchObject({ generation_path: "quality_fallback", quality_issues: ["repeated_delivered_content"] });
  });
  it("bounds the archive and allows short acknowledgments, quotes and requested retelling", () => {
    const messages = Array.from({ length: 110 }, (_, i) => ({ role: "assistant", message_id: `m${i}`, content: "一句旧话" }));
    expect(archiveConversationMessages({}, messages)).toHaveLength(96);
    const evidence = buildDialogueEvidence({ history: [{ role: "assistant", content: "嗯。" }] }, { sender_id: "a" }, "你好", {});
    expect(dialogueReplyIssues("嗯。", evidence)).toEqual([]);
    const long = "这是我们上次聊到的面馆窗边的水汽和街道上的光影，我站着看了许久然后回去了。";
    evidence.delivered_messages = [{ content: long }];
    evidence.current_request.content = "再讲一遍";
    expect(dialogueReplyIssues(long, evidence)).toEqual([]);
    evidence.current_request.content = "为什么";
    evidence.quoted_message.status = "resolved";
    expect(dialogueReplyIssues(long, evidence)).toEqual([]);
  });
  it("rejects future and historical scene changes and accepts evidenced present movement", () => {
    const evidence = { current_request: { content: "下次进去看看" } };
    for (const proof of ["下次我走进面馆", "昨天我走进面馆", "我还没走进面馆"]) {
      expect(sceneTransitionIssues({ reply: proof, scene_transition: { occurred: true, evidence: proof } }, evidence)).not.toEqual([]);
    }
    expect(sceneTransitionIssues({ reply: "我走进面馆，坐下了。", scene_transition: { occurred: true, evidence: "我走进面馆，坐下了" } }, evidence)).toEqual([]);
    expect(sceneTransitionIssues({ reply: "我走进面馆了", scene_transition: { occurred: true } }, evidence)).toEqual(["scene_transition_missing_evidence"]);
  });
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
