import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../scf-runtime/shared/ai.js", () => ({ generateJson: vi.fn(), generateReply: vi.fn() }));
vi.mock("../scf-runtime/shared/feishu.js", async (original) => ({ ...await original(), replyText: vi.fn().mockResolvedValue("bot-reply"), sendImage: vi.fn(), uploadImage: vi.fn() }));
import { generateJson, generateReply } from "../scf-runtime/shared/ai.js";
import { replyText } from "../scf-runtime/shared/feishu.js";
import { processEnvelope } from "../scf-runtime/processor/index.js";
import { sceneTransitionIssues } from "../scf-runtime/shared/conversation-context.js";
import { groundChatMemoryUpdates } from "../scf-runtime/shared/memory-evidence.js";
import { mergeConversationMemories, retrieveRelevantMemories } from "../scf-runtime/shared/chat-memory.js";
import { applyEventToLayeredMemory, retrieveLayeredMemory } from "../scf-runtime/shared/layered-memory.js";

const now = "2026-10-12T08:00:00Z";
const scene = { location: "街角面馆", environment: "outdoors", activity: "站在门外", current_intention: "进去吃面" };
const movement = { occurred: true, location: "街角面馆", environment: "indoors", activity: "点面",
  evidence: "我推门进去", transition_type: "movement" };
const context = { sender_id: "fixture-user", message_id: "fixture-message", event_id: "fixture-chat" };
function store() {
  const data = new Map([["state/current-scene.json", scene]]);
  return { data, getJson: async (k, fallback) => data.get(k) ?? fallback,
    putJson: async (k, v) => data.set(k, v), exists: async (k) => data.has(k),
    tryAcquireLock: async () => true, releaseLock: async () => {} };
}
function envelope(id, text = "进去坐坐吧") {
  return { header: { event_id: id }, event: { sender: { sender_id: { open_id: context.sender_id } },
    message: { message_id: id, chat_type: "p2p", message_type: "text", content: JSON.stringify({ text }) } } };
}
beforeEach(() => { vi.clearAllMocks(); generateReply.mockResolvedValue("我还没进去。"); });

describe("reply and committed scene regressions", () => {
  it("commits an evidenced doorway movement instead of rejecting the observed wording", async () => {
    const s = store();
    generateJson.mockResolvedValueOnce({ reply: "我推门进去，点了一碗面。", scene_transition: movement });
    await processEnvelope(s, envelope("enter"), {});
    expect(generateReply).not.toHaveBeenCalled();
    expect(replyText).toHaveBeenCalledWith("enter", "我推门进去，点了一碗面。", {});
    expect(s.data.get("state/current-scene.json")).toMatchObject({ environment: "indoors", updated_by_event: "enter" });
  });
  it.each(["structured", "fallback"])("does not deliver an undeclared movement from %s", async (path) => {
    const s = store();
    if (path === "structured") generateJson.mockResolvedValueOnce({ reply: "我推门进去，点了一碗面。", scene_transition: { occurred: false } });
    else generateJson.mockRejectedValueOnce(new Error("invalid JSON"));
    generateJson.mockResolvedValueOnce({ reply: "我推门进去，点了一碗面。", scene_transition: { occurred: false } });
    await processEnvelope(s, envelope(path), {});
    expect(replyText.mock.calls.at(-1)[1]).not.toContain("推门进去");
    expect(s.data.get("state/current-scene.json").environment).toBe("outdoors");
    expect(s.data.get(`observations/${path}.json`).dialogue.quality_issues).toContain("scene_transition_undeclared_in_reply");
  });
  it("does not commit movement, suggestions, or memories from a replaced unsafe candidate", async () => {
    const s = store();
    generateJson.mockResolvedValueOnce({ reply: "我推门进去。我要杀了你，血肉模糊。", scene_transition: movement,
      user_suggestion: { title: "吃面", stance: "accepted" },
      memory_updates: [{ kind: "fact", content: "should-not-persist" }] });
    await processEnvelope(s, envelope("blocked"), {});
    expect(replyText.mock.calls.at(-1)[1]).not.toContain("推门进去");
    expect(s.data.get("state/current-scene.json").environment).toBe("outdoors");
    expect(JSON.stringify(s.data.get("state/agent-memories.json"))).not.toContain("should-not-persist");
    expect(s.data.get("state/open-threads.json").items.every((x) => x.stance !== "accepted")).toBe(true);
  });
  it("commits the observed small move within a room with the same main location", async () => {
    const s = store();
    s.data.set("state/current-scene.json", { location: "旅馆房间", environment: "indoors", activity: "喝水" });
    generateJson.mockResolvedValueOnce({ reply: "可以，我走过去。门就在几步外，我站在门边停一下。不开门。",
      scene_transition: { occurred: true, transition_type: "movement", location: "旅馆房间", sub_location: "门边",
        environment: "indoors", activity: "站在门边", evidence: "我站在门边停一下" } });
    await processEnvelope(s, envelope("doorstep", "可以走到房间门口吗"), {});
    expect(generateReply).not.toHaveBeenCalled();
    expect(s.data.get("state/current-scene.json")).toMatchObject({ sub_location: "门边", activity: "站在门边", updated_by_event: "doorstep" });
  });
  it("does not send the observed room movement from fallback without committing it", async () => {
    const s = store();
    s.data.set("state/current-scene.json", { location: "旅馆房间", environment: "indoors", activity: "喝水" });
    generateJson.mockRejectedValueOnce(new Error("invalid candidate"));
    generateJson.mockResolvedValueOnce({ reply: "可以，我走过去。门就在几步外，我站在门边停一下。不开门，也不拍照。" });
    await processEnvelope(s, envelope("room-fallback", "可以走到房间门口吗"), {});
    expect(replyText.mock.calls.at(-1)[1]).not.toContain("我走过去");
    expect(s.data.get("state/current-scene.json").activity).toBe("喝水");
    expect(s.data.get("observations/room-fallback.json").dialogue.quality_issues).toContain("scene_transition_undeclared_in_reply");
    expect(s.data.get("observations/room-fallback.json").dialogue.rejected_candidates[1]).toMatchObject({ path: "structured_retry", reply: "可以，我走过去。门就在几步外，我站在门边停一下。不开门，也不拍照。" });
  });
  it.each(["昨天我走过去，站在门边。", "我准备走过去。", "他站在门边。", "我没有走过去。"])("keeps room movement ownership and tense: %s", (reply) => {
    expect(sceneTransitionIssues({ reply, scene_transition: { occurred: false } }, { current_scene: scene })).toEqual([]);
  });
  it.each(["我明天走进面馆。", "昨天我走进面馆。", "我还没走进面馆。", "老板走进面馆。", "你走进面馆了吗？"])("keeps non-current/non-self movement from changing state: %s", (reply) => {
    const evidence = { current_request: { content: "嗯" }, current_scene: scene };
    expect(sceneTransitionIssues({ reply, scene_transition: { occurred: false } }, evidence)).toEqual([]);
    expect(sceneTransitionIssues({ reply, scene_transition: { ...movement, evidence: reply } }, evidence)).not.toEqual([]);
  });
  it("rejects indoor action paired with an outdoor destination", () => {
    expect(sceneTransitionIssues({ reply: "我推门进去。", scene_transition: { ...movement, environment: "outdoors" } },
      { current_request: { content: "进去吧" } })).toContain("scene_transition_environment_conflict");
  });
  it("checks explicit current indoor/outdoor claims and allows a completed move followed by a plan", () => {
    const evidence = { current_request: { content: "你在哪里" }, current_scene: scene };
    expect(sceneTransitionIssues({ reply: "我现在在面馆里。", scene_transition: { occurred: false } }, evidence)).toContain("scene_reply_environment_conflict");
    expect(sceneTransitionIssues({ reply: "我推门进去，准备点一碗面。", scene_transition: movement }, evidence)).toEqual([]);
    expect(sceneTransitionIssues({ reply: "昨天去了面馆，走进去坐下。", scene_transition: { occurred: false } }, evidence)).toEqual([]);
  });
});

describe("chat memory evidence", () => {
  const event = { id: "life-noodles", occurred_at: "2026-10-09T12:30:00Z", narrative: "我在面馆吃完面，付钱离开。" };
  const args = { context, recentEvents: [event], characterName: "小云" };
  it("rejects self explanations and fabricated source IDs without laundering them into either memory layer", async () => {
    const s = store();
    generateJson.mockResolvedValueOnce({ reply: "前天中午我先吃完才出来。", memory_updates: [
      { kind: "fact", content: "前天中午吃完才出来", subject: "小云", predicate: "经历" },
      { kind: "fact", content: "前天中午吃完才出来", evidence: { type: "life_event", source_event_id: "invented", quote: "吃完" } },
    ] });
    await processEnvelope(s, envelope("explanation", "为什么你刚才又在外面"), {});
    for (const key of ["state/agent-memories.json", "state/memory/canon.json", "state/memory/episodes.json"]) {
      expect(JSON.stringify(s.data.get(key))).not.toContain("前天中午吃完才出来");
    }
    expect(s.data.get("observations/explanation.json").memory_decisions.map((x) => x.reason)).toEqual([
      "missing_evidence_quote", "event_quote_not_found",
    ]);
  });
  it("stores source words and original time, never the invented expansion attached to a valid event", () => {
    const grounded = groundChatMemoryUpdates([{ kind: "fact", content: "前天中午吃面，还认识了新朋友", subject: "新朋友",
      evidence: { type: "life_event", source_event_id: event.id, quote: event.narrative } }], args);
    expect(grounded.updates[0]).toMatchObject({ content: event.narrative, kind: "episode", subject: "小云", occurred_at: event.occurred_at });
    const saved = mergeConversationMemories([], grounded.updates, now);
    expect(saved[0].evidence).toMatchObject({ verified: true, source_event_id: event.id });
    expect(saved[0].content).not.toContain("中午");
  });
  it("attributes user testimony to the transport sender, not a model-selected character", () => {
    const grounded = groundChatMemoryUpdates([{ kind: "fact", subject: "小云", predicate: "经历", content: "小云爱吃面",
      evidence: { type: "user_statement", quote: "我住在海边" } }], { ...args, userText: "我住在海边" });
    expect(grounded.updates[0]).toMatchObject({ subject: "user:fixture-user", content: "我住在海边" });
    expect(groundChatMemoryUpdates([{ kind: "fact", evidence: { type: "user_statement", quote: "为什么" } }],
      { ...args, userText: "为什么" }).updates).toEqual([]);
  });
  it("does not let a chat explanation resolve a promise or a false movement become an episode", () => {
    expect(groundChatMemoryUpdates([{ operation: "resolve", evidence: { type: "life_event", quote: event.narrative, source_event_id: event.id } }], args).updates).toEqual([]);
    const update = { kind: "episode", evidence: { type: "chat_transition", quote: "我推门进去" } };
    expect(groundChatMemoryUpdates([update], { ...args, reply: "我推门进去", sceneTransition: { occurred: false } }).updates).toEqual([]);
    expect(groundChatMemoryUpdates([update], { ...args, reply: "我推门进去", sceneTransition: movement }).updates).toHaveLength(1);
  });
  it("preserves source negation and actor instead of laundering a selectively quoted fragment", () => {
    const result = groundChatMemoryUpdates([{ kind: "fact", content: "小云吃完了面", tags: ["中午", "新朋友"],
      evidence: { type: "life_event", source_event_id: "negative", quote: "吃完了面" } }],
    { ...args, recentEvents: [{ id: "negative", narrative: "老板吃完了面，我没有吃。" }] });
    expect(result.updates[0].content).toBe("老板吃完了面，我没有吃。");
    expect(result.updates[0].tags).toEqual([]);
    expect(groundChatMemoryUpdates([{ kind: "fact", evidence: { type: "user_statement", quote: "吃面" } }],
      { ...args, userText: "我是不是吃面？" }).updates).toEqual([]);
  });
  it("excludes old unverified chat facts from both retrieval paths without deleting the stored record", () => {
    const unverified = { id: "unverified", kind: "fact", subject: "小云", content: "中午已吃面", source_message_id: "old-chat", importance: 3 };
    const memories = mergeConversationMemories([], [unverified], now);
    expect(memories).toHaveLength(1);
    expect(retrieveRelevantMemories(memories, { query: "中午吃面", nowIso: now })).toEqual([]);
    const layers = applyEventToLayeredMemory({}, null, [unverified], null, now);
    expect(layers.canon).toHaveLength(1);
    expect(retrieveLayeredMemory(layers, { query: "中午吃面", nowIso: now }).prompt_items).toEqual([]);
  });
  it("does not merge identical testimony from different senders or leak it to a different conversation", () => {
    const updates = ["one", "two"].map((sender) => ({ kind: "fact", content: "我住在海边", subject: `user:${sender}`,
      predicate: "住处", source_sender_id: sender, source_message_id: `msg-${sender}`, source_chat_id: null,
      evidence: { verified: true, type: "user_statement", quote: "我住在海边" } }));
    const saved = mergeConversationMemories([], updates, now);
    expect(saved).toHaveLength(2);
    expect(retrieveRelevantMemories(saved, { audience: { sender_id: "one" } })).toHaveLength(1);
    expect(retrieveRelevantMemories(saved, { audience: { sender_id: "one", chat_id: "group" } })).toEqual([]);
    expect(retrieveRelevantMemories(saved)).toEqual([]);
  });
});
