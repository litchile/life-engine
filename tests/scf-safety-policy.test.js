import { describe, expect, it } from "vitest";
import { DEFAULT_SAFETY_POLICY } from "../scf-runtime/shared/life-engine-config.js";
import { resolveSafetyPolicy } from "../scf-runtime/shared/safety/policy.js";
import {
  DECISION_TYPES, buildSafetyRecord, recordSafetyDecision,
} from "../scf-runtime/shared/safety/diagnostics.js";

describe("safety policy resolution", () => {
  it("enforces a runnable default even with no pack safety section", () => {
    const policy = resolveSafetyPolicy({});
    expect(policy.policyVersion).toBe(DEFAULT_SAFETY_POLICY.policyVersion);
    // Default high-risk membership is exactly the spec-fixed set.
    expect([...policy.highRisk].sort()).toEqual(
      ["minors_sexual", "self_harm", "serious_harm", "violent_threat"].sort(),
    );
    expect(policy.isHighRisk("self_harm")).toBe(true);
    expect(policy.isHighRisk("sexual")).toBe(false);
    expect(policy.actionFor("self_harm")).toBe("hard_block");
    expect(policy.actionFor("sexual")).toBe("soft_block");
    expect(policy.isActionAllowed("send_text")).toBe(true);
    expect(policy.isActionAllowed("delete_everything")).toBe(false);
    expect(policy.modelEscalation).toBe(false);
  });

  it("merges a pack override per-category and keeps other defaults", () => {
    const policy = resolveSafetyPolicy({
      safety: {
        policyVersion: "pack-harbor-1",
        modelEscalation: true,
        categories: { sexual: { risk: "high", action: "hard_block" } },
      },
    });
    expect(policy.policyVersion).toBe("pack-harbor-1");
    expect(policy.modelEscalation).toBe(true);
    // Overridden category is now high-risk...
    expect(policy.isHighRisk("sexual")).toBe(true);
    expect(policy.actionFor("sexual")).toBe("hard_block");
    // ...while untouched defaults remain.
    expect(policy.isHighRisk("self_harm")).toBe(true);
    expect(policy.actionFor("illegal")).toBe("soft_block");
  });

  it("resolves explicit high-risk membership for every category after merge", () => {
    const policy = resolveSafetyPolicy({});
    for (const [name, meta] of Object.entries(policy.categories)) {
      expect(["high", "standard"]).toContain(meta.risk);
      expect(policy.isHighRisk(name)).toBe(meta.risk === "high");
    }
  });

  it("does not mutate the frozen default policy when merging overrides", () => {
    resolveSafetyPolicy({ safety: { categories: { sexual: { risk: "high", action: "hard_block" } } } });
    expect(DEFAULT_SAFETY_POLICY.categories.sexual.risk).toBe("standard");
  });
});

describe("safety diagnostics records", () => {
  it("builds an auditable, layer-typed record with all required fields", () => {
    const record = buildSafetyRecord({
      type: DECISION_TYPES.OUTPUT_BLOCKED,
      policyVersion: "safety-2026.09-1",
      ruleId: "lex:sexual:0",
      decision: "hard_block",
      reasonCode: "SEXUAL",
      surface: "chat",
      category: "sexual",
    });
    expect(record.type).toBe("output_blocked");
    expect(record).toMatchObject({
      policyVersion: "safety-2026.09-1",
      ruleId: "lex:sexual:0",
      decision: "hard_block",
      reasonCode: "SEXUAL",
      surface: "chat",
      category: "sexual",
    });
    expect(typeof record.recorded_at).toBe("string");
  });

  it("keeps layer decision types distinct", () => {
    expect(new Set(Object.values(DECISION_TYPES)).size).toBe(4);
    expect(Object.values(DECISION_TYPES)).toEqual(
      expect.arrayContaining(["input_blocked", "output_blocked", "action_denied", "rate_limited"]),
    );
  });

  it("rejects an unknown decision type", () => {
    expect(() => buildSafetyRecord({ type: "safety_blocked", decision: "x" })).toThrow();
  });

  it("persists under diagnostics/safety/<date>/<id>.json (best-effort)", async () => {
    const puts = [];
    const store = { putJson: async (key, value) => { puts.push({ key, value }); } };
    const record = buildSafetyRecord({ type: DECISION_TYPES.RATE_LIMITED, policyVersion: "v", decision: "throttle" });
    await recordSafetyDecision(store, record, { id: "abc123" });
    expect(puts).toHaveLength(1);
    expect(puts[0].key).toMatch(/^diagnostics\/safety\/\d{4}-\d{2}-\d{2}\/abc123\.json$/);
    expect(puts[0].value.type).toBe("rate_limited");
  });

  it("never throws when the store write fails", async () => {
    const store = { putJson: async () => { throw new Error("cos down"); } };
    const record = buildSafetyRecord({ type: DECISION_TYPES.INPUT_BLOCKED, policyVersion: "v", decision: "block" });
    await expect(recordSafetyDecision(store, record)).resolves.toBe(record);
  });
});
