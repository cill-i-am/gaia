import { NodeServices } from "@effect/platform-node";
import { assert, describe, it, layer } from "@effect/vitest";
import { parseRunId } from "@gaia/core";
import { Effect, Schema } from "effect";

import {
  makeRunPaths,
  makeRunStorePaths,
  parseRunRelativeArtifactPath,
  parseRunStorageRootInput,
  parseRuntimePath,
  RunPathsSchema,
  RunStorePathsSchema,
  runRelative,
  type RunRelativeArtifactPath,
  type RuntimePath,
} from "./paths.js";

describe("runtime path contracts", () => {
  layer(NodeServices.layer)((it) => {
    it.effect(
      "derives run store and run artifact paths through schemas without changing layout",
      () =>
        Effect.gen(function* () {
          const runId = parseRunId("run-PathSch001");
          const rootDirectory = parseRunStorageRootInput("/tmp/gaia-root");

          const store = yield* makeRunStorePaths({ rootDirectory });
          const paths = yield* makeRunPaths(runId, { rootDirectory });
          const decodedStore =
            Schema.decodeUnknownSync(RunStorePathsSchema)(store);
          const decodedPaths = Schema.decodeUnknownSync(RunPathsSchema)(paths);
          expectRuntimePath(decodedStore.gaiaRoot);
          expectRuntimePath(decodedPaths.events);

          assert.deepEqual(decodedStore, {
            gaiaRoot: "/tmp/gaia-root/.gaia",
            latest: "/tmp/gaia-root/.gaia/latest",
            lock: "/tmp/gaia-root/.gaia/lock",
            runsRoot: "/tmp/gaia-root/.gaia/runs",
          });
          assert.deepEqual(decodedPaths, paths);
          assert.strictEqual(
            paths.events,
            "/tmp/gaia-root/.gaia/runs/run-PathSch001/events.jsonl"
          );
          assert.strictEqual(
            paths.harnessWorkspaceBaseline,
            "/tmp/gaia-root/.gaia/runs/run-PathSch001/.harness-workspace-baseline.json"
          );
          assert.strictEqual(
            paths.workspaceOutput,
            "/tmp/gaia-root/.gaia/runs/run-PathSch001/workspace/output.txt"
          );
          assert.strictEqual(
            paths.evidencePromotionJson,
            "/tmp/gaia-root/.gaia/promoted/run-PathSch001/evidence-promotion.json"
          );
          assert.strictEqual(
            runRelative(paths, paths.workspaceOutput),
            "workspace/output.txt"
          );
          const outsideRuntimePath = parseRuntimePath("/tmp/outside.txt");
          expectRuntimePath(outsideRuntimePath);
          assert.strictEqual(
            runRelative(paths, outsideRuntimePath),
            outsideRuntimePath
          );
        })
    );

    it("parses storage root inputs without treating absolute paths as a separate public category", () => {
      assert.strictEqual(parseRunStorageRootInput("."), ".");
      assert.strictEqual(
        parseRunStorageRootInput("/tmp/gaia-root"),
        "/tmp/gaia-root"
      );
      assert.throws(() => parseRunStorageRootInput(""));
    });

    it("parses run-relative artifact paths without allowing traversal or platform roots", () => {
      assert.strictEqual(
        parseRunRelativeArtifactPath("workspace/output.txt"),
        "workspace/output.txt"
      );
      expectRunRelativeArtifactPath(
        parseRunRelativeArtifactPath("workspace/output.txt")
      );
      assert.strictEqual(
        parseRunRelativeArtifactPath("github-checks/checks-1.json"),
        "github-checks/checks-1.json"
      );

      for (const invalid of [
        "",
        "/tmp/worker-result.json",
        "../worker-result.json",
        "workspace/../secret.txt",
        "workspace\\output.txt",
        "workspace//output.txt",
        "workspace/./output.txt",
      ]) {
        assert.throws(() => parseRunRelativeArtifactPath(invalid));
      }
    });
  });
});

function expectRuntimePath(_path: RuntimePath) {
  return undefined;
}

function expectRunRelativeArtifactPath(_path: RunRelativeArtifactPath) {
  return undefined;
}
