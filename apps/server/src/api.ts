import {
  AgentActionSuccessEnvelope,
  AgentSessionSnapshotSuccessEnvelope,
  DeliveryModeSchema,
  DeliveryPublicationDto,
  DeliveryPublicationAttemptedDto,
  DeliveryPublicationConfirmedDto,
  DeliveryPublicationFailureDto,
  DeliveryPublicationIntentDto,
  DeliveryProvenanceDto,
  DeliverySnapshotDto,
  DeliverySnapshotSuccessEnvelope,
  WorkerRecoverySuccessEnvelope,
  DeliveryStatusSchema,
  FactoryActivitySuccessEnvelope,
  CreateRunAcceptedResponse,
  FactoryArtifactListSuccessEnvelope,
  FactoryArtifactSuccessEnvelope,
  FactoryGraphDto,
  FactoryGraphSuccessEnvelope,
  FactoryActivityListDto,
  FactoryArtifactListDto,
  FactoryRunDetailDto,
  FactoryRunDetailSuccessEnvelope,
  FactoryRunListDto,
  FactoryRunListSuccessEnvelope,
  FactoryRunSummaryDto,
  HealthResponse,
  LocalGaiaServerApi,
  LocalRunApiBadRequest,
  LocalRunApiConflict,
  LocalRunApiInternalServerError,
  LocalRunApiErrorEnvelope,
  LocalRunApiMethodNotAllowed,
  LocalRunApiNotFound,
  LocalRunApiUnprocessable,
  LocalRunEventsSuccessEnvelope,
  type LocalRunApiError,
  LocalRunReadDiagnosticDto,
  type RunId,
  RunEvent,
  parseDeliveryPublication,
  parseDeliveryPullRequestObservation,
  parseDeliveryRemediation,
  parseDeliveryMergeReceipt,
  parseDeliveryMergeReadinessDecision,
  parseDeliveryCleanupReceipt,
  snapshotFromReplay,
  deriveDeliveryActionHistoriesFromEvents,
  deliveryActionAuditSummary,
  parseWorkerRecoveryReceipt,
  workerRecoveryProjection,
  type WorkerRecoveryAction,
} from "@gaia/core";
import type {
  LocalRunList,
  LocalRunReadDiagnostic,
} from "@gaia/runtime/run-read-api";
import { readLocalRunEvents } from "@gaia/runtime/run-read-api";
import {
  GaiaRuntimeError,
  makeRuntimeError,
  makeRunPaths,
  makeLocalRunReadIndex,
  subscribeRunEventFeed,
  dispatchAgentSessionAction,
  makeLiveHarnessSessionCoordinator,
  readAgentSessionSnapshot,
  streamAgentSessionUpdates,
  type LocalRunReadIndex,
} from "@gaia/runtime";
import { Cause, Context, Effect, FileSystem, Layer, Option, Path, Schema, Scope, Stream } from "effect";
import type { Generator } from "effect/unstable/http/Etag";
import type { HttpPlatform } from "effect/unstable/http/HttpPlatform";
import {
  HttpEffect,
  HttpRouter,
  HttpServer,
  HttpServerResponse,
} from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import {
  actOnDeliveryPublication,
  actOnDeliveryRemediation,
  actOnDeliveryMerge,
  actOnWorkerRecovery,
  acceptFactoryRun,
  continueServerRun,
  type ServerRunAcceptance,
  type ServerWorkflowOptions,
} from "@gaia/runtime/server-workflows";
import {
  listFactoryRunArtifacts,
  readFactoryAgentActivity,
  readFactoryGraph,
  readFactoryRunActivity,
  readFactoryRunArtifact,
} from "@gaia/runtime/factory-run-read-api";
import {
  appendServerLog,
  serverMetadataFromAddress,
  type LocalServerIdentity,
} from "./discovery.js";
import {
  ActiveServerRunConflict,
  makeServerRunRegistry,
  type ServerRunReservation,
  type ServerRunRegistryService,
} from "./server-state.js";

type LocalServerConfigValue = LocalServerIdentity & {
  readonly runIndex: LocalRunReadIndex;
  readonly runRegistry: ServerRunRegistryService;
  readonly runScope: Scope.Scope;
  readonly sessionCoordinator: ReturnType<typeof makeLiveHarnessSessionCoordinator>;
  readonly subscribeDeliveryRunEventFeed: typeof subscribeRunEventFeed;
  readonly workflowOptions: ServerWorkflowOptions;
};

/** Finite recovery transaction: persist one receipt, then join its confirmed continuation. */
export function executeWorkerRecoveryTransaction(input: {
  readonly action: WorkerRecoveryAction;
  readonly identity: LocalServerConfigValue;
  readonly runId: string;
}) {
  return Effect.gen(function* () {
    const receipt = yield* actOnWorkerRecovery(input.runId, input.action, {
      ...input.identity.workflowOptions,
      rootDirectory: input.identity.rootDirectory,
    });
    if (receipt.state === "dispatchConfirmed") {
      yield* continueServerRun(input.runId, {
        ...input.identity.workflowOptions,
        rootDirectory: input.identity.rootDirectory,
        sessionCoordinator: input.identity.sessionCoordinator,
      }).pipe(Effect.ignore);
    }
    return receipt;
  });
}

export class LocalServerConfig extends Context.Service<
  LocalServerConfig,
  LocalServerConfigValue
>()("@gaia/server/LocalServerConfig") {}

const decodeFactoryRunSummary = Schema.decodeUnknownSync(FactoryRunSummaryDto);
const decodeFactoryRunDetail = Schema.decodeUnknownSync(FactoryRunDetailDto);
const decodeFactoryRunList = Schema.decodeUnknownSync(FactoryRunListDto);
const decodeDeliveryProjection = Schema.decodeUnknownOption(
  Schema.Struct({
    baseBranch: Schema.NonEmptyString,
    baseRevision: Schema.NonEmptyString,
    headBranch: Schema.NonEmptyString,
    mode: DeliveryModeSchema,
    observation: Schema.optionalKey(Schema.Json),
    publication: Schema.optionalKey(Schema.Json),
    remediation: Schema.optionalKey(Schema.Json),
    mergeDecision: Schema.optionalKey(Schema.Json),
    mergeDecisionSequence: Schema.optionalKey(Schema.Int),
    remediationRearmSequence: Schema.optionalKey(Schema.Int),
    remote: Schema.NonEmptyString,
    stage: DeliveryStatusSchema,
  }),
);

export const HealthLive = HttpApiBuilder.group(
  LocalGaiaServerApi,
  "health",
  (handlers) =>
    handlers.handle("health", () =>
      Effect.gen(function* () {
        const identity = yield* LocalServerConfig;
        const server = yield* HttpServer.HttpServer;
        const metadata = yield* serverMetadataFromAddress(
          identity,
          server.address,
        ).pipe(Effect.mapError((error) => internalApiError(error)));
        return HealthResponse.make({
          ...metadata,
          status: "ok",
        });
      }),
    ),
);

export const RunsLive = HttpApiBuilder.group(
  LocalGaiaServerApi,
  "runs",
  (handlers) =>
    handlers
      .handle("listRuns", () =>
        Effect.gen(function* () {
          const identity = yield* LocalServerConfig;
          yield* identity.runIndex.rebuild.pipe(
            Effect.mapError((error) => internalApiError(error)),
          );
          const runs = yield* identity.runIndex.list;
          const factoryRuns = yield* factoryRunListFromLocalRuns(identity, runs);
          return FactoryRunListSuccessEnvelope.make({
            data: factoryRuns,
            status: "success",
          });
        }),
      )
      .handle("createRun", ({ payload }) =>
        Effect.gen(function* () {
          if (payload === undefined) {
            return yield* Effect.fail(
              createApiError({
                code: "InvalidRequest",
                message: "Create run requests must include a JSON body.",
                recoverable: false,
              }),
            );
          }

          const identity = yield* LocalServerConfig;
          const reservation = yield* identity.runRegistry.reserveCreate.pipe(
            Effect.mapError((error) => activeRunConflictApiError(error)),
          );
          const acceptedExit = yield* Effect.exit(
            acceptFactoryRun(payload, {
              ...identity.workflowOptions,
              rootDirectory: identity.rootDirectory,
            }),
          );

          if (acceptedExit._tag === "Failure") {
            yield* reservation.rollback;
            return yield* Effect.fail(apiErrorFromCause(acceptedExit.cause));
          }

          const accepted = acceptedExit.value;
          yield* identity.runIndex.refreshRun(accepted.runId);
          yield* reservation.markAccepted(accepted.runId);
          yield* forkServerContinuation({
            accepted,
            identity,
            reservation,
          });

          return CreateRunAcceptedResponse.make({
            acceptedAt: accepted.acceptedAt,
            runId: accepted.runId,
            status: "accepted",
            urls: {
              activity: `/runs/${accepted.runId}/activity`,
              artifacts: `/runs/${accepted.runId}/artifacts`,
              factoryGraph: `/runs/${accepted.runId}/factory-graph`,
              run: `/runs/${accepted.runId}`,
            },
          });
        }),
      )
      .handle("getRun", ({ params }) =>
        Effect.gen(function* () {
          const identity = yield* LocalServerConfig;
          yield* identity.runIndex.refreshRun(params.runId);
          const exit = yield* Effect.exit(readFactoryRunProjection(identity, params.runId));
          if (exit._tag === "Success") {
            return FactoryRunDetailSuccessEnvelope.make({
              data: factoryRunDetailFromProjection(exit.value),
              status: "success",
            });
          }

          return yield* Effect.fail(readApiErrorFromCause(exit.cause));
        }),
      )
      .handle("getFactoryGraph", ({ params }) =>
        Effect.gen(function* () {
          const identity = yield* LocalServerConfig;
          const exit = yield* Effect.exit(
            readFactoryGraph(params.runId, {
              rootDirectory: identity.rootDirectory,
            }),
          );
          if (exit._tag === "Success") {
            return FactoryGraphSuccessEnvelope.make({
              data: exit.value,
              status: "success",
            });
          }

          return yield* Effect.fail(readApiErrorFromCause(exit.cause));
        }),
      )
      .handle("getRunActivity", ({ params }) =>
        Effect.gen(function* () {
          const identity = yield* LocalServerConfig;
          const exit = yield* Effect.exit(
            readFactoryRunActivity(params.runId, {
              rootDirectory: identity.rootDirectory,
            }),
          );
          if (exit._tag === "Success") {
            return FactoryActivitySuccessEnvelope.make({
              data: exit.value,
              status: "success",
            });
          }

          return yield* Effect.fail(readApiErrorFromCause(exit.cause));
        }),
      )
      .handle("getDeliverySnapshot", ({ params }) =>
        Effect.gen(function* () {
          const identity = yield* LocalServerConfig;
          const exit = yield* Effect.exit(
            readDeliverySnapshot(params.runId, identity.rootDirectory),
          );
          if (exit._tag === "Success") {
            return DeliverySnapshotSuccessEnvelope.make({
              data: exit.value,
              status: "success",
            });
          }

          return yield* Effect.fail(readApiErrorFromCause(exit.cause));
        }),
      )
      .handle("streamDeliverySnapshot", ({ params, query }) =>
        Effect.gen(function* () {
          const identity = yield* LocalServerConfig;
          const stream = yield* streamDeliveryUpdates(
            params.runId,
            query.afterSequence,
            {
              rootDirectory: identity.rootDirectory,
              subscribeRunEventFeed: identity.subscribeDeliveryRunEventFeed,
            },
          );
          return stream.pipe(
            Stream.map((update) => ({
              data: update,
              event: "delivery-update" as const,
              id: String(update.eventSequence),
            })),
            Stream.mapError(streamApiError),
          );
        }).pipe(Effect.mapError((error) => actionApiErrorFromCause(Cause.fail(error)))),
      )
      .handle("actOnDelivery", ({ params, payload }) =>
        Effect.gen(function* () {
          const identity = yield* LocalServerConfig;
          const workflowOptions = {
            ...identity.workflowOptions,
            rootDirectory: identity.rootDirectory,
          };
          const exit = yield* Effect.exit(
            payload.kind === "activateRemediation"
              ? (identity.workflowOptions.deliveryRemediationActivator ??
                  actOnDeliveryRemediation)(
                    params.runId,
                    payload,
                    workflowOptions,
                  )
              : payload.kind === "merge" || payload.kind === "retryCleanup" || payload.kind === "evaluateMergeReadiness"
                ? (identity.workflowOptions.deliveryMergeActivator ?? actOnDeliveryMerge)(
                    params.runId,
                    payload,
                    workflowOptions,
                  )
              : actOnDeliveryPublication(
                  params.runId,
                  payload,
                  workflowOptions,
                ),
          );
          if (exit._tag === "Failure") {
            return yield* Effect.fail(actionApiErrorFromCause(exit.cause));
          }
          const snapshotExit = yield* Effect.exit(
            readDeliverySnapshot(params.runId, identity.rootDirectory),
          );
          if (snapshotExit._tag === "Failure") {
            return yield* Effect.fail(readApiErrorFromCause(snapshotExit.cause));
          }
          return DeliverySnapshotSuccessEnvelope.make({
            data: snapshotExit.value,
            status: "success",
          });
        }),
      )
      .handle("recoverWorker", ({ params, payload }) =>
        Effect.gen(function* () {
          const identity = yield* LocalServerConfig;
          const exit = yield* Effect.exit(executeWorkerRecoveryTransaction({ action: payload, identity, runId: params.runId }));
          if (exit._tag === "Failure") return yield* Effect.fail(actionApiErrorFromCause(exit.cause));
          yield* identity.runIndex.refreshRun(params.runId);
          return WorkerRecoverySuccessEnvelope.make({ data: exit.value, status: "success" });
        }),
      )
      .handle("getAgentActivity", ({ params }) =>
        Effect.gen(function* () {
          const identity = yield* LocalServerConfig;
          const exit = yield* Effect.exit(
            readFactoryAgentActivity(params.runId, params.agentId, {
              rootDirectory: identity.rootDirectory,
            }),
          );
          if (exit._tag === "Success") {
            return FactoryActivitySuccessEnvelope.make({
              data: exit.value,
              status: "success",
            });
          }

          return yield* Effect.fail(readApiErrorFromCause(exit.cause));
        }),
      )
      .handle("getAgentSession", ({ params }) =>
        Effect.gen(function* () {
          const identity = yield* LocalServerConfig;
          const exit = yield* Effect.exit(readAgentSessionSnapshot(params.runId, params.agentId, { rootDirectory: identity.rootDirectory }));
          if (exit._tag === "Failure") return yield* Effect.fail(readApiErrorFromCause(exit.cause));
          return AgentSessionSnapshotSuccessEnvelope.make({ data: exit.value, status: "success" });
        }),
      )
      .handle("streamAgentSession", ({ params, query }) =>
        Effect.gen(function* () {
          const identity = yield* LocalServerConfig;
          const stream = yield* streamAgentSessionUpdates(params.runId, params.agentId, query.afterSequence, { rootDirectory: identity.rootDirectory });
          return stream.pipe(
            Stream.map((update) => ({ data: update, event: "agent-session-update" as const, id: String(update.eventSequence) })),
            Stream.mapError(streamApiError),
          );
        }).pipe(Effect.mapError((error) => actionApiErrorFromCause(Cause.fail(error)))),
      )
      .handle("actOnAgentSession", ({ params, payload }) =>
        Effect.gen(function* () {
          const identity = yield* LocalServerConfig;
          const exit = yield* Effect.exit(dispatchAgentSessionAction({ action: payload, agentId: params.agentId, coordinator: identity.sessionCoordinator, options: { rootDirectory: identity.rootDirectory }, runId: params.runId }));
          if (exit._tag === "Failure") return yield* Effect.fail(actionApiErrorFromCause(exit.cause));
          return AgentActionSuccessEnvelope.make({ data: exit.value, status: "success" });
        }),
      )
      .handle("listRunArtifacts", ({ params }) =>
        Effect.gen(function* () {
          const identity = yield* LocalServerConfig;
          const exit = yield* Effect.exit(
            listFactoryRunArtifacts(params.runId, {
              rootDirectory: identity.rootDirectory,
            }),
          );
          if (exit._tag === "Success") {
            return FactoryArtifactListSuccessEnvelope.make({
              data: exit.value,
              status: "success",
            });
          }

          return yield* Effect.fail(readApiErrorFromCause(exit.cause));
        }),
      )
      .handle("getRunEvents", ({ params }) =>
        Effect.gen(function* () {
          const identity = yield* LocalServerConfig;
          const exit = yield* Effect.exit(
            readLocalRunEvents(params.runId, {
              rootDirectory: identity.rootDirectory,
            }),
          );
          if (exit._tag === "Success") {
            return LocalRunEventsSuccessEnvelope.make({
              data: { ...exit.value, events: exit.value.events.map(publicRunEvent) },
              status: "success",
            });
          }

          return yield* Effect.fail(readApiErrorFromCause(exit.cause));
        }),
      )
      .handle("streamRunEvents", ({ params }) =>
        Effect.gen(function* () {
          const identity = yield* LocalServerConfig;
          const initialRead = yield* Effect.exit(
            readLocalRunEvents(params.runId, {
              rootDirectory: identity.rootDirectory,
            }),
          );
          if (initialRead._tag === "Failure") {
            return yield* Effect.fail(readApiErrorFromCause(initialRead.cause));
          }

          const context = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
          return streamRunEvents({
            rootDirectory: identity.rootDirectory,
            runId: params.runId,
          }).pipe(Stream.map(publicRunEvent), Stream.provideContext(context));
        }),
      )
      .handle("getRunArtifact", ({ params }) =>
        Effect.gen(function* () {
          const identity = yield* LocalServerConfig;
          const exit = yield* Effect.exit(
            readFactoryRunArtifact(params.runId, params.artifactId, {
              rootDirectory: identity.rootDirectory,
            }),
          );
          if (exit._tag === "Success") {
            return FactoryArtifactSuccessEnvelope.make({
              data: exit.value,
              status: "success",
            });
          }

          return yield* Effect.fail(readApiErrorFromCause(exit.cause));
        }),
      ),
);

export const LocalGaiaServerApiLayer = HttpApiBuilder.layer(LocalGaiaServerApi).pipe(
  Layer.provide(HealthLive),
  Layer.provide(RunsLive),
);

export function makeLocalGaiaServerLayer(
  identity: LocalServerIdentity,
  workflowOptions: ServerWorkflowOptions = {},
  resumableRunIds: ReadonlyArray<string> = [],
  options: {
    readonly subscribeDeliveryRunEventFeed?: typeof subscribeRunEventFeed;
  } = {},
): Layer.Layer<
  never,
  unknown,
  | FileSystem.FileSystem
  | Path.Path
  | HttpServer.HttpServer
  | HttpPlatform
  | Generator
> {
  const configLayer = Layer.effect(
    LocalServerConfig,
    Effect.gen(function* () {
      const runIndex = yield* makeLocalRunReadIndex({
        rootDirectory: identity.rootDirectory,
      });
      const runRegistry = yield* makeServerRunRegistry();
      const sessionCoordinator = makeLiveHarnessSessionCoordinator();
      yield* Effect.addFinalizer(() => sessionCoordinator.shutdown);
      const runScope = yield* Scope.make();
      yield* Effect.addFinalizer((exit) => Scope.close(runScope, exit));
      for (const runId of resumableRunIds) {
        yield* continueServerRun(runId, {
          ...workflowOptions,
          rootDirectory: identity.rootDirectory,
          sessionCoordinator,
        }).pipe(
          Effect.matchEffect({
            onFailure: (error) =>
              appendServerLog(
                identity.rootDirectory,
                `${new Date().toISOString()} ${identity.serverId} resumed run ${runId} failed ${error.code}`,
              ).pipe(Effect.ignore),
            onSuccess: () => Effect.void,
          }),
          Effect.forkIn(runScope),
        );
      }
      const scopedWorkflowOptions = { ...workflowOptions, sessionCoordinator };
      return {
        ...identity,
        runIndex,
        runRegistry,
        runScope,
        sessionCoordinator,
        subscribeDeliveryRunEventFeed:
          options.subscribeDeliveryRunEventFeed ?? subscribeRunEventFeed,
        workflowOptions: scopedWorkflowOptions,
      } satisfies LocalServerConfigValue;
    }),
  );

  return HttpRouter.serve(LocalGaiaServerApiLayer, {
    disableListenLog: true,
    disableLogger: true,
    middleware: structuredServerErrors,
  }).pipe(
    Layer.provide(configLayer),
  );
}

type FactoryRunProjection = {
  readonly activity: typeof FactoryActivityListDto.Type;
  readonly artifacts: typeof FactoryArtifactListDto.Type;
  readonly graph: typeof FactoryGraphDto.Type;
};
type FactoryListDiagnostic = typeof FactoryGraphDto.Type["diagnostics"][number];

function factoryRunListFromLocalRuns(
  identity: LocalServerConfigValue,
  runs: LocalRunList,
): Effect.Effect<typeof FactoryRunListDto.Type, never, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const summaries: Array<typeof FactoryRunSummaryDto.Type> = [];
    const diagnostics: Array<FactoryListDiagnostic> = runs.diagnostics.map(
      factoryListDiagnosticFromLocalRead,
    );

    for (const run of runs.runs) {
      const projectionExit = yield* Effect.exit(
        readFactoryRunProjection(identity, run.runId),
      );
      if (projectionExit._tag === "Success") {
        summaries.push(factoryRunSummaryFromProjection(projectionExit.value));
        continue;
      }

      diagnostics.push(
        factoryListDiagnosticFromApiDiagnostic(
          causeToDiagnostic(projectionExit.cause),
          run.runId,
        ),
      );
    }

    return decodeFactoryRunList({
      diagnostics,
      runs: summaries,
    });
  });
}

function readFactoryRunProjection(
  identity: LocalServerConfigValue,
  runId: string,
): Effect.Effect<FactoryRunProjection, unknown, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const options = { rootDirectory: identity.rootDirectory };
    const graph = yield* readFactoryGraph(runId, options);
    const activity = yield* readFactoryRunActivity(runId, options);
    const artifacts = yield* listFactoryRunArtifacts(runId, options);
    if (graph.workItems[0] === undefined) {
      return yield* Effect.fail({
        code: "FactoryGraphNotFound",
        message: "Factory graph projection does not contain a root work item.",
        recoverable: false,
        runId: graph.runId,
      } satisfies LocalRunReadDiagnostic);
    }

    return { activity, artifacts, graph };
  });
}

function readDeliverySnapshot(
  runId: RunId,
  rootDirectory: string,
): Effect.Effect<typeof DeliverySnapshotDto.Type, unknown, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const events = yield* readLocalRunEvents(runId, { rootDirectory });
    const update = deliveryUpdateFromEvents(events.runId, events.events);

    if (update === undefined) {
      return DeliverySnapshotDto.make({
        eventSequence: 0,
        mode: "local",
        recoveryActions: [],
        runId: events.runId,
        stage: "unavailable",
        status: "unavailable",
      });
    }

    return update;
  });
}

function streamDeliveryUpdates(
  runId: RunId,
  afterSequence: number | undefined,
  options: {
    readonly rootDirectory: string;
    readonly subscribeRunEventFeed: typeof subscribeRunEventFeed;
  },
): Effect.Effect<Stream.Stream<typeof DeliverySnapshotDto.Type, GaiaRuntimeError>, GaiaRuntimeError, FileSystem.FileSystem | Path.Path | Scope.Scope> {
  return Effect.gen(function* () {
    const paths = yield* makeRunPaths(runId, options).pipe(
      Effect.mapError((cause) =>
        makeRuntimeError({
          cause,
          code: "InvalidRunDirectory",
          message: "Run directory could not be resolved.",
          recoverable: false,
        }),
      ),
    );
    const subscription = yield* options.subscribeRunEventFeed(paths).pipe(
      Effect.mapError((cause) =>
        makeRuntimeError({
          cause,
          code: "RunUnreadable",
          message: "Run could not be read from events.jsonl.",
          recoverable: false,
        }),
      ),
    );
    if (subscription.backlog.length === 0) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "RunHasNoEvents",
          message: "Run does not have an events.jsonl history.",
          recoverable: false,
        }),
      );
    }
    if (afterSequence !== undefined && (!Number.isInteger(afterSequence) || afterSequence < 1)) {
      return yield* Effect.fail(makeRuntimeError({ code: "InvalidRequest", message: "Delivery stream cursor must be a positive Gaia sequence.", recoverable: false }));
    }
    if (afterSequence !== undefined && afterSequence > subscription.highWater) {
      return yield* Effect.fail(makeRuntimeError({ code: "DeliveryStreamCursorConflict", message: "Delivery stream cursor is ahead of authoritative run history.", recoverable: true }));
    }
    const cursor = afterSequence ?? 0;
    const backlogEvents = subscription.backlog.filter((event) => event.sequence > cursor && event.sequence <= subscription.highWater);
    const backlog = deliveryUpdatesFromEvents(runId, subscription.backlog, backlogEvents);
    const live = subscription.live.pipe(
      Stream.filter((event) => event.sequence > subscription.highWater),
      Stream.mapAccum(() => subscription.backlog, (history, event) => {
        const next = [...history, event];
        const update = deliveryUpdateFromEvents(runId, next);
        return [next, update === undefined || update.eventSequence !== event.sequence ? [] : [update]] as const;
      }),
    );
    return Stream.fromIterable(backlog).pipe(
      Stream.concat(live),
      Stream.takeUntil((update) =>
        update.stage === "publicationFailed" ||
        update.stage === "publicationOutcomeUnknown" ||
        update.stage === "remediationFailed" ||
        update.stage === "remediationOutcomeUnknown" ||
        update.stage === "failed"
      ),
    );
  });
}

function deliveryUpdatesFromEvents(
  runId: RunId,
  history: ReadonlyArray<RunEvent>,
  events: ReadonlyArray<RunEvent>,
) {
  return events.flatMap((event) => {
    const update = deliveryUpdateFromEvents(
      runId,
      history.filter((candidate) => candidate.sequence <= event.sequence),
    );
    return update === undefined || update.eventSequence !== event.sequence ? [] : [update];
  });
}

function deliveryUpdateFromEvents(
  runId: RunId,
  events: ReadonlyArray<RunEvent>,
) {
  if (events.length === 0) return undefined;
  const snapshot = snapshotFromReplay(events);
  const delivery = decodeDeliveryProjection(snapshot.context["delivery"]).pipe(
    Option.getOrUndefined,
  );
  const eventSequence = events.at(-1)?.sequence ?? 0;
  const workerRecoveryEvent = [...events].reverse().find(({ type }) => type === "WORKER_RECOVERY_RECORDED");
  const workerRecovery = workerRecoveryEvent === undefined ? undefined : parseWorkerRecoveryReceipt(workerRecoveryEvent.payload["recovery"]);

  if (delivery === undefined || delivery.mode === "local") {
    const status = snapshot.state === "failed" ? "failed" : snapshot.state === "completed" ? "readyToPublish" : "unavailable";
    return DeliverySnapshotDto.make({
      eventSequence,
      mode: "local",
      recoveryActions: [],
      runId,
      stage: status,
      status,
    });
  }

  const recoveryStage = workerRecoveryProjection(workerRecovery);
  const stage = recoveryStage === undefined ? (snapshot.state === "failed" ? "failed" : delivery.stage) : recoveryStage;
  const publication =
    delivery.publication === undefined
      ? undefined
      : parseDeliveryPublication(delivery.publication);
  const observation = delivery.observation === undefined
    ? undefined
    : parseDeliveryPullRequestObservation(delivery.observation);
  const remediation = delivery.remediation === undefined
    ? undefined
    : parseDeliveryRemediation(delivery.remediation);
  const actionHistories = deriveDeliveryActionHistoriesFromEvents(events);
  const activeMergeAction = actionHistories.merge.active?.latest;
  const latestMergeAction = actionHistories.merge.latest?.latest;
  const mergeDecision = delivery.mergeDecision === undefined
    ? undefined
    : parseDeliveryMergeReadinessDecision(delivery.mergeDecision);
  const activeCleanupAction = actionHistories.cleanup.active?.latest;
  const latestCleanupAction = actionHistories.cleanup.latest?.latest;
  return DeliverySnapshotDto.make({
    eventSequence,
    mode: "pullRequest",
    ...(publication === undefined
      ? {}
      : { publication: publicDeliveryPublication(publication) }),
    ...(observation === undefined ? {} : { observation }),
    provenance: DeliveryProvenanceDto.make(delivery),
    recoveryActions:
      activeMergeAction?.state === "outcomeUnknown" || activeMergeAction?.state === "dispatchAttempted"
        ? ["reconcileMerge"]
        : delivery.stage === "cleanupRequired"
          ? ["retryCleanup"]
      : publication?.state === "outcomeUnknown"
        ? ["reconcile"]
        : publication?.state === "failed" && publication.recoverable
          ? ["retry"]
          : [],
    runId,
    ...(remediation === undefined ? {} : { remediation }),
    ...(activeMergeAction === undefined ? {} : { activeMergeAction }),
    ...(latestMergeAction === undefined ? {} : { latestMergeAction }),
    ...(mergeDecision === undefined ? {} : { mergeDecision }),
    ...(delivery.mergeDecisionSequence === undefined ? {} : { mergeDecisionSequence: delivery.mergeDecisionSequence }),
    ...(activeCleanupAction === undefined ? {} : { activeCleanupAction }),
    ...(latestCleanupAction === undefined ? {} : { latestCleanupAction }),
    actionAudit: deliveryActionAuditSummary(actionHistories, 20),
    ...(delivery.remediationRearmSequence === undefined
      ? {}
      : { remediationRearmSequence: delivery.remediationRearmSequence }),
    stage,
    status: stage,
    ...(workerRecovery === undefined ? {} : { workerRecovery }),
  });
}

function publicDeliveryPublication(
  publication: ReturnType<typeof parseDeliveryPublication>,
): DeliveryPublicationDto {
  switch (publication.state) {
    case "intentRecorded":
      return DeliveryPublicationIntentDto.make({
        branchName: publication.branchName,
        state: publication.state,
      });
    case "attempted":
      return DeliveryPublicationAttemptedDto.make({
        branchName: publication.branchName,
        commitSha: publication.commitSha,
        state: publication.state,
      });
    case "confirmed":
      return DeliveryPublicationConfirmedDto.make({
        branchName: publication.branchName,
        commitSha: publication.commitSha,
        draft: true,
        prNumber: publication.prNumber,
        prUrl: publication.prUrl,
        state: publication.state,
      });
    case "failed":
    case "outcomeUnknown":
      return DeliveryPublicationFailureDto.make({
        branchName: publication.branchName,
        code: publication.code,
        ...(publication.commitSha === undefined
          ? {}
          : { commitSha: publication.commitSha }),
        message: publication.message,
        recoverable: publication.recoverable,
        state: publication.state,
        step: publication.step,
      });
  }
}

function factoryListDiagnosticFromLocalRead(
  diagnostic: LocalRunReadDiagnostic,
) {
  return {
    code: diagnostic.code,
    message: diagnostic.message,
    recoverable: diagnostic.recoverable,
    ...(diagnostic.pathSegment === undefined
      ? {}
      : { sourceId: diagnostic.pathSegment }),
    ...(diagnostic.runId === undefined ? {} : { sourceId: diagnostic.runId }),
  };
}

function factoryListDiagnosticFromApiDiagnostic(
  diagnostic: ApiDiagnostic,
  fallbackSourceId: string,
) {
  return {
    code: diagnostic.code,
    message: diagnostic.message,
    recoverable: diagnostic.recoverable,
    sourceId:
      diagnostic.runId ??
      diagnostic.pathSegment ??
      diagnostic.artifactName ??
      fallbackSourceId,
  };
}

function factoryRunSummaryFromProjection(
  projection: FactoryRunProjection,
): typeof FactoryRunSummaryDto.Type {
  const rootWorkItem = projection.graph.workItems[0];
  if (rootWorkItem === undefined) {
    throw new Error("Factory graph must contain a root work item.");
  }

  return decodeFactoryRunSummary({
    activeAgent: activeFactoryAgentSummary(projection),
    counts: {
      activity: projection.activity.activities.length,
      agents: projection.graph.agents.length,
      artifacts: projection.artifacts.artifacts.length,
      workItems: projection.graph.workItems.length,
    },
    createdAt:
      projection.activity.activities[0]?.timestamp ?? new Date(0).toISOString(),
    rootWorkItem: {
      id: rootWorkItem.id,
      kind: rootWorkItem.kind,
      title: rootWorkItem.title,
    },
    runId: projection.graph.runId,
    state: factoryRunState(projection),
    updatedAt:
      projection.activity.activities.at(-1)?.timestamp ?? new Date(0).toISOString(),
    workflow: projection.graph.workflow,
  });
}

function factoryRunDetailFromProjection(
  projection: FactoryRunProjection,
): typeof FactoryRunDetailDto.Type {
  const summary = factoryRunSummaryFromProjection(projection);
  return decodeFactoryRunDetail({
    ...summary,
    execution: projection.graph.execution,
    urls: {
      activity: `/runs/${projection.graph.runId}/activity`,
      artifacts: `/runs/${projection.graph.runId}/artifacts`,
      factoryGraph: `/runs/${projection.graph.runId}/factory-graph`,
      run: `/runs/${projection.graph.runId}`,
    },
  });
}

function activeFactoryAgentSummary(projection: FactoryRunProjection) {
  const runningAgent = projection.graph.agents.find(
    (agent) => agent.state === "running",
  );
  const latestAgentId = projection.activity.activities
    .slice()
    .reverse()
    .find((activity) => activity.agentId !== undefined)?.agentId;
  const latestAgent = projection.graph.agents.find(
    (agent) => agent.id === latestAgentId,
  );
  const fallbackAgent = projection.graph.agents.find(
    (agent) => agent.role === "orchestrator",
  );
  const agent = runningAgent ?? latestAgent ?? fallbackAgent;
  if (agent === undefined) {
    return undefined;
  }

  return {
    id: agent.id,
    role: agent.role,
    state: agent.state,
    ...(agent.subState === undefined ? {} : { subState: agent.subState }),
    title: agent.title,
  };
}

function factoryRunState(projection: FactoryRunProjection) {
  if (projection.graph.agents.some((agent) => agent.state === "failed")) {
    return "failed";
  }
  if (projection.graph.agents.some((agent) => agent.state === "canceled")) {
    return "canceled";
  }
  if (projection.graph.agents.some((agent) => agent.state === "blocked")) {
    return "blocked";
  }
  if (
    projection.graph.agents.some(
      (agent) => agent.role === "orchestrator" && agent.state === "succeeded",
    )
  ) {
    return "succeeded";
  }
  if (projection.graph.agents.some((agent) => agent.state === "running")) {
    return "running";
  }
  return "pending";
}

function structuredServerErrors<E, R>(
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) {
  return HttpEffect.withPreResponseHandler(effect, (request, response) => {
    if (!isAllowedMethod(request.method, request.url)) {
      return errorJsonResponse(
        methodNotAllowedApiError({
          code: "MethodNotAllowed",
          message: "Local Gaia API method is not supported for this endpoint.",
          recoverable: false,
        }),
      );
    }

    if (!isEmptyResponse(response)) {
      return Effect.succeed(response);
    }

    if (response.status === 404) {
      return errorJsonResponse(
        apiError({
          code: "EndpointNotFound",
          message: "Local Gaia API endpoint was not found.",
          recoverable: false,
        }),
      );
    }

    if (response.status === 400) {
      const path = pathnameFromUrl(request.url);
      if (isArtifactReadPath(path)) {
        return errorJsonResponse(
          apiError({
            code: "ArtifactNotAllowed",
            message: "Artifact is not allowlisted for local API reads.",
            recoverable: false,
          }),
        );
      }

      return errorJsonResponse(
        apiError({
          code:
            request.method === "GET" && path.startsWith("/runs/")
              ? "InvalidRunId"
              : "InvalidRequest",
          message: "Local Gaia API request could not be parsed.",
          recoverable: false,
        }),
      );
    }

    return Effect.succeed(response);
  });
}

function errorJsonResponse(error: LocalRunApiError) {
  return HttpServerResponse.json(error, {
    status: statusForApiError(error),
  }).pipe(Effect.orDie);
}

function isEmptyResponse(response: HttpServerResponse.HttpServerResponse) {
  return response.body._tag === "Empty";
}

function isAllowedMethod(method: string, url: string) {
  if (method === "GET") {
    return true;
  }

  const path = pathnameFromUrl(url);
  return method === "POST" && (
    path === "/runs" ||
    /^\/runs\/[^/]+\/agents\/[^/]+\/session\/actions$/u.test(path) ||
    /^\/runs\/[^/]+\/delivery\/actions$/u.test(path) ||
    /^\/runs\/[^/]+\/recovery\/actions$/u.test(path)
  );
}

const privateDeliveryEventTypes = new Set([
  "DELIVERY_CLEANUP_PROVENANCE_RECORDED",
  "DELIVERY_CLEANUP_RESOURCE_CHECKPOINT_RECORDED",
  "DELIVERY_MERGE_PROVIDER_CHECKPOINT_RECORDED",
]);

function publicRunEvent(event: RunEvent): RunEvent {
  return privateDeliveryEventTypes.has(event.type)
    ? RunEvent.make({ ...event, payload: { redacted: true } })
    : event;
}

function pathnameFromUrl(url: string) {
  try {
    return new URL(url).pathname;
  } catch {
    return url.split("?")[0] ?? url;
  }
}

function isArtifactReadPath(path: string) {
  return /^\/runs\/[^/]+\/artifacts\/[^/]+$/u.test(path);
}

function statusForApiError(error: LocalRunApiError) {
  return error.status;
}

function statusForDiagnostic(diagnostic: ApiDiagnostic) {
  switch (diagnostic.code) {
    case "InvalidRunId":
    case "InvalidRequest":
    case "InvalidSpec":
      return 400;
    case "ArtifactNotAllowed":
    case "ArtifactNotFound":
    case "EndpointNotFound":
    case "FactoryAgentNotFound":
    case "FactoryGraphNotFound":
    case "RunNotFound":
      return 404;
    case "MethodNotAllowed":
      return 405;
    case "ActiveRunConflict":
    case "AgentActionConflict":
    case "DeliveryActionConflict":
    case "AgentStreamCursorConflict":
    case "DeliveryStreamCursorConflict":
    case "RunStoreLocked":
      return 409;
    case "HarnessAuthenticationRequired":
    case "HarnessCapabilityMismatch":
    case "HarnessIncompatible":
    case "HarnessProfileNotFound":
    case "HarnessUnavailable":
    case "AgentSessionUnavailable":
    case "InvalidRunDirectory":
    case "RunHasNoEvents":
    case "RunUnreadable":
      return 422;
    case "InternalServerError":
      return 500;
  }
}

function readApiErrorFromCause(cause: Cause.Cause<unknown>): LocalRunReadApiError {
  return readApiError(causeToDiagnostic(cause));
}

function apiErrorFromCause(cause: Cause.Cause<unknown>): LocalRunCreateApiError {
  for (const reason of cause.reasons) {
    if (Cause.isFailReason(reason)) {
      if (reason.error instanceof GaiaRuntimeError) {
        return apiErrorFromRuntimeError(reason.error);
      }

      if (isApiDiagnostic(reason.error)) {
        return createApiError(reason.error);
      }
    }
  }

  return internalApiError(cause);
}

function actionApiErrorFromCause(cause: Cause.Cause<unknown>): LocalRunActionApiError {
  const diagnostic = causeToDiagnostic(cause);
  switch (diagnostic.code) {
    case "AgentActionConflict":
    case "AgentStreamCursorConflict":
    case "DeliveryStreamCursorConflict":
      return LocalRunApiConflict.make({ ...publicDiagnosticFields(diagnostic), code: diagnostic.code, status: 409 });
    case "DeliveryActionConflict":
      return LocalRunApiConflict.make({
        code: diagnostic.code,
        message: "Delivery action conflicts with the current authoritative run state.",
        recoverable: true,
        ...(diagnostic.runId === undefined ? {} : { runId: diagnostic.runId }),
        status: 409,
      });
    default:
      return readApiError(diagnostic);
  }
}

function causeToDiagnostic(cause: Cause.Cause<unknown>): ApiDiagnostic {
  for (const reason of cause.reasons) {
    if (Cause.isFailReason(reason) && isRuntimeDiagnostic(reason.error)) {
      return reason.error;
    }

    if (Cause.isDieReason(reason)) {
      const defect = "defect" in reason ? reason.defect : undefined;
      if (isRuntimeDiagnostic(defect)) return defect;
      return {
        code: "InternalServerError",
        message: "Local Gaia API request failed.",
        recoverable: false,
      };
    }
  }

  return {
    code: "RunUnreadable",
    message: "Run could not be read from events.jsonl.",
    recoverable: false,
  };
}

function readApiError(diagnostic: ApiDiagnostic): LocalRunReadApiError {
  switch (diagnostic.code) {
    case "InvalidRequest":
      return LocalRunApiBadRequest.make({
        ...diagnostic,
        code: "InvalidRequest",
        status: 400,
      });
    case "InvalidRunId":
      return LocalRunApiBadRequest.make({
        ...diagnostic,
        code: "InvalidRunId",
        status: 400,
      });
    case "InvalidSpec":
      return LocalRunApiBadRequest.make({
        ...diagnostic,
        code: "InvalidSpec",
        status: 400,
      });
    case "ArtifactNotAllowed":
      return LocalRunApiNotFound.make({
        ...diagnostic,
        code: "ArtifactNotAllowed",
        status: 404,
      });
    case "ArtifactNotFound":
      return LocalRunApiNotFound.make({
        ...diagnostic,
        code: "ArtifactNotFound",
        status: 404,
      });
    case "EndpointNotFound":
      return LocalRunApiNotFound.make({
        ...diagnostic,
        code: "EndpointNotFound",
        status: 404,
      });
    case "FactoryAgentNotFound":
      return LocalRunApiNotFound.make({
        ...diagnostic,
        code: "FactoryAgentNotFound",
        status: 404,
      });
    case "FactoryGraphNotFound":
      return LocalRunApiNotFound.make({
        ...diagnostic,
        code: "FactoryGraphNotFound",
        status: 404,
      });
    case "RunNotFound":
      return LocalRunApiNotFound.make({
        ...diagnostic,
        code: "RunNotFound",
        status: 404,
      });
    case "HarnessAuthenticationRequired":
    case "HarnessCapabilityMismatch":
    case "HarnessIncompatible":
    case "HarnessProfileNotFound":
    case "HarnessUnavailable":
    case "AgentSessionUnavailable":
      return LocalRunApiUnprocessable.make({
        ...diagnostic,
        code: diagnostic.code,
        status: 422,
      });
    case "InvalidRunDirectory":
      return LocalRunApiUnprocessable.make({
        ...diagnostic,
        code: "InvalidRunDirectory",
        status: 422,
      });
    case "RunHasNoEvents":
      return LocalRunApiUnprocessable.make({
        ...diagnostic,
        code: "RunHasNoEvents",
        status: 422,
      });
    case "RunUnreadable":
      return LocalRunApiUnprocessable.make({
        ...diagnostic,
        code: "RunUnreadable",
        status: 422,
      });
    case "ActiveRunConflict":
    case "AgentActionConflict":
    case "DeliveryActionConflict":
    case "AgentStreamCursorConflict":
    case "DeliveryStreamCursorConflict":
    case "RunStoreLocked":
    case "InternalServerError":
    case "MethodNotAllowed":
      return internalApiError(diagnostic);
  }
}

function methodNotAllowedApiError(
  diagnostic: MethodNotAllowedDiagnostic,
): typeof LocalRunApiMethodNotAllowed.Type {
  return LocalRunApiMethodNotAllowed.make({
    ...diagnostic,
    code: "MethodNotAllowed",
    status: 405,
  });
}

function publicDiagnosticFields(diagnostic: ApiDiagnostic) {
  return {
    ...(diagnostic.artifactName === undefined ? {} : { artifactName: diagnostic.artifactName }),
    message: diagnostic.message,
    ...(diagnostic.pathSegment === undefined ? {} : { pathSegment: diagnostic.pathSegment }),
    recoverable: diagnostic.recoverable,
    ...(diagnostic.runId === undefined ? {} : { runId: diagnostic.runId }),
  };
}

function apiError(
  diagnostic: ApiDiagnostic,
): LocalRunApiError {
  switch (diagnostic.code) {
    case "InvalidRequest":
      return LocalRunApiBadRequest.make({
        ...diagnostic,
        code: "InvalidRequest",
        status: 400,
      });
    case "InvalidRunId":
      return LocalRunApiBadRequest.make({
        ...diagnostic,
        code: "InvalidRunId",
        status: 400,
      });
    case "InvalidSpec":
      return LocalRunApiBadRequest.make({
        ...diagnostic,
        code: "InvalidSpec",
        status: 400,
      });
    case "ArtifactNotAllowed":
      return LocalRunApiNotFound.make({
        ...diagnostic,
        code: "ArtifactNotAllowed",
        status: 404,
      });
    case "ArtifactNotFound":
      return LocalRunApiNotFound.make({
        ...diagnostic,
        code: "ArtifactNotFound",
        status: 404,
      });
    case "EndpointNotFound":
      return LocalRunApiNotFound.make({
        ...diagnostic,
        code: "EndpointNotFound",
        status: 404,
      });
    case "FactoryAgentNotFound":
      return LocalRunApiNotFound.make({
        ...diagnostic,
        code: "FactoryAgentNotFound",
        status: 404,
      });
    case "FactoryGraphNotFound":
      return LocalRunApiNotFound.make({
        ...diagnostic,
        code: "FactoryGraphNotFound",
        status: 404,
      });
    case "RunNotFound":
      return LocalRunApiNotFound.make({
        ...diagnostic,
        code: "RunNotFound",
        status: 404,
      });
    case "MethodNotAllowed":
      return LocalRunApiMethodNotAllowed.make({
        ...diagnostic,
        code: "MethodNotAllowed",
        status: 405,
      });
    case "ActiveRunConflict":
      return LocalRunApiConflict.make({
        ...diagnostic,
        code: "ActiveRunConflict",
        status: 409,
      });
    case "AgentActionConflict":
    case "DeliveryActionConflict":
    case "AgentStreamCursorConflict":
    case "DeliveryStreamCursorConflict":
      return LocalRunApiConflict.make({ ...publicDiagnosticFields(diagnostic), code: diagnostic.code, status: 409 });
    case "RunStoreLocked":
      return LocalRunApiConflict.make({
        ...diagnostic,
        code: "RunStoreLocked",
        status: 409,
      });
    case "HarnessAuthenticationRequired":
    case "HarnessCapabilityMismatch":
    case "HarnessIncompatible":
    case "HarnessProfileNotFound":
    case "HarnessUnavailable":
    case "AgentSessionUnavailable":
      return LocalRunApiUnprocessable.make({
        ...diagnostic,
        code: diagnostic.code,
        status: 422,
      });
    case "InvalidRunDirectory":
      return LocalRunApiUnprocessable.make({
        ...diagnostic,
        code: "InvalidRunDirectory",
        status: 422,
      });
    case "RunHasNoEvents":
      return LocalRunApiUnprocessable.make({
        ...diagnostic,
        code: "RunHasNoEvents",
        status: 422,
      });
    case "RunUnreadable":
      return LocalRunApiUnprocessable.make({
        ...diagnostic,
        code: "RunUnreadable",
        status: 422,
      });
    case "InternalServerError":
      return LocalRunApiInternalServerError.make({
        ...diagnostic,
        code: "InternalServerError",
        status: 500,
      });
  }

  return LocalRunApiInternalServerError.make({
    code: "InternalServerError",
    message: diagnostic.message,
    recoverable: false,
    status: 500,
  });
}

function createApiError(diagnostic: ApiDiagnostic): LocalRunCreateApiError {
  switch (diagnostic.code) {
    case "InvalidRequest":
      return LocalRunApiBadRequest.make({
        ...diagnostic,
        code: "InvalidRequest",
        status: 400,
      });
    case "InvalidRunId":
      return LocalRunApiBadRequest.make({
        ...diagnostic,
        code: "InvalidRunId",
        status: 400,
      });
    case "InvalidSpec":
      return LocalRunApiBadRequest.make({
        ...diagnostic,
        code: "InvalidSpec",
        status: 400,
      });
    case "MethodNotAllowed":
      return methodNotAllowedApiError({
        ...diagnostic,
        code: "MethodNotAllowed",
      });
    case "ActiveRunConflict":
      return LocalRunApiConflict.make({
        ...diagnostic,
        code: "ActiveRunConflict",
        status: 409,
      });
    case "AgentActionConflict":
    case "DeliveryActionConflict":
    case "AgentStreamCursorConflict":
    case "DeliveryStreamCursorConflict":
      return LocalRunApiConflict.make({ ...publicDiagnosticFields(diagnostic), code: diagnostic.code, status: 409 });
    case "RunStoreLocked":
      return LocalRunApiConflict.make({
        ...diagnostic,
        code: "RunStoreLocked",
        status: 409,
      });
    case "HarnessAuthenticationRequired":
    case "HarnessCapabilityMismatch":
    case "HarnessIncompatible":
    case "HarnessProfileNotFound":
    case "HarnessUnavailable":
    case "AgentSessionUnavailable":
      return LocalRunApiUnprocessable.make({
        ...diagnostic,
        code: diagnostic.code,
        status: 422,
      });
    case "InvalidRunDirectory":
      return LocalRunApiUnprocessable.make({
        ...diagnostic,
        code: "InvalidRunDirectory",
        status: 422,
      });
    case "RunHasNoEvents":
      return LocalRunApiUnprocessable.make({
        ...diagnostic,
        code: "RunHasNoEvents",
        status: 422,
      });
    case "RunUnreadable":
      return LocalRunApiUnprocessable.make({
        ...diagnostic,
        code: "RunUnreadable",
        status: 422,
      });
    case "ArtifactNotAllowed":
    case "ArtifactNotFound":
    case "EndpointNotFound":
    case "FactoryAgentNotFound":
    case "FactoryGraphNotFound":
    case "RunNotFound":
    case "InternalServerError":
      return internalApiError(diagnostic);
  }
}

function apiErrorFromRuntimeError(error: GaiaRuntimeError): LocalRunCreateApiError {
  switch (error.code) {
    case "InvalidSpec":
      return createApiError({
        code: "InvalidSpec",
        message: error.message,
        recoverable: error.recoverable,
      });
    case "RunStoreLocked":
      return createApiError({
        code: "RunStoreLocked",
        message: error.message,
        recoverable: error.recoverable,
      });
    case "HarnessAuthenticationRequired":
    case "HarnessCapabilityMismatch":
    case "HarnessIncompatible":
    case "HarnessProfileNotFound":
    case "HarnessUnavailable":
      return createApiError({
        code: error.code,
        message: error.message,
        recoverable: error.recoverable,
      });
    default:
      return internalApiError(error);
  }
}

function activeRunConflictApiError(
  error: ActiveServerRunConflict,
): typeof LocalRunApiConflict.Type {
  return LocalRunApiConflict.make({
    code: "ActiveRunConflict",
    message: error.message,
    recoverable: error.recoverable,
    status: 409,
  });
}

function forkServerContinuation(input: {
  readonly accepted: ServerRunAcceptance;
  readonly identity: LocalServerConfigValue;
  readonly reservation: ServerRunReservation;
}) {
  return continueServerRun(input.accepted.runId, {
    ...input.identity.workflowOptions,
    rootDirectory: input.identity.rootDirectory,
  }).pipe(
    Effect.tapError((error) =>
      appendServerLog(
        input.identity.rootDirectory,
        `${new Date().toISOString()} ${input.identity.serverId} run ${input.accepted.runId} failed ${error.code}`,
      ).pipe(Effect.ignore),
    ),
    Effect.ensuring(
      input.identity.runIndex.refreshRun(input.accepted.runId).pipe(Effect.ignore),
    ),
    Effect.ensuring(input.reservation.clear),
    Effect.matchEffect({
      onFailure: () => Effect.void,
      onSuccess: () => Effect.void,
    }),
    Effect.forkIn(input.identity.runScope),
    Effect.asVoid,
  );
}

type EventStreamState = {
  readonly done: boolean;
  readonly nextSequence: number;
  readonly rootDirectory: string;
  readonly runId: string;
};

function streamRunEvents(input: {
  readonly rootDirectory: string;
  readonly runId: string;
}) {
  return Stream.unfold(
    {
      done: false,
      nextSequence: 1,
      rootDirectory: input.rootDirectory,
      runId: input.runId,
    } satisfies EventStreamState,
    readNextStreamEvent,
  );
}

function readNextStreamEvent(
  state: EventStreamState,
): Effect.Effect<
  readonly [RunEvent, EventStreamState] | undefined,
  typeof LocalRunApiErrorEnvelope.Type,
  FileSystem.FileSystem | Path.Path
> {
  if (state.done) {
    return Effect.succeed(undefined);
  }

  return Effect.gen(function* () {
    const events = yield* readLocalRunEvents(state.runId, {
      rootDirectory: state.rootDirectory,
    }).pipe(
      Effect.mapError((error: unknown) => streamApiError(error)),
    );
    const event = events.events.find(
      (candidate) => candidate.sequence === state.nextSequence,
    );

    if (event === undefined) {
      yield* Effect.sleep("50 millis");
      return yield* readNextStreamEvent(state);
    }

    const next: readonly [RunEvent, EventStreamState] = [
      event,
      {
        ...state,
        done: isTerminalRunEvent(event),
        nextSequence: event.sequence + 1,
      },
    ];

    return next;
  });
}

function streamApiError(error: unknown): typeof LocalRunApiErrorEnvelope.Type {
  const diagnostic = isRuntimeDiagnostic(error)
    ? LocalRunReadDiagnosticDto.make(error)
    : LocalRunReadDiagnosticDto.make({
        code: "InternalServerError",
        message: "Local Gaia event stream failed.",
        recoverable: false,
      });

  return LocalRunApiErrorEnvelope.make({
    ...diagnostic,
    status: statusForDiagnostic(diagnostic),
  });
}

function isTerminalRunEvent(event: RunEvent) {
  return event.type === "REPORT_COMPLETED" || event.type === "RUN_FAILED";
}

function isRuntimeDiagnostic(input: unknown): input is LocalRunReadDiagnostic {
  return (
    typeof input === "object" &&
    input !== null &&
    "code" in input &&
    "message" in input &&
    "recoverable" in input
  );
}

function isApiDiagnostic(input: unknown): input is ApiDiagnostic {
  return (
    typeof input === "object" &&
    input !== null &&
    "code" in input &&
    "message" in input &&
    "recoverable" in input
  );
}

type ApiDiagnostic = typeof LocalRunReadDiagnosticDto.Type;
type MethodNotAllowedDiagnostic = Omit<
  typeof LocalRunApiMethodNotAllowed.Type,
  "status"
>;
type LocalRunReadApiError =
  | typeof LocalRunApiBadRequest.Type
  | typeof LocalRunApiNotFound.Type
  | typeof LocalRunApiUnprocessable.Type
  | typeof LocalRunApiInternalServerError.Type;
type LocalRunCreateApiError =
  | typeof LocalRunApiBadRequest.Type
  | typeof LocalRunApiMethodNotAllowed.Type
  | typeof LocalRunApiConflict.Type
  | typeof LocalRunApiUnprocessable.Type
  | typeof LocalRunApiInternalServerError.Type;
type LocalRunActionApiError =
  | LocalRunReadApiError
  | typeof LocalRunApiConflict.Type;

function internalApiError(error: unknown): typeof LocalRunApiInternalServerError.Type {
  const message =
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
      ? error.message
      : "Local Gaia API request failed.";

  return LocalRunApiInternalServerError.make({
    code: "InternalServerError",
    message,
    recoverable: false,
    status: 500,
  });
}
