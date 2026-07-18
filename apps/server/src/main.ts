#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import nodePath from "node:path";
import { pathToFileURL } from "node:url";

import { NodeHttpServer, NodeServices } from "@effect/platform-node";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import {
  codexAppServerHarnessProfileId,
  DeliveryGitShaSchema,
  parseWorkerRecoveryDigest,
  parseWorkerRecoveryReceipt,
  parseWorkspaceRelativePath,
  RunEvent,
  RunIdSchema,
  ServerMetadata,
  WorkerRecoveryAction,
  WorkerRecoveryModelIdSchema,
  type HarnessDetection,
  type RunId,
  type WorkerRecoveryDigest,
} from "@gaia/core";
import {
  createCodexHarnessProvider,
  CodexAppServerSpawnConfig,
  CodexHarnessProviderConfig,
  detectInstalledCodexAppServer,
  makeCodexAppServerClient,
  makeCodexAppServerConnection,
  makeFileCodexHarnessCorrelationStore,
  decodeCodexHarnessCorrelation,
  encodeCodexHarnessCorrelation,
  encodeCodexHarnessCheckpoint,
  listCodexModels,
  recoverWorkerSession,
  parseCodexThreadId,
  readPrivateWorkerRecoveryCheckpoint,
  resumeHarnessSession,
  writePrivateWorkerCorrelationFollowUpCheckpoint,
  makeHarnessProviderRegistry,
  issueDeliveryWorkerHarnessCapabilities,
  inspectContinuableDeliveryWorktreeOwnership,
  inspectRecoverableDeliveryWorktreeOwnership,
  inspectRetainedPayloadDeliveryWorktreeOwnership,
  makeRunPaths,
  makeRuntimeError,
  loadRun,
  parseDeliveryProvenance,
  parseRunStorageRootInput,
  parseRuntimePath,
  RunPathsSchema,
  RunStorageRootInputSchema,
  RuntimePathSchema,
  type RunPaths,
  type CodexModelId,
  type CodexThreadId,
  type CodexTurnId,
  type CodexListedThread,
  type ThreadListParams,
  type ThreadListResult,
  type ThreadReadParams,
  type ThreadResult,
  CodexModelIdSchema,
  type HarnessProviderRegistry,
  type WorkerRecoveryProvider,
  WorkerRecoveryModel,
  WorkerRecoveryProviderError,
  WorkerRecoveryTurnStarted,
  WorkerRecoveryThreadState,
  WorkerRecoveryWorkspaceValidation,
  WorkerRecoveryWorkspaceValidationError,
  type WorkerRecoveryWorkspaceValidationResult,
  type WorkerRecoveryThreadStatus,
} from "@gaia/runtime";
import {
  reconcileInterruptedServerRuns,
  type WorkerDesktopOriginCorrelationInput,
  type WorkerCorrelationReconciliationInput,
} from "@gaia/runtime/server-workflows";
import { makeTestHarnessProviderRegistry } from "@gaia/runtime/test-support";
import { Effect, FileSystem, Layer, Path, Schema } from "effect";
import * as Console from "effect/Console";
import { HttpServer } from "effect/unstable/http";

import { makeLocalGaiaServerLayer } from "./api.js";
export { writeRecoveryHttpEvidence } from "./recovery-http-evidence.js";
import {
  appendServerLog,
  removeServerMetadata,
  serverDiscoveryPaths,
  serverMetadataFromAddress,
  writeServerMetadata,
  type LocalServerIdentity,
} from "./discovery.js";

const ServerConfigSchema = Schema.Struct({
  host: ServerMetadata.fields.host,
  port: ServerMetadata.fields.port,
  rootDirectory: RunStorageRootInputSchema,
  testHarness: Schema.Boolean,
});
const parseServerConfig = Schema.decodeUnknownSync(ServerConfigSchema);

export type ServerConfig = typeof ServerConfigSchema.Encoded;

const RunEventsSchema = Schema.Array(RunEvent);
const AuditedWorkerWorkspaceOwnershipInputSchema = Schema.Struct({
  events: RunEventsSchema,
  paths: RunPathsSchema,
  rootDirectory: RunStorageRootInputSchema,
});
const ValidateProductionWorkerRecoveryWorkspaceInputSchema = Schema.Struct({
  action: WorkerRecoveryAction,
  expectedHead: DeliveryGitShaSchema,
  rootDirectory: RunStorageRootInputSchema,
  runId: RunIdSchema,
});
const parseValidateProductionWorkerRecoveryWorkspaceInput =
  Schema.decodeUnknownSync(
    ValidateProductionWorkerRecoveryWorkspaceInputSchema
  );
const MakeServerIdentityInputSchema = Schema.Struct({
  host: ServerMetadata.fields.host,
  rootDirectory: RunStorageRootInputSchema,
});
const parseServerId = Schema.decodeUnknownSync(ServerMetadata.fields.serverId);
const parseServerStartedAt = Schema.decodeUnknownSync(
  ServerMetadata.fields.startedAt
);

export const defaultServerConfig = {
  host: "127.0.0.1",
  port: 0,
  rootDirectory: process.cwd(),
  testHarness: false,
} satisfies ServerConfig;

export function runLocalGaiaServer(input: {
  readonly harnessProviderRegistry?: HarnessProviderRegistry | undefined;
  readonly onReady?:
    | ((metadata: ServerMetadata) => Effect.Effect<void>)
    | undefined;
  readonly port?: number | undefined;
  readonly rootDirectory?: typeof RunStorageRootInputSchema.Encoded | undefined;
}): Effect.Effect<void, unknown> {
  const rootDirectory = parseRunStorageRootInput(
    input.rootDirectory ?? defaultServerConfig.rootDirectory
  );
  const identity = makeServerIdentity({
    host: defaultServerConfig.host,
    rootDirectory,
  });
  const port = input.port ?? defaultServerConfig.port;
  const nodeLayer = NodeHttpServer.layer(createServer, {
    host: identity.host,
    port,
  });
  return Effect.scoped(
    Effect.gen(function* () {
      const production =
        input.harnessProviderRegistry === undefined
          ? yield* makeProductionHarnessServices(rootDirectory)
          : undefined;
      const harnessProviderRegistry =
        input.harnessProviderRegistry ?? production!.registry;
      const workflowOptions = {
        deliveryObservationEnabled: true,
        harnessProviderRegistry,
        rootDirectory: identity.rootDirectory,
        ...(production === undefined
          ? {}
          : {
              workerDesktopOriginCorrelationFollowUpDispatcher:
                production.dispatchDesktopOriginCorrelationFollowUp,
              workerDesktopOriginCorrelationReconciler:
                production.reconcileDesktopOriginCorrelation,
              workerCorrelationFollowUpDispatcher:
                production.dispatchCorrelationFollowUp,
              workerCorrelationReconciler: production.reconcileCorrelation,
              workerRecoveryActivator: production.recover,
            }),
      };
      const reconciliation =
        yield* reconcileInterruptedServerRuns(workflowOptions);
      const serverLayer = makeLocalGaiaServerLayer(
        identity,
        workflowOptions,
        reconciliation.resumableRunIds
      ).pipe(Layer.provideMerge(nodeLayer));
      yield* Effect.gen(function* () {
        const server = yield* HttpServer.HttpServer;
        const metadata = yield* serverMetadataFromAddress(
          identity,
          server.address
        );
        yield* writeServerMetadata(metadata);
        yield* Effect.addFinalizer(() =>
          removeServerMetadata(metadata).pipe(
            Effect.orElseSucceed(() => undefined)
          )
        );
        const discoveryPaths = yield* serverDiscoveryPaths(
          metadata.workspaceRoot
        );
        yield* appendServerLog(
          metadata.workspaceRoot,
          `${metadata.startedAt} listening ${metadata.url} serverId=${metadata.serverId} pid=${metadata.pid} workspaceRoot=${metadata.workspaceRoot} metadata=${discoveryPaths.serverJson}`
        );
        if (input.onReady !== undefined) {
          yield* input.onReady(metadata);
        }
        yield* Console.log(`Gaia local API listening on ${metadata.url}`);
        yield* Console.log(`workspace: ${metadata.workspaceRoot}`);
        yield* Effect.never;
      }).pipe(Effect.provide(serverLayer));
    })
  ).pipe(Effect.provide(NodeServices.layer));
}

function makeProductionHarnessServices(
  rootDirectory: typeof RunStorageRootInputSchema.Type
) {
  return Effect.gen(function* () {
    const connection = yield* makeCodexAppServerConnection({
      config: CodexAppServerSpawnConfig.make({ cwd: rootDirectory }),
    });
    const client = makeCodexAppServerClient(connection);
    const correlationStore =
      makeFileCodexHarnessCorrelationStore(rootDirectory);
    const provider = createCodexHarnessProvider({
      client,
      config: CodexHarnessProviderConfig.make({
        workspaceRoot: rootDirectory,
      }),
      correlationStore,
      detectionProbe: detectInstalledCodexAppServer,
    });
    const registry = makeHarnessProviderRegistry([
      { profileId: codexAppServerHarnessProfileId, provider },
    ]);
    const recover = (
      runId: RunId,
      action: Parameters<typeof recoverWorkerSession>[1]
    ) =>
      Effect.gen(function* () {
        const correlation = yield* correlationStore.load(
          action.expectedSessionId
        );
        const nativeThreadId =
          correlation === undefined
            ? undefined
            : decodeCodexHarnessCorrelation(correlation);
        if (nativeThreadId === undefined) {
          return yield* Effect.fail(
            makeRuntimeError({
              code: "WorkerRecoveryCorrelationUnavailable",
              message: "Worker recovery session correlation is unavailable.",
              recoverable: false,
            })
          );
        }
        let selectedCodexModel: CodexModelId | undefined;
        return yield* recoverWorkerSession(runId, action, {
          rootDirectory,
          provider: makeProductionWorkerRecoveryProvider({
            detect: provider.detect,
            listModels: () =>
              listCodexModels(connection, { includeHidden: false }).pipe(
                Effect.map(({ data }) =>
                  data.flatMap(({ hidden, id }) => {
                    if (
                      Schema.encodeSync(CodexModelIdSchema)(id) !==
                      Schema.encodeSync(WorkerRecoveryModelIdSchema)(
                        action.model
                      )
                    )
                      return [];
                    selectedCodexModel = id;
                    return [
                      WorkerRecoveryModel.make({
                        hidden,
                        id: action.model,
                      }),
                    ];
                  })
                ),
                Effect.mapError(() => workerRecoveryProviderError("listModels"))
              ),
            readThread: () =>
              client
                .readThread({
                  includeTurns: true,
                  threadId: nativeThreadId,
                })
                .pipe(
                  Effect.flatMap(({ thread }) =>
                    projectWorkerRecoveryThreadState(
                      nativeThreadId,
                      thread,
                      "readThread"
                    )
                  ),
                  Effect.mapError(() =>
                    workerRecoveryProviderError("readThread")
                  )
                ),
            resumeThread: () =>
              client.resumeThread({ threadId: nativeThreadId }).pipe(
                Effect.flatMap(({ thread }) =>
                  projectWorkerRecoveryThreadState(
                    nativeThreadId,
                    thread,
                    "resumeThread"
                  )
                ),
                Effect.mapError(() =>
                  workerRecoveryProviderError("resumeThread")
                )
              ),
            startTurn: ({ model }) => {
              const codexModel =
                model === action.model ? selectedCodexModel : undefined;
              if (codexModel === undefined)
                return Effect.fail(workerRecoveryProviderError("startTurn"));
              return client
                .startTurn({
                  input: [
                    {
                      text: "Resume the retained worker task after the recoverable provider failure.",
                      type: "text",
                    },
                  ],
                  model: codexModel,
                  threadId: nativeThreadId,
                })
                .pipe(
                  Effect.map(({ turn }) =>
                    WorkerRecoveryTurnStarted.make({
                      checkpoint: encodeCodexHarnessCheckpoint(turn.id),
                      nativeTurnIdDigest: parseWorkerRecoveryDigest(
                        createHash("sha256").update(turn.id).digest("hex")
                      ),
                    })
                  ),
                  Effect.mapError(() =>
                    workerRecoveryProviderError("startTurn")
                  )
                );
            },
          }),
          validateWorkspace: (_workspacePath, expectedHead) =>
            validateProductionWorkerRecoveryWorkspace({
              action,
              expectedHead,
              rootDirectory,
              runId,
            }),
        });
      });
    const reconcileCorrelation = (
      input: WorkerCorrelationReconciliationInput
    ) =>
      Effect.gen(function* () {
        const acceptedAt = input.events[0]?.timestamp;
        if (acceptedAt === undefined) {
          return yield* Effect.fail(
            makeRuntimeError({
              code: "HarnessCorrelationUnavailable",
              message:
                "Audited correlation reconciliation requires the accepted worker workspace.",
              recoverable: false,
            })
          );
        }
        const workspacePath = yield* resolveAuditedWorkerWorkspacePath({
          events: input.events,
          paths: input.paths,
          rootDirectory,
        });
        const candidates = yield* listStableCodexThreadsForWorkspace(
          client,
          workspacePath
        );
        const acceptedAtSeconds = Math.floor(Date.parse(acceptedAt) / 1000);
        if (!Number.isFinite(acceptedAtSeconds)) {
          return yield* Effect.fail(
            makeRuntimeError({
              code: "HarnessCorrelationUnavailable",
              message:
                "Audited correlation reconciliation requires a valid accepted creation timestamp.",
              recoverable: false,
            })
          );
        }
        const nowSeconds = Math.ceil(Date.now() / 1000) + 60;
        const matches = yield* Effect.forEach(candidates, (thread) =>
          Effect.gen(function* () {
            if (
              thread.cwd !== workspacePath ||
              thread.source !== "appServer" ||
              thread.createdAt < acceptedAtSeconds - 300 ||
              thread.createdAt > nowSeconds
            ) {
              return undefined;
            }
            const read = yield* client.readThread({
              includeTurns: true,
              threadId: thread.id,
            });
            const turns = read.thread.turns ?? [];
            const latest = turns.at(-1);
            if (
              read.thread.id !== thread.id ||
              latest === undefined ||
              latest.status !== "interrupted" ||
              digestStableNativeId(latest.id) !==
                input.action.expectedNativeTurnIdDigest
            ) {
              return undefined;
            }
            const digestMatches = turns.filter(
              ({ id }) =>
                digestStableNativeId(id) ===
                input.action.expectedNativeTurnIdDigest
            );
            return digestMatches.length === 1 ? thread.id : undefined;
          })
        ).pipe(
          Effect.map((items) =>
            items.filter(
              (threadId): threadId is CodexThreadId => threadId !== undefined
            )
          )
        );
        const [match] = matches;
        if (matches.length !== 1 || match === undefined) {
          return yield* Effect.fail(
            makeRuntimeError({
              code: "HarnessCorrelationUnavailable",
              message:
                "Audited correlation reconciliation could not identify exactly one interrupted App Server checkpoint.",
              recoverable: false,
            })
          );
        }
        yield* correlationStore.save(
          input.action.expectedSessionId,
          encodeCodexHarnessCorrelation(match)
        );
      });
    const reconcileDesktopOriginCorrelation = (
      input: WorkerDesktopOriginCorrelationInput
    ) =>
      Effect.gen(function* () {
        const acceptedAt = input.events[0]?.timestamp;
        if (acceptedAt === undefined) {
          return yield* Effect.fail(
            makeRuntimeError({
              code: "HarnessCorrelationUnavailable",
              message:
                "Audited Desktop-origin correlation requires the accepted worker workspace.",
              recoverable: false,
            })
          );
        }
        const workspacePath = yield* resolveAuditedWorkerWorkspacePath({
          events: input.events,
          paths: input.paths,
          rootDirectory,
        });
        const acceptedAtSeconds = Math.floor(Date.parse(acceptedAt) / 1000);
        if (!Number.isFinite(acceptedAtSeconds)) {
          return yield* Effect.fail(
            makeRuntimeError({
              code: "HarnessCorrelationUnavailable",
              message:
                "Audited Desktop-origin correlation requires a valid accepted creation timestamp.",
              recoverable: false,
            })
          );
        }
        const match = yield* findStableDesktopOriginCorrelationThread({
          client,
          expectedDigest: input.action.expectedNativeTurnIdDigest,
          acceptedAtSeconds,
          workspacePath,
        });
        yield* correlationStore.save(
          input.action.expectedSessionId,
          encodeCodexHarnessCorrelation(match.threadId)
        );
      });
    const dispatchCorrelationFollowUp = (
      input: WorkerCorrelationReconciliationInput
    ) => dispatchCorrelationFollowUpFor(input);
    const dispatchDesktopOriginCorrelationFollowUp = (
      input: WorkerDesktopOriginCorrelationInput
    ) => dispatchCorrelationFollowUpFor(input);
    const dispatchCorrelationFollowUpFor = (
      input:
        | WorkerCorrelationReconciliationInput
        | WorkerDesktopOriginCorrelationInput
    ) =>
      Effect.scoped(
        Effect.gen(function* () {
          const workspacePath = yield* resolveAuditedWorkerWorkspacePath({
            events: input.events,
            paths: input.paths,
            rootDirectory,
          });
          const recoveryReceipt = yield* findBoundWorkerRecoveryReceipt(
            input.events,
            input.action
          );
          const checkpointTurnId = yield* readPrivateWorkerRecoveryCheckpoint(
            input.paths.root,
            input.action.expectedNativeTurnIdDigest,
            recoveryReceipt
          );
          yield* resumeHarnessSession({
            provider,
            request: {
              allowInterruptedCheckpoint: true,
              expectedCheckpoint: checkpointTurnId,
              sessionId: input.action.expectedSessionId,
              workspacePath: parseWorkspaceRelativePath(
                nodePath.relative(rootDirectory, workspacePath)
              ),
            },
            requiredCapabilities: issueDeliveryWorkerHarnessCapabilities,
          });
          const correlation = yield* correlationStore.load(
            input.action.expectedSessionId
          );
          const threadId =
            correlation === undefined
              ? undefined
              : decodeCodexHarnessCorrelation(correlation);
          if (threadId === undefined) {
            return yield* Effect.fail(
              makeRuntimeError({
                code: "HarnessCorrelationUnavailable",
                message:
                  "Audited correlation follow-up requires a private session correlation.",
                recoverable: false,
              })
            );
          }
          const turn = yield* client.startTurn({
            clientUserMessageId: input.clientInputId,
            input: [{ text: input.followUpText, type: "text" }],
            threadId,
          });
          yield* writePrivateWorkerCorrelationFollowUpCheckpoint(
            input.paths.root,
            encodeCodexHarnessCheckpoint(turn.turn.id)
          );
        })
      );
    return {
      dispatchCorrelationFollowUp,
      dispatchDesktopOriginCorrelationFollowUp,
      recover,
      reconcileCorrelation,
      reconcileDesktopOriginCorrelation,
      registry,
    };
  });
}

function workerWorkspacePath(events: typeof RunEventsSchema.Type) {
  const workspacePath = events.find(({ type }) => type === "WORKSPACE_PREPARED")
    ?.payload["workspacePath"];
  return typeof workspacePath === "string" ? workspacePath : undefined;
}

export function resolveAuditedWorkerWorkspacePath(input: {
  readonly events: typeof RunEventsSchema.Type;
  readonly inspectOwnership?:
    | (() => Effect.Effect<void, unknown, FileSystem.FileSystem>)
    | undefined;
  readonly paths: RunPaths;
  readonly rootDirectory: typeof RunStorageRootInputSchema.Encoded;
}) {
  const rootDirectory = parseRunStorageRootInput(input.rootDirectory);
  return Effect.gen(function* () {
    const rawWorkspacePath = workerWorkspacePath(input.events);
    if (
      rawWorkspacePath === undefined ||
      /[\u0000-\u001f\u007f]/u.test(rawWorkspacePath)
    ) {
      return yield* failAuditedWorkerWorkspacePath();
    }

    let workspaceRelativePath: string;
    let expectedWorkspaceRelativePath: string;
    try {
      workspaceRelativePath = parseWorkspaceRelativePath(rawWorkspacePath);
      expectedWorkspaceRelativePath = parseWorkspaceRelativePath(
        nodePath.relative(input.paths.root, input.paths.workspace)
      );
    } catch {
      return yield* failAuditedWorkerWorkspacePath();
    }

    if (workspaceRelativePath !== expectedWorkspaceRelativePath) {
      return yield* failAuditedWorkerWorkspacePath();
    }

    const fs = yield* FileSystem.FileSystem;
    const canonicalRunRoot = yield* fs
      .realPath(input.paths.root)
      .pipe(Effect.mapError(() => auditedWorkerWorkspacePathError()));
    const canonicalWorkspace = yield* fs
      .realPath(input.paths.workspace)
      .pipe(Effect.mapError(() => auditedWorkerWorkspacePathError()));
    const canonicalCandidate = yield* fs
      .realPath(nodePath.join(input.paths.root, workspaceRelativePath))
      .pipe(Effect.mapError(() => auditedWorkerWorkspacePathError()));
    if (
      canonicalCandidate !== canonicalWorkspace ||
      nodePath.relative(canonicalRunRoot, canonicalWorkspace) !==
        expectedWorkspaceRelativePath
    ) {
      return yield* failAuditedWorkerWorkspacePath();
    }

    yield* (
      input.inspectOwnership ??
      (() =>
        inspectAuditedWorkerWorkspaceOwnership({
          events: input.events,
          paths: input.paths,
          rootDirectory,
        }))
    )().pipe(Effect.mapError(() => auditedWorkerWorkspacePathError()));
    return parseRuntimePath(canonicalWorkspace);
  });
}

function inspectAuditedWorkerWorkspaceOwnership(
  input: typeof AuditedWorkerWorkspaceOwnershipInputSchema.Type
) {
  return Effect.gen(function* () {
    const provenance = parseDeliveryProvenance(
      input.events[0]?.payload["delivery"]
    );
    if (provenance._tag === "None") {
      return yield* Effect.fail(auditedWorkerWorkspacePathError());
    }
    yield* inspectContinuableDeliveryWorktreeOwnership({
      expectedHeads: [provenance.value.baseRevision],
      options: { rootDirectory: input.rootDirectory },
      paths: input.paths,
      provenance: provenance.value,
    });
  });
}

function failAuditedWorkerWorkspacePath() {
  return Effect.fail(auditedWorkerWorkspacePathError());
}

function auditedWorkerWorkspacePathError() {
  return makeRuntimeError({
    code: "HarnessCorrelationUnavailable",
    message: "Audited worker correlation requires the owned worker workspace.",
    recoverable: false,
  });
}

function digestStableNativeId(value: CodexTurnId): WorkerRecoveryDigest {
  return parseWorkerRecoveryDigest(
    createHash("sha256").update(value).digest("hex")
  );
}

type StableCodexThreadListClient = {
  readonly listThreads: (
    params: ThreadListParams
  ) => Effect.Effect<ThreadListResult, unknown>;
};
type StableCodexThreadReadClient = {
  readonly readThread: (
    params: ThreadReadParams
  ) => Effect.Effect<ThreadResult, unknown>;
};
type StableCodexThreadClient = StableCodexThreadListClient &
  StableCodexThreadReadClient;

export function listStableCodexThreadsForWorkspace(
  client: StableCodexThreadListClient,
  workspacePath: typeof RuntimePathSchema.Encoded
) {
  const parsedWorkspacePath = parseRuntimePath(workspacePath);
  return Effect.gen(function* () {
    const byId = new Map<CodexThreadId, CodexListedThread>();
    for (const archived of [false, true] as const) {
      const seenCursors = new Set<string>();
      let cursor: string | null = null;
      do {
        const page: ThreadListResult = yield* client.listThreads({
          archived,
          cursor,
          cwd: parsedWorkspacePath,
          limit: 100,
          sortDirection: "asc",
          sortKey: "created_at",
          sourceKinds: ["appServer"],
          useStateDbOnly: true,
        });
        for (const thread of page.data) {
          byId.set(thread.id, thread);
        }
        if (page.nextCursor != null) {
          if (seenCursors.has(page.nextCursor)) {
            return yield* Effect.fail(
              makeRuntimeError({
                code: "HarnessCorrelationUnavailable",
                message:
                  "Audited correlation reconciliation detected cyclic App Server thread pagination.",
                recoverable: false,
              })
            );
          }
          seenCursors.add(page.nextCursor);
        }
        cursor = page.nextCursor ?? null;
      } while (cursor !== null);
    }
    return [...byId.values()];
  });
}

export function findStableDesktopOriginCorrelationThread(input: {
  readonly acceptedAtSeconds: number;
  readonly client: StableCodexThreadClient;
  readonly expectedDigest: WorkerRecoveryDigest;
  readonly workspacePath: typeof RuntimePathSchema.Encoded;
}) {
  const workspacePath = parseRuntimePath(input.workspacePath);
  return Effect.gen(function* () {
    const stateDb = yield* listStableCodexThreadsForWorkspaceBySource(
      input.client,
      workspacePath,
      true,
      ["appServer", "vscode"]
    );
    const jsonl = yield* listStableCodexThreadsForWorkspaceBySource(
      input.client,
      workspacePath,
      false,
      ["appServer", "vscode"]
    );
    const earliestAcceptedCandidate =
      input.acceptedAtSeconds - desktopOriginCorrelationAcceptedWindowSeconds;
    const latestAcceptedCandidate =
      input.acceptedAtSeconds + desktopOriginCorrelationAcceptedWindowSeconds;
    const candidateFilter = (thread: CodexListedThread) =>
      thread.cwd === workspacePath &&
      (thread.source === "appServer" || thread.source === "vscode") &&
      thread.createdAt >= earliestAcceptedCandidate &&
      thread.createdAt <= latestAcceptedCandidate;
    const stateDbMatches = stateDb.filter(candidateFilter);
    const jsonlMatches = jsonl.filter(candidateFilter);
    const [stateDbMatch] = stateDbMatches;
    const [jsonlMatch] = jsonlMatches;
    if (
      stateDbMatches.length !== 1 ||
      jsonlMatches.length !== 1 ||
      stateDbMatch === undefined ||
      jsonlMatch === undefined ||
      stateDbMatch.id !== jsonlMatch.id ||
      stateDbMatch.sessionId !== jsonlMatch.sessionId ||
      stateDbMatch.source !== jsonlMatch.source ||
      stateDbMatch.cwd !== jsonlMatch.cwd ||
      stateDbMatch.createdAt !== jsonlMatch.createdAt ||
      stateDbMatch.status?.type !== jsonlMatch.status?.type
    ) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "HarnessCorrelationUnavailable",
          message:
            "Audited Desktop-origin correlation could not prove one stable Codex thread identity.",
          recoverable: false,
        })
      );
    }
    if (
      stateDbMatch.source === "vscode" &&
      process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE !== "Codex Desktop"
    ) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "HarnessCorrelationUnavailable",
          message:
            "Audited Desktop-origin correlation requires a private Codex Desktop originator proof.",
          recoverable: false,
        })
      );
    }
    const read = yield* input.client
      .readThread({ includeTurns: true, threadId: stateDbMatch.id })
      .pipe(
        Effect.mapError(() =>
          makeRuntimeError({
            code: "HarnessCorrelationUnavailable",
            message:
              "Audited Desktop-origin correlation could not read the stable Codex thread.",
            recoverable: false,
          })
        )
      );
    const turns = read.thread.turns ?? [];
    const latest = turns.at(-1);
    if (
      read.thread.id !== stateDbMatch.id ||
      latest === undefined ||
      latest.status !== "interrupted" ||
      digestStableNativeId(latest.id) !== input.expectedDigest
    ) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "HarnessCorrelationUnavailable",
          message:
            "Audited Desktop-origin correlation could not prove the exact interrupted checkpoint.",
          recoverable: false,
        })
      );
    }
    const digestMatches = turns.filter(
      ({ id }) => digestStableNativeId(id) === input.expectedDigest
    );
    if (digestMatches.length !== 1) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "HarnessCorrelationUnavailable",
          message:
            "Audited Desktop-origin correlation found an ambiguous checkpoint digest.",
          recoverable: false,
        })
      );
    }
    return { threadId: stateDbMatch.id };
  });
}

function listStableCodexThreadsForWorkspaceBySource(
  client: StableCodexThreadListClient,
  workspacePath: typeof RuntimePathSchema.Type,
  useStateDbOnly: boolean,
  sourceKinds: ReadonlyArray<"appServer" | "vscode">
) {
  return Effect.gen(function* () {
    const observations: Array<CodexListedThread> = [];
    for (const archived of [false, true] as const) {
      const seenCursors = new Set<string>();
      let observationCount = 0;
      let pageCount = 0;
      let cursor: string | null = null;
      do {
        if (pageCount >= stableThreadListMaxPagesPerTraversal) {
          return yield* Effect.fail(
            makeRuntimeError({
              code: "HarnessCorrelationUnavailable",
              message:
                "Audited Desktop-origin correlation exceeded the stable App Server thread pagination budget.",
              recoverable: false,
            })
          );
        }
        const page: ThreadListResult = yield* client
          .listThreads({
            archived,
            cursor,
            cwd: workspacePath,
            limit: 100,
            sortDirection: "asc",
            sortKey: "created_at",
            sourceKinds: [...sourceKinds],
            useStateDbOnly,
          })
          .pipe(
            Effect.mapError(() =>
              makeRuntimeError({
                code: "HarnessCorrelationUnavailable",
                message:
                  "Audited Desktop-origin correlation could not list stable Codex threads.",
                recoverable: false,
              })
            )
          );
        pageCount += 1;
        observationCount += page.data.length;
        if (observationCount > stableThreadListMaxObservationsPerTraversal) {
          return yield* Effect.fail(
            makeRuntimeError({
              code: "HarnessCorrelationUnavailable",
              message:
                "Audited Desktop-origin correlation exceeded the stable App Server thread observation budget.",
              recoverable: false,
            })
          );
        }
        observations.push(...page.data);
        if (page.nextCursor != null) {
          if (seenCursors.has(page.nextCursor)) {
            return yield* Effect.fail(
              makeRuntimeError({
                code: "HarnessCorrelationUnavailable",
                message:
                  "Audited Desktop-origin correlation detected cyclic App Server thread pagination.",
                recoverable: false,
              })
            );
          }
          seenCursors.add(page.nextCursor);
        }
        cursor = page.nextCursor ?? null;
      } while (cursor !== null);
    }
    return observations;
  });
}

const desktopOriginCorrelationAcceptedWindowSeconds = 300;
const stableThreadListMaxObservationsPerTraversal = 10_000;
const stableThreadListMaxPagesPerTraversal = 100;

/** Normalize stable App Server thread status into the finite recovery preflight vocabulary. */
export function toWorkerRecoveryThreadStatus(
  status: string | undefined
): WorkerRecoveryThreadStatus {
  switch (status) {
    case "active":
    case "idle":
    case "notLoaded":
    case "systemError":
      return status;
    default:
      return "unknown";
  }
}

export function makeProductionWorkerRecoveryProvider(
  input: WorkerRecoveryProvider & {
    readonly detect: Effect.Effect<HarnessDetection, unknown>;
  }
): WorkerRecoveryProvider {
  return {
    listModels: () =>
      Effect.gen(function* () {
        const detection = yield* input.detect.pipe(
          Effect.mapError(() => workerRecoveryProviderError("listModels"))
        );
        if (detection.state !== "available") {
          return yield* Effect.fail(workerRecoveryProviderError("listModels"));
        }
        return yield* input.listModels();
      }),
    readThread: input.readThread,
    resumeThread: input.resumeThread,
    startTurn: input.startTurn,
  };
}

export function projectWorkerRecoveryThreadState(
  expectedThreadId: ReturnType<typeof parseCodexThreadId>,
  thread: ThreadResult["thread"],
  operation: "readThread" | "resumeThread"
) {
  return thread.id === expectedThreadId
    ? Effect.succeed(
        WorkerRecoveryThreadState.make({
          status: toWorkerRecoveryThreadStatus(thread.status?.type),
        })
      )
    : Effect.fail(workerRecoveryProviderError(operation));
}

function workerRecoveryProviderError(
  operation: WorkerRecoveryProviderError["operation"]
) {
  return new WorkerRecoveryProviderError({
    message: `Worker recovery provider ${operation} failed.`,
    operation,
  });
}

export function validateProductionWorkerRecoveryWorkspace(
  input: typeof ValidateProductionWorkerRecoveryWorkspaceInputSchema.Encoded
): Effect.Effect<
  WorkerRecoveryWorkspaceValidationResult,
  WorkerRecoveryWorkspaceValidationError,
  FileSystem.FileSystem | Path.Path
> {
  const parsedInput =
    parseValidateProductionWorkerRecoveryWorkspaceInput(input);
  return Effect.gen(function* () {
    const paths = yield* makeRunPaths(parsedInput.runId, {
      rootDirectory: parsedInput.rootDirectory,
    });
    const loaded = yield* loadRun(paths);
    const provenance = parseDeliveryProvenance(
      loaded.events[0]?.payload["delivery"]
    );
    if (
      provenance._tag === "None" ||
      provenance.value.baseRevision !== parsedInput.expectedHead
    ) {
      return yield* Effect.fail(
        new Error("Accepted delivery provenance changed.")
      );
    }
    const inspection = {
      expectedHeads: [parsedInput.expectedHead],
      options: { rootDirectory: parsedInput.rootDirectory },
      paths,
      provenance: provenance.value,
    };
    const inspected = shouldAllowRetainedPayloadWorkerRecovery(
      loaded.events,
      parsedInput.action
    )
      ? yield* inspectRetainedPayloadDeliveryWorktreeOwnership(inspection)
      : yield* inspectRecoverableDeliveryWorktreeOwnership(inspection);
    return inspected === undefined
      ? undefined
      : WorkerRecoveryWorkspaceValidation.make({
          trackedPayloadDigest: parseWorkerRecoveryDigest(
            inspected.trackedPayloadDigest
          ),
          trackedPayloadEntryCount: inspected.trackedPayloadEntryCount,
        });
  }).pipe(
    Effect.mapError(
      () =>
        new WorkerRecoveryWorkspaceValidationError({
          message: "Worker recovery workspace validation failed.",
          operation: "validateWorkspace",
        })
    )
  );
}

function shouldAllowRetainedPayloadWorkerRecovery(
  events: typeof RunEventsSchema.Type,
  action: WorkerRecoveryAction
) {
  if (events.some(({ type }) => blocksRetainedPayloadWorkerRecovery(type)))
    return false;
  const currentFailureIndex = events.findIndex(
    (event) => event.sequence === action.expectedFailureSequence
  );
  const currentFailure =
    currentFailureIndex < 0 ? undefined : events[currentFailureIndex];
  if (
    currentFailure?.sequence !== action.expectedFailureSequence ||
    currentFailure.type !== "RUN_FAILED" ||
    currentFailure.payload["recoverable"] !== true ||
    currentFailure.payload["stage"] !== "runningWorker"
  ) {
    return false;
  }
  const actionDigest = parseWorkerRecoveryDigest(
    createHash("sha256").update(JSON.stringify(action)).digest("hex")
  );
  const suffix = events.slice(currentFailureIndex + 1);
  if (
    !suffix.every((event) => {
      if (event.type !== "WORKER_RECOVERY_RECORDED") return false;
      const receipt = parseWorkerRecoveryReceipt(event.payload["recovery"]);
      return (
        receipt.actionId === action.actionId &&
        receipt.expectedFailureSequence === action.expectedFailureSequence &&
        receipt.payloadDigest === actionDigest
      );
    })
  ) {
    return false;
  }
  const latestPriorReceiptsByFailure = new Map<
    number,
    ReturnType<typeof parseWorkerRecoveryReceipt>
  >();
  for (const event of events.slice(0, currentFailureIndex)) {
    if (event.type !== "WORKER_RECOVERY_RECORDED") continue;
    const receipt = parseWorkerRecoveryReceipt(event.payload["recovery"]);
    if (receipt.expectedFailureSequence < action.expectedFailureSequence) {
      latestPriorReceiptsByFailure.set(
        receipt.expectedFailureSequence,
        receipt
      );
    }
  }
  const latestPriorReceipts = [...latestPriorReceiptsByFailure.values()];
  return (
    latestPriorReceipts.length > 0 &&
    latestPriorReceipts.every(
      (receipt) =>
        receipt.state === "dispatchConfirmed" ||
        receipt.state === "failed" ||
        receipt.state === "outcomeUnknown"
    )
  );
}

function blocksRetainedPayloadWorkerRecovery(type: string) {
  return (
    type === "DELIVERY_READY_TO_PUBLISH" ||
    type === "DELIVERY_PUBLICATION_INTENT_RECORDED" ||
    type === "DELIVERY_REMEDIATION_RECORDED" ||
    type === "DELIVERY_MERGE_READINESS_RECORDED" ||
    type === "DELIVERY_MERGE_RECORDED" ||
    type === "DELIVERY_CLEANUP_RECORDED" ||
    type === "DELIVERY_CLEANUP_PROVENANCE_RECORDED" ||
    type === "DELIVERY_CLEANUP_RESOURCE_CHECKPOINT_RECORDED" ||
    type === "DELIVERY_MERGE_PROVIDER_CHECKPOINT_RECORDED" ||
    type === "GITHUB_PR_LOOP_RECORDED" ||
    type === "GITHUB_PR_COMMENT_RECORDED" ||
    type === "MERGE_DECISION_RECORDED"
  );
}

function findBoundWorkerRecoveryReceipt(
  events: typeof RunEventsSchema.Type,
  action: Pick<
    | WorkerCorrelationReconciliationInput["action"]
    | WorkerDesktopOriginCorrelationInput["action"],
    "expectedFailedRecoverySequence" | "expectedRecoveryActionId"
  >
) {
  return Effect.gen(function* () {
    const receipt = [...events].reverse().flatMap((event) => {
      if (event.type !== "WORKER_RECOVERY_RECORDED") return [];
      const recovery = parseWorkerRecoveryReceipt(event.payload["recovery"]);
      return event.sequence === action.expectedFailedRecoverySequence &&
        recovery.actionId === action.expectedRecoveryActionId
        ? [recovery]
        : [];
    })[0];
    if (receipt === undefined) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "WorkerRecoveryTurnCheckpointInvalid",
          message:
            "The exact recovered native turn checkpoint is missing or invalid.",
          recoverable: false,
        })
      );
    }
    return receipt;
  }).pipe(
    Effect.mapError((cause) =>
      makeRuntimeError({
        cause,
        code: "WorkerRecoveryTurnCheckpointInvalid",
        message:
          "The exact recovered native turn checkpoint is missing or invalid.",
        recoverable: false,
      })
    )
  );
}

export function parseServerArgs(args: ReadonlyArray<string>): ServerConfig {
  let port = defaultServerConfig.port;
  let rootDirectory = defaultServerConfig.rootDirectory;
  let testHarness: boolean = defaultServerConfig.testHarness;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
    if (arg === "--port" && next !== undefined) {
      port = parsePort(next);
      index += 1;
      continue;
    }

    if (arg === "--root" && next !== undefined) {
      rootDirectory = next;
      index += 1;
      continue;
    }

    if (arg === "--host") {
      throw new Error("GAIA-12 only supports loopback host 127.0.0.1.");
    }
    if (arg === "--test-harness") {
      testHarness = true;
    }
  }

  return parseServerConfig({
    host: defaultServerConfig.host,
    port,
    rootDirectory,
    testHarness,
  });
}

function makeServerIdentity(
  input: typeof MakeServerIdentityInputSchema.Type
): LocalServerIdentity {
  return {
    host: input.host,
    pid: process.pid,
    rootDirectory: input.rootDirectory,
    serverId: parseServerId(`srv_${randomUUID()}`),
    startedAt: parseServerStartedAt(new Date().toISOString()),
  };
}

function parsePort(input: string): number {
  const parsed = /^\d+$/u.test(input) ? Number(input) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new Error(`Invalid port: ${input}`);
  }

  return parsed;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const config = parseServerArgs(process.argv.slice(2));
  runLocalGaiaServer({
    ...(config.testHarness
      ? { harnessProviderRegistry: makeTestHarnessProviderRegistry() }
      : {}),
    port: config.port,
    rootDirectory: config.rootDirectory,
  }).pipe(NodeRuntime.runMain);
}
