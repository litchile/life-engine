import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import harborPack from "./fixtures/harbor-pack.json" with { type: "json" };
import { run } from "../scripts/character-pack.mjs";
const directories = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "agent-pack-test-")); directories.push(directory);
  const input = join(directory, "pack.json"), binding = join(directory, "instance.json");
  await writeFile(input, JSON.stringify(harborPack));
  await writeFile(binding, JSON.stringify({ user_id: "test-owner", character_id: "harbor-fox", storage_prefix: "instances/test" }));
  return { directory, input, binding };
}
describe("local pack export and activation preparation", () => {
  it("exports an exact complete pack and refuses to overwrite existing files", async () => {
    const { directory, input } = await fixture(), output = join(directory, "export.json");
    await run(["export", input, output]);
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual(harborPack);
    await expect(run(["export", input, output])).rejects.toThrow(/EEXIST/);
    expect(await run(["validate", output])).toMatchObject({ valid: true, resources_checked: false });
  });
  it("prepares scoped upload keys, a pinned digest and matching trigger without uploading", async () => {
    const { directory, input, binding } = await fixture(), output = join(directory, "activation.json");
    expect(await run(["prepare", input, binding, output])).toMatchObject({ uploaded: false, activated: false });
    const plan = JSON.parse(await readFile(output, "utf8"));
    expect(plan.uploads[0].cos_key).toBe("instances/test/packs/harbor-fox/1.0.0.json");
    expect(plan.inbox_trigger_prefix).toBe("instances/test/inbox/");
    expect(plan.environment.LIFE_ENGINE_PACK_SHA256).toBe(createHash("sha256").update(await readFile(input)).digest("hex"));
    expect(JSON.parse(plan.environment.LIFE_ENGINE_CONFIG_JSON).instance.storage_prefix).toBe("instances/test");
  });
  it("rejects resources pointing at running state and requires a local resource audit", async () => {
    const { directory, input, binding } = await fixture(), output = join(directory, "activation.json");
    const pack = structuredClone(harborPack);
    pack.assets = [{ id: "portrait", role: "identity", key: "state/agent.json", mime_type: "image/png", sha256: "a".repeat(64) }];
    await writeFile(input, JSON.stringify(pack));
    await expect(run(["prepare", input, binding, output])).rejects.toThrow(/namespace/);
    pack.assets[0].key = "media/packs/harbor-fox/1.0.0/portrait.png";
    await writeFile(input, JSON.stringify(pack));
    await expect(run(["prepare", input, binding, output])).rejects.toThrow(/ASSETS_DIRECTORY/);
  });
});
