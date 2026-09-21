import { readFile, writeFile, realpath, stat } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import defaultPack from "../scf-runtime/packs/agent.json" with { type: "json" };
import { configFromCharacterPack, parseCharacterPack, serializeCharacterPack } from "../scf-runtime/shared/character-pack.js";

export async function checkLocalAssets(pack, directory) {
  const root = await realpath(resolve(directory));
  for (const asset of pack.assets) {
    const target = await realpath(resolve(root, asset.key));
    const rel = relative(root, target);
    if (rel === ".." || rel.startsWith("..\\") || rel.startsWith("../") || isAbsolute(rel)) throw new Error(`Asset escapes selected directory: ${asset.id}`);
    const metadata = await stat(target);
    if (!metadata.isFile() || metadata.size > 20 * 1024 * 1024) throw new Error(`Asset must be a file up to 20 MiB: ${asset.id}`);
    const body = await readFile(target);
    if (createHash("sha256").update(body).digest("hex") !== asset.sha256) throw new Error(`Asset integrity mismatch: ${asset.id}`);
  }
}

export async function run(args) {
  if (args[0] === "prepare") {
    const [, input, bindingFile, output, assetDirectory, ...extra] = args;
    if (!input || !bindingFile || !output || extra.length) throw new Error("Usage: prepare PACK.json INSTANCE.json NEW_PLAN.json [ASSETS_DIRECTORY]");
    const source = await readFile(resolve(input));
    const pack = parseCharacterPack(source.toString("utf8"));
    const instance = JSON.parse(await readFile(resolve(bindingFile), "utf8"));
    if (Object.keys(instance).some((key) => !["user_id", "character_id", "storage_prefix"].includes(key))) throw new Error("Instance binding contains unsupported fields");
    if (instance.character_id !== pack.id) throw new Error("Instance character_id must match pack id");
    const config = configFromCharacterPack(pack, instance);
    if (pack.assets.length && !assetDirectory) throw new Error("Preparing a pack with resources requires ASSETS_DIRECTORY");
    if (assetDirectory) await checkLocalAssets(pack, assetDirectory);
    const key = `packs/${pack.id}/${pack.version}.json`;
    const physical = (key) => instance.storage_prefix ? `${instance.storage_prefix}/${key}` : key;
    const plan = {
      format: "life-engine-activation-plan", version: 1, status: "prepared_locally",
      pack: { id: pack.id, version: pack.version },
      uploads: [{ local_file: resolve(input), cos_key: physical(key), sha256: createHash("sha256").update(source).digest("hex"), mime_type: "application/json" },
        ...pack.assets.map((asset) => ({ local_file: resolve(assetDirectory, asset.key), cos_key: physical(asset.key), sha256: asset.sha256, mime_type: asset.mime_type }))],
      environment: {
        LIFE_ENGINE_PACK_KEY: key,
        LIFE_ENGINE_PACK_SHA256: createHash("sha256").update(source).digest("hex"),
        LIFE_ENGINE_CONFIG_JSON: JSON.stringify({ instance: config.instance }),
      },
      inbox_trigger_prefix: physical("inbox/"),
      instructions: ["Save the previous host environment before activation.", "Upload and verify resources before changing the host binding; never overwrite an existing version key with different bytes.", "Ingress and processor must use the same instance binding and matching inbox trigger.", "Rollback restores the previous pack key, digest and host configuration; it does not restore or erase runtime state."],
    };
    await writeFile(resolve(output), JSON.stringify(plan, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
    return { prepared: resolve(output), id: pack.id, version: pack.version, uploaded: false, activated: false };
  }
  const [command, input, output, extra] = args;
  if (!input || extra || !["validate", "export", "export-default"].includes(command)
    || (command === "export" && !output) || (command === "export-default" && output)) {
    throw new Error("Usage: node scripts/character-pack.mjs validate PACK.json [ASSETS_DIRECTORY] | export PACK.json NEW_OUTPUT.json | export-default NEW_OUTPUT.json");
  }
  const pack = command === "export-default" ? defaultPack : parseCharacterPack(await readFile(resolve(input), "utf8"));
  if (command === "validate") {
    if (output) await checkLocalAssets(pack, output);
    return { valid: true, id: pack.id, version: pack.version, assets: pack.assets.length, resources_checked: Boolean(output) };
  }
  const destination = resolve(command === "export-default" ? input : output);
  await writeFile(destination, serializeCharacterPack(pack), { encoding: "utf8", flag: "wx" });
  return { exported: destination, id: pack.id, version: pack.version };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  run(process.argv.slice(2)).then((result) => console.log(JSON.stringify(result))).catch((error) => {
    console.error(error.message); process.exitCode = 1;
  });
}
