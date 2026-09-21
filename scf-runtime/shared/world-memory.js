import { DEFAULT_LIFE_ENGINE_CONFIG } from "./life-engine-config.js";

const ENTITY_TYPES = new Set(["character", "place", "object"]);
const KNOWLEDGE_SOURCES = new Set(["direct_observation", "heard_from_character", "found_object"]);
const MAX_ENTITIES = 80;
const MAX_FACTS = 20;
const MAX_VISUAL_FACTS = 12;
const MAX_HISTORY = 20;

function hash(text) {
  let value = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    value = Math.imul(value ^ text.charCodeAt(index), 16777619);
  }
  return (value >>> 0).toString(16).padStart(8, "0");
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function cleanText(value, maxLength = 160) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function cleanList(value, limit, maxLength = 120) {
  return [...new Set(asArray(value).map((item) => cleanText(item, maxLength)).filter(Boolean))].slice(0, limit);
}

export function worldEntityIdentity(type, name) {
  return `${type}:${cleanText(name, 80).replace(/[\s\p{P}\p{S}]+/gu, "").toLowerCase()}`;
}

export function worldEntityId(type, name) {
  return `${type}-${hash(worldEntityIdentity(type, name))}`;
}

export function emptyWorldCanon() {
  return { schema_version: 1, entities: [], updated_at: null };
}

const DEFAULT_SEED_PLACES = DEFAULT_LIFE_ENGINE_CONFIG.world.seed_places;

function samePlaceName(left, right) {
  const a = cleanText(left, 120).replace(/\s+/g, "");
  const b = cleanText(right, 120).replace(/\s+/g, "");
  return Boolean(a && b && (a === b || a.includes(b) || b.includes(a)));
}

function seedPlaceEntity(name, nowIso, worldName = DEFAULT_LIFE_ENGINE_CONFIG.world.name) {
  const placeName = cleanText(name, 80);
  return {
    id: worldEntityId("place", placeName),
    identity: worldEntityIdentity("place", placeName),
    type: "place",
    name: placeName,
    aliases: [],
    first_seen_at: nowIso,
    first_seen_event_id: "seed-known-place",
    first_seen_location: placeName,
    known_facts: [`${worldName}中已确认存在的地点`],
    visual_facts: [],
    relationship_note: "",
    status_observed: "known",
    appearances: 2,
    lifecycle_status: "canonical",
    history: [],
    discovery_evidence: {
      frontier_id: null,
      discovery_decision_id: null,
      source_canon_id: null,
      source_canon_name: null,
      observation_event_id: "seed-known-place",
      observation_source: "seed",
      observation_location: placeName,
    },
  };
}

/**
 * Ensure known spruce-town places exist as canonical entities so Discovery Gate
 * has a source even when production Canon was built before place tracking.
 * Also normalizes legacy entities that lack lifecycle_status.
 */
export function ensureWorldPlaceCanon(canonValue, {
  currentLocation = "",
  extraPlaces = [],
  seedPlaces = DEFAULT_SEED_PLACES,
  worldName = DEFAULT_LIFE_ENGINE_CONFIG.world.name,
  nowIso = null,
} = {}) {
  const canon = canonValue && typeof canonValue === "object" ? canonValue : emptyWorldCanon();
  const occurredAt = cleanText(nowIso, 40) || new Date().toISOString();
  const entities = asArray(canon.entities).map((entity) => {
    if (!entity || typeof entity !== "object") return entity;
    if (entity.lifecycle_status) return entity;
    // Legacy production entities predate lifecycle_status; treat multi-seen as canonical.
    const appearances = Number(entity.appearances || 0);
    return {
      ...entity,
      lifecycle_status: appearances >= 2 ? "canonical" : "provisional",
    };
  });
  const wanted = [...new Set([
    ...asArray(seedPlaces),
    ...asArray(extraPlaces).map((item) => cleanText(item, 80)).filter(Boolean),
    cleanText(currentLocation, 80),
  ].filter(Boolean))];

  let changed = entities.some((entity, index) => (
    entity?.lifecycle_status !== asArray(canon.entities)[index]?.lifecycle_status
  ));
  for (const placeName of wanted) {
    const exists = entities.some((entity) => (
      entity?.type === "place" && samePlaceName(entity.name, placeName)
    ));
    if (exists) continue;
    entities.push(seedPlaceEntity(placeName, occurredAt, worldName));
    changed = true;
  }

  if (!changed) {
    return { canon: { ...canon, entities }, changed: false };
  }
  return {
    canon: {
      schema_version: 1,
      entities,
      updated_at: occurredAt,
    },
    changed: true,
  };
}

export function normalizeWorldObservation(raw) {
  const type = cleanText(raw?.entity_type, 20).toLowerCase();
  const name = cleanText(raw?.name, 80);
  if (!ENTITY_TYPES.has(type) || !name) return null;
  const source = cleanText(raw?.knowledge_source, 40);
  const evidence = raw?.discovery_evidence && typeof raw.discovery_evidence === "object"
    ? {
      frontier_id: cleanText(raw.discovery_evidence.frontier_id, 100) || null,
      discovery_decision_id: cleanText(raw.discovery_evidence.discovery_decision_id, 100) || null,
      source_canon_id: cleanText(raw.discovery_evidence.source_canon_id, 100) || null,
      source_canon_name: cleanText(raw.discovery_evidence.source_canon_name, 100) || null,
      observation_event_id: cleanText(raw.discovery_evidence.observation_event_id, 120) || null,
      observation_source: cleanText(raw.discovery_evidence.observation_source, 40) || null,
      observation_location: cleanText(raw.discovery_evidence.observation_location, 120) || null,
    }
    : null;
  return {
    entity_type: type,
    name,
    observed_facts: cleanList(raw?.observed_facts, 8),
    visual_facts: cleanList(raw?.visual_facts, 6),
    relationship_note: cleanText(raw?.relationship_note, 120),
    status_observed: cleanText(raw?.status_observed, 100),
    knowledge_source: KNOWLEDGE_SOURCES.has(source) ? source : "direct_observation",
    discovery_evidence: evidence,
  };
}

function mergeUnique(existing, incoming, limit) {
  return [...new Set([...asArray(existing), ...incoming].map((item) => cleanText(item)).filter(Boolean))].slice(-limit);
}

export function mergeWorldObservations(canonValue, rawObservations, meta) {
  const canon = canonValue && typeof canonValue === "object" ? canonValue : emptyWorldCanon();
  const entities = asArray(canon.entities).map((entity) => ({ ...entity }));
  const accepted = [];
  const changedEntities = [];
  let createdCount = 0;

  for (const raw of asArray(rawObservations)) {
    const observation = normalizeWorldObservation(raw);
    if (!observation) continue;
    const identity = worldEntityIdentity(observation.entity_type, observation.name);
    const existingIndex = entities.findIndex((entity) => entity.identity === identity
      || (entity.type === observation.entity_type && asArray(entity.aliases).includes(observation.name)));
    const isNew = existingIndex < 0;
    if (isNew && (createdCount >= 1 || entities.length >= MAX_ENTITIES)) continue;
    if (isNew && observation.entity_type === "character" && observation.visual_facts.length === 0) continue;

    const previous = isNew ? {
      id: worldEntityId(observation.entity_type, observation.name),
      identity,
      type: observation.entity_type,
      name: observation.name,
      aliases: [],
      first_seen_at: meta.occurred_at,
      first_seen_event_id: meta.event_id,
      first_seen_location: meta.location || "",
      known_facts: [],
      visual_facts: [],
      relationship_note: "",
      status_observed: "",
      appearances: 0,
      lifecycle_status: "provisional",
      history: [],
      discovery_evidence: observation.discovery_evidence || null,
    } : entities[existingIndex];

    if (!isNew && previous.last_seen_event_id && previous.last_seen_event_id === meta.event_id) {
      continue;
    }

    const acceptedVisualFacts = isNew || asArray(previous.visual_facts).length === 0
      ? observation.visual_facts
      : [];
    const historyEntry = {
      event_id: meta.event_id,
      observed_at: meta.occurred_at,
      location: meta.location || "",
      knowledge_source: observation.knowledge_source,
      observed_facts: observation.observed_facts,
      visual_facts: acceptedVisualFacts,
      relationship_note: observation.relationship_note || null,
      status_observed: observation.status_observed || null,
      discovery_evidence: observation.discovery_evidence || previous.discovery_evidence || null,
    };
    const next = {
      ...previous,
      name: previous.name || observation.name,
      known_facts: mergeUnique(previous.known_facts, observation.observed_facts, MAX_FACTS),
      visual_facts: mergeUnique(previous.visual_facts, acceptedVisualFacts, MAX_VISUAL_FACTS),
      relationship_note: observation.relationship_note || previous.relationship_note || "",
      status_observed: observation.status_observed || previous.status_observed || "",
      last_seen_at: meta.occurred_at,
      last_seen_event_id: meta.event_id,
      appearances: Number(previous.appearances || 0) + 1,
      lifecycle_status: isNew
        ? "provisional"
        : (previous.lifecycle_status === "provisional" ? "canonical" : (previous.lifecycle_status || "canonical")),
      history: [...asArray(previous.history), historyEntry].slice(-MAX_HISTORY),
      discovery_evidence: previous.discovery_evidence || observation.discovery_evidence || null,
    };

    if (isNew) {
      entities.push(next);
      createdCount += 1;
    } else {
      entities[existingIndex] = next;
    }
    accepted.push({ ...observation, visual_facts: acceptedVisualFacts, entity_id: next.id, is_new: isNew });
    changedEntities.push(next);
  }

  return {
    canon: {
      schema_version: 1,
      entities,
      updated_at: meta.occurred_at,
    },
    accepted,
    changedEntities,
  };
}

export function worldCanonForPrompt(canonValue) {
  const entities = asArray(canonValue?.entities).slice(-40).map((entity) => ({
    type: entity.type,
    name: entity.name,
    known_facts: asArray(entity.known_facts).slice(-8),
    visual_facts: asArray(entity.visual_facts).slice(-6),
    relationship_note: entity.relationship_note || "",
    status_observed: entity.status_observed || "",
    lifecycle_status: entity.lifecycle_status || "canonical",
    usage_rule: entity.lifecycle_status === "provisional"
      ? "仅是一次直接观察形成的候选事实；可以谨慎记得这次相遇，但不得补写稳定身份、关系、职业或背景，等待后续独立观察确认。"
      : "已经由多次观察确认，可作为稳定世界事实继续使用。",
    last_seen_at: entity.last_seen_at || "",
  }));
  return entities;
}

export function worldEntityKey(entity) {
  return `world/entities/${entity.type}/${entity.id}.json`;
}
