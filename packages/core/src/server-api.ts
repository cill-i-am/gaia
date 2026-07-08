import { Schema } from "effect";
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
  OpenApi,
} from "effect/unstable/httpapi";
import { EventTypeSchema, RunEvent, RunStateSchema } from "./events.js";
import {
  FactoryActivityListDto,
  FactoryAgentIdSchema,
  FactoryArtifactBodyDto,
  FactoryArtifactIdSchema,
  FactoryArtifactListDto,
  FactoryExternalRefDto,
  FactoryGraphDto,
  FactoryRunDetailDto,
  FactoryRunListDto,
  FactoryRunSummaryDto,
  FactoryWorkflowIdSchema,
} from "./factory-graph.js";
import { RunIdSchema } from "./run-id.js";

export const LocalRunReadDiagnosticCodeSchema = Schema.Literals([
  "ActiveRunConflict",
  "ArtifactNotAllowed",
  "ArtifactNotFound",
  "EndpointNotFound",
  "FactoryAgentNotFound",
  "FactoryGraphNotFound",
  "InvalidRunDirectory",
  "InvalidRunId",
  "InvalidRequest",
  "InvalidSpec",
  "InternalServerError",
  "MethodNotAllowed",
  "RunStoreLocked",
  "RunHasNoEvents",
  "RunNotFound",
  "RunUnreadable",
] as const);

const BadRequestDiagnosticCodeSchema = Schema.Literals([
  "InvalidRequest",
  "InvalidRunId",
  "InvalidSpec",
] as const);
const NotFoundDiagnosticCodeSchema = Schema.Literals([
  "ArtifactNotAllowed",
  "ArtifactNotFound",
  "EndpointNotFound",
  "FactoryAgentNotFound",
  "FactoryGraphNotFound",
  "RunNotFound",
] as const);
const MethodNotAllowedDiagnosticCodeSchema = Schema.Literals([
  "MethodNotAllowed",
] as const);
const ConflictDiagnosticCodeSchema = Schema.Literals([
  "ActiveRunConflict",
  "RunStoreLocked",
] as const);
const UnprocessableDiagnosticCodeSchema = Schema.Literals([
  "InvalidRunDirectory",
  "RunHasNoEvents",
  "RunUnreadable",
] as const);
const InternalServerDiagnosticCodeSchema = Schema.Literals([
  "InternalServerError",
] as const);

export const LocalRunApiErrorStatusSchema = Schema.Literals([
  400,
  404,
  405,
  409,
  422,
  500,
] as const);

const diagnosticFields = {
  artifactName: Schema.optionalKey(Schema.String),
  message: Schema.NonEmptyString,
  pathSegment: Schema.optionalKey(Schema.String),
  recoverable: Schema.Boolean,
  runId: Schema.optionalKey(RunIdSchema),
};

export const ServerHostSchema = Schema.Literal("127.0.0.1");

/** Legacy local run status retained for existing non-product dashboard consumers. */
export const LocalRunStatusSchema = Schema.Literals([
  "completed",
  "failed",
  "running",
] as const);

/** Legacy artifact content types retained for existing non-product dashboard consumers. */
export const LocalRunArtifactContentTypeSchema = Schema.Literals([
  "application/json",
  "text/markdown",
  "text/plain",
] as const);

/** Legacy artifact identifiers retained for existing non-product dashboard consumers. */
export const LocalRunArtifactIdSchema = Schema.Literals([
  "input",
  "worker-plan",
  "reviewer-findings",
  "plan-review",
  "worker-log",
  "worker-result",
  "verification-result",
  "evidence-review",
  "evidence-promotion",
  "evidence-promotion-markdown",
  "factory-retro",
  "factory-retro-markdown",
  "factory-scorecard",
  "factory-scorecard-markdown",
  "report",
  "report-json",
  "events",
  "snapshots",
] as const).annotate({ identifier: "LocalRunArtifactId" });

export class LocalRunReadDiagnosticDto extends Schema.Class<LocalRunReadDiagnosticDto>(
  "LocalRunReadDiagnosticDto",
)({
  artifactName: Schema.optionalKey(Schema.String),
  code: LocalRunReadDiagnosticCodeSchema,
  message: Schema.NonEmptyString,
  pathSegment: Schema.optionalKey(Schema.String),
  recoverable: Schema.Boolean,
  runId: Schema.optionalKey(RunIdSchema),
}) {}

/** Legacy run summary retained until downstream dashboard/server slices migrate. */
export class LocalRunSummaryDto extends Schema.Class<LocalRunSummaryDto>(
  "LocalRunSummaryDto",
)({
  artifacts: Schema.Array(LocalRunArtifactIdSchema),
  createdAt: Schema.NonEmptyString,
  eventCount: Schema.Number.pipe(
    Schema.check(Schema.isInt({ identifier: "EventCount" })),
  ),
  latestEventType: EventTypeSchema,
  runId: RunIdSchema,
  state: RunStateSchema,
  status: LocalRunStatusSchema,
  updatedAt: Schema.NonEmptyString,
}) {}

/** Legacy run list retained until downstream dashboard/server slices migrate. */
export class LocalRunListDto extends Schema.Class<LocalRunListDto>(
  "LocalRunListDto",
)({
  diagnostics: Schema.Array(LocalRunReadDiagnosticDto),
  runs: Schema.Array(LocalRunSummaryDto),
}) {}

/** Legacy internal event read retained but excluded from product OpenAPI. */
export class LocalRunEventsDto extends Schema.Class<LocalRunEventsDto>(
  "LocalRunEventsDto",
)({
  events: Schema.Array(RunEvent),
  runId: RunIdSchema,
}) {}

/** Legacy artifact body retained until first-class artifact metadata is wired downstream. */
export class LocalRunArtifactDto extends Schema.Class<LocalRunArtifactDto>(
  "LocalRunArtifactDto",
)({
  artifactName: LocalRunArtifactIdSchema,
  body: Schema.String,
  contentType: LocalRunArtifactContentTypeSchema,
  runId: RunIdSchema,
}) {}

export class LocalRunListSuccessEnvelope extends Schema.Class<LocalRunListSuccessEnvelope>(
  "LocalRunListSuccessEnvelope",
)({
  data: LocalRunListDto,
  status: Schema.Literal("success"),
}) {}

export class LocalRunListPartialEnvelope extends Schema.Class<LocalRunListPartialEnvelope>(
  "LocalRunListPartialEnvelope",
)({
  data: LocalRunListDto,
  diagnostics: Schema.Array(LocalRunReadDiagnosticDto),
  status: Schema.Literal("partial"),
}) {}

export class LocalRunDetailSuccessEnvelope extends Schema.Class<LocalRunDetailSuccessEnvelope>(
  "LocalRunDetailSuccessEnvelope",
)({
  data: LocalRunSummaryDto,
  status: Schema.Literal("success"),
}) {}

export class FactoryRunListSuccessEnvelope extends Schema.Class<FactoryRunListSuccessEnvelope>(
  "FactoryRunListSuccessEnvelope",
)({
  data: FactoryRunListDto,
  status: Schema.Literal("success"),
}) {}

export class FactoryRunDetailSuccessEnvelope extends Schema.Class<FactoryRunDetailSuccessEnvelope>(
  "FactoryRunDetailSuccessEnvelope",
)({
  data: FactoryRunDetailDto,
  status: Schema.Literal("success"),
}) {}

export class FactoryGraphSuccessEnvelope extends Schema.Class<FactoryGraphSuccessEnvelope>(
  "FactoryGraphSuccessEnvelope",
)({
  data: FactoryGraphDto,
  status: Schema.Literal("success"),
}) {}

export class FactoryActivitySuccessEnvelope extends Schema.Class<FactoryActivitySuccessEnvelope>(
  "FactoryActivitySuccessEnvelope",
)({
  data: FactoryActivityListDto,
  status: Schema.Literal("success"),
}) {}

export class FactoryArtifactListSuccessEnvelope extends Schema.Class<FactoryArtifactListSuccessEnvelope>(
  "FactoryArtifactListSuccessEnvelope",
)({
  data: FactoryArtifactListDto,
  status: Schema.Literal("success"),
}) {}

export class LocalRunArtifactSuccessEnvelope extends Schema.Class<LocalRunArtifactSuccessEnvelope>(
  "LocalRunArtifactSuccessEnvelope",
)({
  data: LocalRunArtifactDto,
  status: Schema.Literal("success"),
}) {}

export class FactoryArtifactSuccessEnvelope extends Schema.Class<FactoryArtifactSuccessEnvelope>(
  "FactoryArtifactSuccessEnvelope",
)({
  data: FactoryArtifactBodyDto,
  status: Schema.Literal("success"),
}) {}

export class LocalRunEventsSuccessEnvelope extends Schema.Class<LocalRunEventsSuccessEnvelope>(
  "LocalRunEventsSuccessEnvelope",
)({
  data: LocalRunEventsDto,
  status: Schema.Literal("success"),
}) {}

export class LocalRunApiErrorEnvelope extends Schema.Class<LocalRunApiErrorEnvelope>(
  "LocalRunApiErrorEnvelope",
)({
  ...diagnosticFields,
  code: LocalRunReadDiagnosticCodeSchema,
  status: LocalRunApiErrorStatusSchema,
}) {}

export class LocalRunApiBadRequest extends Schema.Class<LocalRunApiBadRequest>(
  "LocalRunApiBadRequest",
)({
  ...diagnosticFields,
  code: BadRequestDiagnosticCodeSchema,
  status: Schema.Literal(400),
}) {}

export class LocalRunApiNotFound extends Schema.Class<LocalRunApiNotFound>(
  "LocalRunApiNotFound",
)({
  ...diagnosticFields,
  code: NotFoundDiagnosticCodeSchema,
  status: Schema.Literal(404),
}) {}

export class LocalRunApiMethodNotAllowed extends Schema.Class<LocalRunApiMethodNotAllowed>(
  "LocalRunApiMethodNotAllowed",
)({
  ...diagnosticFields,
  code: MethodNotAllowedDiagnosticCodeSchema,
  status: Schema.Literal(405),
}) {}

export class LocalRunApiConflict extends Schema.Class<LocalRunApiConflict>(
  "LocalRunApiConflict",
)({
  ...diagnosticFields,
  code: ConflictDiagnosticCodeSchema,
  status: Schema.Literal(409),
}) {}

export class LocalRunApiUnprocessable extends Schema.Class<LocalRunApiUnprocessable>(
  "LocalRunApiUnprocessable",
)({
  ...diagnosticFields,
  code: UnprocessableDiagnosticCodeSchema,
  status: Schema.Literal(422),
}) {}

export class LocalRunApiInternalServerError extends Schema.Class<LocalRunApiInternalServerError>(
  "LocalRunApiInternalServerError",
)({
  ...diagnosticFields,
  code: InternalServerDiagnosticCodeSchema,
  status: Schema.Literal(500),
}) {}

export const LocalRunListResponse = Schema.Union([
  LocalRunListSuccessEnvelope,
  LocalRunListPartialEnvelope,
]);

export const LocalRunApiBadRequestResponse =
  LocalRunApiBadRequest.pipe(HttpApiSchema.status(400));
export const LocalRunApiNotFoundResponse =
  LocalRunApiNotFound.pipe(HttpApiSchema.status(404));
export const LocalRunApiMethodNotAllowedResponse =
  LocalRunApiMethodNotAllowed.pipe(HttpApiSchema.status(405));
export const LocalRunApiConflictResponse =
  LocalRunApiConflict.pipe(HttpApiSchema.status(409));
export const LocalRunApiUnprocessableResponse =
  LocalRunApiUnprocessable.pipe(HttpApiSchema.status(422));
export const LocalRunApiInternalServerErrorResponse =
  LocalRunApiInternalServerError.pipe(HttpApiSchema.status(500));

export const LocalRunReadErrorResponse = [
  LocalRunApiBadRequestResponse,
  LocalRunApiNotFoundResponse,
  LocalRunApiUnprocessableResponse,
  LocalRunApiInternalServerErrorResponse,
] as const;

export const LocalRunStreamErrorResponse = [
  LocalRunApiBadRequestResponse,
  LocalRunApiNotFoundResponse,
  LocalRunApiMethodNotAllowedResponse,
  LocalRunApiUnprocessableResponse,
  LocalRunApiInternalServerErrorResponse,
] as const;

export const LocalRunCreateErrorResponse = [
  LocalRunApiBadRequestResponse,
  LocalRunApiMethodNotAllowedResponse,
  LocalRunApiConflictResponse,
  LocalRunApiUnprocessableResponse,
  LocalRunApiInternalServerErrorResponse,
] as const;

export const LocalRunInternalErrorResponse = [
  LocalRunApiInternalServerErrorResponse,
] as const;

export class ServerMetadata extends Schema.Class<ServerMetadata>(
  "ServerMetadata",
)({
  gaiaRoot: Schema.NonEmptyString,
  host: ServerHostSchema,
  pid: Schema.Number.pipe(Schema.check(Schema.isInt({ identifier: "Pid" }))),
  port: Schema.Number.pipe(Schema.check(Schema.isInt({ identifier: "Port" }))),
  serverId: Schema.NonEmptyString,
  startedAt: Schema.NonEmptyString,
  updatedAt: Schema.NonEmptyString,
  url: Schema.NonEmptyString,
  version: Schema.Literal(1),
  workspaceRoot: Schema.NonEmptyString,
}) {}

export class HealthResponse extends Schema.Class<HealthResponse>(
  "HealthResponse",
)({
  gaiaRoot: Schema.NonEmptyString,
  host: ServerHostSchema,
  pid: Schema.Number.pipe(Schema.check(Schema.isInt({ identifier: "Pid" }))),
  port: Schema.Number.pipe(Schema.check(Schema.isInt({ identifier: "Port" }))),
  serverId: Schema.NonEmptyString,
  startedAt: Schema.NonEmptyString,
  status: Schema.Literal("ok"),
  updatedAt: Schema.NonEmptyString,
  url: Schema.NonEmptyString,
  version: Schema.Literal(1),
  workspaceRoot: Schema.NonEmptyString,
}) {}

/** Work item body for the fresh issue delivery run create command. */
export class CreateRunIssueWorkItemRequest extends Schema.Class<CreateRunIssueWorkItemRequest>(
  "CreateRunIssueWorkItemRequest",
)({
  description: Schema.NonEmptyString,
  externalRefs: Schema.optionalKey(Schema.Array(FactoryExternalRefDto)),
  kind: Schema.Literal("issue"),
  title: Schema.NonEmptyString,
}, {
  parseOptions: { onExcessProperty: "error" },
}) {}

/** Fresh factory-run create body for the issueDelivery workflow. */
export class CreateRunRequest extends Schema.Class<CreateRunRequest>(
  "CreateRunRequest",
)({
  workflow: FactoryWorkflowIdSchema,
  workItem: CreateRunIssueWorkItemRequest,
}, {
  parseOptions: { onExcessProperty: "error" },
}) {}

export class CreateRunAcceptedResponse extends Schema.Class<CreateRunAcceptedResponse>(
  "CreateRunAcceptedResponse",
)({
  acceptedAt: Schema.NonEmptyString,
  runId: RunIdSchema,
  status: Schema.Literal("accepted"),
  urls: Schema.Struct({
    activity: Schema.NonEmptyString,
    artifacts: Schema.NonEmptyString,
    factoryGraph: Schema.NonEmptyString,
    run: Schema.NonEmptyString,
  }),
}) {}

export const RunEventStreamResponse = HttpApiSchema.StreamSse({
  data: RunEvent,
  error: LocalRunApiErrorEnvelope,
});

export const HealthGroup = HttpApiGroup.make("health").add(
  HttpApiEndpoint.get("health", "/health", {
    error: LocalRunInternalErrorResponse,
    success: HealthResponse,
  }),
);

export const RunsGroup = HttpApiGroup.make("runs")
  .add(
    HttpApiEndpoint.get("listRuns", "/runs", {
      error: LocalRunInternalErrorResponse,
      success: LocalRunListResponse,
    }),
  )
  .add(
    HttpApiEndpoint.post("createRun", "/runs", {
      error: LocalRunCreateErrorResponse,
      payload: [CreateRunRequest, HttpApiSchema.NoContent],
      success: CreateRunAcceptedResponse.pipe(HttpApiSchema.status(202)),
    }),
  )
  .add(
    HttpApiEndpoint.get("getRun", "/runs/:runId", {
      error: LocalRunReadErrorResponse,
      params: {
        runId: RunIdSchema,
      },
      success: LocalRunDetailSuccessEnvelope,
    }),
  )
  .add(
    HttpApiEndpoint.get("getFactoryGraph", "/runs/:runId/factory-graph", {
      error: LocalRunReadErrorResponse,
      params: {
        runId: RunIdSchema,
      },
      success: FactoryGraphSuccessEnvelope,
    }),
  )
  .add(
    HttpApiEndpoint.get("getRunEvents", "/runs/:runId/events", {
      error: LocalRunReadErrorResponse,
      params: {
        runId: RunIdSchema,
      },
      success: LocalRunEventsSuccessEnvelope,
    }).annotate(OpenApi.Exclude, true),
  )
  .add(
    HttpApiEndpoint.get("streamRunEvents", "/runs/:runId/events/stream", {
      error: LocalRunStreamErrorResponse,
      params: {
        runId: RunIdSchema,
      },
      success: RunEventStreamResponse,
    }).annotate(OpenApi.Exclude, true),
  )
  .add(
    HttpApiEndpoint.get("getRunActivity", "/runs/:runId/activity", {
      error: LocalRunReadErrorResponse,
      params: {
        runId: RunIdSchema,
      },
      success: FactoryActivitySuccessEnvelope,
    }),
  )
  .add(
    HttpApiEndpoint.get("getAgentActivity", "/runs/:runId/agents/:agentId/activity", {
      error: LocalRunReadErrorResponse,
      params: {
        agentId: FactoryAgentIdSchema,
        runId: RunIdSchema,
      },
      success: FactoryActivitySuccessEnvelope,
    }),
  )
  .add(
    HttpApiEndpoint.get("listRunArtifacts", "/runs/:runId/artifacts", {
      error: LocalRunReadErrorResponse,
      params: {
        runId: RunIdSchema,
      },
      success: FactoryArtifactListSuccessEnvelope,
    }),
  )
  .add(
    HttpApiEndpoint.get("getRunArtifact", "/runs/:runId/artifacts/:artifactId", {
      error: LocalRunReadErrorResponse,
      params: {
        artifactId: FactoryArtifactIdSchema,
        runId: RunIdSchema,
      },
      success: LocalRunArtifactSuccessEnvelope,
    }),
  );

export const LocalGaiaServerApi = HttpApi.make("LocalGaiaServerApi")
  .add(HealthGroup)
  .add(RunsGroup)
  .annotate(OpenApi.Title, "Local Gaia Server API")
  .annotate(OpenApi.Version, "0.1.0")
  .annotate(
    OpenApi.Description,
    "Local loopback Gaia server contract for workspace health and run reads.",
  );

export const LocalGaiaServerOpenApi = OpenApi.fromApi(LocalGaiaServerApi);

export type LocalRunApiError =
  | typeof LocalRunApiBadRequest.Type
  | typeof LocalRunApiNotFound.Type
  | typeof LocalRunApiMethodNotAllowed.Type
  | typeof LocalRunApiConflict.Type
  | typeof LocalRunApiUnprocessable.Type
  | typeof LocalRunApiInternalServerError.Type;
