import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { auditGoalsObservation, observationDates } from "./lib/goals-observation-audit.mjs";

async function readJson(file, fallback) {
  try { return JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, "")); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw new Error(`Cannot read valid JSON: ${file}`); }
}

async function main() {
  const args = process.argv.slice(2);
  const input = args[args.indexOf("--input") + 1];
  const startDate = args[args.indexOf("--start-date") + 1];
  if (!args.includes("--input") || !args.includes("--start-date") || !input || !startDate) {
    throw new Error("Usage: node scripts/audit-goals-observation.mjs --input <COS export directory> --start-date YYYY-MM-DD");
  }
  const root = path.resolve(input);
  const snapshot = { events: [], lifePlan: await readJson(path.join(root, "state", "life-plan.json"), null) };
  // Read only explicitly scoped life data. Do not scan credentials, contacts or
  // arbitrary JSON elsewhere in a user's export directory.
  for (const date of observationDates(startDate)) {
    const directory = path.join(root, "events", date);
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    for (const entry of entries) {
      if (entry.isFile() && /^autonomy-[a-zA-Z0-9_-]+\.json$/.test(entry.name)) {
        snapshot.events.push(await readJson(path.join(directory, entry.name), {}));
      }
    }
  }
  const report = auditGoalsObservation(snapshot, { startDate });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.mechanical_status === "fail" ? 1 : 2;
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
