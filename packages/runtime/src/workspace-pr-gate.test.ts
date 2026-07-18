import { NodeServices } from "@effect/platform-node";
import { assert, describe, it, layer } from "@effect/vitest";
import { parseRunId } from "@gaia/core";
import { Effect, FileSystem } from "effect";

import { defaultHarnessName } from "./harness.js";
import { makeRunPaths } from "./paths.js";
import {
  evaluateWorkspacePrQualityGate,
  parseWorkspacePrQualityGateJson,
} from "./workspace-pr-gate.js";

describe("workspace PR quality gate path contracts", () => {
  layer(NodeServices.layer)((it) => {
    it.effect(
      "keeps path-specific gate failures when strict harness decoding rejects unsafe paths",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-workspace-pr-gate-",
          });
          const runId = parseRunId("run-WsPrGate01");
          const paths = yield* makeRunPaths(runId, { rootDirectory: cwd });
          yield* fs.makeDirectory(paths.root, { recursive: true });
          yield* fs.writeFileString(
            paths.workerResult,
            `${JSON.stringify(
              {
                changedWorkspacePaths: ["../src/leak.ts"],
                exitCode: 0,
                harnessName: defaultHarnessName,
                outputArtifacts: ["workspace/../secret.txt"],
                resultPath: "/tmp/worker-result.json",
                runId,
                status: "completed",
                summary: "Unsafe result.",
                workspaceDiff: {
                  notes: [],
                  omittedGeneratedFileCount: 0,
                  omittedGeneratedPathCount: 1,
                  omittedGeneratedPaths: [
                    {
                      changedFileCount: 1,
                      path: "../dist",
                      reason: "generated",
                    },
                  ],
                  productChangedPathCount: 1,
                  productChangedPaths: ["../src/leak.ts"],
                  version: 1,
                },
              },
              null,
              2
            )}\n`
          );

          const gate = yield* evaluateWorkspacePrQualityGate(runId, paths);
          const persisted = parseWorkspacePrQualityGateJson(
            JSON.parse(yield* fs.readFileString(paths.workspacePrGate))
          );

          assert.strictEqual(gate.status, "blocked");
          assert.strictEqual(persisted.status, "blocked");
          assert.deepEqual(
            itemChangedFiles(gate, "worker-result-schema"),
            undefined
          );
          assert.deepEqual(
            itemChangedFiles(gate, "changed-workspace-safe-paths"),
            ["../src/leak.ts"]
          );
          assert.deepEqual(itemChangedFiles(gate, "worker-result-safe-paths"), [
            "/tmp/worker-result.json",
          ]);
          assert.deepEqual(
            itemChangedFiles(gate, "output-artifact-safe-paths"),
            ["workspace/../secret.txt"]
          );
          assert.deepEqual(
            itemChangedFiles(gate, "workspace-diff-product-safe-paths"),
            ["../src/leak.ts"]
          );
          assert.deepEqual(
            itemChangedFiles(gate, "workspace-diff-generated-safe-paths"),
            ["../dist"]
          );
        })
    );

    it.effect(
      "keeps strict schema failures for non-path worker-result violations",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-workspace-pr-gate-",
          });
          const runId = parseRunId("run-WsPrGate03");
          const paths = yield* makeRunPaths(runId, { rootDirectory: cwd });
          yield* fs.makeDirectory(paths.root, { recursive: true });
          yield* fs.writeFileString(
            paths.workerResult,
            `${JSON.stringify(
              {
                changedWorkspacePaths: ["src/index.ts"],
                exitCode: "zero",
                harnessName: defaultHarnessName,
                outputArtifacts: ["workspace/output.txt"],
                resultPath: "worker-result.json",
                runId,
                status: "completed",
                summary: "Invalid non-path result.",
                workspaceDiff: {
                  notes: [],
                  omittedGeneratedFileCount: 0,
                  omittedGeneratedPathCount: 0,
                  omittedGeneratedPaths: [],
                  productChangedPathCount: 1,
                  productChangedPaths: ["src/index.ts"],
                  version: 1,
                },
              },
              null,
              2
            )}\n`
          );

          const gate = yield* evaluateWorkspacePrQualityGate(runId, paths);

          assert.strictEqual(gate.status, "blocked");
          assert.deepEqual(itemChangedFiles(gate, "worker-result-schema"), [
            "worker-result.json",
          ]);
        })
    );

    it.effect(
      "rejects workspace paths with empty, dot, or NUL segments after schema parsing",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-workspace-pr-gate-",
          });
          const runId = parseRunId("run-WsPrGate02");
          const paths = yield* makeRunPaths(runId, { rootDirectory: cwd });
          const strictPolicyRejectedPaths = [
            "src//a.ts",
            "src/./a.ts",
            "src/\0a.ts",
          ];
          yield* fs.makeDirectory(paths.root, { recursive: true });
          yield* fs.writeFileString(
            paths.workerResult,
            `${JSON.stringify(
              {
                changedWorkspacePaths: strictPolicyRejectedPaths,
                exitCode: 0,
                harnessName: defaultHarnessName,
                outputArtifacts: [],
                resultPath: "worker-result.json",
                runId,
                status: "completed",
                summary: "Strict path policy result.",
                workspaceDiff: {
                  notes: [],
                  omittedGeneratedFileCount: 0,
                  omittedGeneratedPathCount: 0,
                  omittedGeneratedPaths: [],
                  productChangedPathCount: strictPolicyRejectedPaths.length,
                  productChangedPaths: strictPolicyRejectedPaths,
                  version: 1,
                },
              },
              null,
              2
            )}\n`
          );

          const gate = yield* evaluateWorkspacePrQualityGate(runId, paths);

          assert.strictEqual(gate.status, "blocked");
          assert.deepEqual(
            sortedItemChangedFiles(gate, "workspace-diff-product-safe-paths"),
            strictPolicyRejectedPaths.toSorted()
          );
          assert.deepEqual(
            sortedItemChangedFiles(gate, "changed-workspace-safe-paths"),
            strictPolicyRejectedPaths.toSorted()
          );
        })
    );
  });
});

function itemChangedFiles(
  gate: Awaited<ReturnType<typeof parseWorkspacePrQualityGateJson>>,
  check: string
) {
  return gate.items.find((item) => item.check === check)?.changedFiles;
}

function sortedItemChangedFiles(
  gate: Awaited<ReturnType<typeof parseWorkspacePrQualityGateJson>>,
  check: string
) {
  return itemChangedFiles(gate, check)?.toSorted();
}

describe("workspace PR quality gate compatibility locks", () => {
  it("round-trips passed and blocked workspace PR gate JSON with exact keys, counts, item order, formatting, and newline", () => {
    const passedRaw = {
      artifactPath: "workspace-pr-gate.json",
      failItemCount: 0,
      items: [
        {
          changedFiles: ["src/index.ts"],
          check: "workspace-diff-reviewable",
          reason: "workspaceDiff reports 1 reviewable product changed file(s).",
          remediation: "No action required.",
          severity: "pass",
        },
      ],
      runId: "run-C5Gate0001",
      status: "passed",
      version: 1,
      warnItemCount: 0,
    };
    const blockedRaw = {
      artifactPath: "workspace-pr-gate.json",
      failItemCount: 1,
      items: [
        {
          changedFiles: ["../src/leak.ts"],
          check: "changed-workspace-safe-paths",
          reason:
            "changedWorkspacePaths contains paths that are not safe relative workspace paths.",
          remediation:
            "Emit changedWorkspacePaths relative to the workspace root without absolute paths or parent-directory segments.",
          severity: "fail",
        },
        {
          changedFiles: ["dist"],
          check: "generated-paths-summarized",
          reason:
            "workspaceDiff summarizes 1 generated file(s) under 1 generated path(s).",
          remediation:
            "Inspect the local .gaia workspace artifacts if needed; publish only if the source changes explain the generated output.",
          severity: "warn",
        },
      ],
      runId: "run-C5Gate0002",
      status: "blocked",
      version: 1,
      warnItemCount: 1,
    };

    const passed = parseWorkspacePrQualityGateJson(passedRaw);
    const blocked = parseWorkspacePrQualityGateJson(blockedRaw);

    assert.deepEqual(JSON.parse(JSON.stringify(passed)), passedRaw);
    assert.deepEqual(JSON.parse(JSON.stringify(blocked)), blockedRaw);
    assert.strictEqual(
      `${JSON.stringify(passed, null, 2)}\n`,
      `${JSON.stringify(passedRaw, null, 2)}\n`
    );
    assert.strictEqual(
      `${JSON.stringify(blocked, null, 2)}\n`,
      `${JSON.stringify(blockedRaw, null, 2)}\n`
    );
    assert.deepEqual(
      blocked.items.map((item) => item.check),
      ["changed-workspace-safe-paths", "generated-paths-summarized"]
    );
  });

  layer(NodeServices.layer)((it) => {
    it.effect(
      "preserves worker-result failure precedence from missing/size/JSON through raw-path/schema/workspaceDiff",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-workspace-pr-gate-compatibility-",
          });
          const runId = parseRunId("run-C5Gate0003");
          const paths = yield* makeRunPaths(runId, { rootDirectory: cwd });
          yield* fs.makeDirectory(paths.root, { recursive: true });

          const missing = yield* evaluateWorkspacePrQualityGate(runId, paths);
          assert.deepEqual(
            missing.items.map((item) => item.check),
            ["worker-result-present"]
          );

          yield* fs.writeFileString(
            paths.workerResult,
            "{".padEnd(70_000, "x")
          );
          const oversizedInvalidJson = yield* evaluateWorkspacePrQualityGate(
            runId,
            paths
          );
          assert.deepEqual(
            oversizedInvalidJson.items.map((item) => item.check),
            ["worker-result-reviewable-size", "worker-result-json"]
          );

          yield* fs.writeFileString(paths.workerResult, "{");
          const invalidJson = yield* evaluateWorkspacePrQualityGate(
            runId,
            paths
          );
          assert.deepEqual(
            invalidJson.items.map((item) => item.check),
            ["worker-result-json"]
          );

          yield* fs.writeFileString(
            paths.workerResult,
            `${JSON.stringify({
              changedWorkspacePaths: ["../src/leak.ts"],
              exitCode: "zero",
              harnessName: defaultHarnessName,
              outputArtifacts: ["workspace/../secret.txt"],
              resultPath: "/tmp/worker-result.json",
              runId,
              status: "completed",
              summary: "Unsafe path result.",
              workspaceDiff: {
                notes: [],
                omittedGeneratedFileCount: 1,
                omittedGeneratedPathCount: 1,
                omittedGeneratedPaths: [
                  {
                    changedFileCount: 1,
                    path: "../dist",
                    reason: "generated",
                  },
                ],
                productChangedPathCount: 1,
                productChangedPaths: ["../src/leak.ts"],
                version: 1,
              },
            })}\n`
          );
          const rawPathInvalid = yield* evaluateWorkspacePrQualityGate(
            runId,
            paths
          );
          assert.deepEqual(
            rawPathInvalid.items.map((item) => item.check),
            [
              "workspace-diff-product-safe-paths",
              "workspace-diff-generated-safe-paths",
              "changed-workspace-safe-paths",
              "worker-result-safe-paths",
              "output-artifact-safe-paths",
            ]
          );

          yield* fs.writeFileString(
            paths.workerResult,
            `${JSON.stringify({
              changedWorkspacePaths: ["src/index.ts"],
              exitCode: "zero",
              harnessName: defaultHarnessName,
              outputArtifacts: ["workspace/output.txt"],
              resultPath: "worker-result.json",
              runId,
              status: "completed",
              summary: "Invalid schema result.",
              workspaceDiff: {
                notes: [],
                omittedGeneratedFileCount: 0,
                omittedGeneratedPathCount: 0,
                omittedGeneratedPaths: [],
                productChangedPathCount: 1,
                productChangedPaths: ["src/index.ts"],
                version: 1,
              },
            })}\n`
          );
          const invalidSchema = yield* evaluateWorkspacePrQualityGate(
            runId,
            paths
          );
          assert.deepEqual(
            invalidSchema.items.map((item) => item.check),
            ["worker-result-schema"]
          );

          yield* fs.writeFileString(
            paths.workerResult,
            `${JSON.stringify({
              changedWorkspacePaths: ["src/index.ts"],
              exitCode: 0,
              harnessName: defaultHarnessName,
              outputArtifacts: ["workspace/output.txt"],
              resultPath: "worker-result.json",
              runId,
              status: "completed",
              summary: "Missing workspace diff result.",
            })}\n`
          );
          const missingWorkspaceDiff = yield* evaluateWorkspacePrQualityGate(
            runId,
            paths
          );
          assert.deepEqual(
            missingWorkspaceDiff.items.map((item) => item.check),
            ["workspace-diff-present"]
          );
        })
    );

    it.effect(
      "rejects parent, absolute, empty, dot, and NUL paths without collapsing them into worker-result-schema",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-workspace-pr-gate-compatibility-",
          });
          const runId = parseRunId("run-C5Gate0004");
          const paths = yield* makeRunPaths(runId, { rootDirectory: cwd });
          const unsafePaths = [
            "../src/parent.ts",
            "/absolute/source.ts",
            "src//empty.ts",
            "src/./dot.ts",
            "src/\0nul.ts",
          ];
          yield* fs.makeDirectory(paths.root, { recursive: true });
          yield* fs.writeFileString(
            paths.workerResult,
            `${JSON.stringify({
              changedWorkspacePaths: unsafePaths,
              exitCode: 0,
              harnessName: defaultHarnessName,
              outputArtifacts: ["workspace/../secret.txt"],
              resultPath: "/tmp/worker-result.json",
              runId,
              status: "completed",
              summary: "Strict path compatibility result.",
              workspaceDiff: {
                notes: [],
                omittedGeneratedFileCount: 1,
                omittedGeneratedPathCount: 1,
                omittedGeneratedPaths: [
                  {
                    changedFileCount: 1,
                    path: "../dist",
                    reason: "generated",
                  },
                ],
                productChangedPathCount: unsafePaths.length,
                productChangedPaths: unsafePaths,
                version: 1,
              },
            })}\n`
          );

          const gate = yield* evaluateWorkspacePrQualityGate(runId, paths);

          assert.strictEqual(gate.status, "blocked");
          assert.strictEqual(
            itemChangedFiles(gate, "worker-result-schema"),
            undefined
          );
          assert.deepEqual(
            itemChangedFiles(gate, "workspace-diff-product-safe-paths"),
            unsafePaths.toSorted()
          );
          assert.deepEqual(
            itemChangedFiles(gate, "changed-workspace-safe-paths"),
            unsafePaths.toSorted()
          );
          assert.deepEqual(
            itemChangedFiles(gate, "workspace-diff-generated-safe-paths"),
            ["../dist"]
          );
          assert.deepEqual(itemChangedFiles(gate, "worker-result-safe-paths"), [
            "/tmp/worker-result.json",
          ]);
          assert.deepEqual(
            itemChangedFiles(gate, "output-artifact-safe-paths"),
            ["workspace/../secret.txt"]
          );
        })
    );
  });

  it("rejects malformed gate runId/version/status/severity while accepting exact version-1 public encodings", () => {
    const raw = {
      artifactPath: "workspace-pr-gate.json",
      failItemCount: 0,
      items: [
        {
          changedFiles: ["src/index.ts"],
          check: "workspace-diff-reviewable",
          reason: "workspaceDiff reports 1 reviewable product changed file(s).",
          remediation: "No action required.",
          severity: "pass",
        },
      ],
      runId: "run-C5Gate0005",
      status: "passed",
      version: 1,
      warnItemCount: 0,
    };

    const parsed = parseWorkspacePrQualityGateJson(raw);
    assert.deepEqual(JSON.parse(JSON.stringify(parsed)), raw);
    assert.throws(() =>
      parseWorkspacePrQualityGateJson({ ...raw, runId: "not-a-run" })
    );
    assert.throws(() =>
      parseWorkspacePrQualityGateJson({ ...raw, status: "pending" })
    );
    assert.throws(() =>
      parseWorkspacePrQualityGateJson({ ...raw, version: 2 })
    );
    assert.throws(() =>
      parseWorkspacePrQualityGateJson({
        ...raw,
        items: [{ ...raw.items[0], severity: "error" }],
      })
    );
  });
});
