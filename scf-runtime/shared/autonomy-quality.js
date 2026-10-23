// Measures the sampled committed events, not model intelligence or satisfaction.
export function summarizeAutonomyQuality(events = []) {
  const unique = [...new Map(events.filter((event) => event?.id && Number.isFinite(Date.parse(event?.occurred_at))
    && event.event_type !== "activity_plan_transition" && event.event_type !== "diagnostic")
    .map((event) => [event.id, event])).values()].sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at));
  const fallback = unique.filter((event) => event.fallback_kind === "director_safe");
  const reasons = {};
  for (const event of fallback) {
    for (const reason of event.life_context_snapshot?.director?.fallback?.rejection_reasons || []) {
      reasons[reason] = (reasons[reason] || 0) + 1;
    }
  }
  let run = 0, longest = 0;
  for (const event of unique) {
    run = event.fallback_kind === "director_safe" ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  const ratio = unique.length ? fallback.length / unique.length : null;
  return {
    schema_version: 1, status: !unique.length ? "insufficient" : longest >= 3 || (unique.length >= 4 && ratio >= 0.5) ? "degraded" : "ok",
    sample_start: unique[0]?.occurred_at || null, sample_end: unique.at(-1)?.occurred_at || null,
    committed_events: unique.length, generated_events: unique.length - fallback.length,
    fallback_events: fallback.length, fallback_ratio: ratio, longest_fallback_run: longest,
    advanced_goals: unique.filter((event) => event.fallback_kind !== "director_safe" && event.director_outcome?.status === "advanced").length,
    fallback_rejection_reasons: reasons,
  };
}
