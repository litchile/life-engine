function providerConfig(env = process.env) {
  const provider = env.AI_PROVIDER || "openai-compatible";
  if (provider !== "openai-compatible" && provider !== "deepseek") {
    throw new Error(`Unsupported AI_PROVIDER: ${provider}`);
  }
  return {
    apiKey: env.AI_API_KEY || env.DEEPSEEK_API_KEY,
    baseUrl: (env.AI_BASE_URL || "https://api.deepseek.com").replace(/\/$/, ""),
    model: env.AI_MODEL || env.DEEPSEEK_MODEL || "deepseek-chat",
  };
}

/**
 * DeepSeek V4 enables thinking by default. Reasoning tokens share max_tokens with
 * content; large autonomy prompts can exhaust the budget and return empty content.
 * Project default matches docs: disabled unless explicitly enabled.
 */
export function thinkingModeFromEnv(env = process.env) {
  const raw = String(env.AI_THINKING_MODE ?? "disabled").trim().toLowerCase();
  if (["1", "true", "enabled", "on", "yes"].includes(raw)) return "enabled";
  return "disabled";
}

function withThinking(body, env = process.env) {
  return {
    ...body,
    thinking: { type: thinkingModeFromEnv(env) },
  };
}

function messageContent(data) {
  const message = data?.choices?.[0]?.message || {};
  const content = typeof message.content === "string" ? message.content.trim() : "";
  return { message, content, finishReason: data?.choices?.[0]?.finish_reason || null };
}

export async function generateReply(systemPrompt, userText, history = [], env = process.env) {
  const config = providerConfig(env);
  if (!config.apiKey) throw new Error("AI_API_KEY is required");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(env.AI_TIMEOUT_MS || 25000));
  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(withThinking({
        model: config.model,
        messages: [
          { role: "system", content: systemPrompt },
          ...history.slice(-10).map(({ role, content }) => ({ role, content })),
          { role: "user", content: userText },
        ],
        temperature: 0.85,
        max_tokens: 320,
      }, env)),
      signal: controller.signal,
    });
    const data = await response.json();
    if (!response.ok) throw new Error(`AI request failed (${response.status}): ${data?.error?.message || "unknown"}`);
    const { content: reply, finishReason } = messageContent(data);
    if (!reply) {
      throw new Error(`AI returned an empty reply (finish_reason=${finishReason || "unknown"})`);
    }
    return reply;
  } finally {
    clearTimeout(timer);
  }
}

export async function generateJson(systemPrompt, userText, env = process.env) {
  const config = providerConfig(env);
  if (!config.apiKey) throw new Error("AI_API_KEY is required");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(env.AI_TIMEOUT_MS || 25000));
  const maxTokens = Math.max(900, Number(env.AI_JSON_MAX_TOKENS || 2000));
  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(withThinking({
        model: config.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userText },
        ],
        response_format: { type: "json_object" },
        temperature: 0.9,
        max_tokens: maxTokens,
      }, env)),
      signal: controller.signal,
    });
    const data = await response.json();
    if (!response.ok) throw new Error(`AI request failed (${response.status}): ${data?.error?.message || "unknown"}`);
    const { content: raw, finishReason, message } = messageContent(data);
    if (!raw) {
      const reasoningLen = typeof message.reasoning_content === "string" ? message.reasoning_content.length : 0;
      throw new Error(
        `AI returned empty JSON (finish_reason=${finishReason || "unknown"}; reasoning_chars=${reasoningLen})`,
      );
    }
    const normalized = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    return JSON.parse(normalized);
  } finally {
    clearTimeout(timer);
  }
}

export { providerConfig };
