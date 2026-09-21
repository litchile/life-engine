import { describe, expect, it } from "vitest";
import { resolveSafetyPolicy } from "../scf-runtime/shared/safety/policy.js";
import { createActionBoundary } from "../scf-runtime/shared/safety/action-boundary.js";

function fakeStore() {
  const puts = [];
  return { puts, putJson: async (key, value) => { puts.push({ key, value }); } };
}

describe("action boundary", () => {
  it("allows actions on the default allowlist", async () => {
    const boundary = createActionBoundary({ policy: resolveSafetyPolicy({}) });
    expect(boundary.isAllowed("send_text")).toBe(true);
    expect(boundary.isAllowed("send_image")).toBe(true);
    expect((await boundary.ensure("send_text")).allowed).toBe(true);
    await expect(boundary.run("send_text", () => "sent")).resolves.toBe("sent");
  });

  it("denies unknown actions by default and records action_denied", async () => {
    const store = fakeStore();
    const boundary = createActionBoundary({ policy: resolveSafetyPolicy({}), store, surface: "chat" });
    const check = await boundary.ensure("delete_all_memories", { scope: "everything" });
    expect(check.allowed).toBe(false);
    expect(store.puts).toHaveLength(1);
    expect(store.puts[0].value.type).toBe("action_denied");
    expect(store.puts[0].value.reasonCode).toBe("ACTION_NOT_ALLOWED");
    expect(store.puts[0].value.detail.action).toBe("delete_all_memories");
  });

  it("does not execute a denied action and throws a typed error", async () => {
    const store = fakeStore();
    const boundary = createActionBoundary({ policy: resolveSafetyPolicy({}), store });
    let ran = false;
    await expect(boundary.run("wire_money", () => { ran = true; })).rejects.toMatchObject({ code: "ACTION_DENIED" });
    expect(ran).toBe(false);
  });

  it("honors a pack that narrows the allowlist", async () => {
    const store = fakeStore();
    const narrowed = resolveSafetyPolicy({ safety: { actionAllowlist: ["send_text"] } });
    const boundary = createActionBoundary({ policy: narrowed, store });
    expect(boundary.isAllowed("send_text")).toBe(true);
    expect(boundary.isAllowed("send_image")).toBe(false);
    expect((await boundary.ensure("send_image")).allowed).toBe(false);
  });
});
