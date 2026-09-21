import { createHash } from "node:crypto";
import { configFromCharacterPack, parseCharacterPack, validateRelativeKey } from "./character-pack.js";
import { lifeEngineConfig } from "./life-engine-config.js";

// Host selects one immutable version key. No global environment mutation, no
// implicit write to the live character's memories or initial state.
export async function loadPackRuntime(store, env = process.env) {
  const host = lifeEngineConfig(env);
  if (!env.LIFE_ENGINE_PACK_KEY) return { store, env, config: host, pack: null };
  const key = validateRelativeKey(env.LIFE_ENGINE_PACK_KEY);
  if (!key.startsWith("packs/")) throw new Error("LIFE_ENGINE_PACK_KEY must be under packs/");
  const stored = await store.getObject(key);
  if (env.LIFE_ENGINE_PACK_SHA256) {
    const expected = String(env.LIFE_ENGINE_PACK_SHA256);
    if (!/^[a-f0-9]{64}$/.test(expected) || createHash("sha256").update(stored.body).digest("hex") !== expected) {
      throw new Error("Character pack integrity mismatch");
    }
  }
  const pack = parseCharacterPack(Buffer.from(stored.body).toString("utf8"));
  if (pack.id !== host.instance.character_id) throw new Error("Pack id does not match the host character binding");
  const config = configFromCharacterPack(pack, host.instance);
  const runtimeEnv = { ...env, LIFE_ENGINE_CONFIG_JSON: JSON.stringify(config) };
  const assets = new Map(pack.assets.map((asset) => [asset.key, asset]));
  const roles = { identity: "identity", supporting_character: "supporting_character", location: "location", style: "character_style" };
  const gallery = { assets: pack.assets.map((asset) => ({
    id: asset.id, cos_key: asset.key, enabled: true, sendable: false,
    viewpoint: asset.viewpoint,
    reference_roles: [roles[asset.role]], tags: [...(asset.tags || []), ...(asset.role === "identity" ? [config.character.name, config.character.species] : [asset.id])],
  })) };
  const runtimeStore = {
    ...store,
    async getJson(key, fallback) {
      // A pack's manifest is authoritative, even if empty. It must never pick up
      // the previous character's gallery implicitly.
      if (key === "media/gallery.json") return structuredClone(gallery);
      return store.getJson(key, fallback);
    },
    async getObject(key) {
      const asset = assets.get(key);
      let object;
      try { object = await store.getObject(key); }
      catch (error) {
        // Declared pack references are required identities, not optional legacy
        // gallery hints. Do not silently generate a replacement identity.
        if (asset) throw new Error(`Required pack asset unavailable: ${asset.id}`, { cause: error });
        throw error;
      }
      if (asset) {
        const hash = createHash("sha256").update(object.body).digest("hex");
        if (hash !== asset.sha256) throw new Error(`Pack asset integrity mismatch: ${asset.id}`);
        if (object.contentType?.split(";")[0] !== asset.mime_type) throw new Error(`Pack asset MIME mismatch: ${asset.id}`);
      }
      return object;
    },
  };
  return { store: runtimeStore, env: runtimeEnv, config: lifeEngineConfig(runtimeEnv), pack };
}
