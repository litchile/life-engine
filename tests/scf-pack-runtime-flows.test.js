import { describe, expect, it, vi, beforeEach } from "vitest";
vi.mock("../scf-runtime/shared/ai.js", () => ({ generateJson: vi.fn(), generateReply: vi.fn() }));
vi.mock("../scf-runtime/shared/feishu.js", async (original) => ({ ...await original(), replyText: vi.fn(), sendImage: vi.fn(), uploadImage: vi.fn() }));
import harborPack from "./fixtures/harbor-pack.json" with { type: "json" };
import { configFromCharacterPack, serializeCharacterPack } from "../scf-runtime/shared/character-pack.js";
import { createScopedStore } from "../scf-runtime/shared/scoped-store.js";
import { loadPackRuntime } from "../scf-runtime/shared/pack-runtime.js";
import { processEnvelope } from "../scf-runtime/processor/index.js";
import { runAutonomousHeartbeat } from "../scf-runtime/processor/autonomy.js";
import { buildConversationPhotoPrompt, createConversationPhotoPlan, fallbackPhotoPlan } from "../scf-runtime/processor/chat-photo.js";
import { generateJson } from "../scf-runtime/shared/ai.js";
import { createHash } from "node:crypto";

function memoryStore() {
  const values = new Map();
  return { values, async getJson(k, fallback) { return structuredClone(values.get(k) ?? fallback); },
    async putJson(k, value) { values.set(k, structuredClone(value)); },
    async getObject(k) { if (!values.has(k)) throw new Error("missing object"); return { body: Buffer.from(values.get(k)), contentType: "application/json" }; },
    async exists(k) { return values.has(k); }, async listKeys(prefix) { return [...values.keys()].filter((k) => k.startsWith(prefix)); },
    async tryAcquireLock() { return true; }, async releaseLock() {} };
}
const leakedIdentity = /小云|松鼠|云杉镇|云杉客栈|米色|花猫|客栈掌柜|Agent|spruce-town|innkeeper/;
async function runtime(raw) {
  const instance = { user_id: "owner-two", character_id: harborPack.id, storage_prefix: "instances/harbor" };
  const scoped = createScopedStore(raw, instance.storage_prefix);
  const source = serializeCharacterPack(harborPack);
  raw.values.set("instances/harbor/packs/harbor-fox/1.0.0.json", source);
  return loadPackRuntime(scoped, { LIFE_ENGINE_PACK_KEY: "packs/harbor-fox/1.0.0.json",
    LIFE_ENGINE_PACK_SHA256: createHash("sha256").update(source).digest("hex"),
    LIFE_ENGINE_CONFIG_JSON: JSON.stringify({ instance }), IMAGE_MODE: "disabled", AUTONOMY_GOALS_ENABLED: "false" });
}
beforeEach(() => vi.clearAllMocks());
describe("an independent character through existing production flows", () => {
  it("runs private chat in the selected pack without default identity or storage leakage", async () => {
    const raw = memoryStore(); raw.values.set("state/agent.json", { activity: "original-storage-marker" });
    const host = await runtime(raw);
    generateJson.mockResolvedValue({ reply: "我在整理潮汐本。", memory_updates: [] });
    await processEnvelope(host.store, { header: { event_id: "alternate-chat" }, event: {
      sender: { sender_id: { open_id: "owner-two" } }, message: { message_id: "message", message_type: "text", content: JSON.stringify({ text: "你在做什么" }) },
    } }, host.env);
    expect(generateJson.mock.calls[0][0]).not.toMatch(leakedIdentity);
    expect(generateJson.mock.calls[0][0]).toContain("阿岚");
    expect(raw.values.get("state/agent.json")).toEqual({ activity: "original-storage-marker" });
    expect(raw.values.get("instances/harbor/state/agent.json").location).toBe("旧灯塔客房");
    expect(raw.values.has("contacts/owner-two.json")).toBe(false);
  });
  it.each(["拍一张自拍给我看", "看你的房间照片", "拍一张潮汐本照片给我看"])("uses the same photo planner and fallback without imported props: %s", async (userText) => {
    const config = configFromCharacterPack(harborPack, { user_id: "owner-two", storage_prefix: "instances/harbor" });
    const agent = { ...config.character.default_state, location: config.world.home.location };
    const env = { LIFE_ENGINE_CONFIG_JSON: JSON.stringify(config) };
    const world = { weather: "晴朗", local_time: "10:00" };
    generateJson.mockResolvedValue({ subject: "潮汐本", agent_visible: false, location: "旧灯塔客房" });
    const plan = await createConversationPhotoPlan({ userText, world, agent, env });
    expect(generateJson.mock.calls[0][0]).not.toMatch(leakedIdentity);
    expect(buildConversationPhotoPrompt(plan, config)).not.toMatch(leakedIdentity);
    const fallback = fallbackPhotoPlan({ userText, world, agent, config });
    expect(JSON.stringify(fallback)).not.toMatch(leakedIdentity);
    if (userText.includes("房间")) expect(fallback.must_show).toContain("帆布椅");
    if (userText.includes("自拍")) expect(fallback.characters).toEqual(["阿岚"]);
  });
  it("commits a heartbeat in the new world while preserving the original instance", async () => {
    const raw = memoryStore(); const host = await runtime(raw);
    const model = vi.fn(async (system) => {
      expect(system).not.toMatch(leakedIdentity);
      return { location: "码头", activity: "核对潮位", narrative: "我在码头看清了水位刻度，把读数记在本子上。",
        diary: "记下了今天的潮位。", next_intention: "核对昨天的记录", photo_worthy: false, notify_user: false,
        world_observations: [], memory_updates: [], world_changes: {}, agent_changes: {} };
    });
    const now = new Date("2026-09-19T02:00:00Z");
    const result = await runAutonomousHeartbeat(host.store, { Type: "Timer", TriggerName: "heartbeat", Time: now.toISOString() }, host.env,
      { now, generateJson: model, sendText: vi.fn() });
    expect(result.event_id, JSON.stringify(result)).toBeTruthy();
    expect(raw.values.has("state/agent.json")).toBe(false);
    expect(raw.values.get("instances/harbor/state/agent.json").location).toBe("码头");
  });
  it("rejects changed pack bytes before any state write", async () => {
    const raw = memoryStore(); const host = await runtime(raw);
    const before = new Map(raw.values);
    await expect(loadPackRuntime(createScopedStore(raw, "instances/harbor"), { ...host.env, LIFE_ENGINE_PACK_SHA256: "0".repeat(64) }))
      .rejects.toThrow("integrity mismatch");
    expect(raw.values).toEqual(before);
  });
});
