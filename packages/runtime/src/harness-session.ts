import {
  HarnessCapabilitySchema,
  HarnessActionIdSchema,
  HarnessInteractionIdSchema,
  HarnessProviderIdSchema,
  HarnessQuestionIdSchema,
  HarnessSessionIdSchema,
  WorkspaceRelativePathSchema,
  missingHarnessCapabilities,
  type HarnessCapability,
  type HarnessCapabilities,
  type HarnessDetection,
  type HarnessEvent,
  type HarnessProviderDescriptor,
  type HarnessSessionSnapshot,
} from "@gaia/core";
import { Effect, Option, Schema, type Scope, type Stream } from "effect";

const RuntimeMessageSchema = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isMaxLength(16_384))
);
const RuntimeVersionSchema = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isMaxLength(200))
);
const HarnessOpaqueTokenMaxLength = 36_864;

/** Provider-neutral opaque correlation token with a versioned wire prefix. */
export const HarnessCorrelationTokenSchema = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^hcor1_[A-Za-z0-9_-]+$/u),
    Schema.isMaxLength(HarnessOpaqueTokenMaxLength)
  ),
  Schema.brand("HarnessCorrelationToken")
);

/** Provider-neutral opaque checkpoint token with a distinct wire prefix. */
export const HarnessCheckpointTokenSchema = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^hchk1_[A-Za-z0-9_-]+$/u),
    Schema.isMaxLength(HarnessOpaqueTokenMaxLength)
  ),
  Schema.brand("HarnessCheckpointToken")
);

/** Opaque provider-neutral session correlation token. */
export type HarnessCorrelationToken = typeof HarnessCorrelationTokenSchema.Type;

/** Opaque provider-neutral resume checkpoint token. */
export type HarnessCheckpointToken = typeof HarnessCheckpointTokenSchema.Type;

export const parseHarnessCorrelationToken = Schema.decodeUnknownSync(
  HarnessCorrelationTokenSchema
);
export const parseHarnessCheckpointToken = Schema.decodeUnknownSync(
  HarnessCheckpointTokenSchema
);

/** Parsed text input sent to a provider-neutral harness session. */
export class HarnessInput extends Schema.Class<HarnessInput>("HarnessInput")({
  clientInputId: Schema.optionalKey(
    Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(200)))
  ),
  text: Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(16_384))),
}) {}

/** Structural proof emitted only after an exact provider transport accepts input. */
export class HarnessActionTransportWitness extends Schema.Class<HarnessActionTransportWitness>(
  "HarnessActionTransportWitness"
)({
  kind: Schema.Literal("codexAppServerTransportOffered"),
  version: Schema.Literal(1),
}) {}

/** Provider-facing interaction response whose sensitive values are not persisted. */
export const HarnessInteractionResponseSchema = Schema.Union([
  Schema.Struct({
    actionId: HarnessActionIdSchema,
    decision: Schema.Literals([
      "approve",
      "approveForSession",
      "decline",
      "cancel",
    ] as const),
    interactionId: HarnessInteractionIdSchema,
    kind: Schema.Literal("approval"),
  }),
  Schema.Struct({
    actionId: HarnessActionIdSchema,
    answers: Schema.Array(
      Schema.Struct({
        answers: Schema.Array(
          Schema.String.pipe(Schema.check(Schema.isMaxLength(16_384)))
        ).pipe(Schema.check(Schema.isMaxLength(20))),
        questionId: HarnessQuestionIdSchema,
      })
    ).pipe(Schema.check(Schema.isMaxLength(20))),
    interactionId: HarnessInteractionIdSchema,
    kind: Schema.Literal("userInput"),
  }),
  Schema.Struct({
    actionId: HarnessActionIdSchema,
    action: Schema.Literals(["submit", "decline", "cancel"] as const),
    content: Schema.optionalKey(Schema.Json),
    interactionId: HarnessInteractionIdSchema,
    kind: Schema.Literal("mcpElicitation"),
  }),
]);
/** A provider-facing response to one pending interaction. */
export type HarnessInteractionResponse =
  typeof HarnessInteractionResponseSchema.Type;

/** Request to create one provider-neutral harness session. */
export class HarnessSessionStart extends Schema.Class<HarnessSessionStart>(
  "HarnessSessionStart"
)({
  input: HarnessInput,
  sessionId: HarnessSessionIdSchema,
  workspacePath: WorkspaceRelativePathSchema,
}) {}

/** Request to resume one provider-neutral harness session. */
export class HarnessSessionResume extends Schema.Class<HarnessSessionResume>(
  "HarnessSessionResume"
)(
  {
    allowInterruptedCheckpoint: Schema.optionalKey(Schema.Boolean),
    expectedCheckpoint: Schema.optionalKey(HarnessCheckpointTokenSchema),
    sessionId: HarnessSessionIdSchema,
    workspacePath: WorkspaceRelativePathSchema,
  },
  { parseOptions: { onExcessProperty: "error" } }
) {}

/** Detection failure before a provider can report availability. */
export class HarnessDetectionError extends Schema.TaggedErrorClass<HarnessDetectionError>()(
  "HarnessDetectionError",
  {
    message: RuntimeMessageSchema,
    providerId: HarnessProviderIdSchema,
  }
) {}

/** Required capabilities absent from a detected provider. */
export class HarnessCapabilityMismatchError extends Schema.TaggedErrorClass<HarnessCapabilityMismatchError>()(
  "HarnessCapabilityMismatchError",
  {
    missing: Schema.Array(HarnessCapabilitySchema).pipe(
      Schema.check(Schema.isMaxLength(15))
    ),
    providerId: HarnessProviderIdSchema,
  }
) {}

/** Provider cannot start because it is missing or needs authentication. */
export class HarnessUnavailableError extends Schema.TaggedErrorClass<HarnessUnavailableError>()(
  "HarnessUnavailableError",
  {
    providerId: HarnessProviderIdSchema,
    state: Schema.Literals(["missing", "authenticationRequired"] as const),
    version: Schema.optionalKey(RuntimeVersionSchema),
  }
) {}

/** Provider version is outside the adapter's supported range. */
export class HarnessIncompatibleError extends Schema.TaggedErrorClass<HarnessIncompatibleError>()(
  "HarnessIncompatibleError",
  {
    message: RuntimeMessageSchema,
    providerId: HarnessProviderIdSchema,
    version: RuntimeVersionSchema,
  }
) {}

/** Provider capabilities contradict the optional operations on its session. */
export class HarnessSessionContractError extends Schema.TaggedErrorClass<HarnessSessionContractError>()(
  "HarnessSessionContractError",
  {
    contradictions: Schema.Array(
      Schema.Literals(["steering", "interruption"] as const)
    ).pipe(Schema.check(Schema.isMaxLength(2))),
    providerId: HarnessProviderIdSchema,
  }
) {}

/** Typed failure while creating a provider session. */
export class HarnessStartError extends Schema.TaggedErrorClass<HarnessStartError>()(
  "HarnessStartError",
  { message: RuntimeMessageSchema, providerId: HarnessProviderIdSchema }
) {}

/** Typed failure while resuming a provider session. */
export class HarnessResumeError extends Schema.TaggedErrorClass<HarnessResumeError>()(
  "HarnessResumeError",
  { message: RuntimeMessageSchema, providerId: HarnessProviderIdSchema }
) {}

/** Typed failure while reading session state or events. */
export class HarnessSessionError extends Schema.TaggedErrorClass<HarnessSessionError>()(
  "HarnessSessionError",
  { message: RuntimeMessageSchema, providerId: HarnessProviderIdSchema }
) {}

/** Typed failure while dispatching an operator action. */
export class HarnessActionError extends Schema.TaggedErrorClass<HarnessActionError>()(
  "HarnessActionError",
  {
    actionKind: Schema.Literals([
      "send",
      "steer",
      "interrupt",
      "resolveInteraction",
    ] as const),
    message: RuntimeMessageSchema,
    providerId: HarnessProviderIdSchema,
  }
) {}

/** Live provider-neutral session capability returned by a harness provider. */
export interface HarnessSession {
  readonly events: Stream.Stream<HarnessEvent, HarnessSessionError>;
  readonly interrupt: Option.Option<Effect.Effect<void, HarnessActionError>>;
  readonly resolveInteraction: (
    response: HarnessInteractionResponse
  ) => Effect.Effect<void, HarnessActionError>;
  readonly send: (
    input: HarnessInput
  ) => Effect.Effect<
    HarnessActionTransportWitness | undefined,
    HarnessActionError
  >;
  readonly snapshot: Effect.Effect<HarnessSessionSnapshot, HarnessSessionError>;
  readonly steer: Option.Option<
    (
      input: HarnessInput
    ) => Effect.Effect<
      HarnessActionTransportWitness | undefined,
      HarnessActionError
    >
  >;
}

/** Narrow provider SPI for detecting, starting, and resuming harness sessions. */
export interface HarnessProvider {
  readonly createSession: (
    request: HarnessSessionStart
  ) => Effect.Effect<HarnessSession, HarnessStartError, Scope.Scope>;
  readonly descriptor: HarnessProviderDescriptor;
  readonly detect: Effect.Effect<HarnessDetection, HarnessDetectionError>;
  readonly resumeSession: (
    request: HarnessSessionResume
  ) => Effect.Effect<HarnessSession, HarnessResumeError, Scope.Scope>;
}

/** Start through the SPI after detection, capability, and contract validation. */
export function startHarnessSession(input: {
  readonly provider: HarnessProvider;
  readonly request: HarnessSessionStart;
  readonly requiredCapabilities: ReadonlyArray<HarnessCapability>;
}) {
  return Effect.gen(function* () {
    const request = yield* Schema.decodeUnknownEffect(HarnessSessionStart)(
      input.request
    ).pipe(
      Effect.mapError(
        () =>
          new HarnessStartError({
            message: "Harness session start input is invalid.",
            providerId: input.provider.descriptor.providerId,
          })
      )
    );
    const detection = yield* input.provider.detect;
    const capabilities = yield* requireAvailableCapabilities(
      input.provider,
      detection,
      input.requiredCapabilities
    );
    const session = yield* input.provider.createSession(request);
    yield* validateSessionContract(input.provider, capabilities, session);
    return session;
  });
}

/** Resume through the SPI after detection, capability, and contract validation. */
export function resumeHarnessSession(input: {
  readonly provider: HarnessProvider;
  readonly request: HarnessSessionResume;
  readonly requiredCapabilities: ReadonlyArray<HarnessCapability>;
}) {
  return Effect.gen(function* () {
    const request = yield* Schema.decodeUnknownEffect(HarnessSessionResume)(
      input.request
    ).pipe(
      Effect.mapError(
        () =>
          new HarnessResumeError({
            message: "Harness session resume input is invalid.",
            providerId: input.provider.descriptor.providerId,
          })
      )
    );
    const detection = yield* input.provider.detect;
    const capabilities = yield* requireAvailableCapabilities(
      input.provider,
      detection,
      ["resumableSessions", ...input.requiredCapabilities]
    );
    const session = yield* input.provider.resumeSession(request);
    yield* validateSessionContract(input.provider, capabilities, session);
    return session;
  });
}

function requireAvailableCapabilities(
  provider: HarnessProvider,
  detection: HarnessDetection,
  required: ReadonlyArray<HarnessCapability>
) {
  switch (detection.state) {
    case "available": {
      const missing = missingHarnessCapabilities(
        detection.capabilities,
        required
      );
      return missing.length === 0
        ? Effect.succeed(detection.capabilities)
        : Effect.fail(
            new HarnessCapabilityMismatchError({
              missing,
              providerId: provider.descriptor.providerId,
            })
          );
    }
    case "missing":
      return Effect.fail(
        new HarnessUnavailableError({
          providerId: provider.descriptor.providerId,
          state: "missing",
        })
      );
    case "authenticationRequired":
      return Effect.fail(
        new HarnessUnavailableError({
          providerId: provider.descriptor.providerId,
          state: "authenticationRequired",
          version: detection.version,
        })
      );
    case "incompatible":
      return Effect.fail(
        new HarnessIncompatibleError({
          message: detection.reason,
          providerId: provider.descriptor.providerId,
          version: detection.version,
        })
      );
  }
}

function validateSessionContract(
  provider: HarnessProvider,
  capabilities: HarnessCapabilities,
  session: HarnessSession
) {
  const contradictions: Array<"steering" | "interruption"> = [];
  if (capabilities.steering !== Option.isSome(session.steer)) {
    contradictions.push("steering");
  }
  if (capabilities.interruption !== Option.isSome(session.interrupt)) {
    contradictions.push("interruption");
  }

  return contradictions.length === 0
    ? Effect.void
    : Effect.fail(
        new HarnessSessionContractError({
          contradictions,
          providerId: provider.descriptor.providerId,
        })
      );
}
