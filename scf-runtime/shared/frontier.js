import {
  normalizeWorldObservation,
  worldEntityId,
  worldEntityIdentity,
} from "./world-memory.js";

const SCHEMA_VERSION = 1;
const FRONTIER_STATES = new Set(["open", "deferred", "discovered", "closed"]);
const ENTITY_TYPES = new Set(["character", "place", "object"]);
const TRUSTED_SOURCES = new Set(["direct_observation", "found_object", "heard_from_character"]);
const DEFAULT_COOLDOWN_HOURS = 36;
const DEFAULT_BUDGET_WINDOW_DAYS = 7;
const DEFAULT_GROWTH_BUDGET = 4;
const MAX_FRONTIERS = 80;
const MAX_DECISIONS = 160;

function list(value) {
  return Array.isArray(value) ? value : [];
}

function text(value, limit = 160) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function hash(value) {
  let result = 2166136261;
  const source = String(value || "");
  for (let index = 0; index < source.length; index += 1) {
    result = Math.imul(result ^ source.charCodeAt(index), 16777619);
  }
  return (result >>> 0).toString(16).padStart(8, "0");
}

function iso(value, fallback = null) {
  const date = new Date(value || "");
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function samePlace(left, right) {
  const a = text(left, 100).replace(/\s+/g, "");
  const b = text(right, 100).replace(/\s+/g, "");
  return Boolean(a && b && (a === b || a.includes(b) || b.includes(a)));
}

function canonicalEntities(worldCanon) {
  return list(worldCanon?.entities).filter((entity) => {
    const status = entity?.lifecycle_status;
    // Legacy entities without lifecycle_status remain usable discovery sources.
    return !status || status === "canonical";
  });
}

function syntheticPlaceSource(name) {
  const placeName = text(name, 120);
  if (!placeName) return null;
  return {
    id: worldEntityId("place", placeName),
    identity: worldEntityIdentity("place", placeName),
    type: "place",
    name: placeName,
    lifecycle_status: "canonical",
    aliases: [],
  };
}

function isArrivalPlaceObservation(observation, location, currentLocation) {
  return observation?.entity_type === "place"
    && Boolean(text(location, 120))
    && !samePlace(location, currentLocation)
    && samePlace(observation?.name, location);
}

function canonicalSourceForObservation(worldCanon, observation, location, currentLocation) {
  const entities = canonicalEntities(worldCanon);
  const explicitId = text(observation?.source_canon_id, 100);
  if (explicitId) {
    const explicit = entities.find((entity) => entity.id === explicitId);
    if (explicit) return explicit;
  }

  const canonicalPlace = entities.find((entity) => (
    entity.type === "place"
    && (samePlace(entity.name, currentLocation) || samePlace(entity.name, location))
  ));
  if (canonicalPlace) return canonicalPlace;

  if (observation?.knowledge_source === "heard_from_character") {
    const sourceName = text(observation?.source_character, 80);
    return entities.find((entity) => entity.type === "character" && sourceName && samePlace(entity.name, sourceName)) || null;
  }

  // Spruce-town exploration may leave a registered path graph; fall back to any known
  // canonical place so a continuous journey can still attach discovery evidence.
  if (observation?.entity_type === "place" || observation?.knowledge_source === "direct_observation" || observation?.knowledge_source === "found_object") {
    const anyPlace = entities.find((entity) => entity.type === "place");
    if (anyPlace) return anyPlace;
  }

  // Continuous arrival / direct observation from a named current location may proceed
  // even when Canon has not yet stored place entities.
  if (
    isArrivalPlaceObservation(observation, location, currentLocation)
    || observation?.knowledge_source === "direct_observation"
    || observation?.knowledge_source === "found_object"
  ) {
    return syntheticPlaceSource(currentLocation) || syntheticPlaceSource(location);
  }
  return null;
}

function normalizeFrontier(raw) {
  const id = text(raw?.id, 100);
  const sourceCanonId = text(raw?.source_canon_id, 100);
  if (!id || !sourceCanonId) return null;
  const allowedTypes = [...new Set(list(raw?.allowed_entity_types)
    .map((item) => text(item, 20).toLowerCase())
    .filter((item) => ENTITY_TYPES.has(item)))].slice(0, 3);
  return {
    id,
    source_canon_id: sourceCanonId,
    source_canon_name: text(raw?.source_canon_name, 100),
    observation_source: TRUSTED_SOURCES.has(raw?.observation_source)
      ? raw.observation_source
      : "direct_observation",
    first_seen_event_id: text(raw?.first_seen_event_id, 120),
    first_seen_at: iso(raw?.first_seen_at),
    first_seen_location: text(raw?.first_seen_location, 120),
    clue: text(raw?.clue, 160),
    state: FRONTIER_STATES.has(raw?.state) ? raw.state : "open",
    cooldown_until: iso(raw?.cooldown_until),
    allowed_entity_types: allowedTypes.length ? allowedTypes : ["object"],
    revealed_entity_id: text(raw?.revealed_entity_id, 100) || null,
    revealed_event_id: text(raw?.revealed_event_id, 120) || null,
    revealed_at: iso(raw?.revealed_at),
    updated_at: iso(raw?.updated_at),
  };
}

function normalizeDecision(raw) {
  const eventId = text(raw?.event_id, 120);
  const observationIdentity = text(raw?.observation_identity, 180);
  if (!eventId || !observationIdentity) return null;
  return {
    id: text(raw?.id, 100) || `discovery-${hash(`${eventId}:${observationIdentity}`)}`,
    event_id: eventId,
    tick_id: text(raw?.tick_id, 120) || null,
    observation_identity: observationIdentity,
    frontier_id: text(raw?.frontier_id, 100) || null,
    outcome: ["allowed", "deferred", "rejected", "confirmation"].includes(raw?.outcome)
      ? raw.outcome
      : "rejected",
    reasons: [...new Set(list(raw?.reasons).map((item) => text(item, 80)).filter(Boolean))].slice(0, 8),
    entity_id: text(raw?.entity_id, 100) || null,
    consumed_growth_budget: Boolean(raw?.consumed_growth_budget),
    decided_at: iso(raw?.decided_at),
  };
}

export function emptyFrontierRegistry() {
  return { schema_version: SCHEMA_VERSION, items: [], decisions: [], updated_at: null };
}

export function normalizeFrontierRegistry(value) {
  return {
    schema_version: SCHEMA_VERSION,
    items: list(value?.items).map(normalizeFrontier).filter(Boolean).slice(-MAX_FRONTIERS),
    decisions: list(value?.decisions).map(normalizeDecision).filter(Boolean).slice(-MAX_DECISIONS),
    updated_at: iso(value?.updated_at),
  };
}

function frontierId(sourceCanonId, observation) {
  return `frontier-${hash(`${sourceCanonId}:${worldEntityIdentity(observation.entity_type, observation.name)}`)}`;
}

function decisionFor(registry, eventId, identity) {
  return registry.decisions.find((decision) => (
    decision.event_id === eventId && decision.observation_identity === identity
  )) || null;
}

function growthUsed(registry, recentEvents, now, windowDays) {
  const threshold = now.getTime() - windowDays * 24 * 60 * 60 * 1000;
  const registryEvents = registry.decisions.filter((decision) => (
    decision.consumed_growth_budget
    && new Date(decision.decided_at || 0).getTime() >= threshold
  )).map((decision) => decision.event_id);
  const eventSnapshots = list(recentEvents).filter((event) => {
    const decidedAt = new Date(event?.occurred_at || 0).getTime();
    return decidedAt >= threshold && event?.discovery_snapshot?.consumed_growth_budget;
  }).map((event) => event.id);
  return new Set([...registryEvents, ...eventSnapshots]).size;
}

function decisionRecord({ eventId, tickId, identity, frontierIdValue, outcome, reasons, entityId, consumed, nowIso }) {
  return {
    id: `discovery-${hash(`${eventId}:${identity}`)}`,
    event_id: eventId,
    tick_id: tickId || null,
    observation_identity: identity,
    frontier_id: frontierIdValue || null,
    outcome,
    reasons,
    entity_id: entityId || null,
    consumed_growth_budget: Boolean(consumed),
    decided_at: nowIso,
  };
}

function evidenceFor(decision, sourceCanon, observation, meta) {
  return {
    frontier_id: decision.frontier_id,
    discovery_decision_id: decision.id,
    source_canon_id: sourceCanon?.id || null,
    source_canon_name: sourceCanon?.name || null,
    observation_event_id: meta.event_id,
    observation_source: observation.knowledge_source,
    observation_location: meta.location || "",
  };
}

export function evaluateDiscoveryGate({
  registryValue,
  worldCanon,
  rawObservations,
  recentEvents = [],
  meta,
  options = {},
}) {
  const registry = normalizeFrontierRegistry(registryValue);
  const nowIso = iso(meta?.occurred_at, new Date(0).toISOString());
  const now = new Date(nowIso);
  const eventId = text(meta?.event_id, 120);
  const tickId = text(meta?.tick_id, 120);
  const location = text(meta?.location, 120);
  const currentLocation = text(meta?.current_location || location, 120);
  const budgetWindowDays = Math.max(1, Number(options.budgetWindowDays || DEFAULT_BUDGET_WINDOW_DAYS));
  const growthBudget = Math.max(0, Number(options.growthBudget ?? DEFAULT_GROWTH_BUDGET));
  const cooldownHours = Math.max(1, Number(options.cooldownHours || DEFAULT_COOLDOWN_HOURS));
  const canonEntities = list(worldCanon?.entities);
  const items = [...registry.items];
  const decisions = [...registry.decisions];
  const accepted = [];
  const results = [];
  let used = growthUsed(registry, recentEvents, now, budgetWindowDays);
  let createdThisEvent = 0;

  for (const raw of list(rawObservations)) {
    const observation = normalizeWorldObservation(raw);
    if (!observation) continue;
    const identity = worldEntityIdentity(observation.entity_type, observation.name);
    const replay = decisionFor(registry, eventId, identity);
    if (replay) {
      const replayFrontier = registry.items.find((item) => item.id === replay.frontier_id);
      const sourceCanon = replayFrontier
        ? canonEntities.find((item) => item.id === replayFrontier.source_canon_id)
        : null;
      if (["allowed", "confirmation"].includes(replay.outcome)) {
        accepted.push({
          ...observation,
          discovery_evidence: evidenceFor(replay, sourceCanon, observation, meta),
        });
      }
      results.push({ ...replay, replayed: true });
      continue;
    }

    const existing = canonEntities.find((entity) => (
      entity.identity === identity
      || (entity.type === observation.entity_type && list(entity.aliases).includes(observation.name))
    ));
    if (existing) {
      const originalFrontierId = text(existing.discovery_evidence?.frontier_id, 100) || null;
      const sourceCanon = originalFrontierId
        ? canonEntities.find((entity) => entity.id === existing.discovery_evidence?.source_canon_id)
        : null;
      const reasons = [];
      if (observation.knowledge_source !== "direct_observation") reasons.push("confirmation_requires_direct_observation");
      const outcome = reasons.length ? "deferred" : "confirmation";
      const decision = decisionRecord({
        eventId, tickId, identity, frontierIdValue: originalFrontierId, outcome, reasons,
        entityId: existing.id, consumed: false, nowIso,
      });
      decisions.push(decision);
      if (outcome === "confirmation") {
        accepted.push({ ...observation, discovery_evidence: evidenceFor(decision, sourceCanon, observation, meta) });
      }
      results.push(decision);
      continue;
    }

    const sourceCanon = canonicalSourceForObservation(worldCanon, raw, location, currentLocation);
    const reasons = [];
    if (!eventId) reasons.push("missing_event_id");
    if (!sourceCanon) reasons.push("missing_source_canon");
    if (!TRUSTED_SOURCES.has(observation.knowledge_source)) reasons.push("untrusted_observation_source");
    if (observation.knowledge_source === "heard_from_character" && sourceCanon?.type !== "character") {
      reasons.push("hearsay_requires_canonical_character");
    }

    const arrivalPlace = isArrivalPlaceObservation(observation, location, currentLocation);
    const candidateFrontierId = sourceCanon ? frontierId(sourceCanon.id, observation) : null;
    const existingFrontierIndex = candidateFrontierId
      ? items.findIndex((item) => item.id === candidateFrontierId)
      : -1;
    const existingFrontier = existingFrontierIndex >= 0 ? items[existingFrontierIndex] : null;
    // Arrival at a newly named spruce-town place is allowed without a pre-registered path edge.
    // Keep cooldown/budget for other entity types; arrival places skip path-mismatch + cooldown.
    if (!arrivalPlace && existingFrontier && existingFrontier.cooldown_until && new Date(existingFrontier.cooldown_until) > now) {
      reasons.push("frontier_cooldown");
    }
    if (!arrivalPlace && used >= growthBudget) reasons.push("growth_budget_exhausted");
    if (!arrivalPlace && createdThisEvent >= 1) reasons.push("event_discovery_limit");
    if (!arrivalPlace && sourceCanon && sourceCanon.type === "place"
      && !samePlace(sourceCanon.name, currentLocation)
      && !samePlace(sourceCanon.name, location)) {
      reasons.push("source_location_mismatch");
    }

    const deferrable = reasons.some((reason) => [
      "frontier_cooldown", "growth_budget_exhausted", "event_discovery_limit",
    ].includes(reason));
    const outcome = reasons.length ? (deferrable ? "deferred" : "rejected") : "allowed";
    const entityId = outcome === "allowed" ? worldEntityId(observation.entity_type, observation.name) : null;
    const decision = decisionRecord({
      eventId, tickId, identity, frontierIdValue: candidateFrontierId, outcome, reasons,
      // Continuous arrival at a new spruce-town place is movement, not scarce world growth.
      entityId, consumed: outcome === "allowed" && !arrivalPlace, nowIso,
    });
    decisions.push(decision);

    if (sourceCanon) {
      const nextFrontier = {
        id: candidateFrontierId,
        source_canon_id: sourceCanon.id,
        source_canon_name: sourceCanon.name,
        observation_source: observation.knowledge_source,
        first_seen_event_id: existingFrontier?.first_seen_event_id || eventId,
        first_seen_at: existingFrontier?.first_seen_at || nowIso,
        first_seen_location: existingFrontier?.first_seen_location || location,
        clue: existingFrontier?.clue || `${sourceCanon.name}附近出现一条可继续观察的${observation.entity_type}线索`,
        state: outcome === "allowed" ? "discovered" : "deferred",
        cooldown_until: new Date(now.getTime() + cooldownHours * 60 * 60 * 1000).toISOString(),
        allowed_entity_types: [observation.entity_type],
        revealed_entity_id: entityId || existingFrontier?.revealed_entity_id || null,
        revealed_event_id: outcome === "allowed" ? eventId : existingFrontier?.revealed_event_id || null,
        revealed_at: outcome === "allowed" ? nowIso : existingFrontier?.revealed_at || null,
        updated_at: nowIso,
      };
      if (existingFrontierIndex >= 0) items[existingFrontierIndex] = nextFrontier;
      else items.push(nextFrontier);
    }

    if (outcome === "allowed") {
      accepted.push({ ...observation, discovery_evidence: evidenceFor(decision, sourceCanon, observation, meta) });
      if (!arrivalPlace) {
        createdThisEvent += 1;
        used += 1;
      }
    }
    results.push(decision);
  }

  return {
    registry: {
      schema_version: SCHEMA_VERSION,
      items: items.slice(-MAX_FRONTIERS),
      decisions: decisions.slice(-MAX_DECISIONS),
      updated_at: nowIso,
    },
    accepted,
    decisions: results,
    snapshot: {
      schema_version: SCHEMA_VERSION,
      event_id: eventId,
      tick_id: tickId || null,
      location,
      growth_budget: growthBudget,
      growth_used_before: growthUsed(registry, recentEvents, now, budgetWindowDays),
      consumed_growth_budget: results.some((decision) => (
        decision.consumed_growth_budget && !decision.replayed
      )),
      decisions: results.map((decision) => ({
        id: decision.id,
        frontier_id: decision.frontier_id,
        outcome: decision.outcome,
        reasons: decision.reasons,
        entity_id: decision.entity_id,
        replayed: Boolean(decision.replayed),
      })),
    },
  };
}

export function snapshotFrontierRegistry(value) {
  return normalizeFrontierRegistry(value);
}
