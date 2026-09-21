const NEAR_TERM_PROMISE = /现在就|一会儿就|一会就|马上就|这就去|这就问|等下就|待会就|待会儿就|待一会儿就|一会儿去|一会去|马上去|这就/;
const SOFT_MUSING = /有空|以后|改天|哪天|或许|也许|说不定|要是|如果有机会|总有一天|以后再/;
const PROGRESS_ASK = /咋样了|怎么样了|问到了吗|去了吗|吃了吗|后来呢|结果呢|办成了吗|找到了吗/;

function text(value, max = 320) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

export function isPromiseProgressQuestion(userText = "") {
  return PROGRESS_ASK.test(text(userText, 240));
}

export function looksLikeNearTermUserFacingPromise(content = "") {
  const value = text(content, 420);
  if (!value) return false;
  if (SOFT_MUSING.test(value) && !NEAR_TERM_PROMISE.test(value)) return false;
  return NEAR_TERM_PROMISE.test(value)
    || /去问问|去找|去吃|去看|去买|去问/.test(value);
}

/**
 * Prefer structured turn fields; fall back to clear near-term phrases in reply/intention.
 */
export function extractReportablePromises(turn = {}, { nowIso = new Date().toISOString() } = {}) {
  const found = [];
  const push = (raw, extras = {}) => {
    const title = text(raw, 180);
    if (!title) return;
    if (found.some((item) => item.title === title)) return;
    found.push({
      title,
      content: title,
      source: "chat_promise",
      report_to_user: true,
      priority: 4,
      promised_at: nowIso,
      ...extras,
    });
  };

  const structured = turn?.reportable_promise && typeof turn.reportable_promise === "object"
    ? turn.reportable_promise
    : null;
  if (structured && (structured.report_to_user === true || structured.user_facing === true)) {
    push(structured.title || structured.content || structured.intention, {
      content: text(structured.content || structured.title || structured.intention, 420),
      location: text(structured.location, 120) || undefined,
      related_entities: list(structured.related_entities).map((item) => text(item, 80)).filter(Boolean),
    });
  }

  for (const memory of list(turn?.memory_updates)) {
    if (!["promise", "intention"].includes(memory?.kind)) continue;
    const content = text(memory.content, 420);
    if (!content) continue;
    if (memory.report_to_user === true || memory.user_facing === true || looksLikeNearTermUserFacingPromise(content)) {
      push(content, {
        related_entities: list(memory.tags).map((item) => text(item, 80)).filter(Boolean),
      });
    }
  }

  if (!found.length) {
    const reply = text(turn?.reply, 900);
    const intention = text(turn?.new_intention, 180);
    for (const candidate of [reply, intention]) {
      if (!looksLikeNearTermUserFacingPromise(candidate)) continue;
      // Prefer a compact clause rather than the whole multi-sentence reply.
      const clause = candidate
        .split(/[。！？\n]/)
        .map((part) => text(part, 180))
        .find((part) => looksLikeNearTermUserFacingPromise(part));
      push(clause || intention || candidate);
      break;
    }
  }

  return found.slice(0, 2);
}

export function promiseFactsForChat(openThreads, recentEvents = [], userText = "") {
  const items = list(openThreads?.items || openThreads);
  const reportable = items.filter((thread) => thread?.report_to_user === true || thread?.source === "chat_promise");
  if (!reportable.length) return [];
  const ask = isPromiseProgressQuestion(userText);
  const active = reportable.filter((thread) => thread.status === "active");
  const closed = reportable
    .filter((thread) => thread.status === "closed")
    .sort((left, right) => String(right.updated_at || "").localeCompare(String(left.updated_at || "")))
    .slice(0, 3);
  const selected = ask ? [...active, ...closed].slice(0, 4) : active.slice(0, 3);
  const events = list(recentEvents).slice(-8);
  return selected.map((thread) => {
    const evidenceIds = new Set(list(thread.evidence).map((item) => item.event_id).filter(Boolean));
    const relatedEvents = events
      .filter((event) => evidenceIds.has(event.id) || (
        thread.status === "closed"
        && `${event.activity || ""} ${event.narrative || ""}`.includes(String(thread.title || "").slice(0, 8))
      ))
      .slice(-2)
      .map((event) => ({
        id: event.id,
        activity: event.activity,
        location: event.location,
        narrative: text(event.narrative, 160),
      }));
    return {
      id: thread.id,
      title: thread.title,
      stage: thread.stage,
      waiting_for: thread.waiting_for || null,
      next_check_at: thread.next_check_at || null,
      blocked_reason: thread.blocked_reason || null,
      last_result: thread.last_result || null,
      status: thread.status,
      report_to_user: true,
      source: thread.source || "chat_promise",
      latest_evidence: list(thread.evidence).slice(-2),
      related_events: relatedEvents,
    };
  });
}
