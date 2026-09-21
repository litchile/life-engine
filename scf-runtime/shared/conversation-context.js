// Conversation ownership comes from the transport, never from model output.
export function conversationContext(envelope, incoming, config, env = {}) {
  const message = envelope.event.message;
  const sender = envelope.event.sender.sender_id.open_id;
  const isGroup = message.chat_type === "group";
  const chatId = isGroup ? String(message.chat_id || "") : "";
  if (![sender, ...(isGroup ? [chatId] : [])].every((id) => /^[a-zA-Z0-9_-]{1,128}$/.test(id))) throw new Error("Invalid conversation identifier");
  const mentions = Array.isArray(message.mentions) ? message.mentions : [];
  const mentioned = mentions.some((mention) => env.FEISHU_BOT_OPEN_ID
    ? mention.id?.open_id === env.FEISHU_BOT_OPEN_ID
    : mention.name === config.character.name);
  const named = incoming.type === "text" && String(incoming.text).startsWith(config.character.name);
  return {
    is_group: isGroup, chat_id: chatId || null, sender_id: sender,
    message_id: message.message_id, event_id: envelope.header?.event_id || null, parent_id: message.parent_id || null,
    contact_key: isGroup ? `conversations/${chatId}.json` : `contacts/${sender}.json`,
    recipient: isGroup ? chatId : sender, recipient_type: isGroup ? "chat_id" : "open_id",
    directly_addressed: !isGroup || mentioned || named,
  };
}

export function conversationDecision(context, incoming, saved = {}) {
  if (incoming.type === "text" && /^(?:这条|这句|现在|暂时)?(?:消息)?(?:你)?(?:不用|不必|不要)(?:再)?(?:回复|回我|回答)[。！!\s]*$/.test(incoming.text)) {
    return { respond: false, reason: "explicit_silence" };
  }
  const replyingToBot = context.parent_id && context.parent_id === saved.last_bot_message_id;
  if (context.is_group && !context.directly_addressed && !replyingToBot) {
    return { respond: false, reason: "group_background" };
  }
  return { respond: true, reason: "addressed" };
}

export function conversationTurn(context, content, now = new Date().toISOString()) {
  return { role: "user", content, sender_id: context.sender_id, chat_id: context.chat_id,
    message_id: context.message_id, event_id: context.event_id, parent_id: context.parent_id, observed_at: now };
}

export function dialogueForPrompt(history, characterName) {
  return history.map((item) => ({
    speaker: item.role === "assistant" ? characterName : (item.sender_id || "用户"),
    message_id: item.message_id || null, reply_to: item.parent_id || null, content: item.content,
  }));
}
