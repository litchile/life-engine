// A conversation-scoped ledger of explicit first-person preferences. Unlike the
// world-memory cache, it is not evicted by character episodes or importance rank.
const list = (v) => Array.isArray(v) ? v : [];
const clean = (v) => String(v || "").replace(/\s+/g, " ").trim();
const topicKey = (v) => clean(v).replace(/^(?:吃|喝|看|听|玩)/, "").replace(/(?:了|的|呀|啊|呢|哦|吧)+$/, "");

export function extractExplicitPreferences(content) {
  const input = clean(content).slice(0, 2000);
  if (/[“”「」"]|(?:他说|她说|你说|比如|假如|如果)/.test(input)) return [];
  const found = [];
  for (const clause of input.split(/[，,。！!；;\n]/)) {
    if (/[？?]|是不是|是否|吗/.test(clause)) continue;
    const match = clause.trim().match(/^(?:哇|其实|说起来|不过|但是)?我(?:现在|一直|真的|很|非常|特别|也|最|更|已经)*(不再喜欢|不喜欢|不爱|讨厌|喜欢|爱)(?:吃|喝|看|听|玩)?(.{1,70})$/);
    if (!match) continue;
    const topic = topicKey(match[2]);
    if (!topic || /因为|但是|所以|而且|你|他|她|我们|以前/.test(topic)) continue;
    found.push({ topic, polarity: /^(?:不|讨厌)/.test(match[1]) ? "dislike" : "like", quote: clause.trim() });
  }
  return found;
}

export function updateUserPreferences(saved = {}, turns = []) {
  let items = list(saved.items).map((item) => ({ ...item }));
  const seen = new Set(list(saved.processed_message_ids));
  const decisions = [];
  for (const turn of turns) {
    if (turn?.role !== "user" || !turn.sender_id || !turn.message_id || seen.has(turn.message_id)) continue;
    seen.add(turn.message_id);
    const input = clean(turn.content);
    const forgetAll = /^(?:请)?(?:忘记|删除|不要再记住)我的(?:所有)?(?:偏好|喜好)[。！!\s]*$/.test(input);
    const forgetTopic = input.match(/^(?:请)?(?:忘记|删除|不要再记住)我(?:喜欢|爱|不喜欢|不爱|讨厌)?(.+?)(?:的偏好|的喜好)[。！!\s]*$/);
    if (forgetAll || forgetTopic) {
      const topic = forgetTopic ? topicKey(forgetTopic[1]) : null;
      const removed = items.filter((x) => x.sender_id === turn.sender_id && (forgetAll || x.topic === topic));
      items = items.filter((x) => !removed.includes(x));
      decisions.push({ message_id: turn.message_id, decision: "deleted", count: removed.length });
      continue;
    }
    for (const preference of extractExplicitPreferences(input)) {
      const previous = items.findIndex((x) => x.sender_id === turn.sender_id && x.topic === preference.topic);
      const item = { ...preference, sender_id: turn.sender_id, source_message_id: turn.message_id,
        source_event_id: turn.event_id || null, observed_at: turn.observed_at || null };
      if (previous >= 0) items[previous] = item;
      else items.push(item);
      decisions.push({ message_id: turn.message_id, decision: previous >= 0 ? "replaced" : "stored", topic: preference.topic });
    }
  }
  return { state: { schema_version: 1, initialized: true, items, processed_message_ids: [...seen].slice(-192) }, decisions };
}

export function preferencesForPrompt(state, senderId, query = "") {
  const own = list(state?.items).filter((item) => item.sender_id === senderId);
  // Give preferences a separate prompt budget; quiet history must not be beaten
  // by the character's current scene. Unselected items remain durably stored.
  return own.map((item, index) => ({ item, index, score: clean(query).includes(item.topic) ? 1 : 0 }))
    .sort((a, b) => b.score - a.score || b.index - a.index).slice(0, 20).map(({ item }) => item);
}
