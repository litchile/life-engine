import { DEFAULT_LIFE_ENGINE_CONFIG } from "./life-engine-config.js";

const WORLD_TICK_SCHEMA_VERSION = 1;
const TEMPORARY_EVENT_TTL_MS = 3 * 60 * 60 * 1000;

function list(value) {
  return Array.isArray(value) ? value : [];
}

function text(value, maximum = 160) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maximum);
}

function stableHash(value) {
  let result = 2166136261;
  for (const character of String(value || "")) {
    result = Math.imul(result ^ character.charCodeAt(0), 16777619);
  }
  return result >>> 0;
}

function stableId(prefix, value) {
  return `${prefix}-${stableHash(value).toString(16).padStart(8, "0")}`;
}

function canonicalEntities(worldCanon) {
  return list(worldCanon?.entities).filter(
    (entity) => (entity?.lifecycle_status || "canonical") === "canonical",
  );
}

function latestKnownLocation(entity) {
  const history = list(entity?.history);
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const location = text(history[index]?.location, 120);
    if (location) return location;
  }
  return text(entity?.last_seen_location || entity?.first_seen_location, 120);
}

export function npcRelationshipTier(entity) {
  const relationship = text(entity?.relationship_note || entity?.relationship, 200);
  const eventCount = list(entity?.history).filter((entry) => entry?.event_id || entry?.occurred_at).length;
  if (entity?.important_relationship === true || /重要|亲近|朋友|信任|家人/.test(relationship)) return "important_relationship";
  if (eventCount > 0 || relationship) return "encountered_resident";
  return "background_resident";
}

function canonicalNpcPresence(worldCanon, currentLocation) {
  return canonicalEntities(worldCanon)
    .filter((entity) => (entity.type || entity.entity_type) === "character")
    .map((entity) => {
      const knownLocation = latestKnownLocation(entity);
      const isKnownHere = Boolean(knownLocation && knownLocation === currentLocation);
      return {
        entity_id: text(entity.id || entity.entity_id, 100),
        name: text(entity.name || entity.canonical_name, 80),
        relationship_tier: npcRelationshipTier(entity),
        presence: isKnownHere ? "possible_here" : "unknown",
        evidence_location: knownLocation || null,
        rule: isKnownHere
          ? "只表示这个已确认镇民曾在此处出现，本轮可能相遇；不得断言其一定在场"
          : "没有当前位置证据，不得断言其在场或安排其行动",
      };
    })
    .filter((entry) => entry.entity_id && entry.name)
    .sort((left, right) => left.entity_id.localeCompare(right.entity_id));
}

function slotStart(now) {
  const value = new Date(now);
  value.setUTCMinutes(0, 0, 0);
  return value;
}

function temporaryEventTemplate({ period, weather, location }) {
  const wet = /雨|雪|雾|霜/.test(weather);
  const templates = wet ? [
    { kind: "weather_trace", summary: "屋檐、石路或叶片还留着天气造成的水迹与清冷气味" },
    { kind: "slower_passage", summary: "湿滑路面让附近的脚步和搬运速度比平时慢一些" },
    { kind: "clearing_light", summary: "云层与潮湿空气正在改变熟悉景物的光线和颜色" },
  ] : [
    { kind: "ordinary_rhythm", summary: `${period || "当前时段"}的日常声响正在${location || "附近"}缓慢展开` },
    { kind: "passing_activity", summary: "附近有短暂经过的脚步、推车声或开关门声，但来源尚未确认" },
    { kind: "changing_light", summary: "自然光正在改变木头、植物和街道表面的细节" },
  ];
  return templates;
}

function activeTemporaryEvents(previousTick, now) {
  const timestamp = new Date(now).getTime();
  return list(previousTick?.temporary_events).filter((event) => {
    const expiry = new Date(event?.expires_at || 0).getTime();
    return Number.isFinite(expiry) && expiry > timestamp;
  });
}

function generateTemporaryEvent({ previousTick, nowIso, localDate, period, weather, location }) {
  const active = activeTemporaryEvents(previousTick, nowIso);
  if (active.length) return active.slice(0, 1);

  const start = slotStart(nowIso);
  const slotKey = `${localDate}:${start.toISOString()}:${period}:${weather}:${location}`;
  // Temporary world events are deliberately sparse. Most ticks only expose
  // ordinary environmental opportunities rather than manufacturing incidents.
  if (stableHash(slotKey) % 100 >= 38) return [];

  const templates = temporaryEventTemplate({ period, weather, location });
  const selected = templates[stableHash(`template:${slotKey}`) % templates.length];
  return [{
    id: stableId("temporary-world-event", slotKey),
    kind: selected.kind,
    location,
    summary: selected.summary,
    created_at: start.toISOString(),
    expires_at: new Date(start.getTime() + TEMPORARY_EVENT_TTL_MS).toISOString(),
    scope: "local",
    lifecycle_status: "temporary",
    canon_effect: "none",
  }];
}

function perceivableOpportunities({ period, weather, location, npcPresence, temporaryEvents, openThreads, tickSeed, characterName }) {
  const opportunities = [];
  for (const event of temporaryEvents) {
    opportunities.push({
      id: stableId("opportunity", `temporary:${event.id}`),
      source_type: "temporary_world_event",
      source_id: event.id,
      location,
      description: `可以直接观察：${event.summary}`,
    });
  }

  for (const npc of npcPresence.filter((entry) => entry.presence === "possible_here").slice(0, 2)) {
    opportunities.push({
      id: stableId("opportunity", `npc:${npc.entity_id}:${location}`),
      source_type: "canonical_npc_history",
      source_id: npc.entity_id,
      npc_relationship_tier: npc.relationship_tier,
      location,
      description: `若本轮自然遇见${npc.name}，只能描写${characterName}当场观察到的行为；也可以完全不相遇`,
    });
  }

  const unfinished = list(openThreads).find((thread) => !["resolved", "abandoned", "closed"].includes(String(thread?.stage || thread?.status || "")));
  if (unfinished) {
    opportunities.push({
      id: stableId("opportunity", `thread:${unfinished.id}:${location}`),
      source_type: "unfinished_matter", source_id: text(unfinished.id, 100), location,
      subject: text(unfinished.title || unfinished.content, 80),
      description: `可以让未完成事项“${text(unfinished.title || unfinished.content, 80)}”产生一个真实小结果，也可以因条件不合适而延期`,
    });
  }

  const ambientKey = `${period}:${weather}:${location}`;
  const ambient = /雨|雪|雾|霜/.test(weather)
    ? "可以观察天气在当前位置留下的真实痕迹，并据此调整一件小行动"
    : period === "夜间"
      ? "可以在安全范围内整理、返回或留意夜间声音"
      : "可以去镇上合理地点，或因一个念头做一件小事";
  opportunities.push({
    id: stableId("opportunity", `ambient:${ambientKey}`),
    source_type: "world_clock",
    source_id: null,
    location,
    description: ambient,
  });
  if (stableHash(`limited:${tickSeed}`) % 4 === 0) {
    opportunities.push({
      id: stableId("opportunity", `limited:${tickSeed}`), source_type: "bounded_randomness", source_id: null, location,
      subject: "一个偶然小细节",
      description: "可以留意一个不改变永久世界事实的偶然小细节；若没有直接观察就不要采用",
    });
  }
  return opportunities.slice(0, 4);
}

export function emptyWorldTick() {
  return {
    schema_version: WORLD_TICK_SCHEMA_VERSION,
    tick_id: null,
    observed_at: null,
    local_date: "",
    local_time: "",
    period: "",
    season: "",
    weather: "",
    weather_state: null,
    current_location: "",
    npc_presence: [],
    temporary_events: [],
    perceivable_opportunities: [],
  };
}

export function buildWorldTick({
  world = {},
  agent = {},
  worldCanon = {},
  previousTick = {},
  weatherState = null,
  timeContext = {},
  openThreads = [],
  characterName = DEFAULT_LIFE_ENGINE_CONFIG.character.name,
  nowIso = new Date().toISOString(),
} = {}) {
  const localDate = text(timeContext.date || world.date, 20);
  const localTime = text(timeContext.time, 10);
  const period = text(timeContext.period, 20);
  const season = text(world.season, 40);
  const weather = text(weatherState?.condition || world.weather, 100);
  const location = text(agent.location, 120);
  const npcPresence = canonicalNpcPresence(worldCanon, location);
  const temporaryEvents = generateTemporaryEvent({
    previousTick,
    nowIso,
    localDate,
    period,
    weather,
    location,
  });
  const tickKey = `${localDate}:${localTime}:${period}:${season}:${weather}:${location}`;
  return {
    schema_version: WORLD_TICK_SCHEMA_VERSION,
    tick_id: stableId("world-tick", tickKey),
    observed_at: nowIso,
    local_date: localDate,
    local_time: localTime,
    period,
    season,
    weather,
    weather_state: weatherState ? JSON.parse(JSON.stringify(weatherState)) : null,
    current_location: location,
    npc_presence: npcPresence,
    temporary_events: temporaryEvents,
    perceivable_opportunities: perceivableOpportunities({
      period,
      weather,
      location,
      npcPresence,
      temporaryEvents,
      openThreads,
      tickSeed: tickKey,
      characterName,
    }),
  };
}

export function snapshotWorldTick(worldTick) {
  return JSON.parse(JSON.stringify(worldTick || emptyWorldTick()));
}
