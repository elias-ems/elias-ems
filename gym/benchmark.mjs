import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { algorithms } from "./algorithms/index.mjs";
import { benchmarkHtml } from "./report.mjs";

const [
  input = "addon/app/lib/benchmark-data/input.json",
  output = "gym/results/benchmark",
  settingsFile,
] = process.argv.slice(2);
await mkdir(output, { recursive: true });
const reports = [];
const rawInput = JSON.parse(await readFile(input, "utf8"));
const config = settingsFile
  ? JSON.parse(await readFile(settingsFile, "utf8"))
  : rawInput.settings ??
    JSON.parse(
      await readFile("addon/app/lib/benchmark-data/experiment.json", "utf8"),
    );
const selected = config.algorithms ?? Object.keys(algorithms);
if (
  !Array.isArray(selected) ||
  !selected.length ||
  selected.some((name) => !Object.hasOwn(algorithms, name)) ||
  new Set(selected).size !== selected.length
)
  throw new Error("Choose unique known algorithms in experiment.algorithms");
for (const name of selected) {
  const directory = path.join(output, name);
  const runArgs = ["gym/run.mjs", input, directory, name];
  if (settingsFile) {
    runArgs.push(settingsFile);
  }
  execFileSync(process.execPath, runArgs);
  reports.push(
    JSON.parse(await readFile(path.join(directory, "report.json"), "utf8")),
  );
}
await writeFile(
  path.join(output, "comparison.json"),
  JSON.stringify(
    reports.map(({ plan, ...r }) => r),
    null,
    2,
  ),
);
const rows = reports.flatMap((r) =>
  r.scenarios.map(
    (s) =>
      `| ${r.algorithm} | ${s.solarHaircut * 100}% | ${s.energyCost.toFixed(4)} | ${s.deadlineSoc.toFixed(2)} | ${s.targetShortfallKwh.toFixed(4)} | ${s.endSoc.toFixed(2)} | ${s.switches} | ${r.elapsedMs.toFixed(1)} |`,
  ),
);
const markdown = `# Fixed dataset benchmark

Deadline: ${reports[0].settings.deadline}. Target: ${reports[0].settings.targetSoc}% SoC.

| Algorithm | Solar reduction | Energy cost EUR | Deadline SoC % | Target shortfall kWh | End SoC % | Changes | Runtime ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
${rows.join("\n")}

Measured-hindsight input. Reduced solar is a stress scenario, not a calibrated probability.
Runtime is one run, not a statistically stable performance measurement.
`;
await writeFile(path.join(output, "comparison.md"), markdown);
console.log(markdown);

await writeFile(
  path.join(output, "index.html"),
  benchmarkHtml(reports, JSON.parse(await readFile(input, "utf8"))),
);
