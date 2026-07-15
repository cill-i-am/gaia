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
