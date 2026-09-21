const HOUR_MS = 60 * 60 * 1000;

function list(value) {
  return Array.isArray(value) ? value : [];
}

function time(value) {
  const parsed = new Date(value || 0).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function check(id, status, details = {}) {
  return { id, status, ...details };
}

function deliveredText(outbox) {
  return outbox?.text_status === "sent"
    || (["sent", "partial_failure", "text_sent"].includes(outbox?.status) && outbox?.text_status !== "pending");
}

function uniqueNonEmpty(values) {
  const clean = values.filter(Boolean);
  return { count: clean.length, unique: new Set(clean).size };
}

function localDate(value) {
  return String(value || "").trim();
}

function completeDates(events, latestTime, windowStart) {
  const dates = new Map();
  for (const event of events) {
    const date = localDate(event.local_date);
    if (!date) continue;
    const at = time(event.occurred_at);
    if (!dates.has(date)) dates.set(date, []);
    dates.get(date).push(at);
  }
  return [...dates.entries()]
    .filter(([, times]) => Math.min(...times) >= windowStart + 12 * HOUR_MS
      && Math.max(...times) <= latestTime - 12 * HOUR_MS)
    .map(([date]) => date);
}

function canonEvidence(entity) {
  const ids = new Set();
  if (entity?.first_seen_event_id) ids.add(entity.first_seen_event_id);
  if (entity?.last_seen_event_id) ids.add(entity.last_seen_event_id);
  for (const entry of list(entity?.history)) {
    if (entry?.event_id) ids.add(entry.event_id);
    if (entry?.discovery_evidence?.observation_event_id) ids.add(entry.discovery_evidence.observation_event_id);
  }
  if (entity?.discovery_evidence?.observation_event_id) ids.add(entity.discovery_evidence.observation_event_id);
  return [...ids];
}

export function auditPhase1Observation(snapshot, options = {}) {
  const hours = Math.max(1, Number(options.hours || 72));
  const events = list(snapshot?.events).filter((event) => event?.id && time(event?.occurred_at))
    .sort((a, b) => time(a.occurred_at) - time(b.occurred_at));
  const outboxes = list(snapshot?.outboxes);
  const latestTime = events.length ? time(events.at(-1).occurred_at) : 0;
  const earliestTime = events.length ? time(events[0].occurred_at) : 0;
  const windowStart = latestTime - hours * HOUR_MS;
  const windowEvents = events.filter((event) => time(event.occurred_at) >= windowStart);
  const windowOutboxes = outboxes.filter((item) => !item?.created_at || time(item.created_at) >= windowStart);
  const checks = [];

  const coverageHours = latestTime && earliestTime ? (latestTime - earliestTime) / HOUR_MS : 0;
  checks.push(check("observation_coverage", coverageHours >= hours ? "pass" : "insufficient", {
    required_hours: hours,
    observed_hours: Number(coverageHours.toFixed(2)),
    earliest_event_at: events[0]?.occurred_at || null,
    latest_event_at: events.at(-1)?.occurred_at || null,
  }));

  const gaps = windowEvents.slice(1).map((event, index) => (
    time(event.occurred_at) - time(windowEvents[index].occurred_at)
  ) / HOUR_MS);
  const maximumGap = gaps.length ? Math.max(...gaps) : (windowEvents.length ? 0 : hours);
  const days = [...new Set(windowEvents.map((event) => localDate(event.local_date)).filter(Boolean))];
  checks.push(check("continuous_world_life", windowEvents.length > 0 && maximumGap <= 18 ? "pass" : "fail", {
    committed_events: windowEvents.length,
    local_dates: days,
    maximum_gap_hours: Number(maximumGap.toFixed(2)),
  }));

  const ids = uniqueNonEmpty(windowEvents.map((event) => event.id));
  const ticks = uniqueNonEmpty(windowEvents.map((event) => event.heartbeat_tick_id));
  checks.push(check("event_idempotency", ids.count === ids.unique && ticks.count === ticks.unique && ticks.count === windowEvents.length ? "pass" : "fail", {
    event_ids: ids,
    heartbeat_tick_ids: ticks,
  }));

  const invalidSnapshots = windowEvents.filter((event) => (
    !event.world_tick_snapshot
    || !event.discovery_snapshot
    || !event.constitution_snapshot
    || event.constitution_snapshot.accepted !== true
  )).map((event) => event.id);
  checks.push(check("governed_event_commits", invalidSnapshots.length ? "fail" : "pass", {
    invalid_event_ids: invalidSnapshots,
  }));

  const deliveredByDate = {};
  for (const outbox of windowOutboxes.filter(deliveredText)) {
    const date = localDate(outbox.local_date) || "unknown";
    deliveredByDate[date] = (deliveredByDate[date] || 0) + 1;
  }
  const complete = completeDates(windowEvents, latestTime, windowStart);
  const outsideTarget = complete.filter((date) => (deliveredByDate[date] || 0) < 2 || (deliveredByDate[date] || 0) > 4);
  checks.push(check("proactive_message_cadence", outsideTarget.length ? "fail" : (complete.length ? "pass" : "insufficient"), {
    target_per_complete_day: "2-4",
    complete_dates: complete,
    delivered_by_date: deliveredByDate,
    outside_target_dates: outsideTarget,
  }));

  const deadLetters = windowOutboxes.filter((item) => item?.status === "dead_letter");
  const failures = windowOutboxes.filter((item) => ["failed", "partial_failure"].includes(item?.status));
  checks.push(check("notification_delivery_health", deadLetters.length ? "fail" : "pass", {
    outbox_records: windowOutboxes.length,
    dead_letter_count: deadLetters.length,
    retry_or_partial_failure_count: failures.length,
  }));

  const decisions = list(snapshot?.frontiers?.decisions);
  const decisionIds = uniqueNonEmpty(decisions.map((decision) => decision?.id));
  checks.push(check("frontier_decision_idempotency", decisionIds.count === decisionIds.unique ? "pass" : "fail", {
    decision_ids: decisionIds,
  }));

  const canonicalEntities = list(snapshot?.canon?.entities).filter((entity) => entity?.lifecycle_status === "canonical");
  const weakCanon = canonicalEntities.filter((entity) => canonEvidence(entity).length < 2)
    .map((entity) => ({ id: entity.id, name: entity.name, evidence_event_ids: canonEvidence(entity) }));
  checks.push(check("canon_requires_repeated_evidence", weakCanon.length ? "fail" : "pass", {
    canonical_entity_count: canonicalEntities.length,
    weak_entities: weakCanon,
  }));

  const latestId = windowEvents.at(-1)?.id || null;
  const linked = latestId
    && snapshot?.worldTick?.committed_event_id === latestId
    && snapshot?.lifeContext?.committed_event_id === latestId;
  checks.push(check("latest_state_linkage", linked ? "pass" : "fail", {
    latest_event_id: latestId,
    world_tick_event_id: snapshot?.worldTick?.committed_event_id || null,
    life_context_event_id: snapshot?.lifeContext?.committed_event_id || null,
  }));

  const hardFailures = checks.filter((item) => item.status === "fail");
  const insufficient = checks.filter((item) => item.status === "insufficient");
  const overall = hardFailures.length ? "fail" : (insufficient.length ? "insufficient" : "pass");
  return {
    schema_version: 1,
    overall,
    observation_hours: hours,
    summary: {
      checks_passed: checks.filter((item) => item.status === "pass").length,
      checks_failed: hardFailures.length,
      checks_insufficient: insufficient.length,
      events_in_window: windowEvents.length,
      outboxes_in_window: windowOutboxes.length,
    },
    checks,
  };
}
