import defaultPack from "../packs/agent.json" with { type: "json" };

const list = (value) => Array.isArray(value) ? value : [];
const record = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};

export const DEFAULT_LIFE_ENGINE_CONFIG = Object.freeze({
  ...defaultPack.config,
  instance: { user_id: "single-user", character_id: defaultPack.id, storage_prefix: "" },
});

function mergeConfig(base, override) {
  const result = { ...base };
  for (const [key, value] of Object.entries(record(override))) {
    if (["__proto__", "prototype", "constructor"].includes(key)) throw new Error("Unsafe config field");
    if (Array.isArray(value)) result[key] = [...value];
    else if (key === "relationships") result[key] = { ...record(value) };
    else if (value && typeof value === "object") result[key] = mergeConfig(record(base[key]), value);
    else result[key] = value;
  }
  return result;
}

export function validateLifeEngineConfig(value) {
  const config = record(value);
  const errors = [];
  const prefix = config.instance?.storage_prefix;
  if (prefix !== undefined && (typeof prefix !== "string"
    || (prefix && (/[\\\x00-\x1f%?#:]/.test(prefix) || prefix.split("/").some((part) => !part || part === "." || part === ".."))))) {
    errors.push("instance.storage_prefix must be a safe relative key prefix");
  }
  const required = [
    ["instance.user_id", config.instance?.user_id], ["instance.character_id", config.instance?.character_id],
    ["character.name", config.character?.name], ["character.species", config.character?.species],
    ["world.name", config.world?.name], ["world.summary", config.world?.summary],
    ["world.initial_location", config.world?.initial_location], ["world.timezone", config.world?.timezone],
    ["world.weather.anchor.name", config.world?.weather?.anchor?.name],
  ];
  for (const [path, entry] of required) if (!String(entry || "").trim()) errors.push(`${path} is required`);
  if (!list(config.character?.core_personality).length) errors.push("character.core_personality must not be empty");
  if (!list(config.world?.seed_places).length) errors.push("world.seed_places must not be empty");
  if (!list(config.visual?.identity_markers).length) errors.push("visual.identity_markers must not be empty");
  if (!list(config.visual?.stable_rules).length) errors.push("visual.stable_rules must not be empty");
  try { new Intl.DateTimeFormat("en-US", { timeZone: config.world?.timezone }).format(new Date()); }
  catch { errors.push("world.timezone must be a valid IANA timezone"); }
  const ttl = Number(config.world?.weather?.ttl_minutes);
  if (!Number.isFinite(ttl) || ttl < 30 || ttl > 1440) errors.push("world.weather.ttl_minutes must be between 30 and 1440");
  const awakeStart = Number(config.autonomy?.awake_start_hour);
  const awakeEnd = Number(config.autonomy?.awake_end_hour);
  if (!Number.isInteger(awakeStart) || !Number.isInteger(awakeEnd) || awakeStart < 0 || awakeEnd > 24 || awakeStart >= awakeEnd) {
    errors.push("autonomy awake hours must satisfy 0 <= start < end <= 24");
  }
  const minimumDelay = Number(config.autonomy?.minimum_delay_minutes);
  const maximumDelay = Number(config.autonomy?.maximum_delay_minutes);
  if (!Number.isFinite(minimumDelay) || !Number.isFinite(maximumDelay) || minimumDelay < 15 || maximumDelay < minimumDelay || maximumDelay > 360) {
    errors.push("autonomy delay minutes must satisfy 15 <= minimum <= maximum <= 360");
  }
  return { valid: errors.length === 0, errors };
}

export function normalizeLifeEngineConfig(value = {}) {
  const config = mergeConfig(DEFAULT_LIFE_ENGINE_CONFIG, value);
  const validation = validateLifeEngineConfig(config);
  if (!validation.valid) throw new Error(`Invalid life engine config: ${validation.errors.join("; ")}`);
  return config;
}

export function lifeEngineConfig(env = process.env, override = null) {
  let parsed = {};
  if (env?.LIFE_ENGINE_CONFIG_JSON) {
    try { parsed = JSON.parse(env.LIFE_ENGINE_CONFIG_JSON); }
    catch (error) { throw new Error(`Invalid LIFE_ENGINE_CONFIG_JSON: ${error instanceof Error ? error.message : String(error)}`); }
  }
  const environmentOverrides = {
    world: { timezone: env?.BOT_TIMEZONE || undefined },
    autonomy: {
      awake_start_hour: env?.AUTONOMY_AWAKE_START_HOUR ? Number(env.AUTONOMY_AWAKE_START_HOUR) : undefined,
      awake_end_hour: env?.AUTONOMY_AWAKE_END_HOUR ? Number(env.AUTONOMY_AWAKE_END_HOUR) : undefined,
      minimum_delay_minutes: env?.AUTONOMY_MIN_DELAY_MINUTES ? Number(env.AUTONOMY_MIN_DELAY_MINUTES) : undefined,
      maximum_delay_minutes: env?.AUTONOMY_MAX_DELAY_MINUTES ? Number(env.AUTONOMY_MAX_DELAY_MINUTES) : undefined,
    },
  };
  const withoutUndefined = JSON.parse(JSON.stringify(environmentOverrides));
  return normalizeLifeEngineConfig(mergeConfig(mergeConfig(parsed, withoutUndefined), override || {}));
}

export function characterDefaults(config = DEFAULT_LIFE_ENGINE_CONFIG) {
  return { location: config.world.current_location || config.world.initial_location, ...config.character.default_state };
}

export function isHomeLocation(location, config = DEFAULT_LIFE_ENGINE_CONFIG) {
  const value = String(location || "");
  return value === config.world.home.location || config.world.home.area_terms.some((term) => term && value.includes(term));
}

export function worldDefaults(config = DEFAULT_LIFE_ENGINE_CONFIG) {
  return { date: "", season: config.world.default_season, weather: "", town_events: [] };
}

export function runtimeProfileForContext(config = DEFAULT_LIFE_ENGINE_CONFIG) {
  return {
    schema_version: config.schema_version,
    instance: { ...config.instance },
    character: {
      id: config.instance.character_id, name: config.character.name, species: config.character.species,
      persona_anchors: [...config.character.core_personality],
    },
    world: { id: config.world.id, name: config.world.name, timezone: config.world.timezone, weather_scope_id: config.world.id },
    ownership: { mode: "single_owner", memory_scope: "character", user_relationship_scope: "owner_contact" },
  };
}
