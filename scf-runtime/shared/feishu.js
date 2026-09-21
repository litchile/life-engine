let cachedToken = null;
let tokenExpiresAt = 0;

async function tenantToken(env = process.env) {
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;
  const response = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET }),
  });
  const data = await response.json();
  if (!response.ok || data.code !== 0 || !data.tenant_access_token) {
    throw new Error(`Feishu token failed (${data.code ?? response.status}): ${data.msg || "unknown"}`);
  }
  cachedToken = data.tenant_access_token;
  tokenExpiresAt = Date.now() + Math.max(60, Number(data.expire || 7200) - 300) * 1000;
  return cachedToken;
}

export async function replyText(messageId, text, env = process.env) {
  const token = await tenantToken(env);
  const response = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ msg_type: "text", content: JSON.stringify({ text }) }),
  });
  const data = await response.json();
  if (!response.ok || data.code !== 0) {
    throw new Error(`Feishu reply failed (${data.code ?? response.status}): ${data.msg || "unknown"}`);
  }
  return data.data?.message_id || null;
}

export async function sendText(receiveId, text, env = process.env, options = {}) {
  const token = await tenantToken(env);
  const response = await fetch("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      receive_id: receiveId,
      msg_type: "text",
      content: JSON.stringify({ text }),
      ...(options.idempotencyKey ? { uuid: String(options.idempotencyKey).slice(0, 50) } : {}),
    }),
  });
  const data = await response.json();
  if (!response.ok || data.code !== 0) {
    throw new Error(`Feishu proactive send failed (${data.code ?? response.status}): ${data.msg || "unknown"}`);
  }
}

export async function uploadImage(buffer, fileName = "agent.jpg", env = process.env) {
  const token = await tenantToken(env);
  const form = new FormData();
  form.append("image_type", "message");
  form.append("image", new Blob([buffer]), fileName);
  const response = await fetch("https://open.feishu.cn/open-apis/im/v1/images", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const data = await response.json();
  if (!response.ok || data.code !== 0 || !data.data?.image_key) {
    throw new Error(`Feishu image upload failed (${data.code ?? response.status}): ${data.msg || "unknown"}`);
  }
  return data.data.image_key;
}

export async function sendImage(receiveId, imageKey, env = process.env, options = {}) {
  const recipientType = options.recipientType || "open_id";
  if (!["open_id", "chat_id"].includes(recipientType)) throw new Error("Unsupported image recipient type");
  const token = await tenantToken(env);
  const response = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${recipientType}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      receive_id: receiveId,
      msg_type: "image",
      content: JSON.stringify({ image_key: imageKey }),
      ...(options.idempotencyKey ? { uuid: String(options.idempotencyKey).slice(0, 50) } : {}),
    }),
  });
  const data = await response.json();
  if (!response.ok || data.code !== 0) {
    throw new Error(`Feishu image send failed (${data.code ?? response.status}): ${data.msg || "unknown"}`);
  }
}

export async function downloadMessageResource(messageId, fileKey, type = "image", env = process.env) {
  const token = await tenantToken(env);
  const url = `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(fileKey)}?type=${encodeURIComponent(type)}`;
  const response = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    let detail = "unknown";
    try {
      const data = await response.json();
      detail = data?.msg || data?.message || detail;
    } catch {}
    throw new Error(`Feishu resource download failed (${response.status}): ${detail}`);
  }
  return {
    body: Buffer.from(await response.arrayBuffer()),
    contentType: response.headers.get("content-type") || "image/jpeg",
  };
}

export function parseIncomingMessage(envelope) {
  const message = envelope?.event?.message;
  const type = String(message?.message_type || "");
  let parsed = {};
  try { parsed = JSON.parse(message?.content || "{}"); }
  catch { parsed = {}; }
  if (type === "text") {
    return {
      type,
      text: String(parsed.text || "").replace(/@_user_\d+/g, "").trim(),
    };
  }
  if (type === "image") return { type, imageKey: String(parsed.image_key || "") };
  return { type };
}

export function parseTextMessage(envelope) {
  const parsed = parseIncomingMessage(envelope);
  return parsed.type === "text" ? parsed.text : null;
}
