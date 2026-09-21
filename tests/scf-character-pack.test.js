import { describe, expect, it } from "vitest";
import defaultPack from "../scf-runtime/packs/agent.json" with { type: "json" };
import { configFromCharacterPack, parseCharacterPack, serializeCharacterPack, validateCharacterPack } from "../scf-runtime/shared/character-pack.js";
import { createScopedStore, logicalEventKey } from "../scf-runtime/shared/scoped-store.js";
import { lifeEngineConfig, normalizeLifeEngineConfig } from "../scf-runtime/shared/life-engine-config.js";
import { loadPackRuntime } from "../scf-runtime/shared/pack-runtime.js";
import { createHash } from "node:crypto";

const pack = () => structuredClone(defaultPack);

describe("portable character world packs", () => {
  it("round-trips the complete default setting without histories or instance credentials", () => {
    expect(validateCharacterPack(defaultPack)).toEqual({ valid: true, errors: [] });
    expect(parseCharacterPack(serializeCharacterPack(defaultPack))).toEqual(defaultPack);
    expect(defaultPack.config).not.toHaveProperty("instance");
    expect(configFromCharacterPack(defaultPack, { user_id: "owner", storage_prefix: "" }).character.name).toBe("小云");
  });

  it("requires a complete alternative and never restores default relationships", () => {
    const other = pack();
    other.id = "harbor-fox";
    other.config.character.name = "阿岚";
    other.config.character.species = "狐狸";
    other.config.character.default_state.relationships = {};
    other.config.visual.unique_species = { species: "狐狸", only_character_name: "阿岚", maximum_visible: 1 };
    const config = configFromCharacterPack(other, { user_id: "owner", storage_prefix: "instances/harbor-fox" });
    expect(lifeEngineConfig({ LIFE_ENGINE_CONFIG_JSON: JSON.stringify(config) }).character.default_state.relationships).toEqual({});
    expect(() => configFromCharacterPack(other, { user_id: "owner", storage_prefix: "" })).toThrow(/isolated/);
    delete other.config.visual;
    expect(() => parseCharacterPack(JSON.stringify(other))).toThrow(/required/);
  });

  it.each([
    (p) => { p.config.instance = { storage_prefix: "somebody-else" }; },
    (p) => { p.format_version = 2; },
    (p) => { p.config.world.initial_location = "nonexistent"; },
    (p) => { p.config.visual.unique_species.species = "wrong"; },
    (p) => { p.config.character.core_personality = "wrong"; },
    (p) => { p.config.autonomy.minimum_delay_minutes = -1; },
    (p) => { p.config.world.timezone = "invalid/timezone"; },
    (p) => { p.config.api_key = "placeholder"; },
    (p) => { p.assets = [{ id: "portrait", role: "identity", key: "../private", mime_type: "image/png", sha256: "a".repeat(64) }]; },
  ])("rejects invalid or host-owned fields before loading (%#)", (mutate) => {
    const p = pack(); mutate(p);
    expect(() => parseCharacterPack(JSON.stringify(p))).toThrow(/Invalid character pack/);
  });

  it("rejects oversized, invalid JSON and prototype fields", () => {
    expect(() => parseCharacterPack("{" )).toThrow(/valid JSON/);
    expect(() => parseCharacterPack(" ".repeat(512 * 1024 + 1))).toThrow(/512 KiB/);
    const p = pack();
    p.config.character.default_state.relationships = JSON.parse('{"__proto__":"invalid"}');
    expect(() => parseCharacterPack(JSON.stringify(p))).toThrow(/forbidden/);
    expect(() => normalizeLifeEngineConfig(JSON.parse('{"__proto__":{"bad":true}}'))).toThrow(/Unsafe/);
    expect({}).not.toHaveProperty("bad");
  });
});

describe("runtime pack loading", () => {
  it("loads a per-invocation configuration without mutating host environment or live states", async () => {
    const p = pack();
    p.config.character.expression_style.tone = "新的表达风格";
    const env = { LIFE_ENGINE_PACK_KEY: "packs/agent/1.0.0.json", BOT_TIMEZONE: "Asia/Shanghai" };
    const store = {
      async getObject() { return { body: Buffer.from(serializeCharacterPack(p)), contentType: "application/json" }; },
      async getJson(key) { return key === "state/agent.json" ? { activity: "正在看日落" } : { assets: [{ id: "old-gallery" }] }; },
      async putJson() { throw new Error("Loading a pack must not write runtime state"); },
    };
    const runtime = await loadPackRuntime(store, env);
    expect(runtime.config.character.expression_style.tone).toBe("新的表达风格");
    expect(env).not.toHaveProperty("LIFE_ENGINE_CONFIG_JSON");
    expect(await runtime.store.getJson("state/agent.json")).toEqual({ activity: "正在看日落" });
    expect(await runtime.store.getJson("media/gallery.json")).toEqual({ assets: [] });
    const legacy = await loadPackRuntime(store, {});
    expect(legacy.store).toBe(store);
    expect(legacy.pack).toBe(null);
  });

  it("refuses wrong binding and verifies reference bytes at the read boundary", async () => {
    const p = pack();
    const image = Buffer.from("fixture image");
    p.assets = [{ id: "identity", role: "identity", key: "media/packs/agent/1.0.0/identity.png", mime_type: "image/png", sha256: createHash("sha256").update(image).digest("hex") }];
    let corrupt = false;
    let missing = false;
    const store = {
      async getObject(key) {
        if (missing && !key.startsWith("packs/")) throw Object.assign(new Error("NoSuchKey"), { statusCode: 404 });
        return key.startsWith("packs/")
        ? { body: Buffer.from(serializeCharacterPack(p)), contentType: "application/json" }
        : { body: corrupt ? Buffer.from("changed") : image, contentType: "image/png" }; },
    };
    const env = { LIFE_ENGINE_PACK_KEY: "packs/agent/1.0.0.json" };
    const runtime = await loadPackRuntime(store, env);
    expect((await runtime.store.getJson("media/gallery.json")).assets[0].reference_roles).toEqual(["identity"]);
    expect((await runtime.store.getObject("media/packs/agent/1.0.0/identity.png")).body).toEqual(image);
    corrupt = true;
    await expect(runtime.store.getObject("media/packs/agent/1.0.0/identity.png")).rejects.toThrow(/integrity mismatch/);
    missing = true;
    await expect(runtime.store.getObject("media/packs/agent/1.0.0/identity.png")).rejects.toThrow(/Required pack asset unavailable/);
    await expect(loadPackRuntime(store, { ...env, LIFE_ENGINE_CONFIG_JSON: JSON.stringify({ instance: { character_id: "another", storage_prefix: "instances/another" } }) })).rejects.toThrow(/binding/);
    await expect(loadPackRuntime(store, { LIFE_ENGINE_PACK_KEY: "state/agent.json" })).rejects.toThrow(/under packs/);
  });
});

describe("instance storage boundary", () => {
  function memoryStore() {
    const values = new Map();
    const raw = {
      async getJson(key, fallback) { return structuredClone(values.has(key) ? values.get(key) : fallback); },
      async putJson(key, value) { values.set(key, structuredClone(value)); },
      async getObject(key) { return values.get(key); },
      async putObject(key, value) { values.set(key, value); },
      async exists(key) { return values.has(key); },
      async listKeys(prefix, limit = 100) { return [...values.keys()].filter((k) => k.startsWith(prefix)).slice(0, limit); },
      async tryAcquireLock(key, owner) { if (await this.exists(key)) return false; await this.putJson(key, { owner }); return true; },
      async releaseLock(key, owner) { if ((await this.getJson(key))?.owner === owner) values.delete(key); },
    };
    return { values, raw };
  }

  it("preserves legacy empty-prefix storage and isolates states, media, lists and locks", async () => {
    const { raw, values } = memoryStore();
    expect(createScopedStore(raw, "")).toBe(raw);
    const a = createScopedStore(raw, "instances/a");
    const b = createScopedStore(raw, "instances/b");
    await raw.putJson("state/agent.json", { original: true });
    await a.putJson("state/agent.json", { activity: "watch waves" });
    expect(await b.getJson("state/agent.json", null)).toBe(null);
    expect(await raw.getJson("state/agent.json")).toEqual({ original: true });
    expect(await a.listKeys("state/")).toEqual(["state/agent.json"]);
    await a.putObject("generated/image.png", Buffer.from("image"));
    expect(await b.exists("generated/image.png")).toBe(false);
    expect(await a.getObject("generated/image.png")).toEqual(Buffer.from("image"));
    expect(await a.tryAcquireLock("locks/world.json", "a")).toBe(true);
    expect(await a.tryAcquireLock("locks/world.json", "again")).toBe(false);
    expect(await b.tryAcquireLock("locks/world.json", "b")).toBe(true);
    await a.releaseLock("locks/world.json", "a");
    expect(values.has("instances/a/locks/world.json")).toBe(false);
    expect(values.has("instances/b/locks/world.json")).toBe(true);
    expect(logicalEventKey("instances/a/inbox/e.json", "instances/a")).toBe("inbox/e.json");
    expect(logicalEventKey("instances/ab/inbox/e.json", "instances/a")).toBe(null);
    expect(logicalEventKey("inbox/e.json", "")).toBe("inbox/e.json");
  });

  it.each(["../other", "/root", "a//b", "a/../b", "a\\b", "%2e%2e", "https://example.com"])("refuses unsafe prefixes and keys %s", (value) => {
    const { raw } = memoryStore();
    expect(() => createScopedStore(raw, value)).toThrow();
    const a = createScopedStore(raw, "instances/a");
    expect(() => a.putJson(value, {})).toThrow();
    expect(() => normalizeLifeEngineConfig({ instance: { storage_prefix: value } })).toThrow();
  });
});
