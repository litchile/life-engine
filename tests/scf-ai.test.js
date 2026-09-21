import { describe, expect, it, vi, afterEach } from "vitest";
import { generateJson, thinkingModeFromEnv } from "../scf-runtime/shared/ai.js";

describe("SCF AI thinking mode", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defaults thinking to disabled", () => {
    expect(thinkingModeFromEnv({})).toBe("disabled");
    expect(thinkingModeFromEnv({ AI_THINKING_MODE: "disabled" })).toBe("disabled");
    expect(thinkingModeFromEnv({ AI_THINKING_MODE: "enabled" })).toBe("enabled");
  });

  it("sends thinking.disabled and rejects empty content with finish_reason context", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [{
          finish_reason: "length",
          message: { role: "assistant", content: "", reasoning_content: "thinking..." },
        }],
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(generateJson("sys", "user", {
      AI_API_KEY: "test-key",
      AI_BASE_URL: "https://example.com",
      AI_MODEL: "deepseek-v4-flash",
    })).rejects.toThrow(/AI returned empty JSON \(finish_reason=length; reasoning_chars=11\)/);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.max_tokens).toBe(2000);
    expect(body.response_format).toEqual({ type: "json_object" });
  });
});
