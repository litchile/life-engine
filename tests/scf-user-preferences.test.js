import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../scf-runtime/shared/ai.js", () => ({ generateJson: vi.fn(), generateReply: vi.fn() }));
vi.mock("../scf-runtime/shared/feishu.js", async (original) => ({ ...await original(), replyText: vi.fn().mockResolvedValue("bot-reply") }));
import { generateJson, generateReply } from "../scf-runtime/shared/ai.js";
import { processEnvelope } from "../scf-runtime/processor/index.js";
import { extractExplicitPreferences, updateUserPreferences, preferencesForPrompt } from "../scf-runtime/shared/user-preferences.js";
const turn = (id, content, sender = "owner") => ({ role: "user", message_id: id, content, sender_id: sender, event_id: id });
function store() {
  const data = new Map();
  return { data, getJson: async (k, fallback) => data.get(k) ?? fallback,
    putJson: async (k, v) => data.set(k, structuredClone(v)), exists: async (k) => data.has(k),
    tryAcquireLock: async () => true, releaseLock: async () => {} };
}
function envelope(id, content, sender = "owner", group = false) {
  return { header: { event_id: id }, event: { sender: { sender_id: { open_id: sender } },
    message: { message_id: id, chat_id: "group", chat_type: group ? "group" : "p2p", message_type: "text", content: JSON.stringify({ text: content }) } } };
}
beforeEach(() => { vi.clearAllMocks(); generateJson.mockResolvedValue({ reply: "嗯，我记着。" }); });
describe("durable user preference ledger", () => {
  it("recovers the archived explicit preference and retains it beyond conversation and world-memory limits", async () => {
    const s = store();
    s.data.set("contacts/owner.json", { message_archive: [turn("original", "哇我很爱吃饼")], history: [] });
    s.data.set("state/agent-memories.json", { memories: Array.from({ length: 120 }, (_, i) => ({ content: `小云自己吃过第${i}份饼`, kind: "episode", importance: 3 })) });
    await processEnvelope(s, envelope("bootstrap", "今天怎么样"), {});
    const saved = s.data.get("contacts/owner.json");
    saved.history = []; saved.message_archive = []; // original now outside every transcript window
    s.data.set("contacts/owner.json", saved);
    for (let i = 0; i < 25; i++) await processEnvelope(s, envelope(`later-${i}`, "嗯"), {});
    await processEnvelope(s, envelope("recall", "我以前说过喜欢吃什么"), {});
    expect(generateJson.mock.calls.at(-1)[1]).toContain('"quote":"哇我很爱吃饼"');
    expect(generateJson.mock.calls.at(-1)[1]).toContain('"source_message_id":"original"');
    expect(s.data.get("contacts/owner.json").user_preferences.items[0]).toMatchObject({ topic: "饼", polarity: "like" });
  });
  it("keeps preferences when model generation fails and includes them in fallback context", async () => {
    const s = store();
    generateJson.mockRejectedValueOnce(new Error("offline"));
    generateJson.mockResolvedValueOnce({ reply: "记下了。" });
    await processEnvelope(s, envelope("like", "我喜欢看书"), {});
    expect(generateJson.mock.calls[1][1]).toContain('"topic":"书"');
    expect(s.data.get("contacts/owner.json").user_preferences.items).toHaveLength(1);
  });
  it("updates the same preference, deletes on request, and does not replay an old archived declaration", () => {
    const original = turn("like", "我很爱吃面");
    let result = updateUserPreferences({}, [original]);
    result = updateUserPreferences(result.state, [turn("changed", "我现在不喜欢吃面了")]);
    expect(result.state.items).toHaveLength(1);
    expect(result.state.items[0].polarity).toBe("dislike");
    result = updateUserPreferences(result.state, [turn("forget", "忘记我吃面的偏好")]);
    expect(result.state.items).toEqual([]);
    expect(updateUserPreferences(result.state, [original]).state.items).toEqual([]);
  });
  it("stores group members separately without importing private-chat preferences", async () => {
    const s = store();
    await processEnvelope(s, envelope("private", "我喜欢秘密点心", "a"), {});
    await processEnvelope(s, envelope("group-a", "我喜欢吃面", "a", true), {});
    await processEnvelope(s, envelope("group-b", "我喜欢喝茶", "b", true), {});
    await processEnvelope(s, envelope("group-recall", "小云，我喜欢什么", "b", true), {});
    const prompt = generateJson.mock.calls.at(-1)[1];
    const preferences = prompt.split("当前说话人明确表达的偏好")[1];
    expect(preferences).toContain('"topic":"茶"');
    expect(preferences).not.toContain('"topic":"面"');
    expect(prompt).not.toContain("秘密点心");
  });
  it.each(["他说我喜欢吃面", "你喜欢吃面吗？", "我喜欢吃面吗？", "假如我喜欢吃面", "我说过“我喜欢吃面”"])("does not misattribute quotation, hypothetical, or questions: %s", (content) => {
    expect(extractExplicitPreferences(content)).toEqual([]);
  });
  it("retains more preferences than fit in the prompt and recalls a requested older topic", () => {
    const result = updateUserPreferences({}, Array.from({ length: 50 }, (_, i) => turn(`p${i}`, `我喜欢口味${i}`)));
    expect(result.state.items).toHaveLength(50);
    expect(preferencesForPrompt(result.state, "owner", "口味0")[0].topic).toBe("口味0");
    expect(preferencesForPrompt(result.state, "another")).toEqual([]);
  });
});
