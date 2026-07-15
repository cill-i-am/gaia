import { assert, describe, it } from "@effect/vitest";
import { parseRunId, type WorkspaceRelativePath } from "@gaia/core";
import { Schema } from "effect";

import {
  defaultHarnessName,
  HarnessRunRequest,
  HarnessRunResult,
} from "./harness.js";
import type { RunRelativeArtifactPath, RuntimePath } from "./paths.js";

const decodeHarnessRunRequest = Schema.decodeUnknownSync(HarnessRunRequest);
const decodeHarnessRunResult = Schema.decodeUnknownSync(HarnessRunResult);

describe("harness path contracts", () => {
  it("decodes runtime filesystem paths in harness requests", () => {
    const runId = parseRunId("run-Harness001");

    const request = decodeHarnessRunRequest({
      codexHarnessProgressPath: "/tmp/run/codex-harness-progress.json",
      harnessName: defaultHarnessName,
      resolvedSkillPaths: ["/tmp/run/skill-sources/effect-ts"],
      runId,
      skillBundlePath: "/tmp/run/skill-bundle.json",
      specBody: "Do the work.",
      specTitle: "Harness path contract",
      workerLogPath: "/tmp/run/worker.log",
      workerResultPath: "/tmp/run/worker-result.json",
      workspaceOutputPath: "/tmp/run/workspace/output.txt",
      workspacePath: "/tmp/run/workspace",
    });

    expectRuntimePath(request.workerResultPath);
    expectRuntimePath(first(request.resolvedSkillPaths));
    assert.strictEqual(request.workerResultPath, "/tmp/run/worker-result.json");
    assert.throws(() =>
      decodeHarnessRunRequest({
        ...request,
        workerResultPath: "",
      })
    );
  });

  it("rejects unsafe workspace and run-relative paths in harness results", () => {
    const runId = parseRunId("run-Harness001");
    const result = {
      changedWorkspacePaths: ["src/index.ts"],
      exitCode: 0,
      harnessName: defaultHarnessName,
      outputArtifacts: ["workspace/output.txt"],
      resultPath: "worker-result.json",
      runId,
      status: "completed",
      summary: "Harness completed.",
    };
    const decodedResult = decodeHarnessRunResult(result);

    expectWorkspaceRelativePath(first(decodedResult.changedWorkspacePaths));
    expectRunRelativeArtifactPath(first(decodedResult.outputArtifacts));
    expectRunRelativeArtifactPath(decodedResult.resultPath);
    assert.strictEqual(
      first(decodedResult.changedWorkspacePaths),
      "src/index.ts"
    );
    assert.throws(() =>
      decodeHarnessRunResult({
        ...result,
        changedWorkspacePaths: ["../src/leak.ts"],
      })
    );
    assert.throws(() =>
      decodeHarnessRunResult({
        ...result,
        outputArtifacts: ["workspace/../secret.txt"],
      })
    );
    assert.throws(() =>
      decodeHarnessRunResult({
        ...result,
        resultPath: "/tmp/worker-result.json",
      })
    );
  });
});

function first<T>(values: ReadonlyArray<T>) {
  const [value] = values;
  if (value === undefined) {
    assert.fail("Expected at least one path.");
  }

  return value;
}

function expectRuntimePath(_path: RuntimePath) {
  return undefined;
}

function expectRunRelativeArtifactPath(_path: RunRelativeArtifactPath) {
  return undefined;
}

function expectWorkspaceRelativePath(_path: WorkspaceRelativePath) {
  return undefined;
}
