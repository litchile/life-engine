import { DEFAULT_LIFE_ENGINE_CONFIG } from "./life-engine-config.js";

export const WEATHER_STATE_KEY = "state/weather.json";
export const LEGACY_WEATHER_STATE_KEY = "state/weather-state.json";

const clean = (value, maximum = 120) => String(value || "").replace(/\s+/g, " ").trim().slice(0, maximum);
const hash = (value) => {
  let result = 2166136261;
  for (const ch of String(value)) result = Math.imul(result ^ ch.charCodeAt(0), 16777619);
  return result >>> 0;
};

export function emptyWeatherState() {
  return {
    schema_version: 2, scope_id: null, world_location: null, place: null, character_location: null, local_date: null, anchor: null,
    condition: null, source: null, fetched_at: null, expires_at: null,
    stale: false, degraded: false, degradation_reason: null,
  };
}

export function fallbackWeather(date, season = "初秋") {
  let options = ["晴朗，阳光柔和", "晴间多云", "多云", "微风", "晨雾后转晴", "短时小雨", "雨后放晴"];
  if (season.includes("冬")) options = ["晴冷", "薄云", "有风", "晨霜", "阴天", "短时小雪", "雪后放晴"];
  else if (season.includes("春")) options = ["晴朗", "薄云", "微风", "晨雾", "短时春雨", "雨后放晴", "温暖多云"];
  else if (season.includes("夏")) options = ["晴朗", "晴间多云", "树荫下有风", "闷热多云", "午后阵雨", "雨后清亮", "薄雾清晨"];
  else if (season.includes("秋")) options = ["秋日晴朗，阳光温和", "晴间薄云", "微风，落叶偶尔飘动", "清晨薄雾后转晴", "多云", "短时秋雨", "雨后空气清透"];
  return options[hash(`${date}:${season}:weather`) % options.length];
}

export function resolveWeatherState(options = {}) {
  const config = options.config || DEFAULT_LIFE_ENGINE_CONFIG;
  const saved = options.saved || {};
  const legacyWorld = options.legacyWorld || {};
  const date = clean(options.date || options.localDate, 20);
  const place = clean(options.place || options.characterLocation || config.world.current_location);
  const worldLocation = clean(options.worldLocation || config.world.name);
  const anchor = options.anchor || config.world.weather.anchor;
  const now = options.now || new Date(options.nowIso || Date.now());
  const nowMs = now.getTime();
  const sameScope = (saved.anchor?.id || saved.scope_id) === (anchor.id || config.world.id)
    && (saved.world_location || worldLocation) === worldLocation
    && saved.local_date === date
    && (saved.place || saved.character_location || place) === place;
  const expiry = Date.parse(saved.expires_at || 0);
  if (sameScope && clean(saved.condition) && Number.isFinite(expiry) && expiry > nowMs) {
    return { ...emptyWeatherState(), ...saved, scope_id: config.world.id, world_location: worldLocation, place,
      character_location: place, anchor: { ...anchor }, stale: false, cache_status: "hit" };
  }
  if (sameScope && clean(saved.condition)) {
    return {
      ...emptyWeatherState(), ...saved, scope_id: config.world.id, world_location: worldLocation, place,
      character_location: place, anchor: { ...anchor },
      source: "cached_stale", stale: true, degraded: true,
      degradation_reason: "weather_cache_expired_live_provider_unavailable", cache_status: "stale",
    };
  }
  const explicit = clean(options.condition);
  const legacy = legacyWorld.date === date ? clean(legacyWorld.weather) : "";
  const ttlMs = Number(config.world.weather.ttl_minutes) * 60_000;
  return {
    ...emptyWeatherState(), scope_id: clean(options.scopeId || config.world.id, 80), world_location: worldLocation,
    place, character_location: place, local_date: date, anchor: { ...anchor },
    condition: explicit || legacy || fallbackWeather(date, options.season || legacyWorld.season),
    source: explicit ? "world_daily_fallback" : legacy ? "legacy_world_state" : "deterministic_fallback",
    fetched_at: now.toISOString(), observed_at: now.toISOString(),
    expires_at: new Date(nowMs + ttlMs).toISOString(),
    stale: false, degraded: true,
    degradation_reason: explicit || legacy ? "live_weather_provider_unavailable" : "live_weather_provider_not_configured",
    cache_status: "refreshed",
  };
}

export function weatherForContext(state) {
  return {
    scope_id: state?.scope_id || null, world_location: state?.world_location || null, place: state?.place || null,
    condition: state?.condition || "天气暂不明确", source: state?.source || "deterministic_fallback",
    anchor: state?.anchor || null, observed_at: state?.fetched_at || state?.observed_at || null,
    expires_at: state?.expires_at || null, stale: Boolean(state?.stale),
    degraded: Boolean(state?.degraded), cache_status: state?.cache_status || null,
  };
}
