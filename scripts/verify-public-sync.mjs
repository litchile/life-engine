import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
const root = process.cwd();
const hash = (text) => createHash("sha256").update(text).digest("hex");
const receipt = JSON.parse(await readFile(resolve(root, ".life-engine-sync.json"), "utf8"));
if (hash(JSON.stringify(receipt.files)) !== receipt.manifest_hash) throw new Error("Sync manifest hash mismatch");
if (!/^[a-f0-9]{40}$/.test(receipt.source_commit)) throw new Error("Missing source commit");
for (const [name, expected] of Object.entries(receipt.files)) {
  const path = resolve(root, name);
  if (relative(root, path).startsWith("..") || name.includes("\\") || name.split("/").includes(".git")) throw new Error("Unsafe manifest path");
  const content = (await readFile(path, "utf8")).replaceAll("\r\n", "\n");
  if (hash(content) !== expected) throw new Error(`Unsynchronized file: ${name}`);
}
console.log(`Verified ${Object.keys(receipt.files).length} generated files from ${receipt.source_commit}`);
