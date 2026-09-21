import { describe, expect, it } from "vitest";
import {
  activityDurationMinutes,
  DEFAULT_LIFE_PROFILE,
  lifeProfileFromEnv,
  profileForContext,
} from "../scf-runtime/shared/life-profile.js";
import { buildWorldTick } from "../scf-runtime/shared/world-tick.js";
import { resolveWeatherState, weatherForContext } from "../scf-runtime/shared/weather-state.js";

describe("life runtime profile and weather state", () => {
  it("keeps identity, world and ownership boundaries centralized while allowing bounded schedule overrides", () => {
    const profile = lifeProfileFromEnv({
      BOT_TIMEZONE: "Asia/Shanghai",
      AUTONOMY_AWAKE_START_HOUR: "6",
      AUTONOMY_AWAKE_END_HOUR: "22",
      AUTONOMY_MIN_DELAY_MINUTES: "40",
      AUTONOMY_MAX_DELAY_MINUTES: "95",
    });
    expect(profileForContext(profile)).toMatchObject({
      character: { id: "agent", name: "小云", species: "松鼠" },
      world: { id: "spruce-town", weather_scope_id: "spruce-town" },
      ownership: { mode: "single_owner", memory_scope: "character" },
    });
    expect(profile.autonomy).toMatchObject({
      awake_start_hour: 6,
      awake_end_hour: 22,
      minimum_delay_minutes: 40,
      maximum_delay_minutes: 95,
    });
    expect(activityDurationMinutes("organize", "same-seed", profile)).toBe(
      activityDurationMinutes("organize", "same-seed", profile),
    );
    expect(activityDurationMinutes("organize", "same-seed", profile)).toBeGreaterThanOrEqual(15);
    expect(activityDurationMinutes("organize", "same-seed", profile)).toBeLessThanOrEqual(35);
    expect(DEFAULT_LIFE_PROFILE.character.persona_anchors).toContain("稍微社恐");
  });

  it("uses a scoped weather cache, refreshes stale days and exposes provenance to the World Tick", () => {
    const first = resolveWeatherState({
      condition: "短时秋雨",
      scopeId: "spruce-town",
      localDate: "2026-09-07",
      characterLocation: "花园",
      nowIso: "2026-09-07T02:00:00.000Z",
    });
    const cached = resolveWeatherState({
      saved: first,
      condition: "晴朗",
      scopeId: "spruce-town",
      localDate: "2026-09-07",
      characterLocation: "花园",
      nowIso: "2026-09-07T03:00:00.000Z",
    });
    expect(cached).toMatchObject({ condition: "短时秋雨", cache_status: "hit", character_location: "花园" });
    const refreshed = resolveWeatherState({
      saved: first,
      condition: "晴朗",
      scopeId: "spruce-town",
      localDate: "2026-09-08",
      characterLocation: "咖啡馆",
      nowIso: "2026-09-08T02:00:00.000Z",
    });
    expect(refreshed).toMatchObject({ condition: "晴朗", cache_status: "refreshed", source: "world_daily_fallback" });
    const tick = buildWorldTick({
      world: { date: "2026-09-07", season: "初秋", weather: "不应覆盖缓存" },
      agent: { location: "咖啡馆" },
      weatherState: weatherForContext(cached),
      timeContext: { date: "2026-09-07", time: "11:00", period: "上午" },
      nowIso: "2026-09-07T03:00:00.000Z",
    });
    expect(tick.weather).toBe("短时秋雨");
    expect(tick.weather_state).toMatchObject({ scope_id: "spruce-town", source: "world_daily_fallback" });
  });
});
