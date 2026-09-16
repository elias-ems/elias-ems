import { benchmarkAlgorithms } from "../../addon/app/lib/benchmark-algorithms.ts";

export const algorithms = Object.fromEntries(
  Object.entries(benchmarkAlgorithms).map(([id, algorithm]) => [id, {
    ...algorithm,
    source: new URL(`../../addon/app/lib/${algorithm.sourceFile}`, import.meta.url),
  }]),
);
