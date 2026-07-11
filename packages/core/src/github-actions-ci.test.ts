import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { parse } from "yaml";

const repoRoot = resolve(import.meta.dirname, "../../..");
const workflowPath = resolve(repoRoot, ".github/workflows/ci.yml");

describe("GitHub Actions PR CI contract", () => {
  it("defines the stable Gaia pull request CI check", () => {
    // SAFETY: This test immediately asserts every workflow field it consumes
    // from the checked-in static YAML contract.
    const workflow = parse(readFileSync(workflowPath, "utf8")) as Workflow;
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
    assert.deepEqual(findStep(steps, "Use Node.js 24").with, { "node-version": "24" });
    assertStepRun(steps, "Activate pnpm 11.7.0", [
      "corepack enable",
      "corepack prepare pnpm@11.7.0 --activate",
    ]);
    assertStepRun(steps, "Install dependencies", ["pnpm install --frozen-lockfile"]);
    assertStepRun(steps, "Check", ["pnpm check"]);
    assertStepRun(steps, "Test", ["pnpm test"]);
    assertStepRun(steps, "Build", ["pnpm build"]);
  });
});

type Workflow = {
  readonly name: string;
  readonly on: unknown;
  readonly permissions: unknown;
  readonly env: unknown;
  readonly jobs: Record<string, WorkflowJob>;
};

type WorkflowJob = {
  readonly name: string;
  readonly "runs-on": string;
  readonly steps: readonly WorkflowStep[];
};

type WorkflowStep = {
  readonly name: string;
  readonly uses?: string;
  readonly run?: string;
  readonly with?: Record<string, unknown>;
};

function assertStepUses(
  steps: readonly WorkflowStep[],
  name: string,
  uses: string,
): void {
  const step = findStep(steps, name);
  assert.strictEqual(step.uses, uses);
}

function assertStepRun(
  steps: readonly WorkflowStep[],
  name: string,
  commands: readonly string[],
): void {
  const step = findStep(steps, name);
  const run = step.run ?? "";

  for (const command of commands) {
    assert.include(run, command);
  }
}

function findStep(steps: readonly WorkflowStep[], name: string): WorkflowStep {
  const step = steps.find((candidate) => candidate.name === name);

  assert.isDefined(step, `Expected workflow step: ${name}`);

  return step;
}
