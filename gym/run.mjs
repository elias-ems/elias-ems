import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { deviceLimit, simulateCharge } from "../addon/app/lib/charge-plan.ts";
import { replay, validateSettings } from "./algorithms/evening.mjs";
import { algorithms } from "./algorithms/index.mjs";

const [
  input = "addon/app/lib/benchmark-data/input.json",
  output = "gym/results/latest",
  selectedAlgorithm,
  settingsFile = "addon/app/lib/benchmark-data/experiment.json",
] = process.argv.slice(2);
if (!input)
  throw new Error("Usage: node gym/run.mjs <dataset.json> [output-directory]");
const raw = await readFile(input, "utf8");
const data = JSON.parse(raw);
if (
  data.schemaVersion !== 1 ||
  !["synthetic", "measured-hindsight", "forecast-snapshot"].includes(data.kind)
)
  throw new Error("Unsupported dataset schema/kind");
if (
  !Number.isFinite(data.terminalReserveKwh) ||
  !Array.isArray(data.assumptions)
)
  throw new Error("Dataset must declare reserve and assumptions");
const settings = JSON.parse(await readFile(settingsFile, "utf8"));
validateSettings(data, settings);
const algorithm = selectedAlgorithm ?? settings.algorithm ?? "cost-optimized";
const implementation = algorithms[algorithm];
if (!implementation) throw new Error(`Unknown algorithm: ${algorithm}`);
const started = performance.now();
const plan = await implementation.run(data, settings);
const elapsedMs = performance.now() - started;
if (
  plan.points.length !== data.slots.length ||
  plan.points.some(
    (p) =>
      !Number.isFinite(p.limitW) ||
      p.limitW < data.model.minW ||
      p.limitW > data.model.maxW ||
      Math.abs(deviceLimit(p.limitW, data.model) - p.limitW) > 1e-6,
  )
)
  throw new Error("Candidate returned an invalid charge schedule");
// Re-score with the shared simulator; never treat a candidate's claimed cost as truth.
const score = (limits) => {
  let energy = (data.model.capacityKwh * data.model.soc) / 100;
  let cost = 0;
  let switches = 0;
  for (const [i, slot] of data.slots.entries()) {
    const step = simulateCharge(slot, energy, limits[i], data.model);
    energy = step.energy;
    cost += step.cost;
    if (i && limits[i] !== limits[i - 1]) switches++;
  }
  const reserve = Math.min(
    (data.model.capacityKwh * (data.model.maxSoc - data.model.minSoc)) / 100,
    data.terminalReserveKwh,
  );
  const shortfall = Math.max(
    0,
    (data.model.capacityKwh * data.model.minSoc) / 100 + reserve - energy,
  );
  const terminalPenalty =
    shortfall *
    Math.max(0, ...data.slots.map((s) => s.buy)) *
    data.model.efficiency;
  return {
    energyCost: cost,
    terminalPenalty,
    objective: cost + terminalPenalty,
    endSoc: (energy / data.model.capacityKwh) * 100,
    switches,
  };
};
const optimized = score(plan.points.map((p) => p.limitW));
const unrestricted = score(
  plan.points.map(() => deviceLimit(data.model.maxW, data.model)),
);
const source = await readFile(implementation.source);
const report = {
  algorithm,
  settings,
  scenarios: [0, settings.solarHaircut].map((haircut) => {
    const { points, ...metrics } = replay(
      data,
      plan.points.map((p) => p.limitW),
      settings,
      haircut,
    );
    return {
      solarHaircut: haircut,
      ...metrics,
      targetShortfallKwh: Math.max(
        0,
        (data.model.capacityKwh * settings.targetSoc) / 100 -
          metrics.deadlineEnergy,
      ),
    };
  }),
  datasetId: data.id,
  kind: data.kind,
  generatedAt: new Date().toISOString(),
  datasetSha256: createHash("sha256").update(raw).digest("hex"),
  evaluatorSha256: createHash("sha256")
    .update(
      await readFile(
        new URL("../addon/app/lib/charge-plan.ts", import.meta.url),
      ),
    )
    .update(
      await readFile(
        new URL("../addon/app/lib/charge-evening.ts", import.meta.url),
      ),
    )
    .update(await readFile(new URL("./run.mjs", import.meta.url)))
    .digest("hex"),
  algorithmSha256: createHash("sha256").update(source).digest("hex"),
  gitCommit: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  elapsedMs,
  optimized,
  unrestricted,
  objectiveImprovement: unrestricted.objective - optimized.objective,
  assumptions: data.assumptions,
  plan,
};
await mkdir(output, { recursive: true });
await writeFile(
  path.join(output, "report.json"),
  JSON.stringify(report, null, 2),
);
const header =
  "start,end,ceilingW,chargingW,dischargingW,solarW,loadW,buy,sell,soc,unrestrictedSoc";
const csv = plan.points.map((p) =>
  [
    new Date(p.start).toISOString(),
    new Date(p.end).toISOString(),
    p.limitW,
    p.chargeW,
    p.dischargeW,
    p.solarW,
    p.loadW,
    p.buy,
    p.sell,
    p.soc,
    p.baselineSoc,
  ].join(","),
);
await writeFile(path.join(output, "schedule.csv"), [header, ...csv].join("\n"));
await writeFile(
  path.join(output, "curation.md"),
  `# ${data.id}\n\nKind: ${data.kind}\n\n${data.assumptions.map((a) => `- ${a}`).join("\n")}\n\n## Review\n\nVerdict: unreviewed\n\nExpected behavior:\n\nSurprising intervals:\n\nInput corrections:\n\nAcceptance criteria for future candidates:\n`,
  { flag: "wx" },
).catch((error) => {
  if (error.code !== "EEXIST") throw error;
});
console.log(
  JSON.stringify(
    {
      output,
      kind: data.kind,
      intervals: plan.points.length,
      optimized,
      unrestricted,
      objectiveImprovement: report.objectiveImprovement,
    },
    null,
    2,
  ),
);
