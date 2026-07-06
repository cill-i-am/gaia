import { Schema } from "effect";
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
  OpenApi,
} from "effect/unstable/httpapi";
import { EventTypeSchema, RunEvent, RunStateSchema } from "./events.js";
import { RunIdSchema } from "./run-id.js";

export const LocalRunReadDiagnosticCodeSchema = Schema.Literals([
  "ActiveRunConflict",
  "ArtifactNotAllowed",
  "ArtifactNotFound",
  "EndpointNotFound",
  "InvalidRunDirectory",
  "InvalidRunId",
  "InternalServerError",
  "MethodNotAllowed",
  "RunHasNoEvents",
  "RunNotFound",
  "RunUnreadable",
] as const);

const BadRequestDiagnosticCodeSchema = Schema.Literals(["InvalidRunId"] as const);
const NotFoundDiagnosticCodeSchema = Schema.Literals([
  "ArtifactNotAllowed",
  "ArtifactNotFound",
  "EndpointNotFound",
  "RunNotFound",
] as const);
const MethodNotAllowedDiagnosticCodeSchema = Schema.Literals([
  "MethodNotAllowed",
] as const);
const ConflictDiagnosticCodeSchema = Schema.Literals([
  "ActiveRunConflict",
] as const);
const UnprocessableDiagnosticCodeSchema = Schema.Literals([
  "InvalidRunDirectory",
  "RunHasNoEvents",
  "RunUnreadable",
] as const);
const InternalServerDiagnosticCodeSchema = Schema.Literals([
  "InternalServerError",
] as const);

const diagnosticFields = {
  artifactName: Schema.optionalKey(Schema.String),
  message: Schema.NonEmptyString,
  pathSegment: Schema.optionalKey(Schema.String),
  recoverable: Schema.Boolean,
  runId: Schema.optionalKey(RunIdSchema),
};

export const LocalRunStatusSchema = Schema.Literals([
  "completed",
  "failed",
  "running",
] as const);

export const LocalRunArtifactContentTypeSchema = Schema.Literals([
  "application/json",
  "text/markdown",
  "text/plain",
] as const);

export const ServerHostSchema = Schema.Literal("127.0.0.1");

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

class BadRequestDiagnosticDto extends Schema.Class<BadRequestDiagnosticDto>(
  "BadRequestDiagnosticDto",
)({
  ...diagnosticFields,
  code: BadRequestDiagnosticCodeSchema,
}) {}

class NotFoundDiagnosticDto extends Schema.Class<NotFoundDiagnosticDto>(
  "NotFoundDiagnosticDto",
)({
  ...diagnosticFields,
  code: NotFoundDiagnosticCodeSchema,
}) {}

class MethodNotAllowedDiagnosticDto extends Schema.Class<MethodNotAllowedDiagnosticDto>(
  "MethodNotAllowedDiagnosticDto",
)({
  ...diagnosticFields,
  code: MethodNotAllowedDiagnosticCodeSchema,
}) {}

class ConflictDiagnosticDto extends Schema.Class<ConflictDiagnosticDto>(
  "ConflictDiagnosticDto",
)({
  ...diagnosticFields,
  code: ConflictDiagnosticCodeSchema,
}) {}

class UnprocessableDiagnosticDto extends Schema.Class<UnprocessableDiagnosticDto>(
  "UnprocessableDiagnosticDto",
)({
  ...diagnosticFields,
  code: UnprocessableDiagnosticCodeSchema,
}) {}

class InternalServerDiagnosticDto extends Schema.Class<InternalServerDiagnosticDto>(
  "InternalServerDiagnosticDto",
)({
  ...diagnosticFields,
  code: InternalServerDiagnosticCodeSchema,
}) {}

export class LocalRunSummaryDto extends Schema.Class<LocalRunSummaryDto>(
  "LocalRunSummaryDto",
)({
  artifacts: Schema.Array(Schema.String),
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

export class LocalRunListDto extends Schema.Class<LocalRunListDto>(
  "LocalRunListDto",
)({
  diagnostics: Schema.Array(LocalRunReadDiagnosticDto),
  runs: Schema.Array(LocalRunSummaryDto),
}) {}

export class LocalRunEventsDto extends Schema.Class<LocalRunEventsDto>(
  "LocalRunEventsDto",
)({
  events: Schema.Array(RunEvent),
  runId: RunIdSchema,
}) {}

export class LocalRunArtifactDto extends Schema.Class<LocalRunArtifactDto>(
  "LocalRunArtifactDto",
)({
  artifactName: Schema.String,
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

export class LocalRunEventsSuccessEnvelope extends Schema.Class<LocalRunEventsSuccessEnvelope>(
  "LocalRunEventsSuccessEnvelope",
)({
  data: LocalRunEventsDto,
  status: Schema.Literal("success"),
}) {}

export class LocalRunArtifactSuccessEnvelope extends Schema.Class<LocalRunArtifactSuccessEnvelope>(
  "LocalRunArtifactSuccessEnvelope",
)({
  data: LocalRunArtifactDto,
  status: Schema.Literal("success"),
}) {}

export class LocalRunApiErrorEnvelope extends Schema.Class<LocalRunApiErrorEnvelope>(
  "LocalRunApiErrorEnvelope",
)({
  error: LocalRunReadDiagnosticDto,
  status: Schema.Literal("error"),
}) {}

export class LocalRunApiBadRequest extends Schema.Class<LocalRunApiBadRequest>(
  "LocalRunApiBadRequest",
)({
  error: BadRequestDiagnosticDto,
  status: Schema.Literal("error"),
}) {}

export class LocalRunApiNotFound extends Schema.Class<LocalRunApiNotFound>(
  "LocalRunApiNotFound",
)({
  error: NotFoundDiagnosticDto,
  status: Schema.Literal("error"),
}) {}

export class LocalRunApiMethodNotAllowed extends Schema.Class<LocalRunApiMethodNotAllowed>(
  "LocalRunApiMethodNotAllowed",
)({
  error: MethodNotAllowedDiagnosticDto,
  status: Schema.Literal("error"),
}) {}

export class LocalRunApiConflict extends Schema.Class<LocalRunApiConflict>(
  "LocalRunApiConflict",
)({
  error: ConflictDiagnosticDto,
  status: Schema.Literal("error"),
}) {}

export class LocalRunApiUnprocessable extends Schema.Class<LocalRunApiUnprocessable>(
  "LocalRunApiUnprocessable",
)({
  error: UnprocessableDiagnosticDto,
  status: Schema.Literal("error"),
}) {}

export class LocalRunApiInternalServerError extends Schema.Class<LocalRunApiInternalServerError>(
  "LocalRunApiInternalServerError",
)({
  error: InternalServerDiagnosticDto,
  status: Schema.Literal("error"),
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

export const LocalRunCreateErrorResponse = [
  LocalRunApiBadRequestResponse,
  LocalRunApiMethodNotAllowedResponse,
  LocalRunApiConflictResponse,
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

export class CreateRunRequest extends Schema.Class<CreateRunRequest>(
  "CreateRunRequest",
)({
  specMarkdown: Schema.NonEmptyString,
  title: Schema.optionalKey(Schema.NonEmptyString),
}) {}

export class CreateRunAcceptedResponse extends Schema.Class<CreateRunAcceptedResponse>(
  "CreateRunAcceptedResponse",
)({
  acceptedAt: Schema.NonEmptyString,
  runId: RunIdSchema,
  status: Schema.Literal("accepted"),
  urls: Schema.Struct({
    eventStream: Schema.NonEmptyString,
    events: Schema.NonEmptyString,
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
      payload: [HttpApiSchema.NoContent, CreateRunRequest],
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
    HttpApiEndpoint.get("getRunEvents", "/runs/:runId/events", {
      error: LocalRunReadErrorResponse,
      params: {
        runId: RunIdSchema,
      },
      success: LocalRunEventsSuccessEnvelope,
    }),
  )
  .add(
    HttpApiEndpoint.get("streamRunEvents", "/runs/:runId/events/stream", {
      error: LocalRunStreamErrorResponse,
      params: {
        runId: RunIdSchema,
      },
      success: RunEventStreamResponse,
    }),
  )
  .add(
    HttpApiEndpoint.get("getRunArtifact", "/runs/:runId/artifacts/:artifactId", {
      error: LocalRunReadErrorResponse,
      params: {
        artifactId: Schema.String,
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
