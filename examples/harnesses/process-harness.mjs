import { writeFileSync } from "node:fs";

const outputPath = process.env.GAIA_WORKSPACE_OUTPUT_PATH;
const runId = process.env.GAIA_RUN_ID;
const specTitle = process.env.GAIA_SPEC_TITLE;

if (
  outputPath === undefined ||
  runId === undefined ||
  specTitle === undefined
) {
  throw new Error("Missing Gaia process harness environment.");
}

writeFileSync(
  outputPath,
  `Gaia example process harness completed ${runId} for "${specTitle}".\n`
);

console.log(`Example process harness completed ${runId}.`);
