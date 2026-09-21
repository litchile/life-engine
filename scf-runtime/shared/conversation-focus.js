// Per-contact attention is a reference aid, never a new world fact.
const TTL_MS = 24 * 60 * 60 * 1000;
export function resolveConversationFocus({ text = "", saved = null, history = [], lastContactAt, now = new Date(), extractSubject }) {
  const value = String(text).trim();
  const fresh = (stamp) => Number.isFinite(Date.parse(stamp))
    && now.getTime() - Date.parse(stamp) >= 0 && now.getTime() - Date.parse(stamp) < TTL_MS;
  const subjectFrom = (input) => {
    if (!/^(?:我)?(?:想看|要看|看看|看一下|看)|拍|照片|相片/.test(input)) return "";
    if (/不要|不用|别拍|不想|先不|算了|换个话题/.test(input)) return "";
    const subject = extractSubject(input.replace(/^(?:我)?(?:想看|要看)/, "看"));
    return /^(?:这|那|它|这个|那个|一下|一张|再|重新|照片|相片|图片|给我|新的|一张新的|照)$/u.test(subject) ? "" : subject;
  };
  if (/不要|不用|别拍|不想|先不|算了|换个话题/.test(value)) return null;
  const explicit = subjectFrom(value);
  if (explicit) return { subject: explicit, updated_at: now.toISOString(), source: "user" };
  // Do not resurrect an old subject after an intervening topic change.
  if (!/^(?:(?:再|重新)?拍(?:一张|张)?|(?:给我)?(?:看|看看|看一下)(?:照片|相片|图片)?|(?:这|那|它|这个|那个).{0,15}|照片呢|嗯|好)[。！？!?]*$/.test(value)) return null;
  if (saved?.subject && fresh(saved.updated_at)) return saved;
  if (!fresh(lastContactAt)) return null;
  const lastUser = history.filter((item) => item.role === "user").at(-1);
  const subject = lastUser ? subjectFrom(String(lastUser.content || "")) : "";
  return subject ? { subject, updated_at: lastContactAt, source: "recent_user" } : null;
}

export function isEllipticalPhotoRequest(text = "") {
  return /^(?:给我)?(?:看|看看|看一下)(?:照片|相片|图片)[。！？!?]*$/.test(String(text).trim())
    || /^(?:再|重新)拍(?:一张|张)?[。！？!?]*$/.test(String(text).trim());
}

export function photoSubjectContext(subject, recentEvents = [], history = []) {
  if (!subject) return { subject: "", life_facts: [], dialogue_claims: [] };
  // Preserve provenance; an assistant's embellishment must not silently become canon.
  return {
    subject,
    life_facts: recentEvents.map((event) => ({
      id: event.id,
      occurred_at: event.occurred_at,
      location: event.location,
      narrative: String(event.narrative || event.story || event.message_to_user || "")
        .split(/(?<=[。！？\n])/).filter((sentence) => sentence.includes(subject)).join("").slice(0, 600),
    })).filter((event) => event.narrative).slice(-4),
    dialogue_claims: history.filter((item) => String(item.content || "").includes(subject)).slice(-4)
      .map((item) => ({ role: item.role, content: String(item.content).slice(0, 400) })),
  };
}
