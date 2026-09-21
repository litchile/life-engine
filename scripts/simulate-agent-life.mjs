import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import {
  autonomyActionFamily,
  autonomyLocationKey,
  evaluateAutonomyCandidate,
} from "../scf-runtime/shared/autonomy-selection.js";
import {
  activeOpenThreads,
  applyOpenThreadUpdates,
  emptyOpenThreads,
  openThreadsForPrompt,
} from "../scf-runtime/shared/open-threads.js";
import {
  applyEventToEmotion,
  defaultEmotionState,
} from "../scf-runtime/shared/emotion.js";
import {
  emptyWorldCanon,
  mergeWorldObservations,
} from "../scf-runtime/shared/world-memory.js";
import {
  buildWorldTick,
  emptyWorldTick,
  snapshotWorldTick,
} from "../scf-runtime/shared/world-tick.js";
import {
  emptyFrontierRegistry,
  evaluateDiscoveryGate,
  snapshotFrontierRegistry,
} from "../scf-runtime/shared/frontier.js";
import { validateWorldConstitution } from "../scf-runtime/shared/world-constitution.js";

const START = Date.parse("2026-08-01T00:00:00.000Z");
const TICK_MINUTES = 200;
const TARGET_EVENTS = 100;
const LOCATIONS = [
  "云杉客栈二楼房间",
  "云杉客栈一楼早餐厅",
  "云杉客栈前台",
  "云杉客栈门廊",
  "小镇青石路",
  "面包店",
  "花店",
  "旧书店",
  "邮局",
  "河边小路",
  "旧石桥",
  "湖边",
  "旧磨坊",
  "小镇广场",
];

const STAY_ACTIONS = [
  (location, index) => [`观察${location}里今天不同的光线和声音`, `小云停下来观察，记下了第${index + 1}个以前没有注意到的小细节。`],
  (location, index) => [`向附近的镇民询问一件小事`, `小云在${location}小声问了一句，并得到了第${index + 1}条具体回应。`],
  (location, index) => [`对照花草图册辨认新叶片`, `小云在${location}完成了一次实际比对，排除了一个错误答案（记录${index + 1}）。`],
  (location, index) => [`写下今天在${location}的新发现`, `小云把第${index + 1}次生活记录写进日记，没有重复昨天的句子。`],
  (location, index) => [`尝试完成一件从未独立做过的小事`, `小云在${location}完成了第${index + 1}次独立练习，动作比上次熟练一点。`],
  (location, index) => [`读完一本小册子的下一页`, `小云在${location}读到一条能用于现实生活的新线索（第${index + 1}页）。`],
  (location, index) => [`整理随身物品并留下必要的一件`, `小云只整理这次旅程需要的东西，并为第${index + 1}段路做好准备。`],
  (location, index) => [`吃一份符合当前时段的小点心`, `小云在${location}尝到一种新的味道，并记住这是第${index + 1}次不同的选择。`],
];

const DISCOVERIES = [
  { entity_type: "character", name: "兔子花店老板", visual_facts: ["灰白色兔子", "绿色围裙"] },
  { entity_type: "place", name: "蓝铃花店后门", visual_facts: ["绿色木门", "窄石阶"] },
  { entity_type: "character", name: "鹿邮差", visual_facts: ["浅棕色鹿", "旧邮差包"] },
  { entity_type: "place", name: "河边旧磨坊", visual_facts: ["木水轮", "石墙"] },
];

function isoForTick(tick) {
  return new Date(START + tick * TICK_MINUTES * 60_000).toISOString();
}

function localDate(iso) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

function localTimeContext(iso) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const hour = Number(parts.find((part) => part.type === "hour")?.value || 0);
  const minute = parts.find((part) => part.type === "minute")?.value || "00";
  const period = hour < 6 ? "凌晨" : hour < 9 ? "早晨" : hour < 12 ? "上午" : hour < 14 ? "中午" : hour < 18 ? "下午" : hour < 22 ? "晚上" : "深夜";
  return { date: localDate(iso), time: `${String(hour).padStart(2, "0")}:${minute}`, period };
}

function canonicalPlace(name, index) {
  return {
    id: `sim-place-${index + 1}`,
    identity: `place:${name}`,
    type: "place",
    name,
    aliases: [],
    lifecycle_status: "canonical",
    known_facts: ["已确认可以连续到达的小镇地点"],
    visual_facts: [],
    history: [],
  };
}

function movementCandidate(currentLocation, direction, index) {
  const currentIndex = LOCATIONS.indexOf(currentLocation);
  const nextIndex = (currentIndex + direction + LOCATIONS.length) % LOCATIONS.length;
  const destination = LOCATIONS[nextIndex];
  return {
    location: destination,
    activity: `离开${currentLocation}后沿着相邻道路到达${destination}`,
    narrative: `小云认真走完了这段相邻路线，在${destination}发现了第${index + 1}个新的生活细节。`,
    mood: "平静而好奇",
    importance: 2,
  };
}

function stayCandidate(currentLocation, templateIndex, index) {
  const [activity, narrative] = STAY_ACTIONS[templateIndex % STAY_ACTIONS.length](currentLocation, index);
  return {
    location: currentLocation,
    activity,
    narrative,
    mood: templateIndex % 3 === 0 ? "安静而满足" : "有一点好奇",
    importance: 1 + (index % 3),
  };
}

function threadCandidate(thread, currentLocation, index) {
  const operation = Number(thread.attempt_count || 0) >= 2 ? "resolve" : "attempt";
  return {
    location: currentLocation,
    activity: operation === "resolve"
      ? `完成“${thread.title}”的最后一次核对并得到答案`
      : `为“${thread.title}”进行第${Number(thread.attempt_count || 0) + 1}次实际尝试`,
    narrative: operation === "resolve"
      ? `小云把已有线索逐一核对，终于让这件悬而未决的小事有了结果（事件${index + 1}）。`
      : `小云没有只想着以后再做，而是在${currentLocation}真的完成了一步（事件${index + 1}）。`,
    mood: operation === "resolve" ? "安心而满足" : "认真又有一点期待",
    importance: 3,
    selected_thread_id: thread.id,
    thread_updates: [{
      thread_id: thread.id,
      operation,
      evidence: operation === "resolve" ? "得到可复核的结果" : "完成一次具体尝试",
    }],
    next_intention: operation === "resolve" ? "" : thread.title,
  };
}

function discoveryForEvent(index) {
  const starts = [10, 35, 60, 85];
  const discoveryIndex = starts.findIndex((start) => index === start || index === start + 1);
  if (discoveryIndex < 0) return [];
  const item = DISCOVERIES[discoveryIndex];
  return [{
    ...item,
    observed_facts: index === starts[discoveryIndex]
      ? ["小云第一次直接看见了这里"]
      : ["小云在另一次经过时再次确认了这个特征"],
    relationship_note: item.entity_type === "character" ? "仍在慢慢认识" : "正在熟悉",
    status_observed: "当前可见",
    knowledge_source: "direct_observation",
  }];
}

function selectCandidate({ index, currentLocation, recentEvents, threads }) {
  const active = openThreadsForPrompt(threads, { currentIntention: "", location: currentLocation });
  const candidates = [];
  if (active.length && index % 5 === 0) candidates.push(threadCandidate(active[0], currentLocation, index));
  const offset = (index * 5 + 3) % STAY_ACTIONS.length;
  for (let step = 0; step < STAY_ACTIONS.length; step += 1) {
    candidates.push(stayCandidate(currentLocation, offset + step, index));
  }
  candidates.push(movementCandidate(currentLocation, 1, index));
  candidates.push(movementCandidate(currentLocation, -1, index));

  for (const candidate of candidates) {
    const gate = evaluateAutonomyCandidate(candidate, recentEvents, active, { currentLocation });
    if (gate.accepted) return { candidate, gate };
  }
  const diagnostics = candidates.map((candidate) => {
    const gate = evaluateAutonomyCandidate(candidate, recentEvents, active, { currentLocation });
    return {
      location: candidate.location,
      action: gate.candidate_action,
      reasons: gate.reasons,
      collapsed_location: gate.directive.collapsed_location,
      collapsed_action: gate.directive.collapsed_action,
    };
  });
  throw new Error(`No candidate passed repetition gates at simulated event ${index}: ${JSON.stringify(diagnostics)}`);
}

function maxRun(values) {
  let maximum = 0;
  let current = 0;
  let previous;
  for (const value of values) {
    current = value === previous ? current + 1 : 1;
    previous = value;
    maximum = Math.max(maximum, current);
  }
  return maximum;
}

function counts(values) {
  const result = {};
  for (const value of values) result[value] = (result[value] || 0) + 1;
  return result;
}

export function runAgentLifeSimulation() {
  const events = [];
  const eventByTick = new Map();
  const failures = [];
  const duplicateReplays = [];
  let threads = emptyOpenThreads(isoForTick(0));
  let emotion = defaultEmotionState(isoForTick(0));
  let canon = {
    ...emptyWorldCanon(),
    entities: LOCATIONS.map(canonicalPlace),
  };
  let frontiers = emptyFrontierRegistry();
  let previousWorldTick = emptyWorldTick();
  let currentLocation = LOCATIONS[0];
  let tick = 0;
  let maximumEmotionDelta = 0;
  let maximumTraitDelta = 0;

  while (events.length < TARGET_EVENTS) {
    const nowIso = isoForTick(tick);
    const tickId = `sim-${nowIso.slice(0, 16).replace(/[-:T]/g, "")}`;

    if (eventByTick.has(tickId)) {
      duplicateReplays.push(tickId);
      tick += 1;
      continue;
    }
    if ([7, 42, 79].includes(tick)) {
      failures.push({ type: "text_model", tick, occurred_at: nowIso, committed_events: events.length });
      tick += 1;
      continue;
    }

    const index = events.length;
    const { candidate, gate } = selectCandidate({ index, currentLocation, recentEvents: events, threads });
    const timeContext = localTimeContext(nowIso);
    const worldTick = buildWorldTick({
      world: {
        date: timeContext.date,
        season: "初秋",
        weather: index % 5 === 0 ? "短时小雨" : index % 3 === 0 ? "多云" : "晴间云",
      },
      agent: { location: currentLocation },
      worldCanon: canon,
      previousTick: previousWorldTick,
      timeContext,
      nowIso,
    });
    const active = activeOpenThreads(threads);
    const shouldOpenThread = active.length === 0 && index % 16 === 1;
    const nextIntention = candidate.next_intention ?? (shouldOpenThread
      ? `弄清第${index + 1}个新发现背后的具体答案`
      : (active[0]?.title || ""));
    const rawObservations = discoveryForEvent(index);
    const discoveryGate = evaluateDiscoveryGate({
      registryValue: frontiers,
      worldCanon: canon,
      rawObservations,
      recentEvents: events,
      meta: {
        event_id: `autonomy-${tickId}`,
        tick_id: worldTick.tick_id,
        occurred_at: nowIso,
        location: candidate.location,
        current_location: currentLocation,
      },
    });
    const event = {
      id: `autonomy-${tickId}`,
      occurred_at: nowIso,
      local_date: localDate(nowIso),
      event_type: "daily_life",
      ...candidate,
      next_intention: nextIntention,
      selected_thread_id: candidate.selected_thread_id || null,
      thread_updates: candidate.thread_updates || [],
      world_observations: discoveryGate.accepted,
      notification_status: [18, 54].includes(index) ? "failed" : "not_requested",
      image_status: [28, 70].includes(index) ? "generation_failed" : "not_requested",
      reference_asset_usage: "reference_only",
      autonomy_selection: gate,
      world_tick_snapshot: snapshotWorldTick(worldTick),
      discovery_snapshot: discoveryGate.snapshot,
    };
    const constitution = validateWorldConstitution({
      candidate: event,
      currentState: { location: currentLocation },
      worldTick,
      worldCanon: canon,
      discoveryGate,
      checkedAt: nowIso,
    });
    if (!constitution.accepted) {
      failures.push({
        type: "constitution",
        tick,
        occurred_at: nowIso,
        committed_events: events.length,
        violation_codes: constitution.violation_codes,
      });
      previousWorldTick = worldTick;
      tick += 1;
      continue;
    }
    event.constitution_snapshot = constitution;

    const previousTime = events.at(-1)?.occurred_at;
    assert.ok(!previousTime || Date.parse(event.occurred_at) > Date.parse(previousTime), "time must move forward");
    assert.equal(eventByTick.has(tickId), false, "tick must not commit twice");
    if (event.location !== currentLocation) {
      const from = LOCATIONS.indexOf(currentLocation);
      const to = LOCATIONS.indexOf(event.location);
      const distance = Math.min(Math.abs(from - to), LOCATIONS.length - Math.abs(from - to));
      assert.equal(distance, 1, "location changes must follow adjacent routes");
      assert.equal(gate.location_transition_violation, false, "movement must satisfy production continuity gate");
    }

    const previousEmotion = emotion;
    emotion = applyEventToEmotion(emotion, event, nowIso);
    for (const key of Object.keys(emotion.current)) {
      if (typeof emotion.current[key] === "number") {
        maximumEmotionDelta = Math.max(maximumEmotionDelta, Math.abs(emotion.current[key] - previousEmotion.current[key]));
      }
    }
    for (const key of Object.keys(emotion.long_term)) {
      maximumTraitDelta = Math.max(maximumTraitDelta, Math.abs(emotion.long_term[key] - previousEmotion.long_term[key]));
    }

    const worldMerge = mergeWorldObservations(canon, event.world_observations, {
      event_id: event.id,
      occurred_at: event.occurred_at,
      location: event.location,
    });
    canon = worldMerge.canon;
    frontiers = discoveryGate.registry;
    previousWorldTick = worldTick;
    event.world_observations = worldMerge.accepted;
    threads = applyOpenThreadUpdates(threads, event, event.thread_updates, nowIso);
    events.push(event);
    eventByTick.set(tickId, event);
    currentLocation = event.location;

    if (index % 13 === 0) {
      const sizeBeforeReplay = events.length;
      const replay = eventByTick.get(tickId);
      assert.equal(replay.id, event.id);
      assert.equal(events.length, sizeBeforeReplay, "heartbeat replay must not create another event");
      duplicateReplays.push(tickId);
    }
    if (event.notification_status === "failed") failures.push({ type: "feishu", tick, occurred_at: nowIso, committed_events: events.length });
    if (event.image_status === "generation_failed") failures.push({ type: "image", tick, occurred_at: nowIso, committed_events: events.length });
    tick += 1;
  }

  const eventIds = events.map((event) => event.id);
  const locations = events.map((event) => autonomyLocationKey(event.location));
  const actions = events.map(autonomyActionFamily);
  const resolvedThreads = threads.items.filter((thread) => thread.stage === "resolved");
  const localDates = [...new Set(events.map((event) => event.local_date))];
  const innEvents = events.filter((event) => /旅馆|房间|早餐厅|前台|门廊/.test(event.location)).length;
  const maxLocationRun = maxRun(locations);
  const maxActionRun = maxRun(actions);
  const recoveredFailures = failures.filter((failure) => events.some((event) => (
    Date.parse(event.occurred_at) > Date.parse(failure.occurred_at)
  )));

  assert.equal(events.length, TARGET_EVENTS);
  assert.equal(new Set(eventIds).size, eventIds.length, "event IDs must be unique");
  assert.ok(localDates.length >= 14, "simulation must span at least 14 local dates");
  assert.ok(resolvedThreads.length >= 1, "at least one Open Thread must resolve");
  assert.ok(resolvedThreads.some((thread) => thread.attempt_count >= 1 && thread.evidence.length >= 3), "resolved thread must have observed/attempted/resolved evidence");
  assert.ok(new Set(locations).size >= 8, "life must expand across locations");
  assert.ok(new Set(actions).size >= 6, "life must contain varied action families");
  assert.ok(maxLocationRun <= 4, `location distribution must not collapse into long runs (actual ${maxLocationRun})`);
  assert.ok(maxActionRun <= 3, `action distribution must not collapse into long runs (actual ${maxActionRun})`);
  assert.ok(innEvents / events.length < 0.45, "inn must not dominate Agent's life");
  assert.equal(recoveredFailures.length, failures.length, "life must continue after injected failures");
  assert.ok(maximumEmotionDelta <= 0.4, `current emotion must remain bounded across elapsed-time recovery (actual ${maximumEmotionDelta})`);
  assert.ok(maximumTraitDelta <= 0.0061, "long-term traits must change gradually");
  assert.ok(canon.entities.length >= 4);
  const discoveredCanon = canon.entities.filter((entity) => entity.discovery_evidence?.frontier_id);
  assert.equal(discoveredCanon.length, 4, "four controlled discoveries should become Canon");
  assert.ok(discoveredCanon.every((entity) => entity.lifecycle_status === "canonical"), "twice-observed entities should become canonical");
  assert.equal(snapshotFrontierRegistry(frontiers).items.filter((item) => item.state === "discovered").length, 4);
  assert.ok(events.every((event) => event.discovery_snapshot?.schema_version === 1));
  assert.ok(events.every((event) => event.constitution_snapshot?.accepted === true));
  assert.ok(events.every((event) => event.world_tick_snapshot?.tick_id));
  assert.ok(events.some((event) => event.world_tick_snapshot?.temporary_events?.length > 0));
  assert.ok(events.every((event) => event.reference_asset_usage === "reference_only"), "gallery references must never become delivered photos");

  return {
    seed: "fixed-cycle-v1",
    heartbeat_attempts: tick,
    committed_events: events.length,
    local_days: localDates.length,
    first_event_at: events[0].occurred_at,
    last_event_at: events.at(-1).occurred_at,
    unique_event_ids: new Set(eventIds).size,
    unique_locations: new Set(locations).size,
    unique_action_families: new Set(actions).size,
    max_same_location_run: maxLocationRun,
    max_same_action_run: maxActionRun,
    inn_event_share: Number((innEvents / events.length).toFixed(3)),
    location_counts: counts(events.map((event) => event.location)),
    action_counts: counts(actions),
    open_threads_total: threads.items.length,
    open_threads_resolved: resolvedThreads.length,
    duplicate_heartbeat_replays: duplicateReplays.length,
    injected_failures: counts(failures.map((failure) => failure.type)),
    failures_with_later_life_progress: recoveredFailures.length,
    canonical_entities: canon.entities.length,
    discovered_canonical_entities: discoveredCanon.length,
    frontier_items: frontiers.items.length,
    frontier_decisions: frontiers.decisions.length,
    temporary_world_events: events.filter((event) => event.world_tick_snapshot?.temporary_events?.length > 0).length,
    max_current_emotion_delta: Number(maximumEmotionDelta.toFixed(4)),
    max_long_term_trait_delta: Number(maximumTraitDelta.toFixed(4)),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(runAgentLifeSimulation(), null, 2));
}
