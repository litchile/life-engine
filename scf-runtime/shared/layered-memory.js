const KEYS = {
  canon: "state/memory/canon.json",
  episodes: "state/memory/episodes.json",
  entities: "state/memory/entities.json",
  reflections: "state/memory/reflections.json",
  intentions: "state/memory/intentions.json",
};

const limits = { canon: 120, episodes: 160, entities: 120, reflections: 80, intentions: 80 };

function text(value, max = 300) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function idFor(prefix, value) {
  let hash = 2166136261;
  const source = text(value, 800);
  for (let index = 0; index < source.length; index += 1) hash = Math.imul(hash ^ source.charCodeAt(index), 16777619);
  return `${prefix}-${(hash >>> 0).toString(16)}`;
}

function uniqueById(items, limit) {
  const found = new Map();
  for (const item of items) {
    if (!item?.id) continue;
    const previous = found.get(item.id);
    if (!previous || String(item.updated_at || item.occurred_at || "") > String(previous.updated_at || previous.occurred_at || "")) found.set(item.id, item);
  }
  return [...found.values()].sort((a, b) => String(b.updated_at || b.occurred_at || "").localeCompare(String(a.updated_at || a.occurred_at || ""))).slice(0, limit);
}

function legacyLayers(legacy, nowIso) {
  const memories = list(legacy.agentMemories);
  const canon = memories.filter((item) => ["fact", "correction"].includes(item.kind)).map((item) => ({
    ...item,
    id: item.id || idFor("canon", `${item.subject}|${item.predicate}|${item.content}`),
    updated_at: item.updated_at || nowIso,
  }));
  const reflections = memories.filter((item) => item.kind === "preference").map((item) => ({
    ...item,
    id: item.id || idFor("reflection", item.content),
    reflection_type: "preference",
    updated_at: item.updated_at || nowIso,
  }));
  const intentions = memories.filter((item) => ["intention", "promise"].includes(item.kind)).map((item) => ({
    ...item,
    id: item.id || idFor("intention", `${item.subject}|${item.predicate}|${item.content}`),
    status: item.status || "active",
    updated_at: item.updated_at || nowIso,
  }));
  const episodes = [
    ...list(legacy.recentEvents).map((event) => ({
      id: event.id || idFor("episode", `${event.occurred_at}|${event.activity}|${event.narrative}`),
      occurred_at: event.occurred_at || nowIso,
      location: text(event.location, 120),
      activity: text(event.activity, 160),
      narrative: text(event.narrative || event.diary, 500),
      importance: Number(event.importance || 1),
      source_event_id: event.id || null,
      updated_at: event.occurred_at || nowIso,
    })),
    ...memories.filter((item) => item.kind === "episode").map((item) => ({ ...item, id: item.id || idFor("episode", item.content), narrative: item.content, updated_at: item.updated_at || nowIso })),
  ];
  const entities = list(legacy.worldCanon?.entities).map((entity) => ({ ...entity, id: entity.id || idFor("entity", entity.name), updated_at: entity.updated_at || nowIso }));
  return { canon, episodes, entities, reflections, intentions };
}

export async function loadLayeredMemory(store, legacy = {}, nowIso = new Date().toISOString()) {
  const [canon, episodes, entities, reflections, intentions] = await Promise.all([
    store.getJson(KEYS.canon, { items: [] }),
    store.getJson(KEYS.episodes, { items: [] }),
    store.getJson(KEYS.entities, { items: [] }),
    store.getJson(KEYS.reflections, { items: [] }),
    store.getJson(KEYS.intentions, { items: [] }),
  ]);
  const migrated = legacyLayers(legacy, nowIso);
  return {
    schema_version: 3,
    canon: uniqueById([...list(canon?.items), ...migrated.canon], limits.canon),
    episodes: uniqueById([...list(episodes?.items), ...migrated.episodes], limits.episodes),
    entities: uniqueById([...list(entities?.items), ...migrated.entities], limits.entities),
    reflections: uniqueById([...list(reflections?.items), ...migrated.reflections], limits.reflections),
    intentions: uniqueById([...list(intentions?.items), ...migrated.intentions], limits.intentions),
    updated_at: nowIso,
  };
}

export async function persistLayeredMemory(store, layers) {
  const nowIso = layers.updated_at || new Date().toISOString();
  await Promise.all(Object.entries(KEYS).map(([name, key]) => store.putJson(key, {
    schema_version: 3,
    items: list(layers[name]).slice(0, limits[name]),
    updated_at: nowIso,
  })));
}

function routeUpdate(update, nowIso) {
  const content = text(update?.content, 500);
  if (!content) return null;
  const base = {
    ...update,
    content,
    updated_at: nowIso,
    importance: Math.max(1, Math.min(5, Number(update?.importance || 1))),
  };
  if (["intention", "promise"].includes(update.kind)) return { layer: "intentions", item: { ...base, id: update.id || idFor("intention", `${update.subject}|${update.predicate}|${content}`), status: update.operation === "resolve" ? "resolved" : "active" } };
  if (update.kind === "episode") return { layer: "episodes", item: { ...base, id: update.id || idFor("episode", content), narrative: content, occurred_at: nowIso } };
  if (update.kind === "preference") return { layer: "reflections", item: { ...base, id: update.id || idFor("reflection", content), reflection_type: "preference" } };
  return { layer: "canon", item: { ...base, id: update.id || idFor("canon", `${update.subject}|${update.predicate}|${content}`), status: "active" } };
}

export function applyEventToLayeredMemory(layers, event, memoryUpdates = [], worldCanon = null, nowIso = new Date().toISOString()) {
  const next = { ...layers, updated_at: nowIso };
  for (const name of Object.keys(KEYS)) next[name] = [...list(layers[name])];
  if (event) {
    next.episodes.unshift({
      id: event.id || event.event_id || idFor("episode", `${nowIso}|${event.activity}|${event.narrative}`),
      occurred_at: event.occurred_at || nowIso,
      location: text(event.location, 120),
      activity: text(event.activity, 160),
      narrative: text(event.narrative || event.diary, 500),
      importance: Math.max(1, Math.min(5, Number(event.importance || 1))),
      notified: Boolean(event.notified),
      source_event_id: event.id || event.event_id || null,
      updated_at: nowIso,
    });
    // A changed state or important event is not automatically a new insight.
    // Keep the evidence once in episodes; preferences come from explicit updates.
  }
  for (const update of list(memoryUpdates)) {
    const routed = routeUpdate(update, nowIso);
    if (!routed) continue;
    if (routed.layer === "intentions" && update.operation === "resolve") {
      next.intentions = next.intentions.map((item) => (
        (item.id === routed.item.id || item.content === routed.item.content
          || (update.subject && update.predicate && item.subject === update.subject && item.predicate === update.predicate))
          ? { ...item, status: "resolved", resolved_at: nowIso, updated_at: nowIso } : item
      ));
    } else {
      if (routed.layer === "canon" && routed.item.subject && routed.item.predicate) {
        next.canon = next.canon.map((item) => (
          item.status !== "superseded"
          && item.subject === routed.item.subject
          && item.predicate === routed.item.predicate
          && item.content !== routed.item.content
            ? { ...item, status: "superseded", superseded_at: nowIso, updated_at: nowIso }
            : item
        ));
      }
      next[routed.layer].unshift(routed.item);
    }
  }
  if (worldCanon?.entities) {
    const normalizedEntities = list(worldCanon.entities).map((entity) => ({
      ...entity,
      id: entity.id || entity.entity_id || idFor("entity", `${entity.entity_type || "entity"}|${entity.name || entity.canonical_name || JSON.stringify(entity)}`),
      updated_at: entity.updated_at || nowIso,
    }));
    next.entities = [...normalizedEntities, ...next.entities];
  }
  for (const name of Object.keys(KEYS)) next[name] = uniqueById(next[name], limits[name]);
  return next;
}

function grams(value) {
  const source = text(value, 900).toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
  const output = new Set();
  for (let index = 0; index < source.length - 1; index += 1) output.add(source.slice(index, index + 2));
  return output;
}

function score(item, query, nowIso) {
  const haystack = grams(JSON.stringify(item));
  const needle = grams(query);
  let overlap = 0;
  for (const token of needle) if (haystack.has(token)) overlap += 1;
  const relevance = needle.size ? overlap / needle.size : 0;
  const ageDays = Math.max(0, ((Date.parse(nowIso) || Date.now()) - (Date.parse(item.updated_at || item.occurred_at) || Date.now())) / 86_400_000);
  return relevance * 12 + Number(item.importance || 1) * 1.5 + 1 / (1 + ageDays / 14);
}

export function retrieveLayeredMemory(layers, { query = "", limit = 12, nowIso = new Date().toISOString() } = {}) {
  const ranked = (items, count) => list(items)
    .filter((item) => item.status !== "resolved" && item.status !== "superseded")
    .map((item) => ({ ...item, retrieval_score: Number(score(item, query, nowIso).toFixed(3)) }))
    .sort((a, b) => b.retrieval_score - a.retrieval_score)
    .slice(0, count);
  const canon = ranked(layers.canon, 3);
  const intentions = ranked(layers.intentions, 3);
  const entities = ranked(layers.entities, 3);
  const episodes = ranked(layers.episodes, 4);
  const reflections = ranked(layers.reflections, 2);
  const budget = Math.max(0, Math.min(20, Number.isFinite(limit) ? Math.floor(limit) : 12));
  const selected = [...canon, ...intentions, ...entities, ...episodes, ...reflections]
    .sort((a, b) => b.retrieval_score - a.retrieval_score).slice(0, budget);
  const included = new Set(selected);
  return {
    canon: canon.filter((item) => included.has(item)),
    intentions: intentions.filter((item) => included.has(item)),
    entities: entities.filter((item) => included.has(item)),
    episodes: episodes.filter((item) => included.has(item)),
    reflections: reflections.filter((item) => included.has(item)),
    prompt_items: selected,
  };
}

export function layeredMemoryForPrompt(retrieved) {
  return {
    stable_facts: retrieved.canon,
    active_intentions: retrieved.intentions,
    relevant_entities: retrieved.entities,
    relevant_episodes: retrieved.episodes,
    reflections_and_preferences: retrieved.reflections,
  };
}

export { KEYS as LAYERED_MEMORY_KEYS };
