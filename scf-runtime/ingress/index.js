import { createStore } from "../shared/cos-store.js";

function response(statusCode, data) {
  return {
    statusCode,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    body: JSON.stringify(data),
  };
}

function methodOf(event) {
  return String(event?.requestContext?.httpMethod || event?.requestContext?.http?.method || event?.httpMethod || event?.method || "POST").toUpperCase();
}

function bodyOf(event) {
  if (typeof event?.body !== "string") return "";
  return event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
}

export async function main_handler(event, context) {
  const method = methodOf(event);
  if (method === "GET") return response(200, { ok: true, service: "agent-feishu-ingress" });
  if (method !== "POST") return response(405, { error: "method not allowed" });

  let payload;
  try { payload = JSON.parse(bodyOf(event)); }
  catch { return response(400, { error: "invalid json" }); }

  if (payload?.type === "url_verification" && typeof payload.challenge === "string") {
    if (payload.token !== process.env.FEISHU_VERIFICATION_TOKEN) return response(401, { error: "invalid token" });
    return response(200, { challenge: payload.challenge });
  }

  if (payload?.header?.token !== process.env.FEISHU_VERIFICATION_TOKEN) {
    return response(401, { error: "invalid token" });
  }
  if (payload?.header?.event_type !== "im.message.receive_v1") return response(200, { code: 0 });

  const eventId = payload?.header?.event_id;
  if (!eventId) return response(400, { error: "missing event id" });
  const store = createStore(context);
  await store.putJson(`inbox/${eventId}.json`, payload);
  return response(200, { code: 0 });
}
