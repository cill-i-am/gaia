import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { Schema } from "effect";

import type { RunEvent } from "./events.js";
import { canonicalV1 } from "./run-contract.js";
import { RunIdSchema } from "./run-id.js";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const LowerSha256Schema = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^[a-f0-9]{64}$/u, { identifier: "LowerSha256" })
  )
);
const BoundedTextSchema = Schema.String.pipe(
  Schema.check(Schema.isMaxLength(16_384))
);
const BoundedItemSchema = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isMaxLength(4_096))
);
const BoundedItemsSchema = Schema.Array(BoundedItemSchema).pipe(
  Schema.check(Schema.isMaxLength(64))
);
const EpisodeKeySchema = Schema.NonEmptyString.pipe(
  Schema.check(
    Schema.isMaxLength(256),
    Schema.isPattern(/^[A-Za-z][A-Za-z0-9:_-]*$/u, {
      identifier: "ModelInvocationEpisodeKey",
    })
  )
);

export const ModelContextContentDigestSchema = LowerSha256Schema.pipe(
  Schema.brand("ModelContextContentDigest")
);
export const ModelContextDigestSchema = LowerSha256Schema.pipe(
  Schema.brand("ModelContextDigest")
);
export const ModelInvocationDigestSchema = LowerSha256Schema.pipe(
  Schema.brand("ModelInvocationDigest")
);
export const RenderedModelInputDigestSchema = LowerSha256Schema.pipe(
  Schema.brand("RenderedModelInputDigest")
);
export const ModelContextIdSchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^mctx1_[a-f0-9]{64}$/u)),
  Schema.brand("ModelContextId")
);
export const ModelInvocationIdSchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^minv1_[a-f0-9]{64}$/u)),
  Schema.brand("ModelInvocationId")
);

export const MODEL_OUTPUT_CONTRACT_CWD_RUN_MARKER_V1 = {
  id: "gaia.output-contract.cwd-run-marker.v1",
  text: "Determine the required Gaia run marker only from the canonical physical current working directory (equivalent to `pwd -P`). Require the accepted shape `<run-store>/.gaia/runs/<runId>/workspace`, with final component exactly `workspace`. Take exactly the immediately preceding single component, require it to match `run-[A-Za-z0-9_-]{10}`, and include that exact component as the run marker alongside the concise final result in `./output.txt`. If canonicalization or the shape/component is missing, malformed, ambiguous or symlink-substituted, stop without guessing. Do not infer the marker from task text, prompt fields, environment variables, filenames, other files, provider/session state or any other source.",
  version: 1,
} as const;

export const MODEL_REVIEW_OUTPUT_CONTRACT_V1 = {
  id: "gaia.review-decision.v1",
  text: "Return a read-only review decision. The first line must be exactly `Status: approved` or `Status: blocked`; the second line must start with `Summary: ` and contain one concise sentence; any remaining lines are bounded Markdown findings. Do not mutate the workspace or any external system.",
  version: 1,
} as const;

export class ModelOutputContractInstructionV1 extends Schema.Class<ModelOutputContractInstructionV1>(
  "ModelOutputContractInstructionV1"
)(
  {
    id: Schema.Literal("gaia.output-contract.cwd-run-marker.v1"),
    text: Schema.Literal(MODEL_OUTPUT_CONTRACT_CWD_RUN_MARKER_V1.text),
    version: Schema.Literal(1),
  },
  strict
) {}

export class ModelReviewOutputContractInstructionV1 extends Schema.Class<ModelReviewOutputContractInstructionV1>(
  "ModelReviewOutputContractInstructionV1"
)(
  {
    id: Schema.Literal("gaia.review-decision.v1"),
    text: Schema.Literal(MODEL_REVIEW_OUTPUT_CONTRACT_V1.text),
    version: Schema.Literal(1),
  },
  strict
) {}

export const AnyModelOutputContractInstructionV1 = Schema.Union([
  ModelOutputContractInstructionV1,
  ModelReviewOutputContractInstructionV1,
]);

export class ModelInvocationBudgetV1 extends Schema.Class<ModelInvocationBudgetV1>(
  "ModelInvocationBudgetV1"
)(
  {
    maxOutputBytes: Schema.Number.pipe(
      Schema.check(
        Schema.isInt(),
        Schema.isBetween({ minimum: 1, maximum: 65_536 })
      )
    ),
    maxTurns: Schema.Number.pipe(
      Schema.check(
        Schema.isInt(),
        Schema.isBetween({ minimum: 1, maximum: 64 })
      )
    ),
  },
  strict
) {}

export class ModelContextContentRefV1 extends Schema.Class<ModelContextContentRefV1>(
  "ModelContextContentRefV1"
)(
  {
    digest: LowerSha256Schema,
    kind: Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(128))),
    relevance: Schema.NonEmptyString.pipe(
      Schema.check(Schema.isMaxLength(512))
    ),
  },
  strict
) {}

export const ModelInvocationEpisodeRoleSchema = Schema.Literals([
  "planReview",
  "workerInitial",
  "evidenceReview",
  "operatorFollowUp",
  "operatorSteer",
  "deliveryRemediation",
  "workerRecovery",
  "workerCorrelation",
  "workerDesktopOriginCorrelation",
] as const);

export class ModelContextContentPayloadV1 extends Schema.Class<ModelContextContentPayloadV1>(
  "ModelContextContentPayloadV1"
)(
  {
    acceptedOutcomes: BoundedItemsSchema,
    authority: BoundedItemsSchema,
    budget: ModelInvocationBudgetV1,
    contentRefs: Schema.Array(ModelContextContentRefV1).pipe(
      Schema.check(Schema.isMaxLength(64))
    ),
    episodeRole: ModelInvocationEpisodeRoleSchema,
    instructions: Schema.Array(BoundedItemSchema).pipe(
      Schema.check(Schema.isMaxLength(32))
    ),
    nonGoals: BoundedItemsSchema,
    outputContract: AnyModelOutputContractInstructionV1,
    planningFacts: BoundedItemsSchema,
    safeExclusions: BoundedItemsSchema,
    skills: Schema.Array(BoundedItemSchema).pipe(
      Schema.check(Schema.isMaxLength(32))
    ),
    stops: BoundedItemsSchema,
    taskInput: BoundedTextSchema,
    verificationCommands: BoundedItemsSchema,
    version: Schema.Literal(1),
  },
  strict
) {}

export class ModelContextContentV1 extends Schema.Class<ModelContextContentV1>(
  "ModelContextContentV1"
)(
  {
    contextContentDigest: ModelContextContentDigestSchema,
    payload: ModelContextContentPayloadV1,
  },
  strict
) {}

export class ModelWorkspaceBindingV1 extends Schema.Class<ModelWorkspaceBindingV1>(
  "ModelWorkspaceBindingV1"
)(
  {
    canonicalRunStoreRootDigest: LowerSha256Schema,
    canonicalWorkspacePathDigest: LowerSha256Schema,
    runId: RunIdSchema,
    shape: Schema.Literal(".gaia/runs/<runId>/workspace"),
    version: Schema.Literal(1),
    workspaceRole: Schema.Literal("workerWorkspace"),
  },
  strict
) {}

export class ModelInvocationBindingV1 extends Schema.Class<ModelInvocationBindingV1>(
  "ModelInvocationBindingV1"
)({ episodeKey: EpisodeKeySchema, runId: RunIdSchema }, strict) {}

export class ModelAuthoritativeRefV1 extends Schema.Class<ModelAuthoritativeRefV1>(
  "ModelAuthoritativeRefV1"
)(
  {
    digest: LowerSha256Schema,
    kind: Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(128))),
  },
  strict
) {}

export class ModelContextManifestPayloadV1 extends Schema.Class<ModelContextManifestPayloadV1>(
  "ModelContextManifestPayloadV1"
)(
  {
    authoritativeRefs: Schema.Array(ModelAuthoritativeRefV1).pipe(
      Schema.check(Schema.isMaxLength(64))
    ),
    binding: ModelInvocationBindingV1,
    content: ModelContextContentPayloadV1,
    contextContentDigest: ModelContextContentDigestSchema,
    version: Schema.Literal(1),
    workspaceBinding: ModelWorkspaceBindingV1,
  },
  strict
) {}

export class ModelContextManifestV1 extends Schema.Class<ModelContextManifestV1>(
  "ModelContextManifestV1"
)(
  {
    contextDigest: ModelContextDigestSchema,
    contextId: ModelContextIdSchema,
    payload: ModelContextManifestPayloadV1,
  },
  strict
) {}

export class RenderedModelInputV1 extends Schema.Class<RenderedModelInputV1>(
  "RenderedModelInputV1"
)(
  {
    byteLength: Schema.Number.pipe(
      Schema.check(
        Schema.isInt(),
        Schema.isBetween({ minimum: 1, maximum: 16_384 })
      )
    ),
    renderedInputDigest: RenderedModelInputDigestSchema,
    text: BoundedTextSchema,
  },
  strict
) {}

export class ModelAdapterSemanticsV1 extends Schema.Class<ModelAdapterSemanticsV1>(
  "ModelAdapterSemanticsV1"
)(
  {
    kind: Schema.Literals([
      "codexBatch",
      "codexAppServer",
      "deterministicFake",
      "deterministicReviewer",
      "legacyProcess",
    ] as const),
    semanticDigest: LowerSha256Schema,
  },
  strict
) {}

export class ModelInvocationContextRefV1 extends Schema.Class<ModelInvocationContextRefV1>(
  "ModelInvocationContextRefV1"
)(
  {
    contextContentDigest: ModelContextContentDigestSchema,
    contextDigest: ModelContextDigestSchema,
    contextId: ModelContextIdSchema,
  },
  strict
) {}

export class ModelInvocationTemplateV1 extends Schema.Class<ModelInvocationTemplateV1>(
  "ModelInvocationTemplateV1"
)(
  {
    id: Schema.Literal("gaia.worker-input.v1"),
    version: Schema.Literal(1),
  },
  strict
) {}

export class ModelInvocationManifestPayloadV1 extends Schema.Class<ModelInvocationManifestPayloadV1>(
  "ModelInvocationManifestPayloadV1"
)(
  {
    acceptedProviderCapabilityObservation: Schema.Literals([
      "offered",
      "retrieved",
      "opened",
      "invoked",
      "reportedRelevant",
      "unobservable",
      "notApplicable",
    ] as const),
    adapterInputClass: Schema.Literals([
      "codexBatchStdin",
      "codexAppTurn",
      "codexReviewerStdin",
      "deterministicInput",
      "legacySpecEnvironment",
    ] as const),
    adapterSemantics: ModelAdapterSemanticsV1,
    authorityRef: ModelAuthoritativeRefV1,
    binding: ModelInvocationBindingV1,
    budget: ModelInvocationBudgetV1,
    context: ModelInvocationContextRefV1,
    outputContract: AnyModelOutputContractInstructionV1,
    rendered: RenderedModelInputV1,
    runContractRef: ModelAuthoritativeRefV1,
    template: ModelInvocationTemplateV1,
    version: Schema.Literal(1),
    workspaceBinding: ModelWorkspaceBindingV1,
  },
  strict
) {}

export class ModelInvocationManifestV1 extends Schema.Class<ModelInvocationManifestV1>(
  "ModelInvocationManifestV1"
)(
  {
    invocationDigest: ModelInvocationDigestSchema,
    invocationId: ModelInvocationIdSchema,
    payload: ModelInvocationManifestPayloadV1,
  },
  strict
) {}

export const ModelManifestArtifactIdSchema = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^mmf1_[a-f0-9]{64}$/u),
    Schema.isMaxLength(69)
  ),
  Schema.brand("ModelManifestArtifactId")
);
export const ModelManifestArtifactPathSchema = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(
      /^model-invocations\/episode1_[a-f0-9]{64}\/(?:context|invocation)-manifest\.json$/u
    )
  ),
  Schema.brand("ModelManifestArtifactPath")
);

export class ModelManifestArtifactRefV1 extends Schema.Class<ModelManifestArtifactRefV1>(
  "ModelManifestArtifactRefV1"
)(
  {
    artifactId: ModelManifestArtifactIdSchema,
    bodyDigest: LowerSha256Schema,
    byteLength: Schema.Number.pipe(
      Schema.check(
        Schema.isInt(),
        Schema.isBetween({ minimum: 1, maximum: 131_072 })
      )
    ),
    episodeKey: EpisodeKeySchema,
    identityDigest: LowerSha256Schema,
    kind: Schema.Literals([
      "modelContextManifest",
      "modelInvocationManifest",
    ] as const),
    path: ModelManifestArtifactPathSchema,
    runId: RunIdSchema,
    version: Schema.Literal(1),
  },
  strict
) {}

export class ModelInvocationEpisodeStartV1 extends Schema.Class<ModelInvocationEpisodeStartV1>(
  "ModelInvocationEpisodeStartV1"
)(
  {
    contextRef: ModelManifestArtifactRefV1,
    episodeKey: EpisodeKeySchema,
    invocationRef: ModelManifestArtifactRefV1,
    version: Schema.Literal(1),
  },
  strict
) {}

export class ModelInvocationObservationV1 extends Schema.Class<ModelInvocationObservationV1>(
  "ModelInvocationObservationV1"
)(
  {
    episodeKey: EpisodeKeySchema,
    kind: Schema.Literals([
      "offered",
      "retrieved",
      "opened",
      "invoked",
      "reportedRelevant",
      "unobservable",
      "notApplicable",
    ] as const),
    source: Schema.Literals([
      "codexBatchTransport",
      "codexAppServerTransport",
      "providerTelemetry",
      "providerSelfReport",
      "gaiaBoundary",
    ] as const),
    trust: Schema.Literals(["high", "low", "none"] as const),
    version: Schema.Literal(1),
  },
  strict
) {}

export const AnyModelContextManifest = ModelContextManifestV1;
export const AnyModelInvocationManifest = ModelInvocationManifestV1;

export const parseModelInvocationEpisodeStart = Schema.decodeUnknownSync(
  ModelInvocationEpisodeStartV1
);
export const parseModelInvocationObservation = Schema.decodeUnknownSync(
  ModelInvocationObservationV1
);

const decodeContentPayload = Schema.decodeUnknownSync(
  ModelContextContentPayloadV1
);
const decodeContent = Schema.decodeUnknownSync(ModelContextContentV1);
const decodeContext = Schema.decodeUnknownSync(ModelContextManifestV1);
const decodeInvocation = Schema.decodeUnknownSync(ModelInvocationManifestV1);
const encodeContentPayload = Schema.encodeSync(ModelContextContentPayloadV1);
const encodeContextPayload = Schema.encodeSync(ModelContextManifestPayloadV1);
const encodeInvocationPayload = Schema.encodeSync(
  ModelInvocationManifestPayloadV1
);
const parseContentDigest = Schema.decodeUnknownSync(
  ModelContextContentDigestSchema
);
const parseContextDigest = Schema.decodeUnknownSync(ModelContextDigestSchema);
const parseContextId = Schema.decodeUnknownSync(ModelContextIdSchema);
const parseInvocationDigest = Schema.decodeUnknownSync(
  ModelInvocationDigestSchema
);
const parseInvocationId = Schema.decodeUnknownSync(ModelInvocationIdSchema);
const parseRenderedDigest = Schema.decodeUnknownSync(
  RenderedModelInputDigestSchema
);
const decodeString = Schema.decodeUnknownSync(Schema.String);

function digest(domain: string, value: unknown) {
  return bytesToHex(sha256(canonicalV1(domain, [value])));
}

function assertUtf8Bounded(value: unknown, maximum: number, label: string) {
  const decoded = decodeString(value);
  if (!decoded.isWellFormed() || utf8ToBytes(decoded).byteLength > maximum)
    throw new Error(`${label} must be well-formed and within its UTF-8 bound.`);
}

export function makeModelContextContentV1(
  input: Omit<typeof ModelContextContentPayloadV1.Type, "version">
) {
  const payload = decodeContentPayload({ ...input, version: 1 });
  assertUtf8Bounded(payload.taskInput, 16_384, "Model task input");
  for (const value of [
    ...payload.acceptedOutcomes,
    ...payload.authority,
    ...payload.instructions,
    ...payload.nonGoals,
    ...payload.planningFacts,
    ...payload.safeExclusions,
    ...payload.skills,
    ...payload.stops,
    ...payload.verificationCommands,
  ])
    assertUtf8Bounded(value, 4_096, "Model context item");
  const encodedPayload = encodeContentPayload(payload);
  return decodeContent({
    contextContentDigest: parseContentDigest(
      digest("gaia.model-context-content.v1", encodedPayload)
    ),
    payload,
  });
}

export function parseModelContextContent(input: unknown) {
  const decoded = decodeContent(input);
  const expected = makeModelContextContentV1(decoded.payload);
  if (expected.contextContentDigest !== decoded.contextContentDigest)
    throw new Error("Model context content failed self-authentication.");
  return decoded;
}

function renderItems(title: string, values: ReadonlyArray<string>) {
  return `${title}:\n${values.length === 0 ? "- none" : values.map((value) => `- ${value}`).join("\n")}`;
}

export function renderModelInputV1(contentInput: ModelContextContentV1) {
  const content = parseModelContextContent(contentInput);
  const payload = content.payload;
  const text = [
    "Gaia model input template: gaia.worker-input.v1",
    "Task input:",
    payload.taskInput,
    renderItems("Accepted outcomes", payload.acceptedOutcomes),
    renderItems("Non-goals", payload.nonGoals),
    renderItems("Stop conditions", payload.stops),
    renderItems("Planning facts", payload.planningFacts),
    renderItems("Authority", payload.authority),
    renderItems("Instructions", payload.instructions),
    renderItems("Skills", payload.skills),
    renderItems("Verification commands", payload.verificationCommands),
    renderItems("Safe exclusions", payload.safeExclusions),
    `Budget: maxTurns=${payload.budget.maxTurns}; maxOutputBytes=${payload.budget.maxOutputBytes}`,
    `Output contract ${payload.outputContract.id}@${payload.outputContract.version}:`,
    payload.outputContract.text,
    "",
  ].join("\n");
  assertUtf8Bounded(text, 16_384, "Rendered model input");
  const bytes = utf8ToBytes(text);
  return RenderedModelInputV1.make({
    byteLength: bytes.byteLength,
    renderedInputDigest: parseRenderedDigest(bytesToHex(sha256(bytes))),
    text,
  });
}

export function makeModelContextManifestV1(input: {
  readonly authoritativeRefs: ReadonlyArray<
    typeof ModelAuthoritativeRefV1.Type
  >;
  readonly binding: typeof ModelInvocationBindingV1.Type;
  readonly content: ModelContextContentV1;
  readonly workspaceBinding: typeof ModelWorkspaceBindingV1.Type;
}) {
  const content = parseModelContextContent(input.content);
  if (input.binding.runId !== input.workspaceBinding.runId)
    throw new Error("Model context workspace binding belongs to another run.");
  const payload = Schema.decodeUnknownSync(ModelContextManifestPayloadV1)({
    authoritativeRefs: input.authoritativeRefs,
    binding: input.binding,
    content: content.payload,
    contextContentDigest: content.contextContentDigest,
    version: 1,
    workspaceBinding: input.workspaceBinding,
  });
  const contextDigest = parseContextDigest(
    digest("gaia.model-context-manifest.v1", encodeContextPayload(payload))
  );
  return decodeContext({
    contextDigest,
    contextId: parseContextId(`mctx1_${contextDigest}`),
    payload,
  });
}

export function parseModelContextManifest(input: unknown) {
  const decoded = decodeContext(input);
  const content = parseModelContextContent({
    contextContentDigest: decoded.payload.contextContentDigest,
    payload: decoded.payload.content,
  });
  const expected = makeModelContextManifestV1({
    authoritativeRefs: decoded.payload.authoritativeRefs,
    binding: decoded.payload.binding,
    content,
    workspaceBinding: decoded.payload.workspaceBinding,
  });
  if (
    expected.contextDigest !== decoded.contextDigest ||
    expected.contextId !== decoded.contextId
  )
    throw new Error("Model context manifest failed self-authentication.");
  return decoded;
}

export function makeModelInvocationManifestV1(input: {
  readonly acceptedProviderCapabilityObservation: typeof ModelInvocationManifestPayloadV1.Type.acceptedProviderCapabilityObservation;
  readonly adapterInputClass: typeof ModelInvocationManifestPayloadV1.Type.adapterInputClass;
  readonly adapterSemantics: typeof ModelAdapterSemanticsV1.Type;
  readonly authorityRef: typeof ModelAuthoritativeRefV1.Type;
  readonly binding: typeof ModelInvocationBindingV1.Type;
  readonly budget: typeof ModelInvocationBudgetV1.Type;
  readonly context: ModelContextManifestV1;
  readonly outputContract: typeof AnyModelOutputContractInstructionV1.Type;
  readonly rendered: RenderedModelInputV1;
  readonly runContractRef: typeof ModelAuthoritativeRefV1.Type;
  readonly template: typeof ModelInvocationTemplateV1.Type;
  readonly workspaceBinding: typeof ModelWorkspaceBindingV1.Type;
}) {
  assertInvocationAdapterMatrix(
    input.adapterSemantics.kind,
    input.adapterInputClass,
    input.acceptedProviderCapabilityObservation
  );
  const context = parseModelContextManifest(input.context);
  if (
    input.binding.runId !== input.workspaceBinding.runId ||
    input.binding.runId !== context.payload.binding.runId ||
    input.binding.episodeKey !== context.payload.binding.episodeKey ||
    input.workspaceBinding.canonicalWorkspacePathDigest !==
      context.payload.workspaceBinding.canonicalWorkspacePathDigest
  )
    throw new Error("Model invocation context binding mismatch.");
  const rendered = Schema.decodeUnknownSync(RenderedModelInputV1)(
    input.rendered
  );
  const renderedBytes = utf8ToBytes(rendered.text);
  if (
    rendered.byteLength !== renderedBytes.byteLength ||
    rendered.renderedInputDigest !== bytesToHex(sha256(renderedBytes))
  )
    throw new Error("Rendered model input failed self-authentication.");
  const payload = Schema.decodeUnknownSync(ModelInvocationManifestPayloadV1)({
    acceptedProviderCapabilityObservation:
      input.acceptedProviderCapabilityObservation,
    adapterInputClass: input.adapterInputClass,
    adapterSemantics: input.adapterSemantics,
    authorityRef: input.authorityRef,
    binding: input.binding,
    budget: input.budget,
    context: {
      contextContentDigest: context.payload.contextContentDigest,
      contextDigest: context.contextDigest,
      contextId: context.contextId,
    },
    outputContract: input.outputContract,
    rendered,
    runContractRef: input.runContractRef,
    template: input.template,
    version: 1,
    workspaceBinding: input.workspaceBinding,
  });
  assertInvocationMatchesContext(payload, context);
  const invocationDigest = parseInvocationDigest(
    digest(
      "gaia.model-invocation-manifest.v1",
      encodeInvocationPayload(payload)
    )
  );
  return decodeInvocation({
    invocationDigest,
    invocationId: parseInvocationId(`minv1_${invocationDigest}`),
    payload,
  });
}

export function parseModelInvocationManifest(
  input: unknown,
  contextInput: unknown
) {
  const decoded = decodeInvocation(input);
  assertInvocationAdapterMatrix(
    decoded.payload.adapterSemantics.kind,
    decoded.payload.adapterInputClass,
    decoded.payload.acceptedProviderCapabilityObservation
  );
  if (
    decoded.payload.binding.runId !== decoded.payload.workspaceBinding.runId ||
    decoded.payload.rendered.byteLength !==
      utf8ToBytes(decoded.payload.rendered.text).byteLength ||
    decoded.payload.rendered.renderedInputDigest !==
      bytesToHex(sha256(utf8ToBytes(decoded.payload.rendered.text)))
  )
    throw new Error("Model invocation manifest binding is invalid.");
  const expectedDigest = parseInvocationDigest(
    digest(
      "gaia.model-invocation-manifest.v1",
      encodeInvocationPayload(decoded.payload)
    )
  );
  if (
    expectedDigest !== decoded.invocationDigest ||
    decoded.invocationId !== `minv1_${expectedDigest}`
  )
    throw new Error("Model invocation manifest failed self-authentication.");
  assertInvocationMatchesContext(
    decoded.payload,
    parseModelContextManifest(contextInput)
  );
  return decoded;
}

function assertInvocationAdapterMatrix(
  kind: typeof ModelAdapterSemanticsV1.Type.kind,
  inputClass: typeof ModelInvocationManifestPayloadV1.Type.adapterInputClass,
  observation: typeof ModelInvocationManifestPayloadV1.Type.acceptedProviderCapabilityObservation
) {
  const rule =
    kind === "codexBatch"
      ? {
          inputClass: "codexBatchStdin" as const,
          observations: ["offered", "unobservable"] as const,
        }
      : kind === "codexAppServer"
        ? {
            inputClass: "codexAppTurn" as const,
            observations: ["offered", "unobservable"] as const,
          }
        : kind === "deterministicReviewer"
          ? {
              inputClass: "codexReviewerStdin" as const,
              observations: ["notApplicable", "unobservable"] as const,
            }
          : kind === "deterministicFake"
            ? {
                inputClass: "deterministicInput" as const,
                observations: ["notApplicable"] as const,
              }
            : {
                inputClass: "legacySpecEnvironment" as const,
                observations: ["unobservable"] as const,
              };
  if (
    inputClass !== rule.inputClass ||
    !(rule.observations as ReadonlyArray<string>).includes(observation)
  )
    throw new Error(
      "Model invocation adapter input or capability observation is contradictory."
    );
}

function canonicalValuesEqual(left: unknown, right: unknown) {
  return (
    digest("gaia.model-invocation-pair-component.v1", left) ===
    digest("gaia.model-invocation-pair-component.v1", right)
  );
}

function assertInvocationMatchesContext(
  invocation: typeof ModelInvocationManifestPayloadV1.Type,
  context: ModelContextManifestV1
) {
  const expectedRendered = renderModelInputV1(
    parseModelContextContent({
      contextContentDigest: context.payload.contextContentDigest,
      payload: context.payload.content,
    })
  );
  if (
    invocation.binding.runId !== context.payload.binding.runId ||
    invocation.binding.episodeKey !== context.payload.binding.episodeKey ||
    invocation.context.contextId !== context.contextId ||
    invocation.context.contextDigest !== context.contextDigest ||
    invocation.context.contextContentDigest !==
      context.payload.contextContentDigest
  )
    throw new Error("Model invocation context binding mismatch.");
  if (!canonicalValuesEqual(invocation.rendered, expectedRendered))
    throw new Error("Model invocation rendered input does not match context.");
  if (!canonicalValuesEqual(invocation.budget, context.payload.content.budget))
    throw new Error("Model invocation budget does not match context.");
  if (
    !canonicalValuesEqual(
      invocation.outputContract,
      context.payload.content.outputContract
    )
  )
    throw new Error("Model invocation output contract does not match context.");
  if (
    !canonicalValuesEqual(
      invocation.workspaceBinding,
      context.payload.workspaceBinding
    )
  )
    throw new Error(
      "Model invocation workspace binding does not match context."
    );
}

const ModelInvocationEpisodeResolutionEntrySchema = Schema.Struct({
  ownerSequence: Schema.Number.pipe(
    Schema.check(Schema.isInt(), Schema.isGreaterThan(0))
  ),
  start: ModelInvocationEpisodeStartV1,
});
const decodeModelInvocationEpisodeResolutionEntry = Schema.decodeUnknownSync(
  ModelInvocationEpisodeResolutionEntrySchema
);
class LegacyModelInvocationEpisodeResolution extends Schema.Class<LegacyModelInvocationEpisodeResolution>(
  "LegacyModelInvocationEpisodeResolution"
)({ protocol: Schema.Literal("legacyAbsent") }) {}

class ModelInvocationEpisodeResolutionV1 extends Schema.Class<ModelInvocationEpisodeResolutionV1>(
  "ModelInvocationEpisodeResolutionV1"
)({
  episodes: Schema.Array(ModelInvocationEpisodeResolutionEntrySchema),
  protocol: Schema.Literal("v1"),
}) {}

export type ModelInvocationEpisodeResolution =
  | LegacyModelInvocationEpisodeResolution
  | ModelInvocationEpisodeResolutionV1;

function artifactIdFor(
  kind: ModelManifestArtifactRefV1["kind"],
  identityDigest: typeof LowerSha256Schema.Type
) {
  return `mmf1_${bytesToHex(sha256(utf8ToBytes(`${kind}\0${identityDigest}`)))}`;
}

function requiredEpisodeKey(event: RunEvent) {
  if (event.type === "WORKER_STARTED") return "workerInitial";
  if (event.type === "REVIEW_STARTED") {
    const phase = event.payload["phase"];
    if (phase === "plan") return "planReview";
    if (phase === "evidence") return `evidenceReview:${event.sequence}`;
  }
  if (event.type === "HARNESS_SESSION_EVENT_RECORDED") {
    const nested = event.payload["event"];
    if (typeof nested !== "object" || nested === null || !("kind" in nested))
      return undefined;
    const kind = nested.kind;
    const actionKind = "actionKind" in nested ? nested.actionKind : undefined;
    const actionId = "actionId" in nested ? nested.actionId : undefined;
    if (
      kind === "operatorActionIntentRecorded" &&
      typeof actionId === "string"
    ) {
      if (actionKind === "followUp") return `operatorFollowUp:${actionId}`;
      if (actionKind === "steer") return `operatorSteer:${actionId}`;
      if (
        actionKind === "interrupt" ||
        actionKind === "approval" ||
        actionKind === "userInput" ||
        actionKind === "mcpElicitation"
      )
        return null;
    }
  }
  if (event.type === "DELIVERY_REMEDIATION_RECORDED") {
    const remediation = event.payload["remediation"];
    if (
      typeof remediation === "object" &&
      remediation !== null &&
      "state" in remediation &&
      remediation.state === "intentRecorded" &&
      "operationId" in remediation &&
      typeof remediation.operationId === "string"
    )
      return `deliveryRemediation:${remediation.operationId}`;
  }
  if (event.type === "WORKER_RECOVERY_RECORDED") {
    const recovery = event.payload["recovery"];
    if (
      typeof recovery === "object" &&
      recovery !== null &&
      "state" in recovery &&
      recovery.state === "intentRecorded" &&
      "actionId" in recovery &&
      typeof recovery.actionId === "string"
    )
      return `workerRecovery:${recovery.actionId}`;
  }
  if (event.type === "WORKER_CORRELATION_RECONCILIATION_RECORDED") {
    const reconciliation = event.payload["reconciliation"];
    if (
      typeof reconciliation === "object" &&
      reconciliation !== null &&
      "state" in reconciliation &&
      reconciliation.state === "intentRecorded" &&
      "actionId" in reconciliation &&
      typeof reconciliation.actionId === "string"
    )
      return `workerCorrelation:${reconciliation.actionId}`;
  }
  if (event.type === "WORKER_DESKTOP_ORIGIN_CORRELATION_RECORDED") {
    const correlation = event.payload["desktopOriginCorrelation"];
    if (
      typeof correlation === "object" &&
      correlation !== null &&
      "state" in correlation &&
      correlation.state === "intentRecorded" &&
      "actionId" in correlation &&
      typeof correlation.actionId === "string"
    )
      return `workerDesktopOriginCorrelation:${correlation.actionId}`;
  }
  return undefined;
}

function assertEpisodeRefPair(
  start: ModelInvocationEpisodeStartV1,
  runId: typeof RunIdSchema.Type
) {
  const context = start.contextRef;
  const invocation = start.invocationRef;
  const contextDirectory = context.path.split("/")[1];
  const invocationDirectory = invocation.path.split("/")[1];
  if (
    context.artifactId !==
      artifactIdFor(context.kind, context.identityDigest) ||
    invocation.artifactId !==
      artifactIdFor(invocation.kind, invocation.identityDigest) ||
    context.runId !== runId ||
    invocation.runId !== runId ||
    context.episodeKey !== start.episodeKey ||
    invocation.episodeKey !== start.episodeKey ||
    contextDirectory === undefined ||
    contextDirectory !== invocationDirectory ||
    context.path.endsWith("/context-manifest.json") === false ||
    invocation.path.endsWith("/invocation-manifest.json") === false
  )
    throw new Error(
      "Model invocation episode artifact references do not authenticate one pair."
    );
}

/** Resolve only event-owned model invocation episodes; artifact files never create authority. */
export function resolveModelInvocationEpisodes(
  events: ReadonlyArray<RunEvent>
): ModelInvocationEpisodeResolution {
  const first = events[0];
  const marked =
    first?.type === "RUN_CREATED" &&
    first.payload["modelInvocationProtocol"] === "v1";
  if (!marked) {
    if (
      events.some(
        (event) =>
          event.payload["modelInvocationEpisode"] !== undefined ||
          event.payload["modelInvocationObservation"] !== undefined
      )
    )
      throw new Error(
        "Legacy history cannot contain a model invocation protocol sibling."
      );
    return { protocol: "legacyAbsent" };
  }

  const episodes = new Map<
    string,
    readonly [ownerSequence: number, start: ModelInvocationEpisodeStartV1]
  >();
  const artifactIds = new Set<string>();
  const paths = new Set<string>();
  const offered = new Set<string>();
  for (const event of events) {
    const required = requiredEpisodeKey(event);
    const rawStart = event.payload["modelInvocationEpisode"];
    if (required === null && rawStart !== undefined)
      throw new Error("This operator action forbids a model invocation pair.");
    if (required !== undefined && required !== null && rawStart === undefined)
      throw new Error(
        `Model invocation episode '${required}' is required by its owner event.`
      );
    if (rawStart !== undefined) {
      const start = parseModelInvocationEpisodeStart(rawStart);
      assertEpisodeRefPair(start, event.runId);
      if (required !== start.episodeKey)
        throw new Error(
          "Model invocation episode key does not match its owner."
        );
      if (episodes.has(start.episodeKey))
        throw new Error("Model invocation episode owner is duplicated.");
      for (const ref of [start.contextRef, start.invocationRef]) {
        if (artifactIds.has(ref.artifactId) || paths.has(ref.path))
          throw new Error("Model invocation artifact reference is reused.");
        artifactIds.add(ref.artifactId);
        paths.add(ref.path);
      }
      episodes.set(start.episodeKey, [event.sequence, start]);
    }
    const rawObservation = event.payload["modelInvocationObservation"];
    if (rawObservation !== undefined) {
      const observation = parseModelInvocationObservation(rawObservation);
      if (!episodes.has(observation.episodeKey))
        throw new Error("Model invocation observation precedes its episode.");
      const validObservation =
        (observation.kind === "offered" &&
          (observation.source === "codexBatchTransport" ||
            observation.source === "codexAppServerTransport") &&
          observation.trust === "high") ||
        ((observation.kind === "retrieved" ||
          observation.kind === "opened" ||
          observation.kind === "invoked") &&
          observation.source === "providerTelemetry" &&
          observation.trust === "high") ||
        (observation.kind === "reportedRelevant" &&
          observation.source === "providerSelfReport" &&
          observation.trust === "low") ||
        ((observation.kind === "unobservable" ||
          observation.kind === "notApplicable") &&
          observation.source === "gaiaBoundary" &&
          observation.trust === "none");
      if (!validObservation)
        throw new Error(
          "Model invocation observation violates its source and trust contract."
        );
      if (observation.kind === "offered") {
        if (offered.has(observation.episodeKey))
          throw new Error(
            "Model invocation offered receipt is invalid or duplicated."
          );
        offered.add(observation.episodeKey);
      }
    }
  }
  return {
    episodes: [...episodes.values()].map(([ownerSequence, start]) =>
      decodeModelInvocationEpisodeResolutionEntry({ ownerSequence, start })
    ),
    protocol: "v1",
  };
}
