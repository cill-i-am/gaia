import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { parse } from "yaml";

const repoRoot = resolve(import.meta.dirname, "../../..");
const workflowPath = resolve(repoRoot, ".github/workflows/ci.yml");

const WorkflowStepSchema = Schema.Struct({
  name: Schema.String,
  run: Schema.optionalKey(Schema.String),
  uses: Schema.optionalKey(Schema.String),
  with: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
});
const WorkflowStepsSchema = Schema.Array(WorkflowStepSchema);
const WorkflowJobSchema = Schema.Struct({
  name: Schema.String,
  "runs-on": Schema.String,
  steps: WorkflowStepsSchema,
});
const WorkflowSchema = Schema.Struct({
  env: Schema.Json,
  jobs: Schema.Record(Schema.String, WorkflowJobSchema),
  name: Schema.String,
  on: Schema.Json,
  permissions: Schema.Json,
});
const decodeWorkflow = Schema.decodeUnknownSync(WorkflowSchema);

describe("GitHub Actions PR CI contract", () => {
  it("defines the stable Gaia pull request CI check", () => {
    const workflow = decodeWorkflow(parse(readFileSync(workflowPath, "utf8")));
    const job = workflow.jobs["gaia-pr-ci"];

    assert.isDefined(job, "Expected gaia-pr-ci job");
    assert.strictEqual(workflow.name, "Gaia PR CI");
    assert.deepEqual(workflow.on, {
      pull_request: {
        types: ["opened", "synchronize", "reopened"],
      },
    });
    assert.deepEqual(workflow.permissions, { contents: "read" });
    assert.deepEqual(workflow.env, { TURBO_CONCURRENCY: "1" });
    assert.strictEqual(job.name, "gaia-pr-ci");
    assert.strictEqual(job["runs-on"], "ubuntu-latest");

    const steps = job.steps;
    assertStepUses(steps, "Checkout", "actions/checkout@v6");
    assertStepUses(steps, "Use Node.js 24", "actions/setup-node@v6");
    assert.deepEqual(findStep(steps, "Use Node.js 24").with, {
      "node-version": "24",
    });
    assertStepRun(steps, "Activate pnpm 11.7.0", [
      "corepack enable",
      "corepack prepare pnpm@11.7.0 --activate",
    ]);
    assertStepRun(steps, "Install dependencies", [
      "pnpm install --frozen-lockfile",
    ]);
    assertStepRun(steps, "Check", ["pnpm check"]);
    assertStepRun(steps, "Test", ["pnpm test"]);
    assertStepRun(steps, "Build", ["pnpm build"]);
  });
});

function assertStepUses(
  steps: typeof WorkflowStepsSchema.Type,
  name: string,
  uses: string
): void {
  const step = findStep(steps, name);
  assert.strictEqual(step.uses, uses);
}

function assertStepRun(
  steps: typeof WorkflowStepsSchema.Type,
  name: string,
  commands: readonly string[]
): void {
  const step = findStep(steps, name);
  const run = step.run ?? "";

  for (const command of commands) {
    assert.include(run, command);
  }
}

function findStep(
  steps: typeof WorkflowStepsSchema.Type,
  name: string
): typeof WorkflowStepSchema.Type {
  const step = steps.find((candidate) => candidate.name === name);

  assert.isDefined(step, `Expected workflow step: ${name}`);

  return step;
}
