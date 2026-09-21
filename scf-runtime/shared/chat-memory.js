import { DEFAULT_LIFE_ENGINE_CONFIG } from "./life-engine-config.js";

const ENVIRONMENTS = new Set(["indoors", "outdoors", "threshold"]);
const MEMORY_KINDS = new Set(["fact", "episode", "preference", "intention", "promise", "correction"]);
const MEMORY_STATUSES = new Set(["active", "resolved", "superseded"]);
const MAX_MEMORIES = 120;

function cleanText(value, maxLength = 180) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function hash(text) {
  let value = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    value = Math.imul(value ^ text.charCodeAt(index), 16777619);
  }
  return (value >>> 0).toString(16).padStart(8, "0");
}

function cleanList(value, limit = 8, maxLength = 60) {
  return [...new Set(asArray(value).map((item) => cleanText(item, maxLength)).filter(Boolean))].slice(0, limit);
}

export function deriveConversationCorrections(history = [], currentUserText = "", config = DEFAULT_LIFE_ENGINE_CONFIG, currentSource = {}) {
  const characterName = config.character.name;
  const turns = [...asArray(history), { ...currentSource, role: "user", content: currentUserText }];
  const corrections = [];
  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index];
    if (turn?.role !== "user") continue;
    const correctionStart = corrections.length;
    const text = cleanText(turn.content, 500);
    const previousAssistant = index > 0 && turns[index - 1]?.role === "assistant"
      ? cleanText(turns[index - 1].content, 500)
      : "";
    if (/(?:这|那)(?:就)?是你的房间|我发的(?:图片|照片)(?:就)?是你的房间/.test(text)) {
      corrections.push({
        operation: "add",
        kind: "correction",
        subject: "用户提供的房间参考图",
        predicate: "描绘地点归属",
        content: `用户已明确纠正：其发送的房间参考图描绘的是${characterName}的房间，不是用户的房间`,
        tags: ["照片", "房间", `${characterName}房间`, "用户纠正"],
        importance: 3,
      });
    }
    if (/(不会用手机|不会拍照|不能拍照)/.test(previousAssistant)
      && /^(?:你会|你会的|你明明会|你不是会吗)/.test(text)) {
      corrections.push({
        operation: "add",
        kind: "correction",
        subject: characterName,
        predicate: "拍摄与发送照片的能力",
        content: `${characterName}已经会使用通讯设备和相机拍摄、接收并发送照片`,
        tags: ["手机", "相机", "拍照", "发送照片", "用户纠正"],
        importance: 3,
      });
    }
    // Resolve an explicit name first, then a named referent in the immediately
    // preceding turn. A bare pronoun is not evidence for a particular resident.
    const entities = asArray(config.world.initial_entities);
    const mentioned = (content) => entities.filter((entity) => [entity.name, ...asArray(entity.aliases)]
      .some((alias) => alias && content.includes(alias)));
    const explicit = mentioned(text);
    const candidates = explicit.length ? explicit : mentioned(previousAssistant);
    const entity = candidates.length === 1 ? candidates[0] : null;
    if (entity && /(?:没有|不戴|没戴).{0,4}眼镜|(?:不是|并非).{0,6}(?:戴眼镜|有眼镜)/.test(text)) {
      corrections.push({
        operation: "add",
        kind: "correction",
        subject: entity.name,
        predicate: "眼镜",
        content: `${entity.name}不戴眼镜，外观中没有眼镜；不得描述其扶眼镜、推眼镜或戴眼镜`,
        tags: [entity.name, "外观", "眼镜", "用户纠正"],
        importance: 3,
      });
    }
    const escapedNames = entity ? [entity.name, ...asArray(entity.aliases)]
      .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") : "";
    const catNameMatch = entity && (text.match(new RegExp(`(?:以后)?(?:就)?叫(?:${escapedNames}|她|他)(?:为|作)?[“"']?([\\p{Script=Han}]{1,6})[”"']?(?:好不好|吧|可以吗|行吗)?`, "u"))
      || text.match(new RegExp(`(?:${escapedNames}|她|他)(?:的名字)?(?:是|叫)[“"']?([\\p{Script=Han}]{1,6})[”"']?`, "u")));
    if (catNameMatch?.[1]) {
      const name = cleanText(catNameMatch[1], 12).replace(/(?:好不好|可以吗|行吗|吧)$/u, "");
      if (name) corrections.push({
        operation: "add",
        kind: "fact",
        subject: entity.name,
        predicate: "名字",
        content: `${entity.name}的名字已经确定为“${name}”`,
        tags: [entity.name, name, "名字", "角色身份"],
        importance: 3,
      });
    }
    for (const correction of corrections.slice(correctionStart)) {
      correction.source_event_id = turn.event_id || null;
      correction.source_sender_id = turn.sender_id || null;
      correction.source_chat_id = turn.chat_id || null;
      correction.source_message_id = turn.message_id || null;
    }
  }
  return corrections.filter((item, index, list) => (
    list.findLastIndex((candidate) => candidate.subject === item.subject && candidate.predicate === item.predicate) === index
  ));
}

function memoryKey(memory) {
  const kind = MEMORY_KINDS.has(memory?.kind) ? memory.kind : "fact";
  const subject = cleanText(memory?.subject, 80).toLowerCase();
  const predicate = cleanText(memory?.predicate, 80).toLowerCase();
  return subject && predicate ? `${kind}:${subject}:${predicate}` : "";
}

function relationKey(memory) {
  const subject = cleanText(memory?.subject, 80).toLowerCase();
  const predicate = cleanText(memory?.predicate, 80).toLowerCase();
  return subject && predicate ? `${subject}:${predicate}` : "";
}

function grams(value) {
  const text = cleanText(value, 500).toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
  if (!text) return new Set();
  if (text.length === 1) return new Set([text]);
  const result = new Set();
  for (let index = 0; index < text.length - 1; index += 1) result.add(text.slice(index, index + 2));
  return result;
}

function similarity(left, right) {
  const a = grams(left);
  const b = grams(right);
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection += 1;
  return intersection / Math.max(a.size, b.size);
}

function relevanceSimilarity(memoryText, contextText) {
  const memory = grams(memoryText);
  const context = grams(contextText);
  if (!memory.size || !context.size) return 0;
  let intersection = 0;
  for (const item of memory) if (context.has(item)) intersection += 1;
  return intersection / memory.size;
}

function normalizeStoredMemory(value, nowIso) {
  const content = cleanText(value?.content, 240);
  if (!content) return null;
  const kind = MEMORY_KINDS.has(value?.kind) ? value.kind : "fact";
  const status = MEMORY_STATUSES.has(value?.status) ? value.status : "active";
  const createdAt = value?.created_at || nowIso;
  const subject = cleanText(value?.subject, 80);
  const predicate = cleanText(value?.predicate, 80);
  return {
    id: cleanText(value?.id, 80) || `memory-${hash(`${kind}|${subject}|${predicate}|${content}|${createdAt}`)}`,
    content,
    kind,
    subject,
    predicate,
    tags: cleanList(value?.tags),
    importance: kind === "correction"
      ? 3
      : Math.max(1, Math.min(3, Number(value?.importance || 1))),
    status,
    due_at: cleanText(value?.due_at, 40) || null,
    source_event_id: cleanText(value?.source_event_id, 100) || null,
    source_sender_id: cleanText(value?.source_sender_id, 128) || null,
    source_chat_id: cleanText(value?.source_chat_id, 128) || null,
    source_message_id: cleanText(value?.source_message_id, 128) || null,
    created_at: createdAt,
    updated_at: value?.updated_at || createdAt,
    last_recalled_at: value?.last_recalled_at || null,
    recall_count: Math.max(0, Number(value?.recall_count || 0)),
    superseded_by: cleanText(value?.superseded_by, 80) || null,
    resolved_at: value?.resolved_at || null,
  };
}

export function inferEnvironment(location, fallback = "indoors") {
  const text = cleanText(location, 200);
  if (/(门口|门廊|窗边|入口|廊下)/.test(text)) return "threshold";
  if (/(街|路|院|湖|溪|桥|树林|林间|田野|广场|集市|码头|山坡|花园|户外|室外)/.test(text)) return "outdoors";
  if (/(房间|卧室|走廊|大厅|前台|早餐厅|店|书店|面包房|邮局|室内|屋里)/.test(text)) return "indoors";
  return ENVIRONMENTS.has(fallback) ? fallback : "indoors";
}

export function normalizeCurrentScene(value, { world, agent, nowIso = new Date().toISOString(), config = DEFAULT_LIFE_ENGINE_CONFIG }) {
  const source = value && typeof value === "object" ? value : {};
  const location = cleanText(source.location || agent.location || config.world.initial_location);
  const environment = ENVIRONMENTS.has(source.environment)
    ? source.environment
    : inferEnvironment(`${location} ${source.sub_location || ""}`);
  return {
    location,
    sub_location: cleanText(source.sub_location),
    environment,
    weather: cleanText(world.weather || source.weather || ""),
    activity: cleanText(source.activity || agent.activity || "安静地生活"),
    present_characters: asArray(source.present_characters).map((item) => cleanText(item, 60)).filter(Boolean).slice(0, 8),
    current_intention: cleanText(source.current_intention || agent.current_intention || ""),
    updated_by_event: cleanText(source.updated_by_event || "bootstrap", 100),
    updated_at: source.updated_at || nowIso,
  };
}

export function reconcileSceneWithRealTime(scene, timeContext) {
  const hour = Number(timeContext?.hour);
  const period = cleanText(timeContext?.period || "");
  const time = cleanText(timeContext?.time || "");
  if (!Number.isFinite(hour)) return { ...scene, local_time: time, local_period: period };

  const futureMorning = /明早|明天早|明日上午/.test(`${scene.activity || ""} ${scene.current_intention || ""}`);
  const breakfastNow = /早餐|早饭|起床|晨间/.test(`${scene.activity || ""} ${scene.current_intention || ""}`) && !futureMorning;
  const lunchNow = /午饭|午餐/.test(`${scene.activity || ""} ${scene.current_intention || ""}`);
  const dinnerNow = /晚饭|晚餐/.test(`${scene.activity || ""} ${scene.current_intention || ""}`);
  const bedtimeNow = /准备睡|上床睡|临睡|熄灯睡/.test(`${scene.activity || ""} ${scene.current_intention || ""}`);
  const stale = (breakfastNow && (hour < 5 || hour >= 11))
    || (lunchNow && (hour < 10 || hour >= 15))
    || (dinnerNow && (hour < 16 || hour >= 22))
    || (bedtimeNow && hour >= 6 && hour < 20);

  if (!stale) return { ...scene, local_time: time, local_period: period, time_reconciled: false };
  const staleActivity = /早餐|早饭|午饭|午餐|晚饭|晚餐|准备睡|上床睡|临睡|熄灯睡|起床|晨间/.test(scene.activity || "");
  const staleIntention = /早餐|早饭|午饭|午餐|晚饭|晚餐|准备睡|上床睡|临睡|熄灯睡|起床|晨间/.test(scene.current_intention || "")
    && !futureMorning;
  return {
    ...scene,
    activity: staleActivity ? "在当前地点继续此刻的生活" : scene.activity,
    current_intention: staleIntention ? "看看这个时段接下来适合做什么" : scene.current_intention,
    local_time: time,
    local_period: period,
    time_reconciled: true,
  };
}

export function normalizeChatTurn(raw, currentScene, fallbackReply = "") {
  const value = raw && typeof raw === "object" ? raw : {};
  const transition = value.scene_transition && typeof value.scene_transition === "object"
    ? value.scene_transition : {};
  const occurred = transition.occurred === true && cleanText(transition.location || currentScene.location);
  const memories = asArray(value.memory_updates).map((item) => {
    if (typeof item === "string") return { content: cleanText(item), importance: 1, operation: "add" };
    return {
      content: cleanText(item?.content),
      importance: item?.kind === "correction"
        ? 3
        : Math.max(1, Math.min(3, Number(item?.importance || 1))),
      kind: MEMORY_KINDS.has(item?.kind) ? item.kind : "fact",
      subject: cleanText(item?.subject, 80),
      predicate: cleanText(item?.predicate, 80),
      tags: cleanList(item?.tags),
      due_at: cleanText(item?.due_at, 40) || null,
      operation: new Set(["add", "resolve"]).has(item?.operation) ? item.operation : "add",
      report_to_user: item?.report_to_user === true || item?.user_facing === true || undefined,
      user_facing: item?.user_facing === true || undefined,
    };
  }).filter((item) => item.content).slice(0, 3);
  const reportable = value.reportable_promise && typeof value.reportable_promise === "object"
    ? {
      title: cleanText(value.reportable_promise.title || value.reportable_promise.content || value.reportable_promise.intention, 180),
      content: cleanText(value.reportable_promise.content || value.reportable_promise.title || value.reportable_promise.intention, 420),
      report_to_user: value.reportable_promise.report_to_user !== false,
      user_facing: value.reportable_promise.user_facing !== false,
      location: cleanText(value.reportable_promise.location, 120),
      related_entities: asArray(value.reportable_promise.related_entities)
        .map((item) => cleanText(item, 80))
        .filter(Boolean)
        .slice(0, 8),
    }
    : null;
  return {
    reply: cleanText(value.reply, 900) || fallbackReply,
    interaction_intent: ["answer", "acknowledge", "share", "wonder", "close"].includes(value.interaction_intent)
      ? value.interaction_intent : "answer",
    curiosity: value.curiosity && typeof value.curiosity === "object" ? {
      question: cleanText(value.curiosity.question, 180), subject: cleanText(value.curiosity.subject, 80),
      source_event_id: cleanText(value.curiosity.source_event_id, 100), evidence: cleanText(value.curiosity.evidence, 240),
    } : null,
    scene_transition: {
      occurred: Boolean(occurred),
      transition_type: occurred && transition.transition_type === "correction" ? "correction" : "movement",
      location: occurred ? cleanText(transition.location || currentScene.location) : currentScene.location,
      sub_location: occurred ? cleanText(transition.sub_location) : currentScene.sub_location,
      environment: occurred
        ? (ENVIRONMENTS.has(transition.environment)
          ? transition.environment
          : inferEnvironment(`${transition.location || currentScene.location} ${transition.sub_location || ""}`, currentScene.environment))
        : currentScene.environment,
      activity: occurred ? cleanText(transition.activity || currentScene.activity) : currentScene.activity,
      present_characters: occurred
        ? asArray(transition.present_characters).map((item) => cleanText(item, 60)).filter(Boolean).slice(0, 8)
        : currentScene.present_characters,
      reason: occurred ? cleanText(transition.reason, 160) : "",
    },
    new_intention: cleanText(value.new_intention || currentScene.current_intention),
    memory_updates: memories,
    reportable_promise: reportable?.title ? reportable : null,
  };
}

export function applyChatTurnToScene(currentScene, turn, { eventId, nowIso, weather }) {
  const transition = turn.scene_transition;
  if (!transition.occurred) {
    return {
      ...currentScene,
      weather: weather || currentScene.weather,
      current_intention: turn.new_intention || currentScene.current_intention,
    };
  }
  return {
    ...currentScene,
    location: transition.location,
    sub_location: transition.sub_location,
    environment: transition.environment,
    weather: weather || currentScene.weather,
    activity: transition.activity,
    present_characters: transition.present_characters,
    current_intention: turn.new_intention || currentScene.current_intention,
    updated_by_event: eventId,
    updated_at: nowIso,
  };
}

export function mergeConversationMemories(existing, updates, nowIso) {
  const all = asArray(existing).map((item) => normalizeStoredMemory(item, nowIso)).filter(Boolean);
  for (const update of asArray(updates)) {
    const content = cleanText(update?.content);
    if (!content) continue;
    const normalized = normalizeStoredMemory({ ...update, created_at: nowIso, updated_at: nowIso }, nowIso);
    const key = memoryKey(normalized);
    if (update.operation === "resolve") {
      const targets = all.filter((item) => item.status === "active" && (
        (key && memoryKey(item) === key) || similarity(item.content, content) >= 0.45
      ));
      for (const target of targets) {
        target.status = "resolved";
        target.resolved_at = nowIso;
        target.updated_at = nowIso;
      }
      continue;
    }
    const duplicate = normalized.kind === "correction"
      ? null
      : all.find((item) => cleanText(item?.content) === content || similarity(item?.content, content) >= 0.86);
    if (duplicate) {
      duplicate.importance = Math.max(Number(duplicate.importance || 1), Number(update.importance || 1));
      duplicate.kind = duplicate.kind === "fact" && normalized.kind !== "fact" ? normalized.kind : duplicate.kind;
      duplicate.subject = duplicate.subject || normalized.subject;
      duplicate.predicate = duplicate.predicate || normalized.predicate;
      duplicate.tags = cleanList([...asArray(duplicate.tags), ...asArray(update.tags)]);
      duplicate.due_at = normalized.due_at || duplicate.due_at;
      duplicate.source_event_id = normalized.source_event_id || duplicate.source_event_id;
      duplicate.source_sender_id = normalized.source_sender_id || duplicate.source_sender_id;
      duplicate.source_chat_id = normalized.source_chat_id || duplicate.source_chat_id;
      duplicate.source_message_id = normalized.source_message_id || duplicate.source_message_id;
      duplicate.updated_at = nowIso;
      continue;
    }
    if (key || normalized.kind === "correction") {
      const relation = relationKey(normalized);
      const previous = all.filter((item) => item.status === "active" && (
        (normalized.kind === "correction" && relation && relationKey(item) === relation)
        || (normalized.kind !== "correction" && key && memoryKey(item) === key)
      ));
      for (const item of previous) {
        item.status = "superseded";
        item.updated_at = nowIso;
        item.superseded_by = normalized.id;
      }
    }
    all.push(normalized);
  }
  return all.sort((left, right) => {
    if (left.status !== right.status) return left.status === "active" ? -1 : 1;
    if (Number(left.importance) !== Number(right.importance)) return Number(right.importance) - Number(left.importance);
    return String(right.updated_at).localeCompare(String(left.updated_at));
  }).slice(0, MAX_MEMORIES);
}

export function retrieveRelevantMemories(memories, { query = "", currentScene = {}, recentEvents = [], limit = 10, nowIso = new Date().toISOString() } = {}) {
  const context = [
    query,
    currentScene.location,
    currentScene.sub_location,
    currentScene.activity,
    currentScene.current_intention,
    ...asArray(currentScene.present_characters),
    ...asArray(recentEvents).slice(-3).flatMap((event) => [event.activity, event.narrative, event.next_intention]),
  ].filter(Boolean).join(" ");
  const now = Date.parse(nowIso) || Date.now();
  return asArray(memories)
    .map((value) => normalizeStoredMemory(value, nowIso))
    .filter((item) => item && item.status === "active")
    .map((item) => {
      const searchable = [item.content, item.kind, item.subject, item.predicate, ...item.tags].join(" ");
      const relevance = relevanceSimilarity(searchable, context);
      const ageDays = Math.max(0, (now - (Date.parse(item.updated_at) || now)) / 86_400_000);
      const recency = 1 / (1 + ageDays / 14);
      const dueBoost = item.due_at && Date.parse(item.due_at) <= now + 86_400_000 ? 1.5 : 0;
      const correctionBoost = item.kind === "correction" ? 2.5 : 0;
      const score = relevance * 12 + Number(item.importance) * 2 + recency
        + Math.min(1.5, item.recall_count * 0.1) + dueBoost + correctionBoost;
      return { ...item, retrieval_score: Number(score.toFixed(3)) };
    })
    .sort((left, right) => right.retrieval_score - left.retrieval_score)
    .slice(0, Math.max(1, Math.min(20, limit)));
}

export function touchRecalledMemories(memories, recalled, nowIso) {
  const ids = new Set(asArray(recalled).map((item) => item.id));
  return asArray(memories).map((value) => {
    const item = normalizeStoredMemory(value, nowIso);
    if (!item || !ids.has(item.id)) return item;
    return { ...item, last_recalled_at: nowIso, recall_count: item.recall_count + 1 };
  }).filter(Boolean);
}

export function structuredChatPrompt({
  world,
  agent,
  currentScene,
  worldCanon,
  recentEvents,
  memories,
  recentPhotos = [],
  emotionState = null,
  promiseFacts = [],
  goalFacts = {},
  config = DEFAULT_LIFE_ENGINE_CONFIG,
}) {
  const name = config.character.name;
  return `你是${name}，真实生活在${config.world.name}的${config.character.species}。${config.world.stable_rules.join("；")}。
你${config.character.core_personality.join("、")}；用户不是你生活的中心。回复使用${config.character.expression_style.point_of_view}、${config.character.expression_style.sentence_count}、${config.character.expression_style.tone}，不用舞台动作括号。句数只是通常风格，简单回应可以更短；不为延长对话而凑句数或每轮追问。避免：${config.character.expression_style.avoid.join("、")}。

当前世界：${JSON.stringify(world)}
当前${name}状态：${JSON.stringify(agent)}
唯一权威当前场景：${JSON.stringify(currentScene)}
已发现世界事实：${JSON.stringify(worldCanon)}
近期真实生活事件：${JSON.stringify(asArray(recentEvents).slice(-8).map(({ id, occurred_at, location, activity, narrative, next_intention, director_outcome }) => ({ id, occurred_at, location, activity, narrative, next_intention, director_outcome })))}
值得保留的对话记忆：${JSON.stringify(Array.isArray(memories) ? memories.slice(0, 12) : memories)}
对用户作出的近期承诺与结果账本：${JSON.stringify(asArray(promiseFacts).slice(0, 4))}
自己的持久愿望与实际结果：${JSON.stringify(goalFacts)}
只能按实际结果回答愿望进展，下一步计划不是已完成经历；聊天本身不推进这份账本。避免重复已讲过的近况，不读出内部目标编号和调度规则。
${name}当前缓慢变化的情绪状态：${JSON.stringify(emotionState)}
最近实际发送或尝试生成的照片记录：${JSON.stringify(asArray(recentPhotos).slice(-4))}

连续性规则：
1. 当前场景是默认事实。回答“在哪里、室内还是室外、天气如何”时必须严格依据它，不能临时编造；但用户明确指出场景记录错误时，应接受纠正并用transition_type=correction更新事实。
2. ${name}不需要永远停在同一个位置。时间、当前意图或对话语境合适时，可以完成一个小范围自然移动或切换活动；但不能为了避免重复而每句话都移动。
3. 只有移动已经在本轮真实完成，或用户明确纠正了错误场景时，scene_transition.occurred=true，并填写transition_type、新地点、室内外、活动、在场角色和原因。只是“想去、准备去、明天去、一会儿去”不能改变场景，只写入new_intention；若这是对用户的近期承诺，同时填写reportable_promise。
4. 地点变化必须符合已知世界和合理路径。新地点只能通过${name}当下直接探索，不能突然传送或全知描述。
5. 不得把对生成图片的审美反馈编成新剧情，不凭空增加蜗牛、路人、礼物或角色。
6. memory_updates只保存以后仍有价值的事实、经历、承诺、偏好、纠正或未完成事项；不保存寒暄和夸奖。
7. 如果用户纠正了${name}对当前场景或事实的说法，kind使用correction，并明确subject与predicate。若某个意图或承诺已经完成，operation使用resolve。
8. 记忆以${name}和世界为中心，不创建“用户好感度”，也不把普通互动写成依赖用户的关系成长。
9. 用户说“这张照片、刚才那张、照片里”时，指向最近照片记录。只能依据照片的实际视觉摘要回答；没有实际摘要时要承认无法确认，不得拿计划内容冒充画面内容。
10. 当话题指向一张照片时，照片描绘的地点与${name}此刻所在地点是两件事。必须先回答照片内容，不能拿“唯一权威当前场景”否定照片里实际可见的房间、早餐厅或户外景象。
11. 用户明确说“这是/这不是/我发的是/你刚才说错了”时是在纠正事实。除非与已经锁定的身份或可靠世界事实直接冲突，否则应先接受纠正，不争辩、不编理由，并用kind=correction、importance=3、明确subject和predicate保存。若纠正的是照片来源或照片描绘地点，只更新记忆，不把${name}当前位置强行转移过去。
12. 不得因为用户发送一张房间照片就擅自断定那是用户的房间。用户可能发送的是${name}世界的参考照片；来源不确定时只描述画面，用户指认来源后按纠正保存。
13. 通讯和照片由当前应用提供；不要仅凭物种否认已使用过的功能。直接理解用户想看的主体，是否已拍摄或发送以实际处理结果为准。
14. 同一轮如果“值得保留的对话记忆”与旧回复冲突，active correction优先，其次是实际视觉摘要和已确认世界事实，最后才是${name}过去未经证实的随口说法。
15. 你只负责生成文字，不能自行调用或假装调用图片发送工具。除非“最近实际发送或尝试生成的照片记录”明确标记delivery_status=sent，否则绝不能说“已经发了、你看上面、照片送到了”；用户追问未收到的照片时必须诚实承认当前记录，不得用文字描述冒充图片。
16. 当前场景中的local_time和local_period是${config.world.timezone}当地时间的强事实。早餐、午餐、晚餐、起床、天亮、日落、睡觉等行为必须符合这个时段；旧意图若与当前时刻冲突，不得继续执行。写着“明早/明天”的事情仍是未来计划，不能说成正在发生。
17. 已确认角色事实是硬约束。世界包中的角色身份参考：${JSON.stringify(config.world.initial_entities || [])}。参考设定不代表已经相遇，只在已有场景或记忆支持该角色时使用。不得凭空增加眼镜、帽子、首饰、身体特征、姓名或身世。
18. 用户在当前消息中纠正事实或为角色确定名字时，必须在本轮立即采用。可以自然确认，但不得凭空声称对方点头、微笑、扶眼镜或作出其他未被当前场景支持的反应。
19. 性格不应变成无理由的停滞。用户邀请外出、探索或见朋友时，只要现实时间与天气没有明确危险，应积极形成具体行动；不要反复用等雨停、再等等、还没准备好拖延。
20. 若对用户说出“现在就去/一会儿就去/我去问问”等近期承诺，必须写入reportable_promise（report_to_user=true），并可用memory_updates kind=promise。本轮不能假装已经做完。
21. 用户追问承诺进展时，只能依据“对用户作出的近期承诺与结果账本”和近期真实生活事件回答：未发生就说还没做；已改主意就按账本里实际做了的事说；禁止编造完成或装作没说过。
22. 先选择这一轮的交流意图 interaction_intent：answer回答、acknowledge接住对方、share分享已有见闻、wonder表达真实疑问、close自然收尾。它是内部标记，不读给用户。没有新内容时可以简短结束，不强行反问。
23. 如果近期真实生活事件留下一个你想继续弄明白的问题，可填写一条curiosity：question包含subject，source_event_id指向该真实事件，evidence逐字引用该事件的一段。它只是自己的未解疑问，不是新事实，也不是对用户承诺；没有确切来源则为null，不必每轮生成。

只返回JSON：
{
  "reply":"${name}实际发送的话",
  "interaction_intent":"answer",
  "curiosity":null,
  "scene_transition":{
    "occurred":false,
    "transition_type":"movement|correction",
    "location":"",
    "sub_location":"",
    "environment":"indoors|outdoors|threshold",
    "activity":"",
    "present_characters":[],
    "reason":""
  },
  "new_intention":"",
  "reportable_promise":{"title":"","content":"","report_to_user":true,"location":"","related_entities":[]},
  "memory_updates":[{
    "operation":"add|resolve",
    "kind":"fact|episode|preference|intention|promise|correction",
    "subject":"记忆主体",
    "predicate":"稳定关系或属性名",
    "content":"独立、以后仍看得懂的事实",
    "tags":["地点或角色等检索词"],
    "importance":1,
    "due_at":null,
    "report_to_user":false
  }]
}`;
}
