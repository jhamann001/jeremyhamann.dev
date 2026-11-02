// Writes the public demo's sample data (lib/demo/samples/data/*.json) from the shared synthetic universe: the showcase
// clients' written sections and everyone else's baseline (lib/demo/samples/build.ts). Run after changing the universe,
// showcase.ts or the seed's accounts; test/demo-samples.test.ts fails while the files are out of date.
//
//   npm run demo:samples

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildDemoSamples, buildWorkflowSample } from "../lib/demo/samples/build";
import { loadUniverse } from "../lib/demo/seed/universe";

const universe = loadUniverse();
const out = join(process.cwd(), "lib/demo/samples/data");
for (const [file, data] of [
  ["clients.json", buildDemoSamples(universe)],
  ["workflow.json", buildWorkflowSample(universe)],
] as const) {
  const path = join(out, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
  console.log(`wrote ${path}`);
}
