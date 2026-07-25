import { Schema } from "effect";

export const FailureStageSchema = Schema.Literals([
  "creating",
  "preparingWorkspace",
  "reviewing",
  "runningWorker",
  "verifying",
  "reporting",
  "replaying",
] as const);

/** Lifecycle stage where a typed failure occurred. */
export type FailureStage = typeof FailureStageSchema.Type;
