import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { auditPhase1Observation } from "./lib/phase1-observation-audit.mjs";

function argumentsFor(argv) {
  const result = { hours: 72, input: "", output: "" };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--input") result.input = argv[++index] || "";
    else if (argv[index] === "--output") result.output = argv[++index] || "";
    else if (argv[index] === "--hours") result.hours = Number(argv[++index] || 72);
  }
  return result;
}

async function jsonFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) files.push(...await jsonFiles(root, absolute));
    else if (entry.isFile() && entry.name.endsWith(".json")) files.push(absolute);
  }
  return files;
}

async function loadExport(root) {
  const snapshot = { events: [], outboxes: [] };
  for (const file of await jsonFiles(root)) {
    const relative = path.relative(root, file).replaceAll("\\", "/");
    const value = JSON.parse(await readFile(file, "utf8"));
    if (relative.startsWith("events/")) snapshot.events.push(value);
    else if (relative.startsWith("outbox/notifications/")) snapshot.outboxes.push(value);
    else if (relative === "state/world-canon.json") snapshot.canon = value;
    else if (relative === "state/frontiers.json") snapshot.frontiers = value;
    else if (relative === "state/autonomy.json") snapshot.autonomy = value;
    else if (relative === "state/autonomy-health.json") snapshot.health = value;
    else if (relative === "state/autonomy-outbox-health.json") snapshot.outboxHealth = value;
    else if (relative === "state/world-tick.json") snapshot.worldTick = value;
    else if (relative === "state/life-context.json") snapshot.lifeContext = value;
  }
  return snapshot;
}

const args = argumentsFor(process.argv.slice(2));
if (!args.input) {
  console.error("Usage: npm run audit:phase1-observation -- --input <COS export directory> [--hours 72] [--output report.json]");
  process.exitCode = 1;
} else {
  const snapshot = await loadExport(path.resolve(args.input));
  const report = auditPhase1Observation(snapshot, { hours: args.hours });
  const rendered = `${JSON.stringify(report, null, 2)}\n`;
  if (args.output) await writeFile(path.resolve(args.output), rendered, "utf8");
  process.stdout.write(rendered);
  process.exitCode = report.overall === "pass" ? 0 : (report.overall === "insufficient" ? 2 : 1);
}
