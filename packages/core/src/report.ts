import * as Schema from "effect/Schema";

import { RunIdSchema } from "./run-id.js";

export const ReportStatusSchema = Schema.Literals([
  "completed",
  "failed",
] as const);

export const RunReportArtifactPathSchema = Schema.NonEmptyString.pipe(
  Schema.brand("RunReportArtifactPath")
);

export type RunReportArtifactPath = typeof RunReportArtifactPathSchema.Type;

export const parseRunReportArtifactPath = Schema.decodeUnknownSync(
  RunReportArtifactPathSchema
);

/** Machine-readable Gaia run report. */
export class RunReport extends Schema.Class<RunReport>("RunReport")({
  artifacts: Schema.Array(RunReportArtifactPathSchema),
  reportPath: Schema.NonEmptyString,
  runId: RunIdSchema,
  selectedSkills: Schema.Array(Schema.NonEmptyString),
  status: ReportStatusSchema,
  summary: Schema.NonEmptyString,
}) {}

export const parseRunReport = Schema.decodeUnknownSync(RunReport);
