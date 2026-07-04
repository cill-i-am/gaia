import { RunIdSchema } from "@gaia/core";
import { Effect, FileSystem, Schema } from "effect";
import type { RunPaths } from "./paths.js";

export class WorkerResult extends Schema.Class<WorkerResult>("WorkerResult")({
  outputPath: Schema.NonEmptyString,
  runId: RunIdSchema,
  status: Schema.Literal("completed"),
}) {}

const WorkerResultJson = Schema.toCodecJson(WorkerResult);
const encodeWorkerResult = Schema.encodeSync(WorkerResultJson);

export function runFakeWorker(runId: typeof RunIdSchema.Type, paths: RunPaths) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const output = `Gaia fake worker completed ${runId}.\n`;
    const result = WorkerResult.make({
      outputPath: "workspace/output.txt",
      runId,
      status: "completed",
    });

    yield* fs.writeFileString(paths.workerLog, "Fake worker started.\n", {
      flag: "a",
    });
    yield* fs.writeFileString(paths.workspaceOutput, output);
    yield* fs.writeFileString(
      paths.workerResult,
      `${JSON.stringify(encodeWorkerResult(result), null, 2)}\n`,
    );
    yield* fs.writeFileString(paths.workerLog, "Fake worker completed.\n", {
      flag: "a",
    });

    return result;
  });
}
