import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

async function collect(directory, files = []) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") await collect(path, files);
    } else if (/\.(js|mjs)$/.test(entry.name)) files.push(path);
  }
  return files;
}

const files = [
  ...await collect(join(root, "scf-runtime")),
  join(root, "scripts/character-pack.mjs"),
  join(root, "scripts/check-runtime.mjs"),
];

let failed = 0;
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) {
    failed += 1;
    process.stderr.write(result.stderr || result.stdout || `check failed: ${file}\n`);
  }
}
if (failed) {
  process.stderr.write(`syntax check failed for ${failed} file(s)\n`);
  process.exit(1);
}
process.stdout.write(`checked ${files.length} files\n`);
