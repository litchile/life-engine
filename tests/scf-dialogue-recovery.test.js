import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../scf-runtime/shared/ai.js", () => ({ generateJson: vi.fn(), generateReply: vi.fn() }));
vi.mock("../scf-runtime/shared/feishu.js", async (original) => ({ ...await original(), replyText: vi.fn().mockResolvedValue("delivered") }));
import { generateJson, generateReply } from "../scf-runtime/shared/ai.js";
import { replyText } from "../scf-runtime/shared/feishu.js";
import { processEnvelope } from "../scf-runtime/processor/index.js";
import { sceneTransitionIssues } from "../scf-runtime/shared/conversation-context.js";

const scene = { location: "小镇青石路", sub_location: "", environment: "outdoors", activity: "喝水" };
const evidence = { current_scene: scene, current_request: { content: "最近有新认识的人吗" } };
function memoryStore() {
  const data = new Map([["state/current-scene.json", scene]]);
  return { data, getJson: async (k, f) => data.get(k) ?? f, putJson: async (k, v) => data.set(k, v),
    exists: async (k) => data.has(k), tryAcquireLock: async () => true, releaseLock: async () => {} };
}
function envelope(text) {
  return { header: { event_id: "recovery" }, event: { sender: { sender_id: { open_id: "owner" } },
    message: { message_id: "recovery", chat_type: "p2p", message_type: "text", content: JSON.stringify({ text }) } } };
}
beforeEach(() => vi.resetAllMocks());

describe("online dialogue recovery regressions", () => {
  it.each([
    ["可以。我就在围栏旁边，往左边挪两步，换到木桩背风的那侧站一会儿。", "我就在围栏旁边，往左边挪两步，换到木桩背风的那侧站一会儿。"],
    ["嗯，不远行。我就在围栏边往旁边挪两步，换个位置站。", "我就在围栏边往旁边挪两步，换个位置站"],
  ])("commits observed movement with a duration or location prefix: %s", async (reply, quote) => {
    const store = memoryStore();
    generateJson.mockResolvedValueOnce({ reply, scene_transition: { occurred: true, location: "旧磨坊后面的围栏",
      sub_location: "围栏旁", environment: "outdoors", activity: "换个位置站", evidence: quote } });
    await processEnvelope(store, envelope("如果愿意，就在原地旁边挪两步"), {});
    expect(generateJson).toHaveBeenCalledTimes(1);
    expect(replyText.mock.calls[0][1]).toBe(reply);
    expect(store.data.get("state/current-scene.json")).toMatchObject({ sub_location: "围栏旁", updated_by_event: "recovery" });
  });
  it.each(["我一会儿往旁边挪两步。", "过一会儿我往旁边挪两步。", "我准备在围栏边往旁边挪两步。", "他就在围栏边往旁边挪两步。", "我没有在围栏边往旁边挪两步。"])("keeps future/negated/other-actor movement blocked: %s", (reply) => {
    expect(sceneTransitionIssues({ reply, scene_transition: { occurred: false } }, evidence)).toEqual([]);
    expect(sceneTransitionIssues({ reply, scene_transition: { occurred: true, evidence: reply } }, evidence)).toContain("scene_transition_not_completed_in_reply");
  });
  it("retries the full contract and commits a legitimate move after the first candidate was rejected", async () => {
    const store = memoryStore();
    const reply = "我往边上挪两步，靠着路边停一下。";
    generateJson.mockResolvedValueOnce({ reply, scene_transition: { occurred: false }, memory_updates: [{ content: "discarded" }] });
    generateJson.mockResolvedValueOnce({ reply, scene_transition: { occurred: true, ...scene, sub_location: "路边", activity: "停在路边", evidence: "我往边上挪两步" } });
    await processEnvelope(store, envelope("愿意往旁边走两步吗"), {});
    expect(generateJson).toHaveBeenCalledTimes(2);
    expect(generateReply).not.toHaveBeenCalled();
    expect(replyText.mock.calls[0][1]).toBe(reply);
    expect(store.data.get("state/current-scene.json")).toMatchObject({ sub_location: "路边", activity: "停在路边", updated_by_event: "recovery" });
    expect(store.data.get("observations/recovery.json").dialogue.generation_path).toBe("structured_retry");
    expect(JSON.stringify(store.data.get("state/agent-memories.json"))).not.toContain("discarded");
  });
  it("does not treat sentences continuing a historical story as movement today", () => {
    const reply = "前天晚上我又去了面馆。那天灯亮着。我推门进去，坐在最里面的小桌旁。吃完就走出来了。";
    expect(sceneTransitionIssues({ reply, scene_transition: { occurred: false } }, evidence)).toEqual([]);
    expect(sceneTransitionIssues({ reply, scene_transition: { occurred: true, evidence: "我推门进去", environment: "indoors" } }, evidence))
      .toContain("scene_transition_not_completed_in_reply");
  });
  it("returns to present after a recollection and still requires the new movement to commit", () => {
    const reply = "前天晚上我去了面馆。现在我往路边挪两步。";
    expect(sceneTransitionIssues({ reply, scene_transition: { occurred: false } }, evidence)).toContain("scene_transition_undeclared_in_reply");
    expect(sceneTransitionIssues({ reply, scene_transition: { occurred: true, evidence: "现在我往路边挪两步", environment: "outdoors" } }, evidence)).toEqual([]);
  });
  it.each(["我准备往路边挪两步。", "他往路边挪两步。", "我没有往路边挪两步。"])("does not commit a plan, another actor or negation: %s", (reply) => {
    expect(sceneTransitionIssues({ reply, scene_transition: { occurred: false } }, evidence)).toEqual([]);
  });
  it("can answer no without generating an old anecdote or side effects", async () => {
    const store = memoryStore();
    generateJson.mockResolvedValueOnce({ reply: "没有，这两天我还没有认识新的人，也没有第一次去什么地方。" });
    await processEnvelope(store, envelope("最近两天有认识新的人或第一次去的地方吗"), {});
    expect(generateJson).toHaveBeenCalledTimes(1);
    expect(replyText.mock.calls[0][1]).toMatch(/^没有/);
    expect(store.data.get("state/current-scene.json")).toMatchObject(scene);
  });
  it.each(["invalid", "unavailable"])("reports bounded uncertainty after two %s candidates, never an unseen-draft apology or fake progress", async (failure) => {
    const store = memoryStore();
    if (failure === "unavailable") generateJson.mockRejectedValue(new Error("model unavailable"));
    else generateJson.mockResolvedValue({ reply: "我走到小茶馆了。", memory_updates: [{ content: "invented-friend" }],
      reportable_promise: { title: "invented-promise" }, user_suggestion: { title: "invented-suggestion", stance: "accepted" } });
    await processEnvelope(store, envelope("最近两天有没有新认识的人，或第一次去的地方"), {});
    expect(generateJson).toHaveBeenCalledTimes(2);
    expect(generateReply).not.toHaveBeenCalled();
    const delivered = replyText.mock.calls[0][1];
    expect(delivered).toContain("还不能确认");
    expect(delivered).not.toMatch(/我刚才|你接着说|我走到|^没有新认识/);
    expect(store.data.get("state/current-scene.json")).toMatchObject(scene);
    expect(store.data.get("observations/recovery.json").dialogue).toMatchObject({ generation_path: "quality_fallback" });
    expect(JSON.stringify([...store.data.entries()])).not.toContain('"title":"invented-promise"');
    expect(JSON.stringify(store.data.get("state/agent-memories.json"))).not.toContain("invented-friend");
    expect(JSON.stringify(store.data.get("state/open-threads.json"))).not.toContain("invented-suggestion");
  });
});
