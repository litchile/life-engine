// Chat text is testimony, not an independent life event. Model supplied labels,
// IDs and summaries are proposals; only server-resolved quotes cross this gate.
import { extractExplicitPreferences } from "./user-preferences.js";

const text = (value, limit = 900) => String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
const list = (value) => Array.isArray(value) ? value : [];
function sourceSentence(source, quote) {
  // Preserve negation, actor and time around the selected substring. Quoting
  // "吃完了" from "我没有吃完了" must never remove the negative qualifier.
  return text(source, 4000).split(/(?<=[。！？!?；;])/u).map((part) => part.trim())
    .find((part) => part.includes(quote) && part.length <= 240) || null;
}

export function recallableMemory(item, audience = null) {
  if (item?.evidence?.type === "user_statement") {
    return Boolean(audience && item.source_sender_id === audience.sender_id
      && (item.source_chat_id || null) === (audience.chat_id || null));
  }
  // Keep historical storage intact, but do not recycle unverified chat facts as
  // authoritative world history. Autonomous records have no chat message source.
  return !(item?.source_message_id && ["fact", "episode", "correction"].includes(item.kind)
    && !item.evidence?.verified);
}

export function groundChatMemoryUpdates(updates, { userText = "", context = {}, recentEvents = [],
  reply = "", characterName = "小云", sceneTransition = {} } = {}) {
  const accepted = [];
  const decisions = [];
  for (const [index, update] of list(updates).entries()) {
    const proof = update?.evidence || {};
    const quote = text(proof.quote, 240);
    const reject = (reason) => decisions.push({ index, decision: "rejected", reason });
    if (!quote) { reject("missing_evidence_quote"); continue; }
    if (update.operation === "resolve") { reject("chat_cannot_certify_completion"); continue; }
    let content, kind, subject, predicate, sourceId, occurredAt;
    if (proof.type === "life_event") {
      const event = list(recentEvents).find((item) => item.id && item.id === proof.source_event_id);
      if (!event || !text(event.narrative, 4000).includes(quote)) { reject("event_quote_not_found"); continue; }
      // Store the source words, not an unsupported expansion attached to a valid ID.
      content = sourceSentence(event.narrative, quote);
      if (!content) { reject("event_sentence_unavailable"); continue; }
      kind = "episode"; subject = characterName;
      predicate = `已记录经历:${event.id}`; sourceId = event.id; occurredAt = event.occurred_at;
    } else if (proof.type === "user_statement") {
      // Preferences have their own scoped, non-evicting transport ledger.
      if (update.kind === "preference" || extractExplicitPreferences(userText).length) { reject("preference_managed_by_user_ledger"); continue; }
      const statement = sourceSentence(userText, quote);
      if (!context.sender_id || !context.message_id || !text(userText).includes(quote)
        || !statement || /[？?]|(?:是不是|是否|为什么|记得吗)/.test(statement)
        || /[“”「」"]/.test(userText)) { reject("not_current_user_statement"); continue; }
      // User testimony stays attributed to the transport sender. It cannot
      // redefine the character's world by choosing an arbitrary subject/slot.
      content = statement; kind = "fact";
      subject = `user:${context.sender_id}`; predicate = `本人陈述:${quote}`;
      sourceId = context.event_id;
    } else if (proof.type === "chat_transition") {
      if (!sceneTransition.occurred || sceneTransition.transition_type === "correction"
        || quote !== text(sceneTransition.evidence, 240) || !text(reply).includes(quote)) {
        reject("not_committed_transition"); continue;
      }
      content = quote; kind = "episode"; subject = characterName;
      predicate = "对话中已提交转场"; sourceId = context.event_id;
    } else if (proof.type === "reply_intention" && ["intention", "promise"].includes(update.kind)) {
      if (!text(reply).includes(quote) || !/想|准备|打算|一会儿|明天|下次|答应|会去/.test(quote)) {
        reject("intention_quote_not_found"); continue;
      }
      content = quote; kind = update.kind; subject = characterName;
      predicate = "计划"; sourceId = context.event_id;
    } else { reject("unsupported_evidence_type"); continue; }
    accepted.push({ content, kind, subject, predicate, operation: "add", importance: update.importance || 1,
      tags: list(update.tags).filter((tag) => content.includes(tag)),
      ...(kind === "promise" ? { report_to_user: update.report_to_user === true } : {}),
      evidence: { type: proof.type, quote, source_event_id: sourceId || null, verified: true },
      ...(occurredAt ? { occurred_at: occurredAt } : {}) });
    decisions.push({ index, decision: "accepted", evidence_type: proof.type, source_event_id: sourceId || null });
  }
  return { updates: accepted, decisions };
}
