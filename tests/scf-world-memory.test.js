import { describe, expect, it } from "vitest";
import {
  emptyWorldCanon,
  ensureWorldPlaceCanon,
  mergeWorldObservations,
  worldCanonForPrompt,
  worldEntityKey,
} from "../scf-runtime/shared/world-memory.js";

const eventMeta = {
  event_id: "event-1",
  occurred_at: "2026-07-24T09:30:00.000Z",
  location: "小镇花店",
};

describe("first-person world memory", () => {
  it("records at most one newly discovered entity as provisional per event", () => {
    const result = mergeWorldObservations(emptyWorldCanon(), [
      {
        entity_type: "character",
        name: "花店老板",
        observed_facts: ["在柜台后整理花束"],
        visual_facts: ["一只灰白色兔子", "戴绿色围裙"],
        relationship_note: "第一次见面",
        knowledge_source: "direct_observation",
      },
      {
        entity_type: "place",
        name: "钟表店",
        observed_facts: ["在花店隔壁"],
        knowledge_source: "direct_observation",
      },
    ], eventMeta);

    expect(result.canon.entities).toHaveLength(1);
    expect(result.canon.entities[0]).toMatchObject({
      type: "character",
      name: "花店老板",
      visual_facts: ["一只灰白色兔子", "戴绿色围裙"],
      appearances: 1,
      lifecycle_status: "provisional",
    });
  });

  it("updates an existing character without rewriting its fixed appearance", () => {
    const first = mergeWorldObservations(emptyWorldCanon(), [{
      entity_type: "character",
      name: "花店老板",
      observed_facts: ["经营花店"],
      visual_facts: ["一只灰白色兔子"],
      status_observed: "正在营业",
    }], eventMeta);
    const second = mergeWorldObservations(first.canon, [{
      entity_type: "character",
      name: "花店老板",
      observed_facts: ["门上挂着今日休息的木牌"],
      visual_facts: ["一只鹿"],
      status_observed: "今日关店",
    }], { ...eventMeta, event_id: "event-2", occurred_at: "2026-07-25T09:30:00.000Z" });

    expect(second.canon.entities).toHaveLength(1);
    expect(second.canon.entities[0].visual_facts).toEqual(["一只灰白色兔子"]);
    expect(second.canon.entities[0].status_observed).toBe("今日关店");
    expect(second.canon.entities[0].appearances).toBe(2);
    expect(second.canon.entities[0].lifecycle_status).toBe("canonical");
  });

  it("does not canonize a new character without a visible description", () => {
    const result = mergeWorldObservations(emptyWorldCanon(), [{
      entity_type: "character",
      name: "不知名店主",
      observed_facts: ["在店里说话"],
      visual_facts: [],
    }], eventMeta);
    expect(result.canon.entities).toHaveLength(0);
  });

  it("marks once-observed entities as provisional in prompts and keeps stable entity paths", () => {
    const result = mergeWorldObservations(emptyWorldCanon(), [{
      entity_type: "place",
      name: "蓝铃花店",
      observed_facts: ["窗台摆着蓝色花盆"],
      visual_facts: ["绿色木门"],
    }], eventMeta);
    expect(worldCanonForPrompt(result.canon)[0]).toMatchObject({
      name: "蓝铃花店",
      lifecycle_status: "provisional",
    });
    expect(worldCanonForPrompt(result.canon)[0].usage_rule).toContain("候选事实");
    expect(worldEntityKey(result.canon.entities[0])).toMatch(/^world\/entities\/place\/place-[a-f0-9]+\.json$/);
  });

  it("does not promote a provisional entity when the same event is replayed", () => {
    const observation = {
      entity_type: "place",
      name: "石桥边的小路",
      observed_facts: ["桥边长着蕨类"],
      visual_facts: ["低矮石墙"],
    };
    const first = mergeWorldObservations(emptyWorldCanon(), [observation], eventMeta);
    const replay = mergeWorldObservations(first.canon, [observation], eventMeta);
    expect(replay.canon.entities[0]).toMatchObject({
      appearances: 1,
      lifecycle_status: "provisional",
    });
  });

  it("seeds known inn places and normalizes legacy entities without lifecycle_status", () => {
    const legacy = {
      schema_version: 1,
      entities: [{
        id: "object-legacy",
        identity: "object:月见草",
        type: "object",
        name: "月见草",
        appearances: 2,
        known_facts: ["雨后开放"],
        visual_facts: [],
        aliases: [],
        history: [],
      }],
      updated_at: null,
    };
    const first = ensureWorldPlaceCanon(legacy, {
      currentLocation: "云杉客栈二楼房间",
      nowIso: "2026-08-11T07:00:00.000Z",
    });
    expect(first.changed).toBe(true);
    expect(first.canon.entities.find((entity) => entity.name === "月见草")).toMatchObject({
      lifecycle_status: "canonical",
    });
    expect(first.canon.entities.filter((entity) => entity.type === "place").length).toBeGreaterThanOrEqual(5);
    expect(first.canon.entities.some((entity) => (
      entity.type === "place" && entity.name === "云杉客栈二楼房间" && entity.lifecycle_status === "canonical"
    ))).toBe(true);

    const second = ensureWorldPlaceCanon(first.canon, {
      currentLocation: "云杉客栈二楼房间",
      nowIso: "2026-08-11T08:00:00.000Z",
    });
    expect(second.changed).toBe(false);
  });
});
