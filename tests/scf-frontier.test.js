import { describe, expect, it } from "vitest";
import {
  emptyFrontierRegistry,
  evaluateDiscoveryGate,
  normalizeFrontierRegistry,
} from "../scf-runtime/shared/frontier.js";
import { emptyWorldCanon, mergeWorldObservations } from "../scf-runtime/shared/world-memory.js";

const place = {
  id: "place-inn",
  identity: "place:云杉客栈一楼早餐厅",
  type: "place",
  name: "云杉客栈一楼早餐厅",
  lifecycle_status: "canonical",
  aliases: [],
};

const observation = {
  entity_type: "character",
  name: "花猫客人",
  observed_facts: ["在窗边翻看花草图册"],
  visual_facts: ["灰白色小猫", "穿浅蓝色针织衫"],
  relationship_note: "第一次见面",
  knowledge_source: "direct_observation",
};

const meta = {
  event_id: "event-1",
  tick_id: "tick-1",
  occurred_at: "2026-08-09T09:30:00.000Z",
  location: "云杉客栈一楼早餐厅",
  current_location: "云杉客栈一楼早餐厅",
};

function canonicalWorld() {
  return { schema_version: 1, entities: [place] };
}

describe("frontier registry and discovery gate", () => {
  it("normalizes missing state to a compatible empty registry", () => {
    expect(normalizeFrontierRegistry(null)).toEqual(emptyFrontierRegistry());
  });

  it("rejects hearsay without a canonical character source", () => {
    const gate = evaluateDiscoveryGate({
      registryValue: emptyFrontierRegistry(),
      worldCanon: emptyWorldCanon(),
      rawObservations: [{
        ...observation,
        knowledge_source: "heard_from_character",
        source_character: "不存在的狐狸",
      }],
      meta,
    });
    expect(gate.accepted).toEqual([]);
    expect(gate.decisions[0]).toMatchObject({
      outcome: "rejected",
      reasons: expect.arrayContaining(["missing_source_canon"]),
    });
    expect(gate.registry.items).toEqual([]);
  });

  it("allows direct observation from a named location even when Canon has no places yet", () => {
    const gate = evaluateDiscoveryGate({
      registryValue: emptyFrontierRegistry(),
      worldCanon: emptyWorldCanon(),
      rawObservations: [observation],
      meta,
    });
    expect(gate.accepted).toHaveLength(1);
    expect(gate.decisions[0]).toMatchObject({ outcome: "allowed" });
    expect(gate.accepted[0].discovery_evidence.source_canon_name).toBe(meta.current_location);
  });

  it("allows one sourced discovery, records a Frontier, and keeps the entity provisional", () => {
    const gate = evaluateDiscoveryGate({
      registryValue: emptyFrontierRegistry(),
      worldCanon: canonicalWorld(),
      rawObservations: [observation, {
        entity_type: "place",
        name: "陌生后门",
        observed_facts: ["门外有石阶"],
        visual_facts: ["窄木门"],
        knowledge_source: "direct_observation",
      }],
      meta,
    });
    expect(gate.accepted).toHaveLength(1);
    expect(gate.decisions).toHaveLength(2);
    expect(gate.decisions[0]).toMatchObject({ outcome: "allowed", consumed_growth_budget: true });
    expect(gate.decisions[1]).toMatchObject({ outcome: "deferred", reasons: ["event_discovery_limit"] });
    expect(gate.registry.items[0]).toMatchObject({
      source_canon_id: place.id,
      source_canon_name: place.name,
      first_seen_event_id: meta.event_id,
      state: "discovered",
      allowed_entity_types: ["character"],
    });

    const merged = mergeWorldObservations(canonicalWorld(), gate.accepted, meta);
    const discovered = merged.canon.entities.find((entity) => entity.name === "花猫客人");
    expect(discovered).toMatchObject({
      lifecycle_status: "provisional",
      appearances: 1,
      discovery_evidence: {
        frontier_id: gate.decisions[0].frontier_id,
        source_canon_id: place.id,
        observation_event_id: meta.event_id,
      },
    });
  });

  it("replays the same decision without consuming budget or creating a second candidate", () => {
    const first = evaluateDiscoveryGate({
      registryValue: emptyFrontierRegistry(),
      worldCanon: canonicalWorld(),
      rawObservations: [observation],
      meta,
    });
    const replay = evaluateDiscoveryGate({
      registryValue: first.registry,
      worldCanon: canonicalWorld(),
      rawObservations: [observation],
      meta,
    });
    expect(replay.accepted).toHaveLength(1);
    expect(replay.decisions).toHaveLength(1);
    expect(replay.decisions[0]).toMatchObject({ replayed: true, outcome: "allowed" });
    expect(replay.registry.decisions).toHaveLength(first.registry.decisions.length);
    expect(replay.snapshot.consumed_growth_budget).toBe(false);
  });

  it("requires a second distinct direct observation before canonical promotion", () => {
    const firstGate = evaluateDiscoveryGate({
      registryValue: emptyFrontierRegistry(),
      worldCanon: canonicalWorld(),
      rawObservations: [observation],
      meta,
    });
    const firstMerge = mergeWorldObservations(canonicalWorld(), firstGate.accepted, meta);
    expect(firstMerge.canon.entities.find((entity) => entity.name === "花猫客人")?.lifecycle_status).toBe("provisional");

    const replayGate = evaluateDiscoveryGate({
      registryValue: firstGate.registry,
      worldCanon: firstMerge.canon,
      rawObservations: [observation],
      meta,
    });
    const replayMerge = mergeWorldObservations(firstMerge.canon, replayGate.accepted, meta);
    expect(replayMerge.canon.entities.find((entity) => entity.name === "花猫客人")?.lifecycle_status).toBe("provisional");

    const secondMeta = {
      ...meta,
      event_id: "event-2",
      tick_id: "tick-2",
      occurred_at: "2026-08-10T09:30:00.000Z",
    };
    const secondGate = evaluateDiscoveryGate({
      registryValue: replayGate.registry,
      worldCanon: replayMerge.canon,
      rawObservations: [observation],
      meta: secondMeta,
    });
    expect(secondGate.decisions[0]).toMatchObject({ outcome: "confirmation", consumed_growth_budget: false });
    const secondMerge = mergeWorldObservations(replayMerge.canon, secondGate.accepted, secondMeta);
    const canonical = secondMerge.canon.entities.find((entity) => entity.name === "花猫客人");
    expect(canonical).toMatchObject({ lifecycle_status: "canonical", appearances: 2 });
    expect(canonical.discovery_evidence.frontier_id).toBe(firstGate.decisions[0].frontier_id);
    expect(canonical.history).toHaveLength(2);
  });

  it("defers discovery during cooldown or when the rolling growth budget is exhausted", () => {
    const first = evaluateDiscoveryGate({
      registryValue: emptyFrontierRegistry(),
      worldCanon: canonicalWorld(),
      rawObservations: [observation],
      meta,
      options: { growthBudget: 1 },
    });
    const second = evaluateDiscoveryGate({
      registryValue: first.registry,
      worldCanon: canonicalWorld(),
      rawObservations: [{
        entity_type: "object",
        name: "刻花木盒",
        observed_facts: ["放在窗台下"],
        visual_facts: ["深色木纹"],
        knowledge_source: "direct_observation",
      }],
      meta: { ...meta, event_id: "event-2", occurred_at: "2026-08-09T10:30:00.000Z" },
      options: { growthBudget: 1 },
    });
    expect(second.accepted).toEqual([]);
    expect(second.decisions[0]).toMatchObject({ outcome: "deferred", reasons: ["growth_budget_exhausted"] });

    const cooldown = evaluateDiscoveryGate({
      registryValue: first.registry,
      worldCanon: canonicalWorld(),
      rawObservations: [observation],
      meta: { ...meta, event_id: "event-3", occurred_at: "2026-08-09T11:30:00.000Z" },
      options: { growthBudget: 10, cooldownHours: 36 },
    });
    expect(cooldown.accepted).toEqual([]);
    expect(cooldown.decisions[0]).toMatchObject({ outcome: "deferred", reasons: ["frontier_cooldown"] });
  });

  it("allows arriving at a new place without a pre-registered path edge", () => {
    const room = {
      id: "place-room",
      identity: "place:云杉客栈二楼房间",
      type: "place",
      name: "云杉客栈二楼房间",
      lifecycle_status: "canonical",
      aliases: [],
    };
    const gate = evaluateDiscoveryGate({
      registryValue: emptyFrontierRegistry(),
      worldCanon: { schema_version: 1, entities: [room] },
      rawObservations: [{
        entity_type: "place",
        name: "小镇溪边的草坪",
        observed_facts: ["草很软", "能听见流水"],
        visual_facts: ["浅绿色草坪"],
        knowledge_source: "direct_observation",
      }, observation],
      meta: {
        event_id: "event-creek",
        tick_id: "tick-creek",
        occurred_at: "2026-08-10T08:00:00.000Z",
        location: "小镇溪边的草坪",
        current_location: room.name,
      },
    });
    expect(gate.accepted.map((item) => item.name)).toEqual([
      "小镇溪边的草坪",
      "花猫客人",
    ]);
    expect(gate.decisions[0]).toMatchObject({
      outcome: "allowed",
      consumed_growth_budget: false,
    });
    expect(gate.decisions[1]).toMatchObject({
      outcome: "allowed",
      consumed_growth_budget: true,
    });
  });
});
