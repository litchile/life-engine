import { activityDurationRange } from "./activity-plans.js";
import { DEFAULT_LIFE_ENGINE_CONFIG, lifeEngineConfig } from "./life-engine-config.js";

const LEGACY_DURATION_RANGES = Object.freeze({
  observe: [12, 28], learn: [25, 50], write: [18, 38], organize: [15, 35],
  social: [10, 25], meal: [20, 40], rest: [20, 55], walk: [20, 45],
  travel: [20, 50], explore: [30, 65], shop_errand: [20, 45], read: [20, 45], other: [15, 35],
});

function toLegacyProfile(config) {
  return {
    schema_version: config.schema_version,
    character: {
      id: config.instance.character_id,
      name: config.character.name,
      species: config.character.species,
      persona_anchors: config.character.core_personality,
    },
    world: {
      id: config.world.id,
      name: config.world.name,
      timezone: config.world.timezone,
      weather_scope_id: config.world.id,
    },
    autonomy: {
      ...config.autonomy,
      duration_ranges: LEGACY_DURATION_RANGES,
    },
    ownership: {
      mode: "single_owner",
      memory_scope: "character",
      user_relationship_scope: "owner_contact",
    },
    life_engine: config,
  };
}

// Compatibility facade for older callers. New code should consume
// life-engine-config directly, while the default values remain identical.
export const DEFAULT_LIFE_PROFILE = Object.freeze(toLegacyProfile(DEFAULT_LIFE_ENGINE_CONFIG));

export function lifeProfileFromEnv(env = {}) {
  return toLegacyProfile(lifeEngineConfig(env));
}

function stableHash(value) {
  let result = 2166136261;
  for (const character of String(value || "")) result = Math.imul(result ^ character.charCodeAt(0), 16777619);
  return result >>> 0;
}

export function activityDurationMinutes(action, seed, profile = DEFAULT_LIFE_PROFILE) {
  const range = profile.autonomy?.duration_ranges?.[action] || activityDurationRange(action);
  const minimum = Number(range[0]);
  const maximum = Math.max(minimum, Number(range[1]));
  return minimum + (stableHash(`${seed}:${action}:duration`) % (maximum - minimum + 1));
}

export function profileForContext(profile = DEFAULT_LIFE_PROFILE) {
  return {
    schema_version: profile.schema_version,
    character: profile.character,
    world: profile.world,
    ownership: profile.ownership,
  };
}
