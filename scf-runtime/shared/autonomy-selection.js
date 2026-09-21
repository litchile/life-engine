function text(value, max = 240) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function compact(value) {
  return text(value, 400).toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

function grams(value) {
  const source = compact(value);
  const output = new Set();
  if (source.length === 1) output.add(source);
  for (let index = 0; index < source.length - 1; index += 1) output.add(source.slice(index, index + 2));
  return output;
}

function similarity(left, right) {
  const a = grams(left);
  const b = grams(right);
  if (!a.size || !b.size) return 0;
  let overlap = 0;
  for (const token of a) if (b.has(token)) overlap += 1;
  return overlap / Math.min(a.size, b.size);
}

export function autonomyActionFamily(event) {
  const activity = String(event?.activity || "");
  const narrative = String(event?.narrative || "");
  const purposePatterns = [
    // Strong action verbs take precedence over incidental objects and venue
    // names. For example, "离开面包店去花店" is travel, not a meal, and an
    // exploration narrative that says "记下" is not automatically writing.
    ["shop_errand", /买|取信|寄信|办事|采购|取货|送信/],
    ["social", /交谈|聊天|问候|认识|拜访|帮忙|邀请|一起|镇民|老板|朋友/],
    ["organize", /整理|收拾|清扫|擦拭|归置|摆放|挪动|调整位置|腾出|留出/],
    ["learn", /学习|练习|学会|尝试制作|研究|辨认|核对|比较/],
    ["meal", /早餐|午餐|晚餐|吃|喝茶|做饭/],
    ["write", /写日记|写信|画|记录|抄写/],
    ["read", /读完|读书|看书|翻书|阅读/],
    ["organize", /皮箱/],
    ["observe", /看窗|看雨|发呆|观察|听雨|望着|闻到/],
    ["rest", /休息|睡觉|打盹|躺|静坐/],
    ["walk", /散步|走走|绕路|闲逛/],
    ["travel", /出门|离开|前往|到达|搭车|乘车|赶路|过桥/],
    ["explore", /探索|发现|寻找|沿着|小路|陌生|地图|湖边|溪流|磨坊/],
  ];
  const activityPurpose = purposePatterns.find(([, pattern]) => pattern.test(activity))?.[0];
  if (activityPurpose) return activityPurpose;
  const narrativePurpose = purposePatterns.find(([, pattern]) => pattern.test(narrative))?.[0];
  if (narrativePurpose) return narrativePurpose;
  const combined = `${activity} ${narrative}`;
  if (/面包店|花店|书店|集市|邮局/.test(combined)) return "shop_errand";
  if (/面包|点心|茶|咖啡/.test(combined)) return "meal";
  return "other";
}

export function autonomyLocationKey(location) {
  return compact(location || "unknown").slice(0, 80) || "unknown";
}

function dominant(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  const sorted = [...counts.entries()].sort((left, right) => right[1] - left[1]);
  return { key: sorted[0]?.[0] || null, count: sorted[0]?.[1] || 0, share: values.length ? (sorted[0]?.[1] || 0) / values.length : 0 };
}

function normalizedEntropy(values) {
  if (values.length < 2) return 1;
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  if (counts.size <= 1) return 0;
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / values.length;
    entropy -= probability * Math.log(probability);
  }
  return entropy / Math.log(counts.size);
}

function suffixRunCount(values, expected) {
  let count = 0;
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (values[index] !== expected) break;
    count += 1;
  }
  return count;
}

function advancesOpenThread(event, activeThreads = []) {
  const updates = Array.isArray(event?.thread_updates) ? event.thread_updates : [];
  if (updates.some((update) => /attempt|advance|resolve|complete|abandon/.test(String(update?.operation || update?.stage || "").toLowerCase()))) return true;
  const selected = text(event?.selected_thread_id, 100);
  return Boolean(selected && activeThreads.some((thread) => thread.id === selected));
}

function violatesLocationContinuity() {
  // Impulsive location changes are allowed; do not require step-by-step movement prose.
  return false;
}

export function autonomySelectionDirective(recentEvents = [], activeThreads = []) {
  const recent = recentEvents.slice(-8);
  const locations = recent.map((event) => autonomyLocationKey(event.location));
  const actions = recent.map(autonomyActionFamily);
  const location = dominant(locations);
  const action = dominant(actions);
  const collapsedLocation = recent.length >= 4 && location.share >= 0.625;
  const collapsedAction = recent.length >= 4 && action.share >= 0.5;
  const instructions = [
    collapsedLocation ? `近期地点过度集中在“${location.key}”；本轮可以因一个念头去不同地点，不必逐步铺路。` : "",
    collapsedAction ? `近期行动类型“${action.key}”过多；本轮换一种行动即可，包括突发小事或只想不做。` : "",
    activeThreads.length ? "可推进一个开放线索，也可以只是犹豫、改变主意或记下念头；不强制本轮必须产生结果。" : "",
  ].filter(Boolean);
  return {
    dominant_location: location,
    dominant_action: action,
    location_entropy: Number(normalizedEntropy(locations).toFixed(3)),
    action_entropy: Number(normalizedEntropy(actions).toFixed(3)),
    collapsed_location: collapsedLocation,
    collapsed_action: collapsedAction,
    instruction: instructions.join(" ") || "保持生活有变化，但允许不可预测的念头；不要用换一种说法重复近期生活。",
  };
}

export function evaluateAutonomyCandidate(event, recentEvents = [], activeThreads = [], context = {}) {
  const recent = recentEvents.slice(-10);
  const candidateAction = autonomyActionFamily(event);
  const candidateLocation = autonomyLocationKey(event?.location);
  const cooldownWindow = recent.slice(-3);
  const cooldownViolation = cooldownWindow.some((previous) => (
    autonomyLocationKey(previous.location) === candidateLocation
    && (autonomyActionFamily(previous) === candidateAction
      || similarity(previous.activity, event?.activity) >= 0.68)
  ));
  const directive = autonomySelectionDirective(recent, activeThreads);
  const threadProgress = advancesOpenThread(event, activeThreads);
  const previousLocation = autonomyLocationKey(
    context.currentLocation || recent.at(-1)?.location || "",
  );
  const currentLocationRun = suffixRunCount(
    recent.map((previous) => autonomyLocationKey(previous.location)),
    previousLocation,
  );
  const breaksLocationRunLimit = currentLocationRun >= 4
    && candidateLocation !== previousLocation;
  const locationRunViolation = suffixRunCount(
    recent.map((previous) => autonomyLocationKey(previous.location)),
    candidateLocation,
  ) >= 4;
  const actionRunViolation = suffixRunCount(
    recent.map(autonomyActionFamily),
    candidateAction,
  ) >= 3;
  const collapsedDimensions = [
    directive.collapsed_location
      ? directive.dominant_location.key === candidateLocation
      : null,
    directive.collapsed_action
      ? directive.dominant_action.key === candidateAction
      : null,
  ].filter((value) => value !== null);
  // A candidate must improve at least one collapsed dimension. Requiring it to
  // fix every dimension in one event can deadlock life progression: leaving an
  // overused location is often itself another travel action.
  const distributionViolation = !threadProgress
    && collapsedDimensions.length > 0
    && collapsedDimensions.every(Boolean);
  const breaksLocationCollapse = directive.collapsed_location
    && directive.dominant_location.key !== candidateLocation;
  const sameActionCount = recent.slice(-6).filter((previous) => autonomyActionFamily(previous) === candidateAction).length;
  const similarNarrativeCount = recent.slice(-8).filter((previous) => (
    similarity(`${previous.activity} ${previous.narrative}`, `${event?.activity || ""} ${event?.narrative || ""}`) >= 0.56
  )).length;
  const locationTransitionViolation = violatesLocationContinuity(event, recent, context);
  const requiredMovementProgress = Boolean(context.forceMovement)
    && candidateLocation !== previousLocation
    && !locationTransitionViolation;
  const noveltyViolation = !threadProgress
    && !requiredMovementProgress
    && !breaksLocationCollapse
    && !breaksLocationRunLimit
    && (sameActionCount >= 3 || similarNarrativeCount >= 2);
  const reasons = [
    cooldownViolation ? "cooldown_same_location_action" : "",
    locationRunViolation ? "location_run_limit" : "",
    actionRunViolation ? "action_run_limit" : "",
    distributionViolation ? "distribution_collapse" : "",
    noveltyViolation ? "novelty_exhausted" : "",
    locationTransitionViolation ? "location_transition_without_movement" : "",
  ].filter(Boolean);
  return {
    accepted: reasons.length === 0,
    cooldown_violation: cooldownViolation,
    location_run_violation: locationRunViolation,
    action_run_violation: actionRunViolation,
    distribution_violation: distributionViolation,
    novelty_violation: noveltyViolation,
    location_transition_violation: locationTransitionViolation,
    thread_progress: threadProgress,
    candidate_action: candidateAction,
    candidate_location: candidateLocation,
    reasons,
    directive,
  };
}
