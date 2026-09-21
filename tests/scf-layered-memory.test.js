import { describe, expect, it } from "vitest";
import {
  applyEventToLayeredMemory,
  loadLayeredMemory,
  persistLayeredMemory,
  retrieveLayeredMemory,
  layeredMemoryForPrompt,
} from "../scf-runtime/shared/layered-memory.js";

function memoryStore() {
  const values = new Map();
  return {
    values,
    async getJson(key, fallback) { return values.has(key) ? values.get(key) : fallback; },
    async putJson(key, value) { values.set(key, value); },
  };
}

describe("five-layer memory", () => {
  it("migrates legacy canon, episodes, entities, preferences and intentions", async () => {
    const store = memoryStore();
    const layers = await loadLayeredMemory(store, {
      worldCanon: { entities: [{ entity_id: "fox", entity_type: "character", name: "客栈掌柜" }] },
      recentEvents: [{ id: "e1", activity: "第一次去面包店", narrative: "买到热面包", location: "面包店", importance: 3 }],
      agentMemories: [
        { kind: "fact", subject: "小云", predicate: "房间", content: "住在旅馆二楼" },
        { kind: "preference", content: "喜欢观察雨后的叶子" },
        { kind: "intention", content: "明天去书店" },
      ],
    }, "2026-07-31T01:00:00.000Z");
    expect(layers.canon[0].content).toContain("旅馆二楼");
    expect(layers.episodes[0].narrative).toContain("热面包");
    expect(layers.entities[0].name).toBe("客栈掌柜");
    expect(layers.reflections[0].content).toContain("雨后");
    expect(layers.intentions[0]).toMatchObject({ content: "明天去书店", status: "active" });
  });

  it("records a world event once and retrieves relevant layers", async () => {
    const store = memoryStore();
    const empty = await loadLayeredMemory(store, {}, "2026-07-31T01:00:00.000Z");
    const event = {
      id: "e2",
      occurred_at: "2026-07-31T02:00:00.000Z",
      location: "小镇花店",
      activity: "第一次认识花店老板",
      narrative: "花店老板是一只戴绿色围裙的兔子",
      importance: 4,
      agent_changes: { known_places: ["小镇花店"] },
    };
    const updated = applyEventToLayeredMemory(empty, event, [
      { kind: "intention", content: "下次带花草图册来花店", importance: 2 },
    ], { entities: [{ entity_id: "rabbit-florist", entity_type: "character", name: "兔子花店老板" }] }, "2026-07-31T02:00:00.000Z");
    await persistLayeredMemory(store, updated);
    const recalled = retrieveLayeredMemory(updated, { query: "花店 兔子老板 花草图册", nowIso: "2026-07-31T03:00:00.000Z" });
    expect(updated.episodes.filter((item) => item.id === "e2")).toHaveLength(1);
    expect(updated.reflections).toEqual([]);
    expect(updated.entities.some((item) => item.name === "兔子花店老板")).toBe(true);
    expect(recalled.intentions[0].content).toContain("花草图册");
    expect(store.values.has("state/memory/episodes.json")).toBe(true);
  });

  it("keeps resolution when an older legacy copy is loaded again", async () => {
    const store = memoryStore();
    const now = "2026-09-19T02:00:00.000Z";
    const memory = { id: "pending", kind: "intention", subject: "角色", predicate: "归还钥匙", content: "准备去还钥匙", updated_at: now };
    const before = await loadLayeredMemory(store, { agentMemories: [memory] }, now);
    const after = applyEventToLayeredMemory(before, null, [{ ...memory, operation: "resolve", content: "钥匙已经交还" }], null, now);
    await persistLayeredMemory(store, after);
    const reloaded = await loadLayeredMemory(store, { agentMemories: [memory] }, now);
    expect(reloaded.intentions[0].status).toBe("resolved");
    expect(retrieveLayeredMemory(reloaded).intentions).toEqual([]);
  });

  it("enforces the total prompt budget across all layers", async () => {
    const empty = await loadLayeredMemory(memoryStore());
    for (const layer of ["canon", "intentions", "entities", "episodes", "reflections"]) {
      empty[layer] = Array.from({ length: 5 }, (_, index) => ({ id: `${layer}-${index}`, content: "钥匙", importance: 2 }));
    }
    const prompt = layeredMemoryForPrompt(retrieveLayeredMemory(empty, { query: "钥匙", limit: 4 }));
    expect(Object.values(prompt).flat()).toHaveLength(4);
    expect(Object.values(layeredMemoryForPrompt(retrieveLayeredMemory(empty, { limit: 0 }))).flat()).toHaveLength(0);
  });

  it("supersedes an old fact when an explicit correction changes the same field", async () => {
    const store = memoryStore();
    const initial = await loadLayeredMemory(store, {
      agentMemories: [{ kind: "fact", subject: "小云房间", predicate: "楼层", content: "二楼" }],
    }, "2026-07-31T01:00:00.000Z");
    const updated = applyEventToLayeredMemory(initial, null, [{
      kind: "correction",
      subject: "小云房间",
      predicate: "楼层",
      content: "一楼",
      importance: 3,
    }], null, "2026-07-31T02:00:00.000Z");
    expect(updated.canon.find((item) => item.content === "二楼")?.status).toBe("superseded");
    const recalled = retrieveLayeredMemory(updated, { query: "小云房间楼层" });
    expect(recalled.canon.some((item) => item.content === "二楼")).toBe(false);
    expect(recalled.canon.some((item) => item.content === "一楼")).toBe(true);
  });
});
