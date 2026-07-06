import * as Schema from "effect/Schema";
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
  OpenApi,
} from "effect/unstable/httpapi";
import { EventTypeSchema, RunEvent, RunStateSchema } from "./events.js";
import { RunIdSchema } from "./run-id.js";

const runIdOpenApiPattern = "^run-[A-Za-z0-9_-]{10}$";

export const LocalRunReadDiagnosticCodeSchema = Schema.Literals([
  "ArtifactNotAllowed",
  "ArtifactNotFound",
  "EndpointNotFound",
  "InternalServerError",
  "InvalidRunDirectory",
  "InvalidRunId",
  "MethodNotAllowed",
  "RunHasNoEvents",
  "RunNotFound",
  "RunUnreadable",
] as const);

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

export class LocalRunReadDiagnostic extends Schema.Class<LocalRunReadDiagnostic>(
  "LocalRunReadDiagnostic",
)({
  artifactName: Schema.optionalKey(Schema.String),
  code: LocalRunReadDiagnosticCodeSchema,
  message: Schema.NonEmptyString,
  pathSegment: Schema.optionalKey(Schema.String),
  recoverable: Schema.Boolean,
  runId: Schema.optionalKey(RunIdSchema),
}) {}

export class LocalRunSummary extends Schema.Class<LocalRunSummary>(
  "LocalRunSummary",
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

export class LocalRunList extends Schema.Class<LocalRunList>("LocalRunList")({
  diagnostics: Schema.Array(LocalRunReadDiagnostic),
  runs: Schema.Array(LocalRunSummary),
}) {}

export class LocalRunEvents extends Schema.Class<LocalRunEvents>("LocalRunEvents")({
  events: Schema.Array(RunEvent),
  runId: RunIdSchema,
}) {}

export class LocalRunArtifact extends Schema.Class<LocalRunArtifact>(
  "LocalRunArtifact",
)({
  artifactName: Schema.NonEmptyString,
  body: Schema.String,
  contentType: LocalRunArtifactContentTypeSchema,
  runId: RunIdSchema,
}) {}

export class LocalRunListSuccess extends Schema.Class<LocalRunListSuccess>(
  "LocalRunListSuccess",
)({
  data: LocalRunList,
  status: Schema.Literal("success"),
}) {}

export class LocalRunListPartial extends Schema.Class<LocalRunListPartial>(
  "LocalRunListPartial",
)({
  data: LocalRunList,
  diagnostics: Schema.Array(LocalRunReadDiagnostic),
  status: Schema.Literal("partial"),
}) {}

export class LocalRunDetailSuccess extends Schema.Class<LocalRunDetailSuccess>(
  "LocalRunDetailSuccess",
)({
  data: LocalRunSummary,
  status: Schema.Literal("success"),
}) {}

export class LocalRunEventsSuccess extends Schema.Class<LocalRunEventsSuccess>(
  "LocalRunEventsSuccess",
)({
  data: LocalRunEvents,
  status: Schema.Literal("success"),
}) {}

export class LocalRunArtifactSuccess extends Schema.Class<LocalRunArtifactSuccess>(
  "LocalRunArtifactSuccess",
)({
  data: LocalRunArtifact,
  status: Schema.Literal("success"),
}) {}

export class ApiBadRequest extends Schema.Class<ApiBadRequest>("ApiBadRequest")({
  error: LocalRunReadDiagnostic,
  status: Schema.Literal("error"),
}) {}

export class ApiNotFound extends Schema.Class<ApiNotFound>("ApiNotFound")({
  error: LocalRunReadDiagnostic,
  status: Schema.Literal("error"),
}) {}

export class ApiMethodNotAllowed extends Schema.Class<ApiMethodNotAllowed>(
  "ApiMethodNotAllowed",
)({
  error: LocalRunReadDiagnostic,
  status: Schema.Literal("error"),
}) {}

export class ApiConflict extends Schema.Class<ApiConflict>("ApiConflict")({
  error: LocalRunReadDiagnostic,
  status: Schema.Literal("error"),
}) {}

export class ApiInternalServerError extends Schema.Class<ApiInternalServerError>(
  "ApiInternalServerError",
)({
  error: LocalRunReadDiagnostic,
  status: Schema.Literal("error"),
}) {}

export const ApiErrorSchemas = [
  ApiBadRequest.pipe(HttpApiSchema.status(400)),
  ApiNotFound.pipe(HttpApiSchema.status(404)),
  ApiMethodNotAllowed.pipe(HttpApiSchema.status(405)),
  ApiConflict.pipe(HttpApiSchema.status(409)),
  ApiInternalServerError.pipe(HttpApiSchema.status(500)),
] as const;

export const ApiError = Schema.Union(ApiErrorSchemas);

const InternalServerErrorSchemas = [
  ApiInternalServerError.pipe(HttpApiSchema.status(500)),
] as const;

const ReadRunErrorSchemas = [
  ApiBadRequest.pipe(HttpApiSchema.status(400)),
  ApiNotFound.pipe(HttpApiSchema.status(404)),
  ApiInternalServerError.pipe(HttpApiSchema.status(500)),
] as const;

const CreateRunErrorSchemas = [
  ApiBadRequest.pipe(HttpApiSchema.status(400)),
  ApiMethodNotAllowed.pipe(HttpApiSchema.status(405)),
  ApiConflict.pipe(HttpApiSchema.status(409)),
  ApiInternalServerError.pipe(HttpApiSchema.status(500)),
] as const;

const StreamRunEventsErrorSchemas = [
  ApiBadRequest.pipe(HttpApiSchema.status(400)),
  ApiNotFound.pipe(HttpApiSchema.status(404)),
  ApiMethodNotAllowed.pipe(HttpApiSchema.status(405)),
  ApiInternalServerError.pipe(HttpApiSchema.status(500)),
] as const;

export class ServerMetadata extends Schema.Class<ServerMetadata>(
  "ServerMetadata",
)({
  gaiaRoot: Schema.NonEmptyString,
  host: Schema.Literal("127.0.0.1"),
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
  server: ServerMetadata,
  status: Schema.Literal("ok"),
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
  eventSequence: Schema.Literal(1),
  runId: RunIdSchema,
  state: Schema.Literal("created"),
  status: Schema.Literal("accepted"),
  urls: Schema.Struct({
    eventStream: Schema.NonEmptyString,
    events: Schema.NonEmptyString,
    run: Schema.NonEmptyString,
  }),
}) {}

export class RunEventStreamEvent extends Schema.Class<RunEventStreamEvent>(
  "RunEventStreamEvent",
)({
  data: Schema.String,
  event: Schema.String,
  id: Schema.optionalKey(Schema.String),
}) {}

const RunParams = Schema.Struct({ runId: Schema.NonEmptyString });
const ArtifactParams = Schema.Struct({
  artifactId: Schema.NonEmptyString,
  runId: Schema.NonEmptyString,
});

const HealthGroup = HttpApiGroup.make("health").add(
  HttpApiEndpoint.get("health", "/health", {
    error: InternalServerErrorSchemas,
    success: HealthResponse,
  }),
);

const RunsGroup = HttpApiGroup.make("runs")
  .add(
    HttpApiEndpoint.get("listRuns", "/runs", {
      error: InternalServerErrorSchemas,
      success: Schema.Union([LocalRunListSuccess, LocalRunListPartial]),
    }),
  )
  .add(
    HttpApiEndpoint.post("createRun", "/runs", {
      error: CreateRunErrorSchemas,
      payload: CreateRunRequest,
      success: CreateRunAcceptedResponse.pipe(HttpApiSchema.status("Accepted")),
    }),
  )
  .add(
    HttpApiEndpoint.get("getRun", "/runs/:runId", {
      error: ReadRunErrorSchemas,
      params: RunParams,
      success: LocalRunDetailSuccess,
    }),
  )
  .add(
    HttpApiEndpoint.get("getRunEvents", "/runs/:runId/events", {
      error: ReadRunErrorSchemas,
      params: RunParams,
      success: LocalRunEventsSuccess,
    }),
  )
  .add(
    HttpApiEndpoint.get("streamRunEvents", "/runs/:runId/events/stream", {
      error: StreamRunEventsErrorSchemas,
      params: RunParams,
      success: HttpApiSchema.StreamSse({
        data: RunEvent,
        error: ApiError,
      }),
    }),
  )
  .add(
    HttpApiEndpoint.get("getArtifact", "/runs/:runId/artifacts/:artifactId", {
      error: ReadRunErrorSchemas,
      params: ArtifactParams,
      success: LocalRunArtifactSuccess,
    }),
  );

export const LocalGaiaServerApi = HttpApi.make("LocalGaiaServerApi")
  .add(HealthGroup)
  .add(RunsGroup)
  .annotate(OpenApi.Transform, addRunIdParamOpenApiPattern);

function addRunIdParamOpenApiPattern(
  document: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const paths = document["paths"];
  if (!isRecord(paths)) {
    return { ...document };
  }

  return {
    ...document,
    paths: Object.fromEntries(
      Object.entries(paths).map(([path, pathItem]) => [
        path,
        transformOpenApiPathItem(pathItem),
      ]),
    ),
  };
}

function transformOpenApiPathItem(pathItem: unknown) {
  if (!isRecord(pathItem)) {
    return pathItem;
  }

  return Object.fromEntries(
    Object.entries(pathItem).map(([method, operation]) => [
      method,
      transformOpenApiOperation(operation),
    ]),
  );
}

function transformOpenApiOperation(operation: unknown) {
  if (!isRecord(operation)) {
    return operation;
  }

  const parameters = operation["parameters"];
  if (!Array.isArray(parameters)) {
    return { ...operation };
  }

  return {
    ...operation,
    parameters: parameters.map((parameter) => {
      if (!isPathParameter(parameter, "runId")) {
        return parameter;
      }

      return {
        ...parameter,
        schema: {
          ...parameter.schema,
          description: "Gaia run identifier formatted as run-<10 url-safe chars>.",
          pattern: runIdOpenApiPattern,
        },
      };
    }),
  };
}

function isRecord(input: unknown): input is Readonly<Record<string, unknown>> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function isPathParameter(
  input: unknown,
  name: string,
): input is {
  readonly in: "path";
  readonly name: string;
  readonly schema: Readonly<Record<string, unknown>>;
} {
  return (
    typeof input === "object" &&
    input !== null &&
    "in" in input &&
    input.in === "path" &&
    "name" in input &&
    input.name === name &&
    "schema" in input &&
    typeof input.schema === "object" &&
    input.schema !== null &&
    !Array.isArray(input.schema)
  );
}
