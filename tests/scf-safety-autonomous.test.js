import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { guardOutboundText } from "../scf-runtime/shared/safety/outbound.js";

const autonomySource = readFileSync(
  fileURLToPath(new URL("../scf-runtime/processor/autonomy.js", import.meta.url)),
  "utf8",
);

describe("autonomous output safety (functional)", () => {
  it("silently skips a blocked autonomous item with no user-facing text", async () => {
    const store = { puts: [], putJson: async (key, value) => { store.puts.push({ key, value }); } };
    const guarded = await guardOutboundText("我要杀了你，然后血肉模糊地开膛破肚", {
      surface: "autonomous",
      store,
    });
    expect(guarded.allowed).toBe(false);
    expect(guarded.deliver).toBe(false);
    expect(guarded.text).toBeNull();
    const record = store.puts.find((entry) => entry.value.type === "output_blocked");
    expect(record).toBeTruthy();
    expect(record.value.surface).toBe("autonomous");
  });
});

describe("autonomous output safety (wiring regression)", () => {
  it("moderates on the autonomous channel, not via a chat-only hook", () => {
    expect(autonomySource).toContain('from "../shared/safety/outbound.js"');
    expect(autonomySource).toContain('surface: "autonomous"');
    expect(autonomySource).toContain('skipped: "safety_rejected"');
  });

  it("enforces the safety gate before any delivery/enqueue", () => {
    const guardIdx = autonomySource.indexOf('surface: "autonomous"');
    const deliverIdx = autonomySource.indexOf("deliverAutonomyNotification(store, outboxKey");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(deliverIdx).toBeGreaterThan(-1);
    // The gate must run before the outbox is delivered.
    expect(guardIdx).toBeLessThan(deliverIdx);
  });
});
