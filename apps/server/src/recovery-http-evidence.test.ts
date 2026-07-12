import { NodeServices } from "@effect/platform-node";
import { assert, layer } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { writeRecoveryHttpEvidence } from "./recovery-http-evidence.js";

layer(NodeServices.layer)((it) => {
  it.effect("retains a bounded typed non-2xx body after scoped server cleanup", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectory({ prefix: "gaia-server-scope-" });
      const evidence = yield* fs.makeTempDirectory({ prefix: "gaia-recovery-evidence-" });
      const target = yield* writeRecoveryHttpEvidence({
        body: {
          code: "WorkerRecoveryModelUnavailable",
          message: "The explicitly selected Codex model is unavailable.",
          recoverable: false,
          status: 422,
        },
        diagnostic: {
          actionId: "recover-1",
          code: "WorkerRecoveryModelUnavailable",
          runId: "run-1234567890",
          stage: "modelSelection",
          status: 422,
          timestamp: "2026-07-12T08:00:00.000Z",
        },
        evidenceDirectory: evidence,
      });
      yield* fs.remove(root, { recursive: true });
      const persisted = yield* fs.readFileString(target);
      assert.include(persisted, "WorkerRecoveryModelUnavailable");
      assert.include(persisted, "modelSelection");
      assert.notInclude(persisted, "nativeThreadId");
      assert.isBelow(Buffer.byteLength(persisted), 16_384);
    }),
  );
});
