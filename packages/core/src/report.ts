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

const RunReportFields = {
  artifacts: Schema.Array(RunReportArtifactPathSchema),
  reportPath: RunReportArtifactPathSchema,
  runId: RunIdSchema,
  selectedSkills: Schema.Array(Schema.NonEmptyString),
  status: ReportStatusSchema,
  summary: Schema.NonEmptyString,
};

const MakeRunReportInputSchema = Schema.Struct({
  ...RunReportFields,
  reportPath: Schema.toEncoded(RunReportArtifactPathSchema),
});

/** Machine-readable Gaia run report. */
export class RunReport extends Schema.Class<RunReport>("RunReport")(
  RunReportFields
) {
  /** Decode raw report fields into a schema-owned report value. */
  static override make(
    input: Schema.Schema.Type<typeof MakeRunReportInputSchema>,
    options?: Schema.MakeOptions
  ): RunReport {
    if (options?.disableChecks === true) {
      return new RunReport(
        {
          ...input,
          reportPath: RunReportArtifactPathSchema.make(
            input.reportPath,
            options
          ),
        },
        options
      );
    }
    return parseRunReport(input, options?.parseOptions);
  }
}

export const parseRunReport = Schema.decodeUnknownSync(RunReport);
