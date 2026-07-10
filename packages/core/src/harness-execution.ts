import { Schema } from "effect";
import {
  HarnessCapabilities,
  HarnessProviderDescriptor,
} from "./harness-session.js";

/** Fixed production harness profile supported by issue-delivery create calls. */
export const HarnessProfileIdSchema = Schema.Literal("codexAppServer").pipe(
  Schema.brand("HarnessProfileId"),
);

/** A parsed stable harness profile identifier. */
export type HarnessProfileId = typeof HarnessProfileIdSchema.Type;

/** Parse a public harness profile identifier at a boundary. */
export const parseHarnessProfileId = Schema.decodeUnknownSync(
  HarnessProfileIdSchema,
);

/** The only production issue-delivery harness profile in this slice. */
export const codexAppServerHarnessProfileId = parseHarnessProfileId(
  "codexAppServer",
);

/** Explicit profile selection accepted by the strict create-run contract. */
export class HarnessExecutionSelection extends Schema.Class<HarnessExecutionSelection>(
  "HarnessExecutionSelection",
)({
  harnessProfileId: HarnessProfileIdSchema,
}, {
  parseOptions: { onExcessProperty: "error" },
}) {}

/** Fixed selection used by current dashboard and CLI create callers. */
export const codexAppServerExecutionSelection = HarnessExecutionSelection.make({
  harnessProfileId: codexAppServerHarnessProfileId,
});

/** Immutable safe execution assignment persisted with an accepted run. */
export class ResolvedHarnessExecution extends Schema.Class<ResolvedHarnessExecution>(
  "ResolvedHarnessExecution",
)({
  capabilities: HarnessCapabilities,
  executionMode: Schema.Literal("local"),
  harnessProfileId: HarnessProfileIdSchema,
  provider: HarnessProviderDescriptor,
  version: Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(200))),
}, {
  parseOptions: { onExcessProperty: "error" },
}) {}
