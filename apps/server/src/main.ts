#!/usr/bin/env node
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { NodeHttpServer, NodeServices } from "@effect/platform-node";
import {
  codexAppServerHarnessProfileId,
  parseWorkerRecoveryReceipt,
  parseWorkspaceRelativePath,
  type HarnessDetection,
  type RunId,
  type ServerMetadata,
} from "@gaia/core";
import {
  createCodexHarnessProvider,
  detectInstalledCodexAppServer,
  makeCodexAppServerClient,
  makeCodexAppServerConnection,
  makeFileCodexHarnessCorrelationStore,
  decodeCodexHarnessCorrelation,
  encodeCodexHarnessCorrelation,
  listCodexModels,
  recoverWorkerSession,
  parseCodexThreadId,
  readPrivateWorkerRecoveryTurn,
  resumeHarnessSession,
  writePrivateWorkerCorrelationFollowUpTurn,
  makeHarnessProviderRegistry,
  issueDeliveryWorkerHarnessCapabilities,
  inspectContinuableDeliveryWorktreeOwnership,
  inspectRecoverableDeliveryWorktreeOwnership,
  inspectRetainedPayloadDeliveryWorktreeOwnership,
  makeRunPaths,
  makeRuntimeError,
  loadRun,
  parseDeliveryProvenance,
  type RunPaths,
  type HarnessProviderRegistry,
  type WorkerRecoveryProvider,
  type WorkerRecoveryWorkspaceValidation,
  type WorkerRecoveryThreadStatus,
} from "@gaia/runtime";
import {
  reconcileInterruptedServerRuns,
  type WorkerDesktopOriginCorrelationInput,
  type WorkerCorrelationReconciliationInput,
} from "@gaia/runtime/server-workflows";
import { makeTestHarnessProviderRegistry } from "@gaia/runtime/test-support";
import { Effect, FileSystem, Layer, Path } from "effect";
import * as Console from "effect/Console";
import { HttpServer } from "effect/unstable/http";
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import nodePath from "node:path";
import { pathToFileURL } from "node:url";
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

export type ServerConfig = {
  readonly host: "127.0.0.1";
  readonly port: number;
  readonly rootDirectory: string;
  readonly testHarness: boolean;
};

export const defaultServerConfig = {
  host: "127.0.0.1",
  port: 0,
  rootDirectory: process.cwd(),
  testHarness: false,
} satisfies ServerConfig;

export function runLocalGaiaServer(input: {
  readonly harnessProviderRegistry?: HarnessProviderRegistry | undefined;
  readonly onReady?: ((metadata: ServerMetadata) => Effect.Effect<void>) | undefined;
  readonly port?: number | undefined;
  readonly rootDirectory?: string | undefined;
}): Effect.Effect<void, unknown> {
  const identity = makeServerIdentity({
    host: defaultServerConfig.host,
    rootDirectory: input.rootDirectory ?? defaultServerConfig.rootDirectory,
  });
  const port = input.port ?? defaultServerConfig.port;
  const nodeLayer = NodeHttpServer.layer(createServer, {
    host: identity.host,
    port,
  });
  return Effect.scoped(
    Effect.gen(function* () {
      const production = input.harnessProviderRegistry === undefined
        ? yield* makeProductionHarnessServices(identity.rootDirectory)
        : undefined;
      const harnessProviderRegistry = input.harnessProviderRegistry ?? production!.registry;
      const workflowOptions = {
        deliveryObservationEnabled: true,
        harnessProviderRegistry,
        rootDirectory: identity.rootDirectory,
        ...(production === undefined ? {} : {
          workerDesktopOriginCorrelationFollowUpDispatcher: production.dispatchDesktopOriginCorrelationFollowUp,
          workerDesktopOriginCorrelationReconciler: production.reconcileDesktopOriginCorrelation,
          workerCorrelationFollowUpDispatcher: production.dispatchCorrelationFollowUp,
          workerCorrelationReconciler: production.reconcileCorrelation,
          workerRecoveryActivator: production.recover,
        }),
      };
      const reconciliation = yield* reconcileInterruptedServerRuns(
        workflowOptions,
      );
      const serverLayer = makeLocalGaiaServerLayer(
        identity,
        workflowOptions,
        reconciliation.resumableRunIds,
      ).pipe(Layer.provideMerge(nodeLayer));
      yield* Effect.gen(function* () {
        const server = yield* HttpServer.HttpServer;
        const metadata = yield* serverMetadataFromAddress(identity, server.address);
        yield* writeServerMetadata(metadata);
        yield* Effect.addFinalizer(() =>
          removeServerMetadata(metadata).pipe(Effect.orElseSucceed(() => undefined)),
        );
        const discoveryPaths = yield* serverDiscoveryPaths(metadata.workspaceRoot);
        yield* appendServerLog(
          metadata.workspaceRoot,
          `${metadata.startedAt} listening ${metadata.url} serverId=${metadata.serverId} pid=${metadata.pid} workspaceRoot=${metadata.workspaceRoot} metadata=${discoveryPaths.serverJson}`,
        );
        if (input.onReady !== undefined) {
          yield* input.onReady(metadata);
        }
        yield* Console.log(
          `Gaia local API listening on ${metadata.url}`,
        );
        yield* Console.log(`workspace: ${metadata.workspaceRoot}`);
        yield* Effect.never;
      }).pipe(Effect.provide(serverLayer));
    }),
  ).pipe(Effect.provide(NodeServices.layer));
}

function makeProductionHarnessServices(rootDirectory: string) {
  return Effect.gen(function* () {
    const connection = yield* makeCodexAppServerConnection({
      cwd: rootDirectory,
    });
    const client = makeCodexAppServerClient(connection);
    const correlationStore = makeFileCodexHarnessCorrelationStore(rootDirectory);
    const provider = createCodexHarnessProvider({
      client,
      correlationStore,
      detectionProbe: detectInstalledCodexAppServer,
      workspaceRoot: rootDirectory,
    });
    const registry = makeHarnessProviderRegistry([
      { profileId: codexAppServerHarnessProfileId, provider },
    ]);
    const recover = (runId: RunId, action: Parameters<typeof recoverWorkerSession>[1]) => Effect.gen(function* () {
      const correlation = yield* correlationStore.load(action.expectedSessionId);
      const nativeThreadId = correlation === undefined ? undefined : decodeCodexHarnessCorrelation(correlation);
      if (nativeThreadId === undefined) {
        return yield* Effect.fail(makeRuntimeError({
          code: "WorkerRecoveryCorrelationUnavailable",
          message: "Worker recovery session correlation is unavailable.",
          recoverable: false,
        }));
      }
      return yield* recoverWorkerSession(runId, action, {
        nativeThreadId,
        rootDirectory,
        provider: makeProductionWorkerRecoveryProvider({
          detect: provider.detect,
          listModels: () => listCodexModels(connection, { includeHidden: false }).pipe(Effect.map(({ data }) => data.map(({ hidden, id }) => ({ hidden, id })))),
          readThread: (threadId) => client.readThread({ includeTurns: true, threadId: parseCodexThreadId(threadId) }).pipe(Effect.map(({ thread }) => ({ status: toWorkerRecoveryThreadStatus(thread.status?.type), threadId: thread.id }))),
          resumeThread: (threadId) => client.resumeThread({ threadId: parseCodexThreadId(threadId) }).pipe(Effect.map(({ thread }) => ({ status: toWorkerRecoveryThreadStatus(thread.status?.type), threadId: thread.id }))),
          startTurn: ({ model, threadId }) => client.startTurn({ input: [{ text: "Resume the retained worker task after the recoverable provider failure.", type: "text" }], model, threadId: parseCodexThreadId(threadId) }).pipe(Effect.map(({ turn }) => ({ turnId: turn.id }))),
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
    const reconcileCorrelation = (input: WorkerCorrelationReconciliationInput) =>
      Effect.gen(function* () {
        const acceptedAt = input.events[0]?.timestamp;
        if (acceptedAt === undefined) {
          return yield* Effect.fail(makeRuntimeError({
            code: "HarnessCorrelationUnavailable",
            message: "Audited correlation reconciliation requires the accepted worker workspace.",
            recoverable: false,
          }));
        }
        const workspacePath = yield* resolveAuditedWorkerWorkspacePath({
          events: input.events,
          paths: input.paths,
          rootDirectory,
        });
        const candidates = yield* listStableCodexThreadsForWorkspace(client, workspacePath);
        const acceptedAtSeconds = Math.floor(Date.parse(acceptedAt) / 1000);
        if (!Number.isFinite(acceptedAtSeconds)) {
          return yield* Effect.fail(makeRuntimeError({
            code: "HarnessCorrelationUnavailable",
            message: "Audited correlation reconciliation requires a valid accepted creation timestamp.",
            recoverable: false,
          }));
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
            const read = yield* client.readThread({ includeTurns: true, threadId: thread.id });
            const turns = read.thread.turns ?? [];
            const latest = turns.at(-1);
            if (
              read.thread.id !== thread.id ||
              latest === undefined ||
              latest.status !== "interrupted" ||
              digestStableNativeId(latest.id) !== input.action.expectedNativeTurnIdDigest
            ) {
              return undefined;
            }
            const digestMatches = turns.filter(({ id }) => digestStableNativeId(id) === input.action.expectedNativeTurnIdDigest);
            return digestMatches.length === 1 ? { threadId: thread.id } : undefined;
          }),
        ).pipe(Effect.map((items) => items.filter((item): item is { readonly threadId: ReturnType<typeof parseCodexThreadId> } => item !== undefined)));
        const [match] = matches;
        if (matches.length !== 1 || match === undefined) {
          return yield* Effect.fail(makeRuntimeError({
            code: "HarnessCorrelationUnavailable",
            message: "Audited correlation reconciliation could not identify exactly one interrupted App Server checkpoint.",
            recoverable: false,
          }));
        }
        yield* correlationStore.save(
          input.action.expectedSessionId,
          encodeCodexHarnessCorrelation(match.threadId),
        );
      });
    const reconcileDesktopOriginCorrelation = (input: WorkerDesktopOriginCorrelationInput) =>
      Effect.gen(function* () {
        const acceptedAt = input.events[0]?.timestamp;
        if (acceptedAt === undefined) {
          return yield* Effect.fail(makeRuntimeError({
            code: "HarnessCorrelationUnavailable",
            message: "Audited Desktop-origin correlation requires the accepted worker workspace.",
            recoverable: false,
          }));
        }
        const workspacePath = yield* resolveAuditedWorkerWorkspacePath({
          events: input.events,
          paths: input.paths,
          rootDirectory,
        });
        const acceptedAtSeconds = Math.floor(Date.parse(acceptedAt) / 1000);
        if (!Number.isFinite(acceptedAtSeconds)) {
          return yield* Effect.fail(makeRuntimeError({
            code: "HarnessCorrelationUnavailable",
            message: "Audited Desktop-origin correlation requires a valid accepted creation timestamp.",
            recoverable: false,
          }));
        }
        const match = yield* findStableDesktopOriginCorrelationThread({
          client,
          expectedDigest: input.action.expectedNativeTurnIdDigest,
          acceptedAtSeconds,
          workspacePath,
        });
        yield* correlationStore.save(
          input.action.expectedSessionId,
          encodeCodexHarnessCorrelation(match.threadId),
        );
      });
    const dispatchCorrelationFollowUp = (input: WorkerCorrelationReconciliationInput) =>
      dispatchCorrelationFollowUpFor(input);
    const dispatchDesktopOriginCorrelationFollowUp = (input: WorkerDesktopOriginCorrelationInput) =>
      dispatchCorrelationFollowUpFor(input);
    const dispatchCorrelationFollowUpFor = (input: {
      readonly action: {
        readonly expectedFailedRecoverySequence: number;
        readonly expectedNativeTurnIdDigest: string;
        readonly expectedRecoveryActionId: string;
        readonly expectedSessionId: WorkerCorrelationReconciliationInput["action"]["expectedSessionId"];
      };
      readonly clientInputId: string;
      readonly events: ReadonlyArray<{ readonly payload: Record<string, unknown>; readonly sequence: number; readonly type: string }>;
      readonly followUpText: string;
      readonly paths: RunPaths;
    }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const workspacePath = yield* resolveAuditedWorkerWorkspacePath({
            events: input.events,
            paths: input.paths,
            rootDirectory,
          });
          const recoveryReceipt = yield* findBoundWorkerRecoveryReceipt(input.events, input.action);
          const checkpointTurnId = yield* readPrivateWorkerRecoveryTurn(
            input.paths.root,
            input.action.expectedNativeTurnIdDigest,
            recoveryReceipt,
          );
          yield* resumeHarnessSession({
            provider,
            request: {
              allowInterruptedCheckpoint: true,
              expectedNativeTurnId: checkpointTurnId,
              sessionId: input.action.expectedSessionId,
              workspacePath: parseWorkspaceRelativePath(
                nodePath.relative(rootDirectory, workspacePath),
              ),
            },
            requiredCapabilities: issueDeliveryWorkerHarnessCapabilities,
          });
          const correlation = yield* correlationStore.load(input.action.expectedSessionId);
          const threadId = correlation === undefined
            ? undefined
            : decodeCodexHarnessCorrelation(correlation);
          if (threadId === undefined) {
            return yield* Effect.fail(makeRuntimeError({
              code: "HarnessCorrelationUnavailable",
              message: "Audited correlation follow-up requires a private session correlation.",
              recoverable: false,
            }));
          }
          const turn = yield* client.startTurn({
            clientUserMessageId: input.clientInputId,
            input: [{ text: input.followUpText, type: "text" }],
            threadId,
          });
          yield* writePrivateWorkerCorrelationFollowUpTurn(
            input.paths.root,
            turn.turn.id,
          );
        }),
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

function workerWorkspacePath(events: ReadonlyArray<{ readonly payload: Readonly<Record<string, unknown>>; readonly type: string }>) {
  const workspacePath = events.find(({ type }) => type === "WORKSPACE_PREPARED")?.payload["workspacePath"];
  return typeof workspacePath === "string" ? workspacePath : undefined;
}

export function resolveAuditedWorkerWorkspacePath(input: {
  readonly events: ReadonlyArray<{ readonly payload: Readonly<Record<string, unknown>>; readonly type: string }>;
  readonly inspectOwnership?: (() => Effect.Effect<void, unknown, FileSystem.FileSystem>) | undefined;
  readonly paths: RunPaths;
  readonly rootDirectory: string;
}) {
  return Effect.gen(function* () {
    const rawWorkspacePath = workerWorkspacePath(input.events);
    if (rawWorkspacePath === undefined || /[\u0000-\u001f\u007f]/u.test(rawWorkspacePath)) {
      return yield* failAuditedWorkerWorkspacePath();
    }

    let workspaceRelativePath: string;
    let expectedWorkspaceRelativePath: string;
    try {
      workspaceRelativePath = parseWorkspaceRelativePath(rawWorkspacePath);
      expectedWorkspaceRelativePath = parseWorkspaceRelativePath(
        nodePath.relative(input.paths.root, input.paths.workspace),
      );
    } catch {
      return yield* failAuditedWorkerWorkspacePath();
    }

    if (workspaceRelativePath !== expectedWorkspaceRelativePath) {
      return yield* failAuditedWorkerWorkspacePath();
    }

    const fs = yield* FileSystem.FileSystem;
    const canonicalRunRoot = yield* fs.realPath(input.paths.root).pipe(
      Effect.mapError(() => auditedWorkerWorkspacePathError()),
    );
    const canonicalWorkspace = yield* fs.realPath(input.paths.workspace).pipe(
      Effect.mapError(() => auditedWorkerWorkspacePathError()),
    );
    const canonicalCandidate = yield* fs.realPath(
      nodePath.join(input.paths.root, workspaceRelativePath),
    ).pipe(Effect.mapError(() => auditedWorkerWorkspacePathError()));
    if (
      canonicalCandidate !== canonicalWorkspace ||
      nodePath.relative(canonicalRunRoot, canonicalWorkspace) !== expectedWorkspaceRelativePath
    ) {
      return yield* failAuditedWorkerWorkspacePath();
    }

    yield* (input.inspectOwnership ?? (() => inspectAuditedWorkerWorkspaceOwnership(input)))().pipe(
      Effect.mapError(() => auditedWorkerWorkspacePathError()),
    );
    return canonicalWorkspace;
  });
}

function inspectAuditedWorkerWorkspaceOwnership(input: {
  readonly events: ReadonlyArray<{ readonly payload: Readonly<Record<string, unknown>>; readonly type: string }>;
  readonly paths: RunPaths;
  readonly rootDirectory: string;
}) {
  return Effect.gen(function* () {
    const provenance = parseDeliveryProvenance(input.events[0]?.payload["delivery"]);
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

function digestStableNativeId(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

type ListedCodexThreadForReconciliation = {
  readonly createdAt: number;
  readonly cwd: string;
  readonly id: ReturnType<typeof parseCodexThreadId>;
  readonly sessionId: string;
  readonly source: unknown;
  readonly status?: { readonly type: string };
};

type StableCodexThreadListClient = {
  readonly listThreads: (params: {
    readonly archived: boolean;
    readonly cursor: string | null;
    readonly cwd: string;
    readonly limit: number;
    readonly sortDirection: "asc";
    readonly sortKey: "created_at";
    readonly sourceKinds: ReadonlyArray<"appServer" | "vscode">;
    readonly useStateDbOnly: boolean;
  }) => Effect.Effect<{
    readonly data: ReadonlyArray<ListedCodexThreadForReconciliation>;
    readonly nextCursor: string | null;
  }, unknown>;
};
type StableCodexThreadReadClient = {
  readonly readThread: (params: {
    readonly includeTurns: true;
    readonly threadId: ReturnType<typeof parseCodexThreadId>;
  }) => Effect.Effect<{
    readonly thread: {
      readonly id: ReturnType<typeof parseCodexThreadId>;
      readonly turns?: ReadonlyArray<{
        readonly id: string;
        readonly status?: string;
      }>;
    };
  }, unknown>;
};
type StableCodexThreadClient = StableCodexThreadListClient & StableCodexThreadReadClient;

export function listStableCodexThreadsForWorkspace(
  client: StableCodexThreadListClient,
  workspacePath: string,
) {
  return Effect.gen(function* () {
    const byId = new Map<string, ListedCodexThreadForReconciliation>();
    for (const archived of [false, true] as const) {
      const seenCursors = new Set<string>();
      let cursor: string | null = null;
      do {
        const page: {
          readonly data: ReadonlyArray<ListedCodexThreadForReconciliation>;
          readonly nextCursor: string | null;
        } = yield* client.listThreads({
          archived,
          cursor,
          cwd: workspacePath,
          limit: 100,
          sortDirection: "asc",
          sortKey: "created_at",
          sourceKinds: ["appServer"],
          useStateDbOnly: true,
        });
        for (const thread of page.data) {
          byId.set(thread.id, thread);
        }
        if (page.nextCursor !== null) {
          if (seenCursors.has(page.nextCursor)) {
            return yield* Effect.fail(makeRuntimeError({
              code: "HarnessCorrelationUnavailable",
              message: "Audited correlation reconciliation detected cyclic App Server thread pagination.",
              recoverable: false,
            }));
          }
          seenCursors.add(page.nextCursor);
        }
        cursor = page.nextCursor;
      } while (cursor !== null);
    }
    return [...byId.values()];
  });
}

export function findStableDesktopOriginCorrelationThread(input: {
  readonly acceptedAtSeconds: number;
  readonly client: StableCodexThreadClient;
  readonly expectedDigest: string;
  readonly workspacePath: string;
}) {
  return Effect.gen(function* () {
    const stateDb = yield* listStableCodexThreadsForWorkspaceBySource(
      input.client,
      input.workspacePath,
      true,
      ["appServer", "vscode"],
    );
    const jsonl = yield* listStableCodexThreadsForWorkspaceBySource(
      input.client,
      input.workspacePath,
      false,
      ["appServer", "vscode"],
    );
    const earliestAcceptedCandidate = input.acceptedAtSeconds - desktopOriginCorrelationAcceptedWindowSeconds;
    const latestAcceptedCandidate = input.acceptedAtSeconds + desktopOriginCorrelationAcceptedWindowSeconds;
    const candidateFilter = (thread: ListedCodexThreadForReconciliation) =>
      thread.cwd === input.workspacePath &&
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
      return yield* Effect.fail(makeRuntimeError({
        code: "HarnessCorrelationUnavailable",
        message: "Audited Desktop-origin correlation could not prove one stable Codex thread identity.",
        recoverable: false,
      }));
    }
    if (
      stateDbMatch.source === "vscode" &&
      process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE !== "Codex Desktop"
    ) {
      return yield* Effect.fail(makeRuntimeError({
        code: "HarnessCorrelationUnavailable",
        message: "Audited Desktop-origin correlation requires a private Codex Desktop originator proof.",
        recoverable: false,
      }));
    }
    const read = yield* input.client.readThread({ includeTurns: true, threadId: stateDbMatch.id }).pipe(
      Effect.mapError(() =>
        makeRuntimeError({
          code: "HarnessCorrelationUnavailable",
          message: "Audited Desktop-origin correlation could not read the stable Codex thread.",
          recoverable: false,
        })
      ),
    );
    const turns = read.thread.turns ?? [];
    const latest = turns.at(-1);
    if (
      read.thread.id !== stateDbMatch.id ||
      latest === undefined ||
      latest.status !== "interrupted" ||
      digestStableNativeId(latest.id) !== input.expectedDigest
    ) {
      return yield* Effect.fail(makeRuntimeError({
        code: "HarnessCorrelationUnavailable",
        message: "Audited Desktop-origin correlation could not prove the exact interrupted checkpoint.",
        recoverable: false,
      }));
    }
    const digestMatches = turns.filter(({ id }) => digestStableNativeId(id) === input.expectedDigest);
    if (digestMatches.length !== 1) {
      return yield* Effect.fail(makeRuntimeError({
        code: "HarnessCorrelationUnavailable",
        message: "Audited Desktop-origin correlation found an ambiguous checkpoint digest.",
        recoverable: false,
      }));
    }
    return { threadId: stateDbMatch.id };
  });
}

function listStableCodexThreadsForWorkspaceBySource(
  client: StableCodexThreadListClient,
  workspacePath: string,
  useStateDbOnly: boolean,
  sourceKinds: ReadonlyArray<"appServer" | "vscode">,
) {
  return Effect.gen(function* () {
    const observations: Array<ListedCodexThreadForReconciliation> = [];
    for (const archived of [false, true] as const) {
      const seenCursors = new Set<string>();
      let observationCount = 0;
      let pageCount = 0;
      let cursor: string | null = null;
      do {
        if (pageCount >= stableThreadListMaxPagesPerTraversal) {
          return yield* Effect.fail(makeRuntimeError({
            code: "HarnessCorrelationUnavailable",
            message: "Audited Desktop-origin correlation exceeded the stable App Server thread pagination budget.",
            recoverable: false,
          }));
        }
        const page: {
          readonly data: ReadonlyArray<ListedCodexThreadForReconciliation>;
          readonly nextCursor: string | null;
        } = yield* client.listThreads({
          archived,
          cursor,
          cwd: workspacePath,
          limit: 100,
          sortDirection: "asc",
          sortKey: "created_at",
          sourceKinds: [...sourceKinds],
          useStateDbOnly,
        }).pipe(
          Effect.mapError(() =>
            makeRuntimeError({
              code: "HarnessCorrelationUnavailable",
              message: "Audited Desktop-origin correlation could not list stable Codex threads.",
              recoverable: false,
            })
          ),
        );
        pageCount += 1;
        observationCount += page.data.length;
        if (observationCount > stableThreadListMaxObservationsPerTraversal) {
          return yield* Effect.fail(makeRuntimeError({
            code: "HarnessCorrelationUnavailable",
            message: "Audited Desktop-origin correlation exceeded the stable App Server thread observation budget.",
            recoverable: false,
          }));
        }
        observations.push(...page.data);
        if (page.nextCursor !== null) {
          if (seenCursors.has(page.nextCursor)) {
            return yield* Effect.fail(makeRuntimeError({
              code: "HarnessCorrelationUnavailable",
              message: "Audited Desktop-origin correlation detected cyclic App Server thread pagination.",
              recoverable: false,
            }));
          }
          seenCursors.add(page.nextCursor);
        }
        cursor = page.nextCursor;
      } while (cursor !== null);
    }
    return observations;
  });
}

const desktopOriginCorrelationAcceptedWindowSeconds = 300;
const stableThreadListMaxObservationsPerTraversal = 10_000;
const stableThreadListMaxPagesPerTraversal = 100;

/** Normalize stable App Server thread status into the finite recovery preflight vocabulary. */
export function toWorkerRecoveryThreadStatus(status: string | undefined): WorkerRecoveryThreadStatus {
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
  },
): WorkerRecoveryProvider {
  return {
    listModels: () =>
      Effect.gen(function* () {
        const detection = yield* input.detect;
        if (detection.state !== "available") {
          return yield* Effect.fail(
            new Error("Codex App Server is unavailable or incompatible."),
          );
        }
        return yield* input.listModels();
      }),
    readThread: input.readThread,
    resumeThread: input.resumeThread,
    startTurn: input.startTurn,
  };
}

export function validateProductionWorkerRecoveryWorkspace(input: {
  readonly action: Parameters<typeof recoverWorkerSession>[1];
  readonly expectedHead: string;
  readonly rootDirectory: string;
  readonly runId: RunId;
}): Effect.Effect<WorkerRecoveryWorkspaceValidation, unknown, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const paths = yield* makeRunPaths(input.runId, {
      rootDirectory: input.rootDirectory,
    });
    const loaded = yield* loadRun(paths);
    const provenance = parseDeliveryProvenance(loaded.events[0]?.payload["delivery"]);
    if (provenance._tag === "None" || provenance.value.baseRevision !== input.expectedHead) {
      return yield* Effect.fail(new Error("Accepted delivery provenance changed."));
    }
    const inspection = {
      expectedHeads: [input.expectedHead],
      options: { rootDirectory: input.rootDirectory },
      paths,
      provenance: provenance.value,
    };
    return shouldAllowRetainedPayloadWorkerRecovery(loaded.events, input.action)
      ? yield* inspectRetainedPayloadDeliveryWorktreeOwnership(inspection)
      : yield* inspectRecoverableDeliveryWorktreeOwnership(inspection);
  });
}

function shouldAllowRetainedPayloadWorkerRecovery(
  events: ReadonlyArray<{ readonly payload: Record<string, unknown>; readonly sequence: number; readonly type: string }>,
  action: Parameters<typeof recoverWorkerSession>[1],
) {
  if (events.some(({ type }) => blocksRetainedPayloadWorkerRecovery(type))) return false;
  const currentFailureIndex = events.findIndex((event) => event.sequence === action.expectedFailureSequence);
  const currentFailure = currentFailureIndex < 0 ? undefined : events[currentFailureIndex];
  if (
    currentFailure?.sequence !== action.expectedFailureSequence ||
    currentFailure.type !== "RUN_FAILED" ||
    currentFailure.payload["recoverable"] !== true ||
    currentFailure.payload["stage"] !== "runningWorker"
  ) {
    return false;
  }
  const actionDigest = createHash("sha256").update(JSON.stringify(action)).digest("hex");
  const suffix = events.slice(currentFailureIndex + 1);
  if (!suffix.every((event) => {
    if (event.type !== "WORKER_RECOVERY_RECORDED") return false;
    const receipt = parseWorkerRecoveryReceipt(event.payload["recovery"]);
    return receipt.actionId === action.actionId &&
      receipt.expectedFailureSequence === action.expectedFailureSequence &&
      receipt.payloadDigest === actionDigest;
  })) {
    return false;
  }
  const latestPriorReceiptsByFailure = new Map<number, ReturnType<typeof parseWorkerRecoveryReceipt>>();
  for (const event of events.slice(0, currentFailureIndex)) {
    if (event.type !== "WORKER_RECOVERY_RECORDED") continue;
    const receipt = parseWorkerRecoveryReceipt(event.payload["recovery"]);
    if (receipt.expectedFailureSequence < action.expectedFailureSequence) {
      latestPriorReceiptsByFailure.set(receipt.expectedFailureSequence, receipt);
    }
  }
  const latestPriorReceipts = [...latestPriorReceiptsByFailure.values()];
  return latestPriorReceipts.length > 0 &&
    latestPriorReceipts.every((receipt) =>
      receipt.state === "dispatchConfirmed" ||
      receipt.state === "failed" ||
      receipt.state === "outcomeUnknown"
    );
}

function blocksRetainedPayloadWorkerRecovery(type: string) {
  return type === "DELIVERY_READY_TO_PUBLISH" ||
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
    type === "MERGE_DECISION_RECORDED";
}

function findBoundWorkerRecoveryReceipt(
  events: ReadonlyArray<{ readonly payload: Record<string, unknown>; readonly sequence: number; readonly type: string }>,
  action: {
    readonly expectedFailedRecoverySequence: number;
    readonly expectedRecoveryActionId: string;
  },
) {
  return Effect.gen(function* () {
    const receipt = [...events].reverse().flatMap((event) => {
      if (event.type !== "WORKER_RECOVERY_RECORDED") return [];
      const recovery = parseWorkerRecoveryReceipt(event.payload["recovery"]);
      return event.sequence === action.expectedFailedRecoverySequence && recovery.actionId === action.expectedRecoveryActionId
        ? [recovery]
        : [];
    })[0];
    if (receipt === undefined) {
      return yield* Effect.fail(makeRuntimeError({
        code: "WorkerRecoveryTurnCheckpointInvalid",
        message: "The exact recovered native turn checkpoint is missing or invalid.",
        recoverable: false,
      }));
    }
    return receipt;
  }).pipe(Effect.mapError((cause) => makeRuntimeError({
    cause,
    code: "WorkerRecoveryTurnCheckpointInvalid",
    message: "The exact recovered native turn checkpoint is missing or invalid.",
    recoverable: false,
  })));
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

  return {
    host: defaultServerConfig.host,
    port,
    rootDirectory,
    testHarness,
  };
}

function makeServerIdentity(input: {
  readonly host: "127.0.0.1";
  readonly rootDirectory: string;
}): LocalServerIdentity {
  return {
    host: input.host,
    pid: process.pid,
    rootDirectory: input.rootDirectory,
    serverId: `srv_${randomUUID()}`,
    startedAt: new Date().toISOString(),
  };
}

function parsePort(input: string): number {
  const parsed = /^\d+$/u.test(input) ? Number(input) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new Error(`Invalid port: ${input}`);
  }

  return parsed;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = parseServerArgs(process.argv.slice(2));
  runLocalGaiaServer({
    ...(config.testHarness
      ? { harnessProviderRegistry: makeTestHarnessProviderRegistry() }
      : {}),
    port: config.port,
    rootDirectory: config.rootDirectory,
  }).pipe(NodeRuntime.runMain);
}
