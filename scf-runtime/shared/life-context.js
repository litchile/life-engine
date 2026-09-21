import { DEFAULT_LIFE_ENGINE_CONFIG, isHomeLocation } from "./life-engine-config.js";

function clamp(value, minimum = 0, maximum = 1) {
  return Math.max(minimum, Math.min(maximum, Number(value) || 0));
}

function text(value, maximum = 160) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maximum);
}

function hash(value) {
  let result = 2166136261;
  for (const character of String(value || "")) {
    result = Math.imul(result ^ character.charCodeAt(0), 16777619);
  }
  return result >>> 0;
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function trailingLocationRun(events, location) {
  let count = 0;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (text(events[index]?.location, 100) !== text(location, 100)) break;
    count += 1;
  }
  return count;
}

function canonicalEntities(worldCanon) {
  return list(worldCanon?.entities)
    .filter((entity) => (entity.lifecycle_status || "canonical") === "canonical")
    .map((entity) => ({
      id: text(entity.id || entity.entity_id, 100),
      name: text(entity.name || entity.canonical_name, 100),
      entity_type: text(entity.type || entity.entity_type, 40),
      relationship_note: text(entity.relationship_note || entity.relationship, 160),
    }))
    .filter((entity) => entity.name);
}

function activeThreads(openThreads) {
  return list(openThreads)
    .filter((thread) => !["resolved", "abandoned"].includes(String(thread.stage || thread.status || "")))
    .sort((left, right) => Number(Boolean(right.report_to_user)) - Number(Boolean(left.report_to_user)))
    .slice(0, 6);
}

function ambientOpportunity({ date, period, weather, location }) {
  const wet = /雨|雪|雾|霜/.test(weather);
  const optionsByPeriod = {
    清晨: ["店铺开门前的准备声", "送货车和早班邮差经过", "晨光改变街道与植物的样子"],
    上午: ["镇民开始办事和开店", "适合完成一件具体差事", "适合因念头再向外走一点"],
    中午: ["店铺与街道最有人气", "适合短暂用餐并观察镇民往来", "适合拜访已经认识的地点"],
    下午: ["手艺人和店主继续工作", "适合查找线索或学习一件小技能", "光线适合辨认建筑和植物细节"],
    晚间: ["店铺陆续收尾", "适合回访、归还物品或总结白天发现", "灯光让熟悉地点显出不同细节"],
    夜间: ["大多数店铺已经休息", "适合安全返回、整理记录或完成室内线索", "安静时更容易听见旅馆与街道的小声音"],
  };
  const options = optionsByPeriod[period] || optionsByPeriod.下午;
  const selected = options[hash(`${date}:${period}:${weather}:${location}`) % options.length];
  return wet ? `${selected}；天气留下的潮湿、积水或清冷空气可成为现实阻力` : selected;
}

function rankedMotivations({ emotionState, recentEvents, openThreads, agent, config }) {
  const longTerm = emotionState?.long_term || {};
  const current = emotionState?.current || {};
  const threads = activeThreads(openThreads);
  const recent = list(recentEvents).slice(-8);
  const locationRun = trailingLocationRun(recent, agent?.location);
  const innShare = recent.length ? recent.filter((event) => isHomeLocation(event.location, config)).length / recent.length : 0;
  const highestThreadPriority = threads.reduce((maximum, thread) => (
    Math.max(maximum, Math.max(1, Math.min(5, Number(thread.priority || 2))))
  ), 0);
  const reportableThread = threads.some((thread) => thread.report_to_user);
  const attemptedThread = threads.some((thread) => thread.stage === "attempted");
  const consideredThread = threads.some((thread) => thread.stage === "considered");
  const values = [
    {
      id: "closure",
      label: "了结未完成的事",
      score: clamp(
        0.22
        + threads.length * 0.14
        + highestThreadPriority * 0.06
        + (reportableThread ? 0.45 : 0)
        + (attemptedThread ? 0.28 : consideredThread ? 0.12 : 0),
      ),
      reason: reportableThread
        ? "有对用户作出的近期承诺，需要真实去做或诚实改主意"
        : threads.length ? `仍有${threads.length}条开放线索` : "当前没有强烈的未完成线索",
    },
    {
      id: "curiosity",
      label: "探索和弄明白",
      score: clamp(0.25 + clamp(longTerm.curiosity, 0, 1) * 0.45 + Math.min(0.25, locationRun * 0.08)),
      reason: locationRun >= 2 ? "在同一地点停留较久，需要新的直接观察" : "依据实际好奇程度留意可以直接探索的问题",
    },
    {
      id: "world_belonging",
      label: "加深与周围世界的联系",
      score: clamp(0.28 + (1 - clamp(longTerm.belonging, 0, 1)) * 0.35 + innShare * 0.18),
      reason: innShare >= 0.5 ? "近期生活集中在住所，可以重新接触周围世界" : "通过真实往来积累归属感",
    },
    {
      id: "independence",
      label: "独自完成一件小事",
      score: clamp(0.25 + (1 - clamp(longTerm.independence, 0, 1)) * 0.32 + (1 - clamp(longTerm.social_confidence, 0, 1)) * 0.12),
      reason: "用可完成的小行动积累熟悉感和独立性",
    },
    {
      id: "restoration",
      label: "恢复精力和安全感",
      score: clamp((1 - clamp(current.energy, 0, 1)) * 0.7 + (1 - clamp(current.security, 0, 1)) * 0.25),
      reason: "休息只在精力或安全感确实偏低时成为优先目标",
    },
  ];
  return values.sort((left, right) => right.score - left.score).map((item) => ({
    ...item,
    score: Number(item.score.toFixed(3)),
  }));
}

function goalStack({ motivations, openThreads, worldCanon, agent, timeContext, recentEvents, config }) {
  const goals = [];
  const threads = activeThreads(openThreads);
  const known = canonicalEntities(worldCanon);
  const recent = list(recentEvents).slice(-8);
  const locationRun = trailingLocationRun(recent, agent?.location);

  if (threads.length) {
    const thread = threads[0];
    goals.push({
      layer: "inner",
      goal: thread.report_to_user
        ? `兑现或诚实改主意：对用户承诺的“${text(thread.title || thread.content, 100)}”，必须留下真实生活结果`
        : `让开放线索“${text(thread.title || thread.content, 100)}”产生一个真实的新结果`,
      source: thread.report_to_user ? "chat_promise" : "open_thread",
      source_id: text(thread.id, 100) || null,
    });
  }

  const knownCharacter = known.find((entity) => entity.entity_type === "character");
  if (knownCharacter) {
    goals.push({
      layer: "relationship",
      goal: `在地点与时机合理时，推进与${knownCharacter.name}或其他已认识镇民的一次具体往来`,
      source: "canonical_relationship",
      source_id: knownCharacter.id || null,
    });
  } else {
    goals.push({
      layer: "relationship",
      goal: "在不强行社交的前提下，留意一个真实可见的镇民往来",
      source: "belonging_need",
      source_id: null,
    });
  }

  const restorationFirst = motivations[0]?.id === "restoration";
  goals.push({
    layer: "daily",
    goal: restorationFirst
      ? "先完成必要的恢复，再进行一件不费力但有结果的小事"
      : locationRun >= 2 || isHomeLocation(agent?.location, config)
        ? "可以突发离开当前小范围，去探索、办事、拜访，或只是跟着一个念头走"
        : `完成一件符合${timeContext?.period || "当前时段"}、当前位置和天气的具体小事，也可以只是一个念头`,
    source: restorationFirst ? "energy_need" : "world_tick",
    source_id: null,
  });
  return goals.slice(0, 3);
}

export function buildLifeContext({
  world = {},
  agent = {},
  emotionState = {},
  recentEvents = [],
  openThreads = [],
  worldCanon = {},
  timeContext = {},
  worldTick = null,
  lifeProfile = null,
  config = DEFAULT_LIFE_ENGINE_CONFIG,
  nowIso = new Date().toISOString(),
} = {}) {
  const motivations = rankedMotivations({ emotionState, recentEvents, openThreads, agent, config });
  const goals = goalStack({ motivations, openThreads, worldCanon, agent, timeContext, recentEvents, config });
  return {
    schema_version: 1,
    tick: worldTick?.tick_id ? {
      tick_id: text(worldTick.tick_id, 100),
      observed_at: text(worldTick.observed_at, 40),
      local_date: text(worldTick.local_date, 20),
      local_time: text(worldTick.local_time, 10),
      period: text(worldTick.period, 20),
      season: text(worldTick.season, 40),
      weather: text(worldTick.weather, 100),
      current_location: text(worldTick.current_location, 120),
    } : {
      observed_at: nowIso,
      local_date: text(timeContext.date || world.date, 20),
      local_time: text(timeContext.time, 10),
      period: text(timeContext.period, 20),
      season: text(world.season, 40),
      weather: text(world.weather, 100),
      current_location: text(agent.location, 120),
    },
    world_signals: {
      ambient_opportunity: worldTick?.perceivable_opportunities?.[0]?.description || ambientOpportunity({
        date: timeContext.date || world.date,
        period: timeContext.period,
        weather: world.weather,
        location: agent.location,
      }),
      perceivable_opportunities: list(worldTick?.perceivable_opportunities),
      canonical_npc_presence: list(worldTick?.npc_presence),
      temporary_world_events: list(worldTick?.temporary_events),
      same_location_run: trailingLocationRun(list(recentEvents), agent.location),
      active_open_threads: activeThreads(openThreads).length,
      canonical_entity_count: canonicalEntities(worldCanon).length,
    },
    motivations,
    goal_stack: goals,
    runtime_profile: lifeProfile,
    planning_rule: "本轮可响应动机或目标，也允许休息和随想；只有已经发生的具体结果才能计入目标进度，准备、等待、回想或承诺不算完成。",
  };
}
