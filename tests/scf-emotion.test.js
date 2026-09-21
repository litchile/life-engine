import { describe, expect, it } from "vitest";
import { applyEventToEmotion, decayEmotionState, defaultEmotionState } from "../scf-runtime/shared/emotion.js";

describe("gradual emotion model", () => {
  it("changes slowly through world experiences rather than user attendance", () => {
    const initial = defaultEmotionState("2026-07-31T00:00:00.000Z");
    const next = applyEventToEmotion(initial, {
      id: "e1",
      activity: "第一次独自探索花店",
      mood: "惊喜且好奇",
      importance: 4,
      world_observations: [{ entity_type: "character", name: "兔子花店老板" }],
    }, "2026-07-31T01:00:00.000Z");
    expect(next.long_term.curiosity - initial.long_term.curiosity).toBeLessThan(0.02);
    expect(next.long_term.social_confidence).toBeGreaterThan(initial.long_term.social_confidence);
    expect(next.current.valence).toBeGreaterThan(initial.current.valence);
  });

  it("recovers toward baseline over time without punishing silence", () => {
    const saved = defaultEmotionState("2026-07-30T00:00:00.000Z");
    saved.current = { ...saved.current, valence: -0.8, security: 0.1, arousal: 0.9 };
    const recovered = decayEmotionState(saved, "2026-07-31T00:00:00.000Z");
    expect(recovered.current.valence).toBeGreaterThan(-0.8);
    expect(recovered.current.security).toBeGreaterThan(0.1);
    expect(recovered.current.arousal).toBeLessThan(0.9);
  });
});
