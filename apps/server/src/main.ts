#!/usr/bin/env node
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { NodeHttpServer, NodeServices } from "@effect/platform-node";
import {
  codexAppServerHarnessProfileId,
  parseWorkspaceRelativePath,
  parseRunId,
  type HarnessDetection,
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
  inspectRecoverableDeliveryWorktreeOwnership,
  makeRunPaths,
  makeRuntimeError,
  loadRun,
  parseDeliveryProvenance,
  type HarnessProviderRegistry,
  type WorkerRecoveryProvider,
  type WorkerRecoveryThreadStatus,
} from "@gaia/runtime";
import {
  reconcileInterruptedServerRuns,
  type WorkerCorrelationReconciliationInput,
} from "@gaia/runtime/server-workflows";
import { makeTestHarnessProviderRegistry } from "@gaia/runtime/test-support";
import { Effect, Layer } from "effect";
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
    const recover = (runId: string, action: Parameters<typeof recoverWorkerSession>[1]) => Effect.gen(function* () {
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
        validateWorkspace: (_workspacePath, expectedHead) => Effect.gen(function* () {
          const paths = yield* makeRunPaths(parseRunId(runId), { rootDirectory });
          const loaded = yield* loadRun(paths);
          const provenance = parseDeliveryProvenance(loaded.events[0]?.payload["delivery"]);
          if (provenance._tag === "None" || provenance.value.baseRevision !== expectedHead) return yield* Effect.fail(new Error("Accepted delivery provenance changed."));
          yield* inspectRecoverableDeliveryWorktreeOwnership({ expectedHeads: [expectedHead], options: { rootDirectory }, paths, provenance: provenance.value });
        }),
      });
    });
    const reconcileCorrelation = (input: WorkerCorrelationReconciliationInput) =>
      Effect.gen(function* () {
        const workspacePath = workerWorkspacePath(input.events);
        const acceptedAt = input.events[0]?.timestamp;
        if (workspacePath === undefined || acceptedAt === undefined) {
          return yield* Effect.fail(makeRuntimeError({
            code: "HarnessCorrelationUnavailable",
            message: "Audited correlation reconciliation requires the accepted worker workspace.",
            recoverable: false,
          }));
        }
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
    const dispatchCorrelationFollowUp = (input: WorkerCorrelationReconciliationInput) =>
      Effect.scoped(
        Effect.gen(function* () {
          const workspacePath = workerWorkspacePath(input.events);
          if (workspacePath === undefined) {
            return yield* Effect.fail(makeRuntimeError({
              code: "HarnessCorrelationUnavailable",
              message: "Audited correlation follow-up requires the accepted worker workspace.",
              recoverable: false,
            }));
          }
          const checkpointTurnId = yield* readPrivateWorkerRecoveryTurn(
            input.paths.root,
            input.action.expectedNativeTurnIdDigest,
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
    return { dispatchCorrelationFollowUp, recover, reconcileCorrelation, registry };
  });
}

function workerWorkspacePath(events: ReadonlyArray<{ readonly payload: Readonly<Record<string, unknown>>; readonly type: string }>) {
  const workspacePath = events.find(({ type }) => type === "WORKSPACE_PREPARED")?.payload["workspacePath"];
  return typeof workspacePath === "string" ? workspacePath : undefined;
}

function digestStableNativeId(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

type ListedCodexThreadForReconciliation = {
  readonly createdAt: number;
  readonly cwd: string;
  readonly id: ReturnType<typeof parseCodexThreadId>;
  readonly source: unknown;
};

type StableCodexThreadListClient = Pick<ReturnType<typeof makeCodexAppServerClient>, "listThreads">;

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
