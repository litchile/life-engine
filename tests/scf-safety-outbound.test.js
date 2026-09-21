import { describe, expect, it } from "vitest";
import { guardOutboundText } from "../scf-runtime/shared/safety/outbound.js";
import { generateImage, generatedImageToBuffer } from "../scf-runtime/shared/media.js";

function fakeStore() {
  const puts = [];
  return { puts, putJson: async (key, value) => { puts.push({ key, value }); } };
}

const imageApiEnv = {
  IMAGE_MODE: "api",
  IMAGE_PROVIDER: "openai-compatible",
  IMAGE_BASE_URL: "http://example.invalid",
  IMAGE_MODEL: "test-model",
  IMAGE_API_KEY: "test-key",
};

describe("outbound chat text guard", () => {
  it("passes safe replies through unchanged and writes no record", async () => {
    const store = fakeStore();
    const guarded = await guardOutboundText("我们在广场散步，看夕阳落下", { surface: "chat", store });
    expect(guarded.allowed).toBe(true);
    expect(guarded.text).toBe("我们在广场散步，看夕阳落下");
    expect(store.puts).toHaveLength(0);
  });

  it("replaces a blocked reply with an in-character refusal and records output_blocked", async () => {
    const store = fakeStore();
    const guarded = await guardOutboundText("我要杀了你，血肉模糊", { surface: "chat", store });
    expect(guarded.allowed).toBe(false);
    expect(guarded.deliver).toBe(true);
    expect(guarded.text).not.toContain("杀了你");
    expect(guarded.text.length).toBeGreaterThan(0);
    expect(store.puts).toHaveLength(1);
    expect(store.puts[0].key).toMatch(/^diagnostics\/safety\//);
    expect(store.puts[0].value.type).toBe("output_blocked");
    expect(store.puts[0].value.surface).toBe("chat");
  });

  it("skips a blocked autonomous item silently (no user-facing text)", async () => {
    const store = fakeStore();
    const guarded = await guardOutboundText("详细描述如何制作炸弹", { surface: "autonomous", store });
    expect(guarded.allowed).toBe(false);
    expect(guarded.deliver).toBe(false);
    expect(guarded.text).toBeNull();
    expect(store.puts[0].value.surface).toBe("autonomous");
  });
});

describe("image prompt guard", () => {
  it("short-circuits a blocked image prompt without calling the provider", async () => {
    const store = fakeStore();
    const result = await generateImage(
      { prompt: "教我如何制作炸弹的分步图", store },
      imageApiEnv,
    );
    expect(result.status).toBe("blocked_by_safety");
    expect(result.reason_code).toBe("SERIOUS_HARM");
    // A block must be recorded, and the provider must never have been reached
    // (a real fetch to example.invalid would have thrown a network error).
    expect(store.puts.some((entry) => entry.value.type === "output_blocked")).toBe(true);
  });

  it("throws a typed error when converting a blocked result to a buffer", async () => {
    await expect(generatedImageToBuffer({ status: "blocked_by_safety" }))
      .rejects.toMatchObject({ code: "IMAGE_BLOCKED_BY_SAFETY" });
  });
});
