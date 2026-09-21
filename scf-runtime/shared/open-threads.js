export const OPEN_THREADS_KEY = "state/open-threads.json";

const ACTIVE_STAGES = new Set(["observed", "considered", "attempted", "waiting", "blocked"]);
const TERMINAL_STAGES = new Set(["resolved", "abandoned"]);
const STAGE_ORDER = ["observed", "considered", "attempted", "resolved"];
const MAX_THREADS = 60;
const MAX_EVIDENCE = 12;

function text(value, max = 320) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function hash(value) {
  let result = 2166136261;
  for (const character of text(value, 900)) result = Math.imul(result ^ character.charCodeAt(0), 16777619);
  return (result >>> 0).toString(16).padStart(8, "0");
}

function grams(value) {
  const source = text(value, 500).toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
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

function threadId(value) {
  return `thread-${hash(value)}`;
}

function normalizeStage(value) {
  const stage = text(value, 24).toLowerCase();
  return ACTIVE_STAGES.has(stage) || TERMINAL_STAGES.has(stage) ? stage : "observed";
}

function normalizeSource(value) {
  const source = text(value, 40).toLowerCase();
  if (["chat_promise", "autonomy", "system"].includes(source)) return source;
  return source || "autonomy";
}

function normalizeThread(raw, nowIso) {
  const title = text(raw?.title || raw?.content || raw?.intention, 180);
  if (!title) return null;
  const stage = normalizeStage(raw?.stage || raw?.status);
  const source = normalizeSource(raw?.source);
  const reportToUser = raw?.report_to_user === true || source === "chat_promise";
  return {
    id: text(raw?.id || raw?.thread_id, 100) || threadId(title),
    title,
    content: text(raw?.content || title, 420),
    stage,
    status: TERMINAL_STAGES.has(stage) ? "closed" : "active",
    priority: Math.max(1, Math.min(5, Number(raw?.priority || (reportToUser ? 4 : 2)))),
    location: text(raw?.location, 120),
    related_entities: [...new Set(list(raw?.related_entities).map((item) => text(item, 80)).filter(Boolean))].slice(0, 8),
    source,
    report_to_user: reportToUser,
    promised_at: text(raw?.promised_at, 40) || (reportToUser ? (raw?.created_at || nowIso) : null),
    source_event_id: text(raw?.source_event_id, 120) || null,
    created_at: raw?.created_at || nowIso,
    updated_at: raw?.updated_at || nowIso,
    last_attempt_at: raw?.last_attempt_at || null,
    resolved_at: raw?.resolved_at || null,
    abandoned_at: raw?.abandoned_at || null,
    attempt_count: Math.max(0, Number(raw?.attempt_count || 0)),
    waiting_for: text(raw?.waiting_for, 100) || null,
    next_check_at: Number.isFinite(Date.parse(raw?.next_check_at)) ? new Date(raw.next_check_at).toISOString() : null,
    blocked_reason: text(raw?.blocked_reason, 220) || null,
    last_result: raw?.last_result && typeof raw.last_result === "object" ? {
      status: text(raw.last_result.status, 24),
      actor: text(raw.last_result.actor, 100) || null,
      evidence: text(raw.last_result.evidence, 420),
      event_id: text(raw.last_result.event_id, 120),
      occurred_at: text(raw.last_result.occurred_at, 40),
    } : null,
    evidence: list(raw?.evidence).slice(-MAX_EVIDENCE),
  };
}

export function emptyOpenThreads(nowIso = new Date().toISOString()) {
  return { schema_version: 1, items: [], updated_at: nowIso };
}

export function normalizeOpenThreads(value, nowIso = new Date().toISOString()) {
  const found = new Map();
  for (const raw of list(value?.items)) {
    const thread = normalizeThread(raw, nowIso);
    if (!thread) continue;
    const previous = found.get(thread.id);
    if (!previous || String(thread.updated_at) >= String(previous.updated_at)) found.set(thread.id, thread);
  }
  return {
    schema_version: 1,
    items: [...found.values()]
      .sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)))
      .slice(0, MAX_THREADS),
    updated_at: value?.updated_at || nowIso,
  };
}

export function activeOpenThreads(value) {
  return normalizeOpenThreads(value).items.filter((thread) => thread.status === "active" && ACTIVE_STAGES.has(thread.stage));
}

function findMatchingThread(items, update) {
  const requestedId = text(update?.thread_id || update?.id, 100);
  if (requestedId) return items.find((thread) => thread.id === requestedId) || null;
  const query = text(update?.title || update?.content || update?.intention, 320);
  if (!query) return null;
  return items
    .map((thread) => ({ thread, score: similarity(`${thread.title} ${thread.content}`, query) }))
    .filter((entry) => entry.score >= 0.42)
    .sort((left, right) => right.score - left.score)[0]?.thread || null;
}

function operationStage(operation, currentStage = "observed") {
  const normalized = text(operation, 24).toLowerCase();
  if (["observe", "observed", "add"].includes(normalized)) return currentStage;
  if (["consider", "considered"].includes(normalized)) return "considered";
  if (["attempt", "attempted", "advance"].includes(normalized)) return "attempted";
  if (normalized === "wait") return "waiting";
  if (normalized === "block") return "blocked";
  if (["resolve", "resolved", "complete", "completed"].includes(normalized)) return "resolved";
  if (["abandon", "abandoned", "drop"].includes(normalized)) return "abandoned";
  return currentStage;
}

function applyUpdate(items, rawUpdate, event, nowIso) {
  const title = text(rawUpdate?.title || rawUpdate?.content || rawUpdate?.intention, 180);
  let current = findMatchingThread(items, rawUpdate);
  if (current?.status === "closed") return items;
  const operation = text(rawUpdate?.operation || rawUpdate?.stage, 24).toLowerCase();
  // New outcome-bearing transitions require an exact sentence in the accepted event.
  // This checks consistency in the fictional world, not independent real-world truth.
  const outcome = rawUpdate?.action_result;
  let receipt = null;
  if (outcome != null) {
    const status = text(outcome.status, 24);
    const evidence = text(outcome.evidence, 420);
    const actor = text(outcome.actor, 100);
    if (!event?.id || !evidence || !text(event.narrative, 10000).includes(evidence)
      || !["submitted", "answered", "refused", "unknown", "no_reply", "succeeded", "failed"].includes(status)) return items;
    if (["submitted", "answered", "refused", "unknown", "no_reply"].includes(status)
      && (!actor || !evidence.includes(actor))) return items;
    const stages = { submitted: "waiting", answered: "attempted", refused: "blocked", unknown: "blocked", no_reply: "blocked", succeeded: "resolved", failed: "blocked" };
    if (operationStage(operation, current?.stage) !== stages[status]) return items;
    if (status === "no_reply" && (!current || current.stage !== "waiting" || !Number.isFinite(Date.parse(current.next_check_at)) || Date.parse(current.next_check_at) > Date.parse(nowIso))) return items;
    if (status === "submitted" && current?.stage === "waiting") return items;
    if (current?.waiting_for && ["answered", "refused", "unknown", "no_reply"].includes(status) && actor !== current.waiting_for) return items;
    if (status === "succeeded" && (/打算|准备|想要|计划|还没|尚未|没有完成|未完成/.test(evidence)
      || !/完成|写好|写完|交给|交付|送到|做成|修好|确认|找到了|记下|画好|归还|finished|completed|delivered/i.test(evidence))) return items;
    receipt = { status, actor: actor || null, evidence, event_id: event.id, occurred_at: nowIso };
    if (current?.last_result?.event_id === event.id && current.last_result.status === status) return items;
  }
  if (["wait", "block"].includes(operation) && !receipt) return items;
  if (current?.last_result && operationStage(operation, current.stage) === "resolved" && !receipt) return items;
  if (current && ["waiting", "blocked"].includes(current.stage)
    && !receipt && !["abandon", "abandoned", "drop", "observe", "add"].includes(operation)) return items;
  if (!current && !title) return items;
  if (!current) {
    current = normalizeThread({
      id: rawUpdate?.thread_id,
      title,
      content: rawUpdate?.content || title,
      priority: rawUpdate?.priority,
      location: rawUpdate?.location || event?.location,
      related_entities: rawUpdate?.related_entities,
      source: rawUpdate?.source,
      report_to_user: rawUpdate?.report_to_user,
      promised_at: rawUpdate?.promised_at,
      source_event_id: event?.id,
      created_at: nowIso,
    }, nowIso);
    items.unshift(current);
  }
  const index = items.findIndex((thread) => thread.id === current.id);
  const nextStage = operationStage(rawUpdate?.operation || rawUpdate?.stage, current.stage);
  const previousRank = STAGE_ORDER.indexOf(current.stage);
  const nextRank = STAGE_ORDER.indexOf(nextStage);
  const stage = nextStage === "abandoned" || ["waiting", "blocked"].includes(nextStage) || ["waiting", "blocked"].includes(current.stage)
    ? nextStage
    : nextRank >= previousRank ? nextStage : current.stage;
  const attemptedNow = ["attempt", "attempted", "advance"].includes(
    text(rawUpdate?.operation || rawUpdate?.stage, 24).toLowerCase(),
  );
  const evidence = event?.id ? [...current.evidence, {
    event_id: event.id,
    occurred_at: event.occurred_at || nowIso,
    operation: text(rawUpdate?.operation || stage, 24),
    note: text(rawUpdate?.evidence || event?.activity || event?.narrative, 220),
    ...(receipt ? { result: receipt } : {}),
  }].slice(-MAX_EVIDENCE) : current.evidence;
  const nextSource = rawUpdate?.source ? normalizeSource(rawUpdate.source) : current.source;
  const nextReport = rawUpdate?.report_to_user === true
    || current.report_to_user === true
    || nextSource === "chat_promise";
  items[index] = {
    ...current,
    title: title || current.title,
    content: text(rawUpdate?.content || current.content, 420),
    stage,
    status: TERMINAL_STAGES.has(stage) ? "closed" : "active",
    priority: Math.max(1, Math.min(5, Number(rawUpdate?.priority || current.priority || 2))),
    location: text(rawUpdate?.location || event?.location || current.location, 120),
    related_entities: [...new Set([...current.related_entities, ...list(rawUpdate?.related_entities).map((item) => text(item, 80))])].slice(0, 8),
    source: nextSource,
    report_to_user: nextReport,
    promised_at: text(rawUpdate?.promised_at || current.promised_at, 40) || current.promised_at,
    source_event_id: current.source_event_id || event?.id || null,
    updated_at: nowIso,
    last_attempt_at: stage === "attempted" ? nowIso : current.last_attempt_at,
    resolved_at: stage === "resolved" ? nowIso : current.resolved_at,
    abandoned_at: stage === "abandoned" ? nowIso : current.abandoned_at,
    attempt_count: current.attempt_count + (attemptedNow ? 1 : 0),
    waiting_for: stage === "waiting" ? receipt?.actor || current.waiting_for : null,
    next_check_at: stage === "waiting" ? (current.stage === "waiting" ? current.next_check_at : new Date(Math.min(
      Date.parse(nowIso) + 7 * 86_400_000,
      Math.max(Date.parse(nowIso) + 3_600_000, Date.parse(rawUpdate.next_check_at) || Date.parse(nowIso) + 48 * 3_600_000),
    )).toISOString()) : null,
    blocked_reason: stage === "blocked" ? receipt?.evidence || current.blocked_reason : null,
    last_result: receipt || current.last_result,
    evidence,
  };
  return items;
}

export function applyOpenThreadUpdates(value, event, rawUpdates = [], nowIso = new Date().toISOString()) {
  const normalized = normalizeOpenThreads(value, nowIso);
  let items = normalized.items.map((thread) => ({ ...thread, evidence: [...thread.evidence] }));
  for (const update of list(rawUpdates)) items = applyUpdate(items, update, event, nowIso);

  const nextIntention = text(event?.next_intention, 180);
  if (nextIntention && !findMatchingThread(items.filter((thread) => thread.status === "active"), { title: nextIntention })) {
    items = applyUpdate(items, {
      operation: "observe",
      title: nextIntention,
      content: nextIntention,
      location: event?.location,
      priority: 2,
      source: "autonomy",
      report_to_user: false,
    }, event, nowIso);
  }

  return normalizeOpenThreads({ schema_version: 1, items, updated_at: nowIso }, nowIso);
}

// A curiosity is a question grounded in a committed event, never a new fact or
// a promise. Reuse the existing thread lifecycle and bounded scheduler.
export function queueGroundedCuriosity(value, candidate, recentEvents = [], nowIso = new Date().toISOString()) {
  const state = normalizeOpenThreads(value, nowIso);
  if (!candidate) return state;
  if (state.items.length >= MAX_THREADS) return state;
  const question = text(candidate.question, 180), subject = text(candidate.subject, 80);
  const evidence = text(candidate.evidence, 240);
  const source = list(recentEvents).find((event) => event.id === candidate.source_event_id);
  if (!source || !subject || !question.includes(subject) || evidence.length < 6
    || !text(source.narrative, 10000).includes(evidence)) return state;
  const existing = state.items.filter((item) => item.source === "curiosity");
  if (existing.some((item) => item.related_entities.includes(subject)
    && (item.status === "active" || item.source_event_id === source.id))) return state;
  if (existing.filter((item) => item.status === "active").length >= 3) return state;
  const thread = normalizeThread({
    id: threadId(`curiosity:${source.id}:${subject}`), title: question,
    content: `尚未确认的问题：${question}`, stage: "observed", source: "curiosity",
    priority: 1, report_to_user: false, location: source.location,
    related_entities: [subject], source_event_id: source.id, created_at: nowIso,
    evidence: [{ event_id: source.id, occurred_at: source.occurred_at || nowIso, operation: "observe", note: evidence }],
  }, nowIso);
  return normalizeOpenThreads({ ...state, items: [...state.items, thread], updated_at: nowIso }, nowIso);
}

export function upsertChatPromiseThreads(value, promises = [], {
  eventId = null,
  location = "",
  nowIso = new Date().toISOString(),
} = {}) {
  const event = eventId ? { id: eventId, location, occurred_at: nowIso } : { location, occurred_at: nowIso };
  const updates = list(promises).map((promise) => ({
    operation: "observe",
    title: promise.title || promise.content,
    content: promise.content || promise.title,
    location: promise.location || location,
    related_entities: promise.related_entities,
    priority: promise.priority || 4,
    source: "chat_promise",
    report_to_user: true,
    promised_at: promise.promised_at || nowIso,
  }));
  return applyOpenThreadUpdates(value, event, updates, nowIso);
}

/**
 * When a heartbeat commits an event that touched a reportable chat promise,
 * close it as fulfilled (matching activity) or abandoned with lived evidence.
 * Never leave a selected reportable promise untouched after a committed event.
 */
export function reconcileReportablePromiseClosures(beforeValue, afterValue, event = {}, {
  selectedThreadId = null,
  nowIso = new Date().toISOString(),
} = {}) {
  const beforeActive = new Map(
    activeOpenThreads(beforeValue)
      .filter((thread) => thread.report_to_user)
      .map((thread) => [thread.id, thread]),
  );
  if (!beforeActive.size) {
    return {
      threads: normalizeOpenThreads(afterValue, nowIso),
      closed: [],
    };
  }
  let items = normalizeOpenThreads(afterValue, nowIso).items.map((thread) => ({
    ...thread,
    evidence: [...thread.evidence],
  }));
  const closed = [];
  const eventText = `${event.activity || ""} ${event.narrative || ""} ${event.next_intention || ""}`;
  for (const [id, prior] of beforeActive) {
    const current = items.find((thread) => thread.id === id);
    if (!current) continue;
    if (current.status === "closed") {
      closed.push(current);
      continue;
    }
    // Waiting, refusals and partial results do not fulfill or cancel a promise.
    if (["waiting", "blocked"].includes(current.stage) || current.last_result) continue;
    const selected = selectedThreadId && selectedThreadId === id;
    const related = similarity(`${prior.title} ${prior.content}`, eventText) >= 0.36;
    if (!selected && !related) continue;
    const fulfilled = similarity(`${prior.title} ${prior.content}`, `${event.activity || ""} ${event.narrative || ""}`) >= 0.42;
    const operation = fulfilled ? "resolve" : "abandon";
    items = applyUpdate(items, {
      thread_id: id,
      operation,
      evidence: fulfilled
        ? (event.activity || "兑现了对用户的承诺")
        : `改主意了，实际去做了：${event.activity || event.narrative || "别的事"}`,
      source: current.source,
      report_to_user: true,
    }, event, nowIso);
    const updated = items.find((thread) => thread.id === id);
    if (updated?.status === "closed") closed.push(updated);
  }
  return {
    threads: normalizeOpenThreads({ schema_version: 1, items, updated_at: nowIso }, nowIso),
    closed,
  };
}

export function prioritizeOpenThreads(value, context = {}, limit = 6) {
  const nowMs = Date.parse(context.nowIso || new Date().toISOString()) || Date.now();
  const currentIntention = text(context.currentIntention, 240);
  const location = text(context.location, 120);
  return activeOpenThreads(value)
    .filter((thread) => thread.stage !== "waiting" || !thread.next_check_at || Date.parse(thread.next_check_at) <= nowMs)
    .map((thread) => {
      const ageDays = Math.max(0, (nowMs - (Date.parse(thread.updated_at) || nowMs)) / 86_400_000);
      const intentionMatch = currentIntention ? similarity(`${thread.title} ${thread.content}`, currentIntention) : 0;
      const locationMatch = location && thread.location === location ? 1 : 0;
      const attemptNeed = thread.stage === "considered" ? 1.2 : thread.stage === "observed" ? 0.7 : 0.3;
      const reportBoost = thread.report_to_user ? 3.5 : 0;
      return {
        ...thread,
        selection_score: Number((
          thread.priority * 1.4
          + intentionMatch * 4
          + locationMatch
          + attemptNeed
          + reportBoost
          + 1 / (1 + ageDays / 7)
        ).toFixed(3)),
      };
    })
    .sort((left, right) => right.selection_score - left.selection_score)
    .slice(0, limit);
}

export function openThreadsForPrompt(value, context = {}) {
  return prioritizeOpenThreads(value, context).map((thread) => ({
    id: thread.id,
    title: thread.title,
    stage: thread.stage,
    priority: thread.priority,
    location: thread.location,
    related_entities: thread.related_entities,
    attempt_count: thread.attempt_count,
    updated_at: thread.updated_at,
    source: thread.source,
    report_to_user: thread.report_to_user === true,
    waiting_for: thread.waiting_for,
    next_check_at: thread.next_check_at,
    blocked_reason: thread.blocked_reason,
    last_result: thread.last_result,
  }));
}

/** Read model for chat and background context, including matters not due yet. */
export function threadContinuityFacts(value) {
  return normalizeOpenThreads(value).items
    .filter((thread) => thread.last_result || thread.stage === "waiting" || thread.stage === "blocked")
    .slice(0, 8)
    .map(({ id, title, stage, waiting_for, next_check_at, blocked_reason, last_result }) =>
      ({ id, title, stage, waiting_for, next_check_at, blocked_reason, last_result }));
}
