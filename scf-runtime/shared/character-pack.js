import defaultPack from "../packs/agent.json" with { type: "json" };
import { validateLifeEngineConfig } from "./life-engine-config.js";

const MAX_PACK_BYTES = 512 * 1024;
const ID = /^[a-z][a-z0-9-]{0,63}$/;
const FORBIDDEN = new Set(["__proto__", "prototype", "constructor"]);
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export function validateRelativeKey(value, { allowEmpty = false } = {}) {
  if (allowEmpty && value === "") return value;
  if (typeof value !== "string" || !value || value.length > 512
    || /[\\\x00-\x1f%?#:]/.test(value) || value.startsWith("/")
    || value.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("Expected a relative storage key without traversal or URL syntax");
  }
  return value;
}

// Portable packs are complete documents. Partial environment overrides use the
// existing config API; importing a different character must not fill gaps with
// the bundled character's identity or relationships.
function checkShape(value, template, path, errors, depth = 0) {
  if (depth > 16) { errors.push(`${path}: nesting limit exceeded`); return; }
  if (Array.isArray(template)) {
    if (!Array.isArray(value) || value.length > 200) { errors.push(`${path}: expected array of at most 200 items`); return; }
    for (const [index, item] of value.entries()) checkShape(item, template[0] ?? "", `${path}[${index}]`, errors, depth + 1);
  } else if (isRecord(template)) {
    if (!isRecord(value)) { errors.push(`${path}: expected object`); return; }
    // Relationships are an explicit dictionary of names to descriptions.
    if (path === "config.character.default_state.relationships") {
      for (const [key, item] of Object.entries(value)) {
        if (FORBIDDEN.has(key)) errors.push(`${path}: forbidden key`);
        checkShape(item, "", `${path}.${key}`, errors, depth + 1);
      }
      return;
    }
    for (const key of Object.keys(value)) if (!Object.hasOwn(template, key) || FORBIDDEN.has(key)) errors.push(`${path}.${key}: unknown field`);
    for (const [key, item] of Object.entries(template)) {
      if (!Object.hasOwn(value, key)) errors.push(`${path}.${key}: required`);
      else checkShape(value[key], item, `${path}.${key}`, errors, depth + 1);
    }
  } else if (typeof value !== typeof template || (typeof value === "number" && !Number.isFinite(value))) {
    errors.push(`${path}: expected ${typeof template}`);
  } else if (typeof value === "string" && value.length > 16000) errors.push(`${path}: text too long`);
}

export function validateCharacterPack(pack) {
  const errors = [];
  if (!isRecord(pack)) return { valid: false, errors: ["Pack must be an object"] };
  for (const key of Object.keys(pack)) if (!["format", "format_version", "id", "version", "config", "assets"].includes(key)) errors.push(`Unknown pack field: ${key}`);
  if (pack.format !== "life-engine-pack" || pack.format_version !== 1) errors.push("Unsupported pack format/version");
  if (!ID.test(pack.id || "")) errors.push("Invalid pack id");
  if (!/^\d+\.\d+\.\d+$/.test(pack.version || "")) errors.push("Expected numeric major.minor.patch version");
  checkShape(pack.config, defaultPack.config, "config", errors);
  if (!errors.length) {
    if (pack.config.schema_version !== 1) errors.push("Unsupported config schema version");
    errors.push(...validateLifeEngineConfig({ ...pack.config, instance: { user_id: "validation", character_id: pack.id } }).errors);
    if (!ID.test(pack.config.world.id)) errors.push("Invalid world id");
    if (!pack.config.world.seed_places.includes(pack.config.world.initial_location)) errors.push("Initial location must exist in seed_places");
    if (!pack.config.world.seed_places.includes(pack.config.world.current_location)) errors.push("Initial current_location must exist in seed_places");
    if (!pack.config.world.seed_places.includes(pack.config.world.home.location)) errors.push("Home must exist in seed_places");
    const entityIds = new Set();
    for (const entity of pack.config.world.initial_entities) {
      if (!ID.test(entity.id) || entityIds.has(entity.id) || !entity.name.trim() || !entity.facts.length) errors.push("Invalid or duplicate initial entity");
      entityIds.add(entity.id);
    }
    if (pack.config.visual.unique_species.only_character_name !== pack.config.character.name
      || pack.config.visual.unique_species.species !== pack.config.character.species) errors.push("Unique species rule must match the character");
    if (pack.config.visual.unique_species.maximum_visible !== 1) errors.push("This engine supports one unique main character per image");
  }
  const ids = new Set();
  const keys = new Set();
  if (!Array.isArray(pack.assets) || pack.assets.length > 100) errors.push("assets must contain at most 100 references");
  else for (const asset of pack.assets) {
    if (!isRecord(asset)) { errors.push("Asset must be an object"); continue; }
    for (const key of Object.keys(asset)) if (!["id", "role", "key", "mime_type", "sha256", "tags", "viewpoint"].includes(key)) errors.push(`Unknown asset field: ${key}`);
    if (!ID.test(asset.id || "") || ids.has(asset.id)) errors.push("Asset ids must be unique identifiers");
    ids.add(asset.id);
    if (keys.has(asset.key)) errors.push("Asset keys must be unique");
    keys.add(asset.key);
    if (asset.tags !== undefined && (!Array.isArray(asset.tags) || asset.tags.length > 20
      || asset.tags.some((tag) => typeof tag !== "string" || !tag.trim() || tag.length > 80))) errors.push("Invalid asset tags");
    if (asset.viewpoint !== undefined && !["single", "turnaround", "first_person", "selfie"].includes(asset.viewpoint)) errors.push("Invalid asset viewpoint");
    if (!["identity", "supporting_character", "location", "style"].includes(asset.role)) errors.push("Unsupported asset role");
    if (!["image/png", "image/jpeg", "image/webp"].includes(asset.mime_type)) errors.push("Unsupported asset MIME type");
    if (!/^[a-f0-9]{64}$/.test(asset.sha256 || "")) errors.push("Asset requires lowercase SHA-256");
    try {
      validateRelativeKey(asset.key);
      if (!asset.key.startsWith(`media/packs/${pack.id}/${pack.version}/`)) errors.push("Assets must be stored under their pack/version namespace");
    } catch { errors.push("Unsafe asset storage key"); }
  }
  return { valid: errors.length === 0, errors };
}

export function parseCharacterPack(source) {
  if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > MAX_PACK_BYTES) throw new Error("Character pack exceeds 512 KiB or is not JSON text");
  let pack;
  try { pack = JSON.parse(source); } catch { throw new Error("Character pack is not valid JSON"); }
  const result = validateCharacterPack(pack);
  if (!result.valid) throw new Error(`Invalid character pack: ${result.errors.join("; ")}`);
  return pack;
}

export function serializeCharacterPack(pack) {
  const output = JSON.stringify(pack, null, 2) + "\n";
  parseCharacterPack(output);
  return output;
}

export function configFromCharacterPack(pack, instance) {
  const verified = parseCharacterPack(JSON.stringify(pack));
  if (!isRecord(instance) || typeof instance.user_id !== "string" || !instance.user_id.trim()) throw new Error("Host must supply an instance owner");
  const prefix = validateRelativeKey(instance.storage_prefix, { allowEmpty: true });
  if (verified.id !== defaultPack.id && !prefix) throw new Error("A different character requires an isolated storage prefix");
  return { ...verified.config, instance: { user_id: instance.user_id, character_id: verified.id, storage_prefix: prefix } };
}
