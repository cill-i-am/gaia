import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeServices } from "@effect/platform-node";
import { assert, describe, it, layer } from "@effect/vitest";
import {
  codexAppServerExecutionSelection,
  DeliveryBranchNamePublicSchema,
  DeliveryFeedbackTrustPolicyV1,
  DeliveryGitShaPublicSchema,
  DeliveryPublicationConfirmed,
  DeliveryRemoteNamePublicSchema,
  HarnessProfileIdSchema,
  HarnessSessionIdSchema,
  RunEvent,
  WorkerContinuationReceiptSchema,
  WorkerContinuationAction,
  WorkerCorrelationReconciliationReceiptSchema,
  WorkerCorrelationReconciliationAction,
  WorkerDesktopOriginCorrelationReceiptSchema,
  WorkerDesktopOriginCorrelationAction,
  WorkerRecoveryActionIdSchema,
  WorkerRecoveryDigestSchema,
  WorkerRecoveryModelIdSchema,
  encodeWorkerContinuationReceiptJson,
  encodeWorkerCorrelationReconciliationReceiptJson,
  encodeWorkerDesktopOriginCorrelationReceiptJson,
  encodeWorkerRecoveryReceiptJson,
  HarnessCapabilities,
  HarnessProviderDescriptor,
  parseRunId,
  parseHarnessProviderId,
  parseHarnessSessionId,
  parseWorkerRecoveryActionId,
  parseWorkerRecoveryDigest,
  ResolvedHarnessExecution,
  snapshotFromReplay,
} from "@gaia/core";
import { Effect, FileSystem, Schema } from "effect";

import {
  CodexTurnIdSchema,
  parseCodexTurnId,
} from "./codex-app-server-protocol.js";
import { GaiaRuntimeError } from "./errors.js";
import { appendEvent } from "./event-store.js";
import {
  DeliveryAcceptanceProvenancePolicyV1,
  prepareDeliveryWorktree,
  type GitDeliveryCommandInput,
} from "./git-delivery.js";
import { makeHarnessProviderRegistry } from "./harness-provider-registry.js";
import {
  parseHarnessCheckpointToken,
  type HarnessProvider,
} from "./harness-session.js";
import { makeRunPaths } from "./paths.js";
import {
  ReviewFinding,
  ReviewResult,
  ReviewerNameSchema,
  type GaiaReviewer,
} from "./reviewer.js";
import { readLocalRun, readLocalRunEvents } from "./run-read-api.js";
import {
  acceptFactoryRun,
  acceptServerRun,
  actOnWorkerDesktopOriginCorrelation,
  actOnWorkerCorrelationReconciliation,
  actOnWorkerContinuation,
  continueServerRun,
  reconcileInterruptedServerRuns,
} from "./server-workflows.js";
import { makeTestHarnessProviderRegistry } from "./test-support.js";

const WorkerContinuationEventPayloadSchema = Schema.Struct({
  continuation: WorkerContinuationReceiptSchema,
});
const WorkerCorrelationEventPayloadSchema = Schema.Struct({
  reconciliation: WorkerCorrelationReconciliationReceiptSchema,
});
const WorkerDesktopOriginEventPayloadSchema = Schema.Struct({
  desktopOriginCorrelation: WorkerDesktopOriginCorrelationReceiptSchema,
});
const decodeWorkerContinuationEventPayload = Schema.decodeUnknownSync(
  WorkerContinuationEventPayloadSchema
);
const decodeWorkerCorrelationEventPayload = Schema.decodeUnknownSync(
  WorkerCorrelationEventPayloadSchema
);
const decodeWorkerDesktopOriginEventPayload = Schema.decodeUnknownSync(
  WorkerDesktopOriginEventPayloadSchema
);

describe("server workflows", () => {
  layer(NodeServices.layer)((it) => {
    it.effect("durably accepts Markdown content before continuation", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({
          prefix: "gaia-server-workflow-",
        });

        const accepted = yield* acceptServerRun(
          { specMarkdown: "Accept this server run.\n" },
          { rootDirectory: cwd }
        );
        const input = yield* fs.readFileString(
          `${accepted.runDirectory}/input.md`
        );
        const events = yield* readLocalRunEvents(accepted.runId, {
          rootDirectory: cwd,
        });

        assert.strictEqual(input, "Accept this server run.\n");
        assert.strictEqual(events.events.length, 1);
        assert.strictEqual(events.events[0]?.type, "RUN_CREATED");
        assert.strictEqual(events.events[0]?.payload["source"], "server");
        assert.strictEqual(events.events[0]?.sequence, accepted.eventSequence);
      })
    );

    it.effect(
      "resolves and persists only safe execution metadata before accepting a factory run",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-factory-accept-",
          });
          const registry = makeHarnessProviderRegistry([
            {
              profileId: codexAppServerExecutionSelection.harnessProfileId,
              provider: acceptanceProvider,
            },
          ]);

          const accepted = yield* acceptFactoryRun(
            {
              execution: codexAppServerExecutionSelection,
              workflow: "issueDelivery",
              workItem: {
                description: "Deliver through the selected provider.",
                kind: "issue",
                title: "Selected provider acceptance",
              },
            },
            { harnessProviderRegistry: registry, rootDirectory: cwd }
          );
          const events = yield* readLocalRunEvents(accepted.runId, {
            rootDirectory: cwd,
          });
          const serialized = JSON.stringify(events.events[0]?.payload);

          assert.deepEqual(events.events[0]?.payload["execution"], {
            resolved: Schema.encodeSync(ResolvedHarnessExecution)(
              ResolvedHarnessExecution.make({
                capabilities: acceptanceCapabilities,
                executionMode: "local",
                harnessProfileId:
                  codexAppServerExecutionSelection.harnessProfileId,
                provider: acceptanceProvider.descriptor,
                version: "synthetic-1",
              })
            ),
            selection: { harnessProfileId: "codexAppServer" },
          });
          assert.notInclude(serialized, "credential");
          assert.notInclude(serialized, "/usr/local/bin");
        })
    );

    it.effect(
      "continues an accepted server run through the default workflow",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-server-workflow-",
          });
          const accepted = yield* acceptServerRun(
            { specMarkdown: "Complete this server run.\n" },
            { rootDirectory: cwd }
          );

          const summary = yield* continueServerRun(accepted.runId, {
            rootDirectory: cwd,
          });
          const read = yield* readLocalRun(accepted.runId, {
            rootDirectory: cwd,
          });

          assert.strictEqual(summary.status, "completed");
          assert.strictEqual(read.status, "completed");
          assert.strictEqual(read.latestEventType, "REPORT_COMPLETED");
        })
    );

    it.effect(
      "records a canonical failure when provider availability changes after acceptance",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-provider-change-",
          });
          let providerAvailable = true;
          const provider: HarnessProvider = {
            ...acceptanceProvider,
            detect: Effect.sync(() =>
              providerAvailable
                ? ({
                    auth: { state: "authenticated" },
                    capabilities: acceptanceCapabilities,
                    state: "available",
                    version: "synthetic-1",
                  } as const)
                : ({ state: "missing" } as const)
            ),
          };
          const registry = makeHarnessProviderRegistry([
            {
              profileId: codexAppServerExecutionSelection.harnessProfileId,
              provider,
            },
          ]);
          const accepted = yield* acceptFactoryRun(
            {
              execution: codexAppServerExecutionSelection,
              workflow: "issueDelivery",
              workItem: {
                description:
                  "Fail when the accepted provider becomes unavailable.",
                kind: "issue",
                title: "Post-acceptance provider change",
              },
            },
            { harnessProviderRegistry: registry, rootDirectory: cwd }
          );
          providerAvailable = false;

          const continuation = yield* continueServerRun(accepted.runId, {
            harnessProviderRegistry: registry,
            rootDirectory: cwd,
          }).pipe(Effect.exit);
          const events = yield* readLocalRunEvents(accepted.runId, {
            rootDirectory: cwd,
          });

          assert.strictEqual(continuation._tag, "Failure");
          assert.strictEqual(events.events.at(-1)?.type, "RUN_FAILED");
          assert.strictEqual(
            events.events.at(-1)?.payload["code"],
            "HarnessUnavailable"
          );
        })
    );

    it.effect(
      "keeps default issue delivery local even inside a git repository",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-delivery-local-",
          });
          const commands: Array<GitDeliveryCommandInput> = [];
          const accepted = yield* acceptFactoryRun(
            {
              execution: codexAppServerExecutionSelection,
              workflow: "issueDelivery",
              workItem: {
                description:
                  "Run locally unless pull-request delivery is requested.",
                kind: "issue",
                title: "Local delivery policy",
              },
            },
            {
              deliveryGitCommandRunner: recordingGitRunner(commands, {
                baseRevision: "eea77bffa399d93ae0c90e71e9a39f1fb9a4aa92",
              }),
              harnessProviderRegistry: makeTestHarnessProviderRegistry(),
              rootDirectory: cwd,
            }
          );
          const summary = yield* continueServerRun(accepted.runId, {
            deliveryGitCommandRunner: recordingGitRunner(commands, {
              baseRevision: "eea77bffa399d93ae0c90e71e9a39f1fb9a4aa92",
            }),
            harnessProviderRegistry: makeTestHarnessProviderRegistry(),
            rootDirectory: cwd,
          });
          const events = yield* readLocalRunEvents(accepted.runId, {
            rootDirectory: cwd,
          });

          assert.strictEqual(summary.state, "completed");
          assert.strictEqual(events.events.at(-1)?.type, "REPORT_COMPLETED");
          assert.deepEqual(commands, []);
          assert.deepEqual(events.events[0]?.payload["delivery"], {
            mode: "local",
          });
        })
    );

    it.effect(
      "runs issue delivery in an owned worktree at the accepted remote base",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-delivery-worktree-",
          });
          const commands: Array<GitDeliveryCommandInput> = [];
          const gitRunner = recordingGitRunner(commands, {
            baseRevision: "eea77bffa399d93ae0c90e71e9a39f1fb9a4aa92",
          });
          const publicationCalls: Array<string> = [];

          const accepted = yield* acceptFactoryRun(
            {
              delivery: { mode: "pullRequest" },
              execution: codexAppServerExecutionSelection,
              workflow: "issueDelivery",
              workItem: {
                description: "Deliver in a run-owned worktree.",
                kind: "issue",
                title: "Owned worktree delivery",
              },
            },
            {
              deliveryGitCommandRunner: gitRunner,
              harnessProviderRegistry: makeTestHarnessProviderRegistry(),
              rootDirectory: cwd,
            }
          );
          const summary = yield* continueServerRun(accepted.runId, {
            deliveryGitCommandRunner: gitRunner,
            deliveryPublisher: recordingDeliveryPublisher(publicationCalls),
            harnessProviderRegistry: makeTestHarnessProviderRegistry(),
            rootDirectory: cwd,
          });
          const events = yield* readLocalRunEvents(accepted.runId, {
            rootDirectory: cwd,
          });
          const serialized = JSON.stringify(events.events);
          const deliveryStarted = events.events.find(
            ({ type }) => type === "DELIVERY_STARTED"
          );

          assert.strictEqual(summary.state, "delivering");
          assert.deepEqual(publicationCalls, [accepted.runId]);
          assert.strictEqual(
            events.events.at(-1)?.type,
            "DELIVERY_READY_TO_PUBLISH"
          );
          assert.isTrue(
            commands.some(
              ({ args }) =>
                args[0] === "worktree" &&
                args[1] === "add" &&
                args.includes("eea77bffa399d93ae0c90e71e9a39f1fb9a4aa92")
            )
          );
          assert.include(serialized, '"remote":"origin"');
          assert.include(serialized, '"baseBranch":"main"');
          assert.deepEqual(deliveryStarted?.payload["delivery"], {
            baseBranch: "main",
            baseRevision: "eea77bffa399d93ae0c90e71e9a39f1fb9a4aa92",
            feedbackTrustPolicy: {
              allowPullRequestAuthor: false,
              trustedChecks: [
                {
                  appSlug: "github-actions",
                  name: "gaia-pr-ci",
                  repository: "cill-i-am/gaia",
                  workflow: "Gaia PR CI",
                },
              ],
              trustedHumanLogins: [],
              version: 1,
            },
            headBranch: `gaia/${accepted.runId}`,
            mode: "pullRequest",
            remote: "origin",
            stage: "delivering",
          });
          assert.notInclude(serialized, cwd);
        })
    );

    it.effect(
      "persists explicit solo approval policy only at delivery acceptance",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-delivery-solo-policy-",
          });
          const gitRunner = recordingGitRunner([], {
            baseRevision: "eea77bffa399d93ae0c90e71e9a39f1fb9a4aa92",
          });
          const trustPolicy = DeliveryFeedbackTrustPolicyV1.make({
            allowPullRequestAuthor: false,
            requireApprovedReview: false,
            trustedChecks: [],
            trustedHumanLogins: [],
            version: 1,
          });
          const provenancePolicy = DeliveryAcceptanceProvenancePolicyV1.make({
            baseBranch: "gaia-93-smoke-base-acceptance",
            headBranch: "gaia/gaia-93-smoke-head-acceptance",
            remote: "origin",
            version: 1,
          });
          const accepted = yield* acceptFactoryRun(
            {
              delivery: { mode: "pullRequest" },
              execution: codexAppServerExecutionSelection,
              workflow: "issueDelivery",
              workItem: {
                description: "Persist solo review authority.",
                kind: "issue",
                title: "Solo policy",
              },
            },
            {
              deliveryAcceptanceProvenancePolicy: provenancePolicy,
              deliveryFeedbackTrustPolicy: trustPolicy,
              deliveryGitCommandRunner: gitRunner,
              harnessProviderRegistry: makeTestHarnessProviderRegistry(),
              rootDirectory: cwd,
            }
          );
          const acceptedEvents = yield* readLocalRunEvents(accepted.runId, {
            rootDirectory: cwd,
          });
          assert.deepInclude(acceptedEvents.events[0]?.payload, {
            delivery: {
              baseBranch: provenancePolicy.baseBranch,
              baseRevision: "eea77bffa399d93ae0c90e71e9a39f1fb9a4aa92",
              headBranch: provenancePolicy.headBranch,
              mode: "pullRequest",
              remote: provenancePolicy.remote,
            },
            deliveryFeedbackTrustPolicy: {
              allowPullRequestAuthor: false,
              requireApprovedReview: false,
              trustedChecks: [],
              trustedHumanLogins: [],
              version: 1,
            },
          });
          yield* continueServerRun(accepted.runId, {
            deliveryGitCommandRunner: gitRunner,
            deliveryPublisher: recordingDeliveryPublisher([]),
            harnessProviderRegistry: makeTestHarnessProviderRegistry(),
            rootDirectory: cwd,
          });
          const events = yield* readLocalRunEvents(accepted.runId, {
            rootDirectory: cwd,
          });
          const deliveryStarted = events.events.find(
            ({ type }) => type === "DELIVERY_STARTED"
          );

          assert.deepInclude(deliveryStarted?.payload["delivery"], {
            feedbackTrustPolicy: {
              allowPullRequestAuthor: false,
              requireApprovedReview: false,
              trustedChecks: [],
              trustedHumanLogins: [],
              version: 1,
            },
            headBranch: provenancePolicy.headBranch,
          });
          assert.lengthOf(
            events.events.filter(({ type }) => type === "DELIVERY_STARTED"),
            1
          );
        })
    );

    it.effect(
      "rejects a continuation policy mismatch before delivery starts or external work",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-delivery-policy-drift-",
          });
          const commands: Array<GitDeliveryCommandInput> = [];
          const gitRunner = recordingGitRunner(commands, {
            baseRevision: "e".repeat(40),
          });
          const solo = DeliveryFeedbackTrustPolicyV1.make({
            allowPullRequestAuthor: false,
            requireApprovedReview: false,
            trustedChecks: [],
            trustedHumanLogins: [],
            version: 1,
          });
          const strict = DeliveryFeedbackTrustPolicyV1.make({
            ...solo,
            requireApprovedReview: true,
          });
          const accepted = yield* acceptFactoryRun(
            {
              delivery: { mode: "pullRequest" },
              execution: codexAppServerExecutionSelection,
              workflow: "issueDelivery",
              workItem: {
                description: "Reject policy drift.",
                kind: "issue",
                title: "Policy drift",
              },
            },
            {
              deliveryFeedbackTrustPolicy: solo,
              deliveryGitCommandRunner: gitRunner,
              harnessProviderRegistry: makeTestHarnessProviderRegistry(),
              rootDirectory: cwd,
            }
          );
          const commandCountAfterAcceptance = commands.length;
          const exit = yield* continueServerRun(accepted.runId, {
            deliveryFeedbackTrustPolicy: strict,
            deliveryGitCommandRunner: gitRunner,
            deliveryPublisher: recordingDeliveryPublisher([]),
            harnessProviderRegistry: makeTestHarnessProviderRegistry(),
            rootDirectory: cwd,
          }).pipe(Effect.exit);
          const events = yield* readLocalRunEvents(accepted.runId, {
            rootDirectory: cwd,
          });

          assert.strictEqual(exit._tag, "Failure");
          if (exit._tag === "Failure")
            assert.include(
              String(exit.cause),
              "Delivery feedback trust policy changed after run acceptance."
            );
          assert.strictEqual(commands.length, commandCountAfterAcceptance);
          assert.lengthOf(
            events.events.filter(({ type }) => type === "DELIVERY_STARTED"),
            0
          );
        })
    );

    it.effect(
      "replays legacy RUN_CREATED without acceptance policy as strict",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-delivery-legacy-policy-",
          });
          const gitRunner = recordingGitRunner([], {
            baseRevision: "e".repeat(40),
          });
          const accepted = yield* acceptFactoryRun(
            {
              delivery: { mode: "pullRequest" },
              execution: codexAppServerExecutionSelection,
              workflow: "issueDelivery",
              workItem: {
                description: "Replay legacy strict policy.",
                kind: "issue",
                title: "Legacy policy",
              },
            },
            {
              deliveryGitCommandRunner: gitRunner,
              harnessProviderRegistry: makeTestHarnessProviderRegistry(),
              rootDirectory: cwd,
            }
          );
          const paths = yield* makeRunPaths(parseRunId(accepted.runId), {
            rootDirectory: cwd,
          });
          const encoded = Schema.decodeUnknownSync(Schema.Json)(
            JSON.parse(yield* fs.readFileString(paths.events))
          );
          if (
            typeof encoded !== "object" ||
            encoded === null ||
            Array.isArray(encoded)
          ) {
            throw new Error("Expected the stored run event to be an object.");
          }
          const encodedObject = Schema.decodeUnknownSync(
            Schema.Record(Schema.String, Schema.Json)
          )(encoded);
          const { payload } = encodedObject;
          if (
            typeof payload !== "object" ||
            payload === null ||
            Array.isArray(payload)
          ) {
            throw new Error(
              "Expected the stored run event payload to be an object."
            );
          }
          const payloadObject = Schema.decodeUnknownSync(
            Schema.Record(Schema.String, Schema.Json)
          )(payload);
          const {
            deliveryFeedbackTrustPolicy: _deliveryFeedbackTrustPolicy,
            ...legacyPayload
          } = payloadObject;
          yield* fs.writeFileString(
            paths.events,
            `${JSON.stringify({ ...encodedObject, payload: legacyPayload })}\n`
          );

          yield* continueServerRun(accepted.runId, {
            deliveryGitCommandRunner: gitRunner,
            deliveryPublisher: recordingDeliveryPublisher([]),
            harnessProviderRegistry: makeTestHarnessProviderRegistry(),
            rootDirectory: cwd,
          });
          const events = yield* readLocalRunEvents(accepted.runId, {
            rootDirectory: cwd,
          });
          const started = events.events.find(
            ({ type }) => type === "DELIVERY_STARTED"
          );
          assert.notProperty(
            events.events[0]?.payload ?? {},
            "deliveryFeedbackTrustPolicy"
          );
          assert.isDefined(started);
          if (started === undefined) {
            throw new Error("DELIVERY_STARTED event was not recorded.");
          }
          assert.notProperty(
            (started.payload["delivery"] as Record<string, unknown>)
              .feedbackTrustPolicy as Record<string, unknown>,
            "requireApprovedReview"
          );
        })
    );

    it.effect(
      "rejects provenance assertion drift before continuation git or events",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-delivery-provenance-drift-",
          });
          const commands: Array<GitDeliveryCommandInput> = [];
          const gitRunner = recordingGitRunner(commands, {
            baseRevision: "e".repeat(40),
          });
          const acceptedPolicy = DeliveryAcceptanceProvenancePolicyV1.make({
            baseBranch: "gaia-93-smoke-base-drift",
            headBranch: "gaia/gaia-93-smoke-head-drift",
            remote: "origin",
            version: 1,
          });
          const accepted = yield* acceptFactoryRun(
            {
              delivery: { mode: "pullRequest" },
              execution: codexAppServerExecutionSelection,
              workflow: "issueDelivery",
              workItem: {
                description: "Reject provenance drift.",
                kind: "issue",
                title: "Provenance drift",
              },
            },
            {
              deliveryAcceptanceProvenancePolicy: acceptedPolicy,
              deliveryGitCommandRunner: gitRunner,
              harnessProviderRegistry: makeTestHarnessProviderRegistry(),
              rootDirectory: cwd,
            }
          );
          const countAfterAcceptance = commands.length;
          const drifted = DeliveryAcceptanceProvenancePolicyV1.make({
            ...acceptedPolicy,
            headBranch: "gaia/gaia-93-smoke-head-changed",
          });
          const exit = yield* continueServerRun(accepted.runId, {
            deliveryAcceptanceProvenancePolicy: drifted,
            deliveryGitCommandRunner: gitRunner,
            deliveryPublisher: recordingDeliveryPublisher([]),
            harnessProviderRegistry: makeTestHarnessProviderRegistry(),
            rootDirectory: cwd,
          }).pipe(Effect.exit);
          const events = yield* readLocalRunEvents(accepted.runId, {
            rootDirectory: cwd,
          });

          assert.strictEqual(exit._tag, "Failure");
          assert.strictEqual(commands.length, countAfterAcceptance);
          assert.lengthOf(
            events.events.filter(({ type }) => type === "DELIVERY_STARTED"),
            0
          );
        })
    );

    it.effect(
      "fails closed when a persisted delivery worktree has the wrong head",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-delivery-collision-",
          });
          const acceptedBase = "eea77bffa399d93ae0c90e71e9a39f1fb9a4aa92";
          const gitRunner = recordingGitRunner([], {
            baseRevision: acceptedBase,
            workspaceHead: "1111111111111111111111111111111111111111",
          });

          const accepted = yield* acceptFactoryRun(
            {
              delivery: { mode: "pullRequest" },
              execution: codexAppServerExecutionSelection,
              workflow: "issueDelivery",
              workItem: {
                description: "Reject a colliding worktree.",
                kind: "issue",
                title: "Wrong worktree identity",
              },
            },
            {
              deliveryGitCommandRunner: gitRunner,
              harnessProviderRegistry: makeTestHarnessProviderRegistry(),
              rootDirectory: cwd,
            }
          );
          yield* fs.makeDirectory(`${accepted.runDirectory}/workspace`, {
            recursive: true,
          });

          const exit = yield* continueServerRun(accepted.runId, {
            deliveryGitCommandRunner: gitRunner,
            harnessProviderRegistry: makeTestHarnessProviderRegistry(),
            rootDirectory: cwd,
          }).pipe(Effect.exit);
          const events = yield* readLocalRunEvents(accepted.runId, {
            rootDirectory: cwd,
          });

          assert.strictEqual(exit._tag, "Failure");
          assert.strictEqual(events.events.at(-1)?.type, "RUN_FAILED");
          assert.strictEqual(
            events.events.at(-1)?.payload["code"],
            "DeliveryWorktreeIdentityMismatch"
          );
        })
    );

    it.effect(
      "fails closed when ownership evidence does not match the repository identity",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-delivery-ownership-",
          });
          const acceptedBase = "eea77bffa399d93ae0c90e71e9a39f1fb9a4aa92";
          const gitRunner = recordingGitRunner([], {
            baseRevision: acceptedBase,
            workspaceHead: acceptedBase,
          });

          const accepted = yield* acceptFactoryRun(
            {
              delivery: { mode: "pullRequest" },
              execution: codexAppServerExecutionSelection,
              workflow: "issueDelivery",
              workItem: {
                description: "Reject stale ownership evidence.",
                kind: "issue",
                title: "Wrong ownership identity",
              },
            },
            {
              deliveryGitCommandRunner: gitRunner,
              harnessProviderRegistry: makeTestHarnessProviderRegistry(),
              rootDirectory: cwd,
            }
          );
          yield* fs.makeDirectory(`${accepted.runDirectory}/workspace`, {
            recursive: true,
          });
          yield* fs.writeFileString(
            `${accepted.runDirectory}/delivery-ownership.json`,
            `${JSON.stringify(
              {
                baseRevision: acceptedBase,
                repositoryCommonDir: `${cwd}/other-common-dir`,
                repositoryRoot: cwd,
                token: "stale-token",
                version: 1,
                workspaceCommonDir: `${accepted.runDirectory}/workspace/.git`,
                workspaceRoot: `${accepted.runDirectory}/workspace`,
              },
              null,
              2
            )}\n`
          );

          const exit = yield* continueServerRun(accepted.runId, {
            deliveryGitCommandRunner: gitRunner,
            harnessProviderRegistry: makeTestHarnessProviderRegistry(),
            rootDirectory: cwd,
          }).pipe(Effect.exit);
          const events = yield* readLocalRunEvents(accepted.runId, {
            rootDirectory: cwd,
          });

          assert.strictEqual(exit._tag, "Failure");
          assert.strictEqual(events.events.at(-1)?.type, "RUN_FAILED");
          assert.strictEqual(
            events.events.at(-1)?.payload["code"],
            "DeliveryWorktreeIdentityMismatch"
          );
        })
    );

    it.effect(
      "fails closed when accepted pull-request provenance is corrupt",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-delivery-provenance-",
          });
          const acceptedBase = "eea77bffa399d93ae0c90e71e9a39f1fb9a4aa92";
          const gitRunner = recordingGitRunner([], {
            baseRevision: acceptedBase,
          });

          const accepted = yield* acceptFactoryRun(
            {
              delivery: { mode: "pullRequest" },
              execution: codexAppServerExecutionSelection,
              workflow: "issueDelivery",
              workItem: {
                description: "Reject corrupt provenance.",
                kind: "issue",
                title: "Corrupt provenance",
              },
            },
            {
              deliveryGitCommandRunner: gitRunner,
              harnessProviderRegistry: makeTestHarnessProviderRegistry(),
              rootDirectory: cwd,
            }
          );
          const eventLog = `${accepted.runDirectory}/events.jsonl`;
          const firstLine = yield* fs.readFileString(eventLog);
          const created = Schema.decodeUnknownSync(Schema.Json)(
            JSON.parse(firstLine.trim())
          );
          if (
            typeof created !== "object" ||
            created === null ||
            Array.isArray(created)
          ) {
            throw new Error("Expected the stored run event to be an object.");
          }
          const createdObject = Schema.decodeUnknownSync(
            Schema.Record(Schema.String, Schema.Json)
          )(created);
          const { payload } = createdObject;
          if (
            typeof payload !== "object" ||
            payload === null ||
            Array.isArray(payload)
          ) {
            throw new Error(
              "Expected the stored run event payload to be an object."
            );
          }
          const payloadObject = Schema.decodeUnknownSync(
            Schema.Record(Schema.String, Schema.Json)
          )(payload);
          yield* fs.writeFileString(
            eventLog,
            `${JSON.stringify({
              ...createdObject,
              payload: {
                ...payloadObject,
                delivery: { mode: "pullRequest" },
              },
            })}\n`
          );

          const exit = yield* continueServerRun(accepted.runId, {
            deliveryGitCommandRunner: gitRunner,
            harnessProviderRegistry: makeTestHarnessProviderRegistry(),
            rootDirectory: cwd,
          }).pipe(Effect.exit);
          const events = yield* readLocalRunEvents(accepted.runId, {
            rootDirectory: cwd,
          });

          assert.strictEqual(exit._tag, "Failure");
          assert.strictEqual(events.events.at(-1)?.type, "RUN_FAILED");
          assert.strictEqual(
            events.events.at(-1)?.payload["code"],
            "DeliveryWorktreeIdentityMismatch"
          );
        })
    );

    it.effect(
      "continues an audited worker recovery from a fresh epoch without publishing stale ready evidence",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const smoke = makeDisposableGitRemote();
          try {
            const cwd = realpathSync(smoke.source);
            const publicationCalls: Array<string> = [];
            const accepted = yield* acceptFactoryRun(
              {
                delivery: { mode: "pullRequest" },
                execution: codexAppServerExecutionSelection,
                workflow: "issueDelivery",
                workItem: {
                  description: "Recover the interrupted checkpoint.",
                  kind: "issue",
                  title: "Audited continuation",
                },
              },
              {
                harnessProviderRegistry: makeTestHarnessProviderRegistry(),
                rootDirectory: cwd,
              }
            );
            yield* continueServerRun(accepted.runId, {
              deliveryPublisher: recordingDeliveryPublisher(publicationCalls),
              harnessProviderRegistry: makeTestHarnessProviderRegistry(),
              rootDirectory: cwd,
            });
            publicationCalls.length = 0;

            const runId = parseRunId(accepted.runId);
            const paths = yield* makeRunPaths(runId, { rootDirectory: cwd });
            const readyEvents = yield* readLocalRunEvents(runId, {
              rootDirectory: cwd,
            });
            const contaminatedReady = readyEvents.events.find(
              ({ type }) => type === "DELIVERY_READY_TO_PUBLISH"
            );
            if (contaminatedReady === undefined) {
              assert.fail("Expected contaminated ready evidence.");
            }
            const sessionId = parseHarnessSessionId(`session-${runId}`);
            const recoveryBase = {
              actionId: "recover-1",
              attempt: 1 as const,
              expectedFailureSequence: 10,
              expectedSessionId: sessionId,
              harnessProfileId:
                codexAppServerExecutionSelection.harnessProfileId,
              maxAttempts: 1 as const,
              model: "gpt-5.4",
              payloadDigest: "a".repeat(64),
            };
            const recoveredTurnDigest = digest("turn-test-worker");
            yield* appendEvent(runId, paths, {
              payload: {
                recovery: encodeWorkerRecoveryReceiptJson({
                  ...recoveryBase,
                  nativeTurnIdDigest: recoveredTurnDigest,
                  state: "dispatchConfirmed",
                }),
              },
              type: "WORKER_RECOVERY_RECORDED",
            });
            const failedRecovery = yield* appendEvent(runId, paths, {
              payload: {
                recovery: encodeWorkerRecoveryReceiptJson({
                  ...recoveryBase,
                  code: "WorkerRecoveryContinuationFailed",
                  message:
                    "The checkpoint turn was interrupted after zero product changes.",
                  nativeTurnIdDigest: recoveredTurnDigest,
                  state: "failed",
                }),
              },
              type: "WORKER_RECOVERY_RECORDED",
            });
            yield* fs.writeFileString(
              `${paths.root}/.worker-recovery-turn.json`,
              `${workerRecoveryTurnCheckpoint("turn-test-worker", recoveryBase)}\n`
            );

            const action = WorkerContinuationAction.make({
              actionId: parseWorkerRecoveryActionId("continue-recovery-1"),
              expectedContaminatedReadySequence: contaminatedReady.sequence,
              expectedCurrentSequence: failedRecovery.event.sequence,
              expectedDeliveryProvenanceDigest: deliveryProvenanceDigest({
                baseBranch: "main",
                baseRevision: smoke.baseRevision,
                headBranch: `gaia/${runId}`,
                remote: "origin",
              }),
              expectedFailedRecoverySequence: failedRecovery.event.sequence,
              expectedRecoveryActionId:
                parseWorkerRecoveryActionId("recover-1"),
              expectedSessionId: sessionId,
              harnessProfileId:
                codexAppServerExecutionSelection.harnessProfileId,
              kind: "continueInterruptedWorkerRecovery",
            });
            const receipt = yield* actOnWorkerContinuation(runId, action, {
              deliveryPublisher: recordingDeliveryPublisher(publicationCalls),
              harnessProviderRegistry: makeTestHarnessProviderRegistry(),
              rootDirectory: cwd,
            });
            const events = yield* readLocalRunEvents(runId, {
              rootDirectory: cwd,
            });
            const continuationStates = events.events.flatMap((event) =>
              event.type === "WORKER_CONTINUATION_RECORDED"
                ? [
                    decodeWorkerContinuationEventPayload(event.payload)
                      .continuation.state,
                  ]
                : []
            );
            const workerCompletions = events.events.filter(
              ({ type }) => type === "WORKER_COMPLETED"
            );
            const freshReady = events.events
              .filter(({ type }) => type === "DELIVERY_READY_TO_PUBLISH")
              .at(-1);
            const delivery = snapshotFromReplay(events.events).context[
              "delivery"
            ];

            assert.strictEqual(receipt.state, "workerCompleted");
            assert.deepEqual(continuationStates, [
              "intentRecorded",
              "resumeAttempted",
              "workerCompleted",
            ]);
            assert.lengthOf(workerCompletions, 2);
            assert.isAbove(
              workerCompletions.at(-1)?.sequence ?? 0,
              failedRecovery.event.sequence
            );
            assert.isAbove(
              freshReady?.sequence ?? 0,
              failedRecovery.event.sequence
            );
            assert.deepEqual(publicationCalls, []);
            assert.isObject(delivery);
            assert.strictEqual(
              (delivery as Record<string, unknown>)["stage"],
              "readyToPublish"
            );
            assert.strictEqual(
              (delivery as Record<string, unknown>)[
                "workerEvidenceEpochSequence"
              ],
              failedRecovery.event.sequence + 1
            );

            const replayEventCount = events.events.length;
            const replayReceipt = yield* actOnWorkerContinuation(
              runId,
              action,
              {
                deliveryPublisher: recordingDeliveryPublisher(publicationCalls),
                harnessProviderRegistry: makeTestHarnessProviderRegistry(),
                rootDirectory: cwd,
              }
            );
            const replayedEvents = yield* readLocalRunEvents(runId, {
              rootDirectory: cwd,
            });
            const conflict = yield* Effect.flip(
              actOnWorkerContinuation(
                runId,
                WorkerContinuationAction.make({
                  ...action,
                  actionId: parseWorkerRecoveryActionId("continue-recovery-2"),
                }),
                {
                  deliveryPublisher:
                    recordingDeliveryPublisher(publicationCalls),
                  harnessProviderRegistry: makeTestHarnessProviderRegistry(),
                  rootDirectory: cwd,
                }
              )
            );
            const conflictedEvents = yield* readLocalRunEvents(runId, {
              rootDirectory: cwd,
            });

            assert.deepEqual(replayReceipt, receipt);
            assert.lengthOf(replayedEvents.events, replayEventCount);
            assert.instanceOf(conflict, GaiaRuntimeError);
            assert.strictEqual(conflict.code, "DeliveryActionConflict");
            assert.lengthOf(conflictedEvents.events, replayEventCount);
          } finally {
            rmSync(smoke.root, { force: true, recursive: true });
          }
        })
    );

    it.effect(
      "marks ambiguous audited continuation restarts outcomeUnknown without redispatch",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-audited-continuation-ambiguity-",
          });
          const accepted = yield* acceptServerRun(
            {
              specMarkdown: "Already accepted before ambiguous continuation.\n",
            },
            { rootDirectory: cwd }
          );
          const runId = parseRunId(accepted.runId);
          const paths = yield* makeRunPaths(runId, { rootDirectory: cwd });
          const sessionId = parseHarnessSessionId(`session-${runId}`);
          const action = WorkerContinuationAction.make({
            actionId: parseWorkerRecoveryActionId("continue-recovery-1"),
            expectedContaminatedReadySequence: accepted.eventSequence,
            expectedCurrentSequence: accepted.eventSequence,
            expectedDeliveryProvenanceDigest: parseWorkerRecoveryDigest(
              "c".repeat(64)
            ),
            expectedFailedRecoverySequence: accepted.eventSequence,
            expectedRecoveryActionId: parseWorkerRecoveryActionId("recover-1"),
            expectedSessionId: sessionId,
            harnessProfileId: codexAppServerExecutionSelection.harnessProfileId,
            kind: "continueInterruptedWorkerRecovery",
          });
          const base = {
            actionId: action.actionId,
            expectedContaminatedReadySequence:
              action.expectedContaminatedReadySequence,
            expectedCurrentSequence: action.expectedCurrentSequence,
            expectedDeliveryProvenanceDigest:
              action.expectedDeliveryProvenanceDigest,
            expectedFailedRecoverySequence:
              action.expectedFailedRecoverySequence,
            expectedRecoveryActionId: action.expectedRecoveryActionId,
            expectedSessionId: action.expectedSessionId,
            harnessProfileId: action.harnessProfileId,
            maxAttempts: 1 as const,
            workerEvidenceEpochSequence: accepted.eventSequence + 1,
          };
          yield* appendEvent(runId, paths, {
            payload: {
              continuation: encodeWorkerContinuationReceiptJson({
                ...base,
                state: "intentRecorded",
              }),
            },
            type: "WORKER_CONTINUATION_RECORDED",
          });
          yield* appendEvent(runId, paths, {
            payload: {
              continuation: encodeWorkerContinuationReceiptJson({
                ...base,
                state: "resumeAttempted",
              }),
            },
            type: "WORKER_CONTINUATION_RECORDED",
          });

          let dispatches = 0;
          const receipt = yield* actOnWorkerContinuation(runId, action, {
            rootDirectory: cwd,
            workerContinuationRunner: () =>
              Effect.sync(() => {
                dispatches += 1;
                return {
                  reportPath: paths.reportMarkdown,
                  runDirectory: paths.root,
                  runId,
                  state: "delivering",
                  status: "running",
                };
              }),
          });
          const events = yield* readLocalRunEvents(runId, {
            rootDirectory: cwd,
          });
          const continuationStates = events.events.flatMap((event) =>
            event.type === "WORKER_CONTINUATION_RECORDED"
              ? [
                  decodeWorkerContinuationEventPayload(event.payload)
                    .continuation.state,
                ]
              : []
          );
          const replayEventCount = events.events.length;
          const replayReceipt = yield* actOnWorkerContinuation(runId, action, {
            rootDirectory: cwd,
            workerContinuationRunner: () =>
              Effect.sync(() => {
                dispatches += 1;
                return {
                  reportPath: paths.reportMarkdown,
                  runDirectory: paths.root,
                  runId,
                  state: "delivering",
                  status: "running",
                };
              }),
          });
          const replayedEvents = yield* readLocalRunEvents(runId, {
            rootDirectory: cwd,
          });

          assert.strictEqual(receipt.state, "outcomeUnknown");
          assert.strictEqual(replayReceipt.state, "outcomeUnknown");
          assert.strictEqual(dispatches, 0);
          assert.deepEqual(continuationStates, [
            "intentRecorded",
            "resumeAttempted",
            "outcomeUnknown",
          ]);
          assert.lengthOf(replayedEvents.events, replayEventCount);
        })
    );

    it.effect(
      "records one audited correlation reconciliation epoch before a deterministic follow-up",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const smoke = makeDisposableGitRemote();
          try {
            const cwd = realpathSync(smoke.source);
            const publicationCalls: Array<string> = [];
            const accepted = yield* acceptFactoryRun(
              {
                delivery: { mode: "pullRequest" },
                execution: codexAppServerExecutionSelection,
                workflow: "issueDelivery",
                workItem: {
                  description: "Recover the interrupted checkpoint.",
                  kind: "issue",
                  title: "Audited correlation reconciliation",
                },
              },
              {
                harnessProviderRegistry: makeTestHarnessProviderRegistry(),
                rootDirectory: cwd,
              }
            );
            yield* continueServerRun(accepted.runId, {
              deliveryPublisher: recordingDeliveryPublisher(publicationCalls),
              harnessProviderRegistry: makeTestHarnessProviderRegistry(),
              rootDirectory: cwd,
            });
            publicationCalls.length = 0;

            const runId = parseRunId(accepted.runId);
            const paths = yield* makeRunPaths(runId, { rootDirectory: cwd });
            const readyEvents = yield* readLocalRunEvents(runId, {
              rootDirectory: cwd,
            });
            const contaminatedReady = readyEvents.events.find(
              ({ type }) => type === "DELIVERY_READY_TO_PUBLISH"
            );
            if (contaminatedReady === undefined) {
              assert.fail("Expected contaminated ready evidence.");
            }
            const sessionId = parseHarnessSessionId(`session-${runId}`);
            const recoveredTurnDigest = digest("turn-test-worker");
            const recoveryBase = {
              actionId: "recover-1",
              attempt: 1 as const,
              expectedFailureSequence: 10,
              expectedSessionId: sessionId,
              harnessProfileId:
                codexAppServerExecutionSelection.harnessProfileId,
              maxAttempts: 1 as const,
              model: "gpt-5.4",
              payloadDigest: "a".repeat(64),
            };
            yield* appendEvent(runId, paths, {
              payload: {
                recovery: encodeWorkerRecoveryReceiptJson({
                  ...recoveryBase,
                  nativeTurnIdDigest: recoveredTurnDigest,
                  state: "dispatchConfirmed",
                }),
              },
              type: "WORKER_RECOVERY_RECORDED",
            });
            const failedRecovery = yield* appendEvent(runId, paths, {
              payload: {
                recovery: encodeWorkerRecoveryReceiptJson({
                  ...recoveryBase,
                  code: "WorkerRecoveryContinuationFailed",
                  message:
                    "The checkpoint turn was interrupted after zero product changes.",
                  nativeTurnIdDigest: recoveredTurnDigest,
                  state: "failed",
                }),
              },
              type: "WORKER_RECOVERY_RECORDED",
            });
            const continuationBase = {
              actionId: "continue-recovery-1",
              expectedContaminatedReadySequence: contaminatedReady.sequence,
              expectedCurrentSequence: failedRecovery.event.sequence,
              expectedDeliveryProvenanceDigest: deliveryProvenanceDigest({
                baseBranch: "main",
                baseRevision: smoke.baseRevision,
                headBranch: `gaia/${runId}`,
                remote: "origin",
              }),
              expectedFailedRecoverySequence: failedRecovery.event.sequence,
              expectedRecoveryActionId: "recover-1",
              expectedSessionId: sessionId,
              harnessProfileId:
                codexAppServerExecutionSelection.harnessProfileId,
              maxAttempts: 1 as const,
              workerEvidenceEpochSequence: failedRecovery.event.sequence + 1,
            };
            yield* appendEvent(runId, paths, {
              payload: {
                continuation: encodeWorkerContinuationReceiptJson({
                  ...continuationBase,
                  state: "intentRecorded",
                }),
              },
              type: "WORKER_CONTINUATION_RECORDED",
            });
            const failedContinuation = yield* appendEvent(runId, paths, {
              payload: {
                continuation: encodeWorkerContinuationReceiptJson({
                  ...continuationBase,
                  code: "HarnessCorrelationUnavailable",
                  message:
                    "The interrupted checkpoint correlation is unavailable.",
                  state: "failed",
                }),
              },
              type: "WORKER_CONTINUATION_RECORDED",
            });
            const action = WorkerCorrelationReconciliationAction.make({
              actionId: parseWorkerRecoveryActionId("reconcile-correlation-1"),
              expectedContaminatedReadySequence: contaminatedReady.sequence,
              expectedContinuationActionId: parseWorkerRecoveryActionId(
                "continue-recovery-1"
              ),
              expectedCurrentSequence: failedContinuation.event.sequence,
              expectedDeliveryProvenanceDigest:
                continuationBase.expectedDeliveryProvenanceDigest,
              expectedFailedContinuationSequence:
                failedContinuation.event.sequence,
              expectedFailedRecoverySequence: failedRecovery.event.sequence,
              expectedNativeTurnIdDigest: recoveredTurnDigest,
              expectedRecoveryActionId:
                parseWorkerRecoveryActionId("recover-1"),
              expectedSessionId: sessionId,
              harnessProfileId:
                codexAppServerExecutionSelection.harnessProfileId,
              kind: "reconcileInterruptedWorkerCorrelation",
            });
            const seamCalls: Array<string> = [];
            const receipt = yield* actOnWorkerCorrelationReconciliation(
              runId,
              action,
              {
                rootDirectory: cwd,
                workerCorrelationReconciler: ({
                  action: seamAction,
                  clientInputId,
                }) =>
                  Effect.sync(() => {
                    seamCalls.push(
                      `reconcile:${seamAction.actionId}:${clientInputId}`
                    );
                  }),
                workerCorrelationFollowUpDispatcher: ({
                  clientInputId,
                  followUpText,
                }) =>
                  Effect.sync(() => {
                    seamCalls.push(
                      `follow-up:${clientInputId}:${followUpText.includes("Do not restart")}`
                    );
                  }),
                workerCorrelationRunner: () =>
                  appendEvent(runId, paths, {
                    payload: {
                      workerResultPath: "worker-result-reconciled.json",
                    },
                    type: "WORKER_COMPLETED",
                  }).pipe(
                    Effect.as({
                      reportPath: paths.reportMarkdown,
                      runDirectory: paths.root,
                      runId,
                      state: "delivering" as const,
                      status: "running" as const,
                    })
                  ),
              }
            );
            const events = yield* readLocalRunEvents(runId, {
              rootDirectory: cwd,
            });
            const reconciliationStates = events.events.flatMap((event) =>
              event.type === "WORKER_CORRELATION_RECONCILIATION_RECORDED"
                ? [
                    decodeWorkerCorrelationEventPayload(event.payload)
                      .reconciliation.state,
                  ]
                : []
            );
            const delivery = snapshotFromReplay(events.events).context[
              "delivery"
            ];

            assert.strictEqual(receipt.state, "workerCompleted");
            assert.deepEqual(reconciliationStates, [
              "intentRecorded",
              "correlationAttempted",
              "correlationConfirmed",
              "followUpAttempted",
              "followUpConfirmed",
              "workerCompleted",
            ]);
            assert.lengthOf(seamCalls, 2);
            assert.deepEqual(publicationCalls, []);
            assert.isObject(delivery);
            assert.strictEqual(
              (delivery as Record<string, unknown>)[
                "workerEvidenceEpochSequence"
              ],
              failedContinuation.event.sequence + 1
            );

            const replayEventCount = events.events.length;
            const replayReceipt = yield* actOnWorkerCorrelationReconciliation(
              runId,
              action,
              {
                rootDirectory: cwd,
                workerCorrelationReconciler: () =>
                  Effect.die("must not reconcile twice"),
                workerCorrelationFollowUpDispatcher: () =>
                  Effect.die("must not redispatch follow-up"),
                workerCorrelationRunner: () =>
                  Effect.die("must not rerun completed worker"),
              }
            );
            const replayedEvents = yield* readLocalRunEvents(runId, {
              rootDirectory: cwd,
            });
            const conflict = yield* Effect.flip(
              actOnWorkerCorrelationReconciliation(
                runId,
                WorkerCorrelationReconciliationAction.make({
                  ...action,
                  actionId: parseWorkerRecoveryActionId(
                    "reconcile-correlation-2"
                  ),
                }),
                {
                  rootDirectory: cwd,
                  workerCorrelationReconciler: () =>
                    Effect.die("must not reconcile conflicting action"),
                  workerCorrelationFollowUpDispatcher: () =>
                    Effect.die("must not dispatch conflicting action"),
                }
              )
            );
            const conflictedEvents = yield* readLocalRunEvents(runId, {
              rootDirectory: cwd,
            });

            assert.deepEqual(replayReceipt, receipt);
            assert.lengthOf(replayedEvents.events, replayEventCount);
            assert.instanceOf(conflict, GaiaRuntimeError);
            assert.strictEqual(conflict.code, "DeliveryActionConflict");
            assert.lengthOf(conflictedEvents.events, replayEventCount);
          } finally {
            rmSync(smoke.root, { force: true, recursive: true });
          }
        })
    );

    it.effect(
      "records one desktop-origin correlation epoch after terminal source-classification failure",
      () =>
        Effect.gen(function* () {
          const smoke = makeDisposableGitRemote();
          try {
            const cwd = realpathSync(smoke.source);
            const publicationCalls: Array<string> = [];
            const accepted = yield* acceptFactoryRun(
              {
                delivery: { mode: "pullRequest" },
                execution: codexAppServerExecutionSelection,
                workflow: "issueDelivery",
                workItem: {
                  description:
                    "Recover the Desktop-originated interrupted checkpoint.",
                  kind: "issue",
                  title: "Desktop-origin correlation reconciliation",
                },
              },
              {
                harnessProviderRegistry: makeTestHarnessProviderRegistry(),
                rootDirectory: cwd,
              }
            );
            yield* continueServerRun(accepted.runId, {
              deliveryPublisher: recordingDeliveryPublisher(publicationCalls),
              harnessProviderRegistry: makeTestHarnessProviderRegistry(),
              rootDirectory: cwd,
            });
            publicationCalls.length = 0;
            const runId = parseRunId(accepted.runId);
            const paths = yield* makeRunPaths(runId, { rootDirectory: cwd });
            const readyEvents = yield* readLocalRunEvents(runId, {
              rootDirectory: cwd,
            });
            const contaminatedReady = readyEvents.events.find(
              ({ type }) => type === "DELIVERY_READY_TO_PUBLISH"
            );
            if (contaminatedReady === undefined)
              assert.fail("Expected contaminated ready evidence.");
            const sessionId = parseHarnessSessionId(`session-${runId}`);
            const recoveredTurnDigest = digest("turn-test-worker");
            const provenanceDigest = deliveryProvenanceDigest({
              baseBranch: "main",
              baseRevision: smoke.baseRevision,
              headBranch: `gaia/${runId}`,
              remote: "origin",
            });
            const recoveryBase = {
              actionId: "recover-1",
              attempt: 1 as const,
              expectedFailureSequence: 10,
              expectedSessionId: sessionId,
              harnessProfileId:
                codexAppServerExecutionSelection.harnessProfileId,
              maxAttempts: 1 as const,
              model: "gpt-5.4",
              payloadDigest: "a".repeat(64),
            };
            yield* appendEvent(runId, paths, {
              payload: {
                recovery: encodeWorkerRecoveryReceiptJson({
                  ...recoveryBase,
                  nativeTurnIdDigest: recoveredTurnDigest,
                  state: "dispatchConfirmed",
                }),
              },
              type: "WORKER_RECOVERY_RECORDED",
            });
            const failedRecovery = yield* appendEvent(runId, paths, {
              payload: {
                recovery: encodeWorkerRecoveryReceiptJson({
                  ...recoveryBase,
                  code: "WorkerRecoveryContinuationFailed",
                  message:
                    "The checkpoint turn was interrupted after zero product changes.",
                  nativeTurnIdDigest: recoveredTurnDigest,
                  state: "failed",
                }),
              },
              type: "WORKER_RECOVERY_RECORDED",
            });
            const continuationBase = {
              actionId: "continue-recovery-1",
              expectedContaminatedReadySequence: contaminatedReady.sequence,
              expectedCurrentSequence: failedRecovery.event.sequence,
              expectedDeliveryProvenanceDigest: provenanceDigest,
              expectedFailedRecoverySequence: failedRecovery.event.sequence,
              expectedRecoveryActionId: "recover-1",
              expectedSessionId: sessionId,
              harnessProfileId:
                codexAppServerExecutionSelection.harnessProfileId,
              maxAttempts: 1 as const,
              workerEvidenceEpochSequence: failedRecovery.event.sequence + 1,
            };
            yield* appendEvent(runId, paths, {
              payload: {
                continuation: encodeWorkerContinuationReceiptJson({
                  ...continuationBase,
                  state: "intentRecorded",
                }),
              },
              type: "WORKER_CONTINUATION_RECORDED",
            });
            const failedContinuation = yield* appendEvent(runId, paths, {
              payload: {
                continuation: encodeWorkerContinuationReceiptJson({
                  ...continuationBase,
                  code: "HarnessCorrelationUnavailable",
                  message:
                    "The interrupted checkpoint correlation is unavailable.",
                  state: "failed",
                }),
              },
              type: "WORKER_CONTINUATION_RECORDED",
            });
            const correlationBase = {
              actionId: "reconcile-correlation-1",
              expectedContaminatedReadySequence: contaminatedReady.sequence,
              expectedContinuationActionId: "continue-recovery-1",
              expectedCurrentSequence: failedContinuation.event.sequence,
              expectedDeliveryProvenanceDigest: provenanceDigest,
              expectedFailedContinuationSequence:
                failedContinuation.event.sequence,
              expectedFailedRecoverySequence: failedRecovery.event.sequence,
              expectedNativeTurnIdDigest: recoveredTurnDigest,
              expectedRecoveryActionId: "recover-1",
              expectedSessionId: sessionId,
              harnessProfileId:
                codexAppServerExecutionSelection.harnessProfileId,
              maxAttempts: 1 as const,
              workerEvidenceEpochSequence:
                failedContinuation.event.sequence + 1,
            };
            yield* appendEvent(runId, paths, {
              payload: {
                reconciliation:
                  encodeWorkerCorrelationReconciliationReceiptJson({
                    ...correlationBase,
                    state: "intentRecorded",
                  }),
              },
              type: "WORKER_CORRELATION_RECONCILIATION_RECORDED",
            });
            yield* appendEvent(runId, paths, {
              payload: {
                reconciliation:
                  encodeWorkerCorrelationReconciliationReceiptJson({
                    ...correlationBase,
                    state: "correlationAttempted",
                  }),
              },
              type: "WORKER_CORRELATION_RECONCILIATION_RECORDED",
            });
            const failedCorrelation = yield* appendEvent(runId, paths, {
              payload: {
                reconciliation:
                  encodeWorkerCorrelationReconciliationReceiptJson({
                    ...correlationBase,
                    code: "WorkerCorrelationReconciliationFailed",
                    message:
                      "The source-classification proof excluded the Desktop-originated thread.",
                    state: "failed",
                  }),
              },
              type: "WORKER_CORRELATION_RECONCILIATION_RECORDED",
            });
            const action = WorkerDesktopOriginCorrelationAction.make({
              actionId: parseWorkerRecoveryActionId(
                "reconcile-desktop-origin-1"
              ),
              expectedContaminatedReadySequence: contaminatedReady.sequence,
              expectedContinuationActionId: parseWorkerRecoveryActionId(
                "continue-recovery-1"
              ),
              expectedCorrelationActionId: parseWorkerRecoveryActionId(
                "reconcile-correlation-1"
              ),
              expectedCurrentSequence: failedCorrelation.event.sequence,
              expectedDeliveryProvenanceDigest: provenanceDigest,
              expectedFailedContinuationSequence:
                failedContinuation.event.sequence,
              expectedFailedCorrelationSequence:
                failedCorrelation.event.sequence,
              expectedFailedRecoverySequence: failedRecovery.event.sequence,
              expectedNativeTurnIdDigest: recoveredTurnDigest,
              expectedRecoveryActionId:
                parseWorkerRecoveryActionId("recover-1"),
              expectedSessionId: sessionId,
              harnessProfileId:
                codexAppServerExecutionSelection.harnessProfileId,
              kind: "reconcileDesktopOriginatedWorkerCorrelation",
            });
            const seamCalls: Array<string> = [];
            const receipt = yield* actOnWorkerDesktopOriginCorrelation(
              runId,
              action,
              {
                rootDirectory: cwd,
                workerDesktopOriginCorrelationFollowUpDispatcher: ({
                  clientInputId,
                  followUpText,
                }) =>
                  Effect.sync(() =>
                    seamCalls.push(
                      `follow-up:${clientInputId}:${followUpText.includes("Do not restart")}`
                    )
                  ),
                workerDesktopOriginCorrelationReconciler: ({
                  action: seamAction,
                  clientInputId,
                }) =>
                  Effect.sync(() =>
                    seamCalls.push(
                      `source:${seamAction.actionId}:${clientInputId}`
                    )
                  ),
                workerDesktopOriginCorrelationRunner: () =>
                  appendEvent(runId, paths, {
                    payload: {
                      workerResultPath: "worker-result-desktop-origin.json",
                    },
                    type: "WORKER_COMPLETED",
                  }).pipe(
                    Effect.as({
                      reportPath: paths.reportMarkdown,
                      runDirectory: paths.root,
                      runId,
                      state: "delivering" as const,
                      status: "running" as const,
                    })
                  ),
              }
            );
            const events = yield* readLocalRunEvents(runId, {
              rootDirectory: cwd,
            });
            const desktopStates = events.events.flatMap((event) =>
              event.type === "WORKER_DESKTOP_ORIGIN_CORRELATION_RECORDED"
                ? [
                    decodeWorkerDesktopOriginEventPayload(event.payload)
                      .desktopOriginCorrelation.state,
                  ]
                : []
            );
            const delivery = snapshotFromReplay(events.events).context[
              "delivery"
            ];

            assert.strictEqual(receipt.state, "workerCompleted");
            assert.deepEqual(desktopStates, [
              "intentRecorded",
              "sourceCorrelationAttempted",
              "sourceCorrelationConfirmed",
              "followUpAttempted",
              "followUpConfirmed",
              "workerCompleted",
            ]);
            assert.lengthOf(seamCalls, 2);
            assert.deepEqual(publicationCalls, []);
            assert.isObject(delivery);
            assert.strictEqual(
              (delivery as Record<string, unknown>)[
                "workerEvidenceEpochSequence"
              ],
              failedCorrelation.event.sequence + 1
            );
            const replayEventCount = events.events.length;
            const replayReceipt = yield* actOnWorkerDesktopOriginCorrelation(
              runId,
              action,
              {
                rootDirectory: cwd,
                workerDesktopOriginCorrelationFollowUpDispatcher: () =>
                  Effect.die("must not redispatch follow-up"),
                workerDesktopOriginCorrelationReconciler: () =>
                  Effect.die("must not reconcile twice"),
                workerDesktopOriginCorrelationRunner: () =>
                  Effect.die("must not rerun completed worker"),
              }
            );
            const replayedEvents = yield* readLocalRunEvents(runId, {
              rootDirectory: cwd,
            });
            const conflict = yield* Effect.flip(
              actOnWorkerDesktopOriginCorrelation(
                runId,
                WorkerDesktopOriginCorrelationAction.make({
                  ...action,
                  actionId: parseWorkerRecoveryActionId(
                    "reconcile-desktop-origin-2"
                  ),
                }),
                {
                  rootDirectory: cwd,
                  workerDesktopOriginCorrelationFollowUpDispatcher: () =>
                    Effect.die("must not dispatch conflicting action"),
                  workerDesktopOriginCorrelationReconciler: () =>
                    Effect.die("must not reconcile conflicting action"),
                }
              )
            );

            assert.deepEqual(replayReceipt, receipt);
            assert.lengthOf(replayedEvents.events, replayEventCount);
            assert.instanceOf(conflict, GaiaRuntimeError);
            assert.strictEqual(conflict.code, "DeliveryActionConflict");
          } finally {
            rmSync(smoke.root, { force: true, recursive: true });
          }
        })
    );

    it.effect(
      "rejects desktop-origin correlation when the predecessor failure code is not source-classification failed",
      () =>
        Effect.gen(function* () {
          const smoke = makeDisposableGitRemote();
          try {
            const cwd = realpathSync(smoke.source);
            const accepted = yield* acceptFactoryRun(
              {
                delivery: { mode: "pullRequest" },
                execution: codexAppServerExecutionSelection,
                workflow: "issueDelivery",
                workItem: {
                  description:
                    "Reject a non-source-classification predecessor.",
                  kind: "issue",
                  title: "Desktop-origin predecessor code",
                },
              },
              {
                harnessProviderRegistry: makeTestHarnessProviderRegistry(),
                rootDirectory: cwd,
              }
            );
            yield* continueServerRun(accepted.runId, {
              deliveryPublisher: recordingDeliveryPublisher([]),
              harnessProviderRegistry: makeTestHarnessProviderRegistry(),
              rootDirectory: cwd,
            });
            const runId = parseRunId(accepted.runId);
            const paths = yield* makeRunPaths(runId, { rootDirectory: cwd });
            const readyEvents = yield* readLocalRunEvents(runId, {
              rootDirectory: cwd,
            });
            const contaminatedReady = readyEvents.events.find(
              ({ type }) => type === "DELIVERY_READY_TO_PUBLISH"
            );
            if (contaminatedReady === undefined)
              assert.fail("Expected contaminated ready evidence.");
            const sessionId = parseHarnessSessionId(`session-${runId}`);
            const recoveredTurnDigest = digest("turn-test-worker");
            const provenanceDigest = deliveryProvenanceDigest({
              baseBranch: "main",
              baseRevision: smoke.baseRevision,
              headBranch: `gaia/${runId}`,
              remote: "origin",
            });
            const recoveryBase = {
              actionId: "recover-1",
              attempt: 1 as const,
              expectedFailureSequence: 10,
              expectedSessionId: sessionId,
              harnessProfileId:
                codexAppServerExecutionSelection.harnessProfileId,
              maxAttempts: 1 as const,
              model: "gpt-5.4",
              payloadDigest: "a".repeat(64),
            };
            yield* appendEvent(runId, paths, {
              payload: {
                recovery: encodeWorkerRecoveryReceiptJson({
                  ...recoveryBase,
                  nativeTurnIdDigest: recoveredTurnDigest,
                  state: "dispatchConfirmed",
                }),
              },
              type: "WORKER_RECOVERY_RECORDED",
            });
            const failedRecovery = yield* appendEvent(runId, paths, {
              payload: {
                recovery: encodeWorkerRecoveryReceiptJson({
                  ...recoveryBase,
                  code: "WorkerRecoveryContinuationFailed",
                  message:
                    "The checkpoint turn was interrupted after zero product changes.",
                  nativeTurnIdDigest: recoveredTurnDigest,
                  state: "failed",
                }),
              },
              type: "WORKER_RECOVERY_RECORDED",
            });
            const continuationBase = {
              actionId: "continue-recovery-1",
              expectedContaminatedReadySequence: contaminatedReady.sequence,
              expectedCurrentSequence: failedRecovery.event.sequence,
              expectedDeliveryProvenanceDigest: provenanceDigest,
              expectedFailedRecoverySequence: failedRecovery.event.sequence,
              expectedRecoveryActionId: "recover-1",
              expectedSessionId: sessionId,
              harnessProfileId:
                codexAppServerExecutionSelection.harnessProfileId,
              maxAttempts: 1 as const,
              workerEvidenceEpochSequence: failedRecovery.event.sequence + 1,
            };
            yield* appendEvent(runId, paths, {
              payload: {
                continuation: encodeWorkerContinuationReceiptJson({
                  ...continuationBase,
                  state: "intentRecorded",
                }),
              },
              type: "WORKER_CONTINUATION_RECORDED",
            });
            const failedContinuation = yield* appendEvent(runId, paths, {
              payload: {
                continuation: encodeWorkerContinuationReceiptJson({
                  ...continuationBase,
                  code: "HarnessCorrelationUnavailable",
                  message:
                    "The interrupted checkpoint correlation is unavailable.",
                  state: "failed",
                }),
              },
              type: "WORKER_CONTINUATION_RECORDED",
            });
            const correlationBase = {
              actionId: "reconcile-correlation-1",
              expectedContaminatedReadySequence: contaminatedReady.sequence,
              expectedContinuationActionId: "continue-recovery-1",
              expectedCurrentSequence: failedContinuation.event.sequence,
              expectedDeliveryProvenanceDigest: provenanceDigest,
              expectedFailedContinuationSequence:
                failedContinuation.event.sequence,
              expectedFailedRecoverySequence: failedRecovery.event.sequence,
              expectedNativeTurnIdDigest: recoveredTurnDigest,
              expectedRecoveryActionId: "recover-1",
              expectedSessionId: sessionId,
              harnessProfileId:
                codexAppServerExecutionSelection.harnessProfileId,
              maxAttempts: 1 as const,
              workerEvidenceEpochSequence:
                failedContinuation.event.sequence + 1,
            };
            yield* appendEvent(runId, paths, {
              payload: {
                reconciliation:
                  encodeWorkerCorrelationReconciliationReceiptJson({
                    ...correlationBase,
                    state: "intentRecorded",
                  }),
              },
              type: "WORKER_CORRELATION_RECONCILIATION_RECORDED",
            });
            yield* appendEvent(runId, paths, {
              payload: {
                reconciliation:
                  encodeWorkerCorrelationReconciliationReceiptJson({
                    ...correlationBase,
                    state: "correlationAttempted",
                  }),
              },
              type: "WORKER_CORRELATION_RECONCILIATION_RECORDED",
            });
            const failedCorrelation = yield* appendEvent(runId, paths, {
              payload: {
                reconciliation:
                  encodeWorkerCorrelationReconciliationReceiptJson({
                    ...correlationBase,
                    state: "correlationConfirmed",
                  }),
              },
              type: "WORKER_CORRELATION_RECONCILIATION_RECORDED",
            }).pipe(
              Effect.andThen(() =>
                appendEvent(runId, paths, {
                  payload: {
                    reconciliation:
                      encodeWorkerCorrelationReconciliationReceiptJson({
                        ...correlationBase,
                        state: "followUpAttempted",
                      }),
                  },
                  type: "WORKER_CORRELATION_RECONCILIATION_RECORDED",
                })
              ),
              Effect.andThen(() =>
                appendEvent(runId, paths, {
                  payload: {
                    reconciliation:
                      encodeWorkerCorrelationReconciliationReceiptJson({
                        ...correlationBase,
                        state: "followUpConfirmed",
                      }),
                  },
                  type: "WORKER_CORRELATION_RECONCILIATION_RECORDED",
                })
              ),
              Effect.andThen(() =>
                appendEvent(runId, paths, {
                  payload: {
                    reconciliation:
                      encodeWorkerCorrelationReconciliationReceiptJson({
                        ...correlationBase,
                        code: "WorkerCorrelationContinuationFailed",
                        message:
                          "The follow-up failed after source classification.",
                        state: "failed",
                      }),
                  },
                  type: "WORKER_CORRELATION_RECONCILIATION_RECORDED",
                })
              )
            );
            const before = yield* readLocalRunEvents(runId, {
              rootDirectory: cwd,
            });
            const action = WorkerDesktopOriginCorrelationAction.make({
              actionId: parseWorkerRecoveryActionId(
                "reconcile-desktop-origin-1"
              ),
              expectedContaminatedReadySequence: contaminatedReady.sequence,
              expectedContinuationActionId: parseWorkerRecoveryActionId(
                "continue-recovery-1"
              ),
              expectedCorrelationActionId: parseWorkerRecoveryActionId(
                "reconcile-correlation-1"
              ),
              expectedCurrentSequence: failedCorrelation.event.sequence,
              expectedDeliveryProvenanceDigest: provenanceDigest,
              expectedFailedContinuationSequence:
                failedContinuation.event.sequence,
              expectedFailedCorrelationSequence:
                failedCorrelation.event.sequence,
              expectedFailedRecoverySequence: failedRecovery.event.sequence,
              expectedNativeTurnIdDigest: recoveredTurnDigest,
              expectedRecoveryActionId:
                parseWorkerRecoveryActionId("recover-1"),
              expectedSessionId: sessionId,
              harnessProfileId:
                codexAppServerExecutionSelection.harnessProfileId,
              kind: "reconcileDesktopOriginatedWorkerCorrelation",
            });

            const error = yield* Effect.flip(
              actOnWorkerDesktopOriginCorrelation(runId, action, {
                rootDirectory: cwd,
                workerDesktopOriginCorrelationFollowUpDispatcher: () =>
                  Effect.die("must not dispatch"),
                workerDesktopOriginCorrelationReconciler: () =>
                  Effect.die("must not reconcile"),
              })
            );
            const after = yield* readLocalRunEvents(runId, {
              rootDirectory: cwd,
            });

            assert.instanceOf(error, GaiaRuntimeError);
            assert.strictEqual(error.code, "DeliveryActionConflict");
            assert.lengthOf(after.events, before.events.length);
            assert.notInclude(
              after.events.map(({ type }) => type),
              "WORKER_DESKTOP_ORIGIN_CORRELATION_RECORDED"
            );
          } finally {
            rmSync(smoke.root, { force: true, recursive: true });
          }
        })
    );

    it.effect(
      "rejects audited continuation before intent when historical recovery evidence is missing",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-audited-continuation-preflight-",
          });
          const accepted = yield* acceptServerRun(
            { specMarkdown: "No eligible failed recovery exists.\n" },
            { rootDirectory: cwd }
          );
          const runId = parseRunId(accepted.runId);
          const paths = yield* makeRunPaths(runId, { rootDirectory: cwd });
          const action = WorkerContinuationAction.make({
            actionId: parseWorkerRecoveryActionId("continue-recovery-1"),
            expectedContaminatedReadySequence: accepted.eventSequence,
            expectedCurrentSequence: accepted.eventSequence,
            expectedDeliveryProvenanceDigest: parseWorkerRecoveryDigest(
              "c".repeat(64)
            ),
            expectedFailedRecoverySequence: accepted.eventSequence,
            expectedRecoveryActionId: parseWorkerRecoveryActionId("recover-1"),
            expectedSessionId: parseHarnessSessionId(`session-${runId}`),
            harnessProfileId: codexAppServerExecutionSelection.harnessProfileId,
            kind: "continueInterruptedWorkerRecovery",
          });
          let dispatches = 0;
          const error = yield* Effect.flip(
            actOnWorkerContinuation(runId, action, {
              rootDirectory: cwd,
              workerContinuationRunner: () =>
                Effect.sync(() => {
                  dispatches += 1;
                  return {
                    reportPath: paths.reportMarkdown,
                    runDirectory: paths.root,
                    runId,
                    state: "delivering",
                    status: "running",
                  };
                }),
            })
          );
          const events = yield* readLocalRunEvents(runId, {
            rootDirectory: cwd,
          });

          assert.instanceOf(error, GaiaRuntimeError);
          assert.strictEqual(error.code, "DeliveryActionConflict");
          assert.strictEqual(dispatches, 0);
          assert.isFalse(
            events.events.some(
              ({ type }) => type === "WORKER_CONTINUATION_RECORDED"
            )
          );
        })
    );

    it.effect(
      "marks ambiguous audited correlation follow-up restarts outcomeUnknown without redispatch",
      () =>
        Effect.gen(function* () {
          const smoke = makeDisposableGitRemote();
          try {
            const cwd = realpathSync(smoke.source);
            const accepted = yield* acceptFactoryRun(
              {
                delivery: { mode: "pullRequest" },
                execution: codexAppServerExecutionSelection,
                workflow: "issueDelivery",
                workItem: {
                  description: "Ambiguous audited correlation.",
                  kind: "issue",
                  title: "Audited correlation ambiguity",
                },
              },
              {
                harnessProviderRegistry: makeTestHarnessProviderRegistry(),
                rootDirectory: cwd,
              }
            );
            const runId = parseRunId(accepted.runId);
            const paths = yield* makeRunPaths(runId, { rootDirectory: cwd });
            yield* appendEvent(runId, paths, {
              payload: {
                delivery: {
                  baseBranch: "main",
                  baseRevision: smoke.baseRevision,
                  headBranch: `gaia/${runId}`,
                  mode: "pullRequest",
                  remote: "origin",
                  stage: "delivering",
                },
              },
              type: "DELIVERY_STARTED",
            });
            const sessionId = parseHarnessSessionId(`session-${runId}`);
            const action = WorkerCorrelationReconciliationAction.make({
              actionId: parseWorkerRecoveryActionId("reconcile-correlation-1"),
              expectedContaminatedReadySequence: accepted.eventSequence,
              expectedContinuationActionId: parseWorkerRecoveryActionId(
                "continue-recovery-1"
              ),
              expectedCurrentSequence: accepted.eventSequence,
              expectedDeliveryProvenanceDigest: parseWorkerRecoveryDigest(
                "c".repeat(64)
              ),
              expectedFailedContinuationSequence: accepted.eventSequence,
              expectedFailedRecoverySequence: accepted.eventSequence,
              expectedNativeTurnIdDigest: parseWorkerRecoveryDigest(
                "d".repeat(64)
              ),
              expectedRecoveryActionId:
                parseWorkerRecoveryActionId("recover-1"),
              expectedSessionId: sessionId,
              harnessProfileId:
                codexAppServerExecutionSelection.harnessProfileId,
              kind: "reconcileInterruptedWorkerCorrelation",
            });
            const base = {
              actionId: action.actionId,
              expectedContaminatedReadySequence:
                action.expectedContaminatedReadySequence,
              expectedContinuationActionId: action.expectedContinuationActionId,
              expectedCurrentSequence: action.expectedCurrentSequence,
              expectedDeliveryProvenanceDigest:
                action.expectedDeliveryProvenanceDigest,
              expectedFailedContinuationSequence:
                action.expectedFailedContinuationSequence,
              expectedFailedRecoverySequence:
                action.expectedFailedRecoverySequence,
              expectedNativeTurnIdDigest: action.expectedNativeTurnIdDigest,
              expectedRecoveryActionId: action.expectedRecoveryActionId,
              expectedSessionId: action.expectedSessionId,
              harnessProfileId: action.harnessProfileId,
              maxAttempts: 1 as const,
              workerEvidenceEpochSequence: accepted.eventSequence + 1,
            };
            yield* appendEvent(runId, paths, {
              payload: {
                reconciliation:
                  encodeWorkerCorrelationReconciliationReceiptJson({
                    ...base,
                    state: "intentRecorded",
                  }),
              },
              type: "WORKER_CORRELATION_RECONCILIATION_RECORDED",
            });
            yield* appendEvent(runId, paths, {
              payload: {
                reconciliation:
                  encodeWorkerCorrelationReconciliationReceiptJson({
                    ...base,
                    state: "correlationAttempted",
                  }),
              },
              type: "WORKER_CORRELATION_RECONCILIATION_RECORDED",
            });
            yield* appendEvent(runId, paths, {
              payload: {
                reconciliation:
                  encodeWorkerCorrelationReconciliationReceiptJson({
                    ...base,
                    state: "correlationConfirmed",
                  }),
              },
              type: "WORKER_CORRELATION_RECONCILIATION_RECORDED",
            });
            yield* appendEvent(runId, paths, {
              payload: {
                reconciliation:
                  encodeWorkerCorrelationReconciliationReceiptJson({
                    ...base,
                    state: "followUpAttempted",
                  }),
              },
              type: "WORKER_CORRELATION_RECONCILIATION_RECORDED",
            });

            let dispatches = 0;
            const receipt = yield* actOnWorkerCorrelationReconciliation(
              runId,
              action,
              {
                rootDirectory: cwd,
                workerCorrelationFollowUpDispatcher: () =>
                  Effect.sync(() => {
                    dispatches += 1;
                  }),
                workerCorrelationReconciler: () =>
                  Effect.sync(() => {
                    dispatches += 1;
                  }),
              }
            );
            const events = yield* readLocalRunEvents(runId, {
              rootDirectory: cwd,
            });
            const reconciliationStates = events.events.flatMap((event) =>
              event.type === "WORKER_CORRELATION_RECONCILIATION_RECORDED"
                ? [
                    decodeWorkerCorrelationEventPayload(event.payload)
                      .reconciliation.state,
                  ]
                : []
            );
            const replayEventCount = events.events.length;
            const replayReceipt = yield* actOnWorkerCorrelationReconciliation(
              runId,
              action,
              {
                rootDirectory: cwd,
                workerCorrelationFollowUpDispatcher: () =>
                  Effect.die("must not redispatch ambiguous follow-up"),
                workerCorrelationReconciler: () =>
                  Effect.die("must not reconcile ambiguous follow-up"),
              }
            );
            const replayedEvents = yield* readLocalRunEvents(runId, {
              rootDirectory: cwd,
            });

            assert.strictEqual(receipt.state, "outcomeUnknown");
            assert.strictEqual(replayReceipt.state, "outcomeUnknown");
            assert.strictEqual(dispatches, 0);
            assert.deepEqual(reconciliationStates, [
              "intentRecorded",
              "correlationAttempted",
              "correlationConfirmed",
              "followUpAttempted",
              "outcomeUnknown",
            ]);
            assert.lengthOf(replayedEvents.events, replayEventCount);
          } finally {
            rmSync(smoke.root, { force: true, recursive: true });
          }
        })
    );

    it.effect(
      "fails closed when an unrelated same-head clone forges ownership evidence",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const smoke = makeDisposableGitRemote();
          try {
            const source = realpathSync(smoke.source);
            const runId = parseRunId("run-WrongRepo1");
            const paths = yield* makeRunPaths(runId, { rootDirectory: source });
            const provenance = {
              baseBranch: "main",
              baseRevision: smoke.baseRevision,
              headBranch: "gaia/run-WrongRepo1",
              mode: "pullRequest" as const,
              remote: "origin",
            };
            yield* fs.makeDirectory(paths.root, { recursive: true });

            yield* prepareDeliveryWorktree({
              options: { rootDirectory: source },
              paths,
              provenance,
            });
            const manifest = JSON.parse(
              readFileSync(paths.deliveryOwnershipManifest, "utf8")
            ) as Record<string, unknown>;
            rmSync(paths.workspace, { force: true, recursive: true });
            git(smoke.root, "clone", smoke.bare, paths.workspace);
            git(paths.workspace, "checkout", "--detach", smoke.baseRevision);
            manifest["workspaceRoot"] = paths.workspace;
            manifest["workspaceCommonDir"] = git(
              paths.workspace,
              "rev-parse",
              "--path-format=absolute",
              "--git-common-dir"
            );
            writeFileSync(
              paths.deliveryOwnershipManifest,
              `${JSON.stringify(manifest, null, 2)}\n`
            );

            const error = yield* Effect.flip(
              prepareDeliveryWorktree({
                options: { rootDirectory: source },
                paths,
                provenance,
              })
            );

            assert.instanceOf(error, GaiaRuntimeError);
            assert.strictEqual(error.code, "DeliveryWorktreeIdentityMismatch");
          } finally {
            rmSync(smoke.root, { force: true, recursive: true });
          }
        })
    );

    it.effect(
      "creates a real disposable detached git worktree without moving the primary checkout",
      () =>
        Effect.gen(function* () {
          const smoke = makeDisposableGitRemote();
          try {
            const primaryBefore = gitState(smoke.source);
            const publicationCalls: Array<string> = [];
            const accepted = yield* acceptFactoryRun(
              {
                delivery: { mode: "pullRequest" },
                execution: codexAppServerExecutionSelection,
                workflow: "issueDelivery",
                workItem: {
                  description: "Real git worktree smoke.",
                  kind: "issue",
                  title: "Real worktree smoke",
                },
              },
              {
                harnessProviderRegistry: makeTestHarnessProviderRegistry(),
                rootDirectory: smoke.source,
              }
            );
            const summary = yield* continueServerRun(accepted.runId, {
              deliveryPublisher: recordingDeliveryPublisher(publicationCalls),
              harnessProviderRegistry: makeTestHarnessProviderRegistry(),
              rootDirectory: smoke.source,
            });
            const workspace = `${accepted.runDirectory}/workspace`;
            const workspaceHead = git(workspace, "rev-parse", "HEAD");
            const workspaceBranch = git(workspace, "branch", "--show-current");
            const primaryAfter = gitState(smoke.source);

            assert.strictEqual(summary.state, "delivering");
            assert.deepEqual(publicationCalls, [accepted.runId]);
            assert.strictEqual(workspaceHead, smoke.baseRevision);
            assert.strictEqual(workspaceBranch, "");
            assert.deepEqual(primaryAfter, primaryBefore);
          } finally {
            rmSync(smoke.root, { force: true, recursive: true });
          }
        })
    );

    it.effect("appends RUN_FAILED for expected continuation failures", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({
          prefix: "gaia-server-workflow-",
        });
        const accepted = yield* acceptServerRun(
          { specMarkdown: "Fail this server run during review.\n" },
          { rootDirectory: cwd }
        );
        const reviewer = blockingReviewer();

        const error = yield* Effect.flip(
          continueServerRun(accepted.runId, { reviewer, rootDirectory: cwd })
        );
        const events = yield* readLocalRunEvents(accepted.runId, {
          rootDirectory: cwd,
        });
        const failed = events.events.at(-1);

        assert.isTrue(error instanceof GaiaRuntimeError);
        assert.strictEqual(failed?.type, "RUN_FAILED");
        assert.strictEqual(failed?.payload["code"], "ReviewBlocked");
      })
    );

    it.effect(
      "marks unfinished accepted server runs interrupted on startup reconciliation",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-server-workflow-",
          });
          const accepted = yield* acceptServerRun(
            { specMarkdown: "Interrupt this server run.\n" },
            { rootDirectory: cwd }
          );

          const reconciled = yield* reconcileInterruptedServerRuns({
            rootDirectory: cwd,
          });
          const events = yield* readLocalRunEvents(accepted.runId, {
            rootDirectory: cwd,
          });
          const failed = events.events.at(-1);

          assert.deepEqual(reconciled.reconciledRunIds, [accepted.runId]);
          assert.strictEqual(failed?.type, "RUN_FAILED");
          assert.strictEqual(
            failed?.payload["code"],
            "ServerExecutionInterrupted"
          );
          assert.strictEqual(failed?.payload["stage"], "preparingWorkspace");
        })
    );
  });
});

const acceptanceCapabilities = HarnessCapabilities.make({
  approvals: [],
  fileChangeEvents: true,
  interruption: true,
  resumableSessions: true,
  review: false,
  steering: false,
  streamingMessages: true,
  structuredOutput: false,
  subagents: false,
  toolEvents: false,
  usageReporting: false,
  userQuestions: false,
});

const acceptanceProvider: HarnessProvider = {
  createSession: () => Effect.die("not used during acceptance"),
  descriptor: HarnessProviderDescriptor.make({
    displayName: "Synthetic Harness",
    executionModes: ["local"],
    providerId: parseHarnessProviderId("synthetic"),
  }),
  detect: Effect.succeed({
    auth: { state: "authenticated" },
    capabilities: acceptanceCapabilities,
    state: "available",
    version: "synthetic-1",
  }),
  resumeSession: () => Effect.die("not used during acceptance"),
};

function blockingReviewer(): GaiaReviewer {
  const reviewerName = Schema.decodeUnknownSync(ReviewerNameSchema)(
    "server-blocking-reviewer"
  );

  return {
    name: reviewerName,
    run: (request) =>
      Effect.succeed(
        ReviewResult.make({
          findings: [
            ReviewFinding.make({
              message: "Server workflow expected failure.",
              severity: "blocker",
            }),
          ],
          phase: request.phase,
          resultPath:
            request.phase === "plan"
              ? "plan-review.json"
              : "evidence-review.json",
          reviewerName,
          runId: request.runId,
          status: request.phase === "plan" ? "blocked" : "approved",
          summary: "Server workflow expected failure.",
        })
      ),
  };
}

const RecordingGitRunnerInputSchema = Schema.Struct({
  baseRevision: DeliveryGitShaPublicSchema,
  workspaceHead: Schema.optionalKey(DeliveryGitShaPublicSchema),
});

function recordingGitRunner(
  commands: Array<GitDeliveryCommandInput>,
  input: typeof RecordingGitRunnerInputSchema.Type
) {
  return (command: GitDeliveryCommandInput) =>
    Effect.sync(() => {
      commands.push(command);
      const [first, ...rest] = command.args;
      if (first === "rev-parse" && rest[0] === "--show-toplevel") {
        return { stderr: "", stdout: `${command.cwd}\n` };
      }
      if (
        first === "rev-parse" &&
        rest[0] === "--path-format=absolute" &&
        rest[1] === "--git-common-dir"
      ) {
        return { stderr: "", stdout: `${command.cwd}/.git\n` };
      }
      if (first === "fetch") {
        return { stderr: "", stdout: "" };
      }
      if (first === "check-ref-format" && rest[0] === "--branch") {
        return { stderr: "", stdout: `${rest[1]}\n` };
      }
      if (first === "remote" && rest[0] === "get-url") {
        return {
          stderr: "",
          stdout: "https://github.com/cill-i-am/gaia.git\n",
        };
      }
      if (
        first === "rev-parse" &&
        (rest[0] === "origin/main" || rest[0] === "--verify")
      ) {
        return { stderr: "", stdout: `${input.baseRevision}\n` };
      }
      if (first === "rev-parse" && rest[0] === "HEAD") {
        return {
          stderr: "",
          stdout: `${input.workspaceHead ?? input.baseRevision}\n`,
        };
      }
      if (first === "worktree" && rest[0] === "add") {
        return { stderr: "", stdout: "" };
      }
      throw new Error(`Unexpected git command ${command.args.join(" ")}`);
    });
}

function recordingDeliveryPublisher(calls: Array<string>) {
  return (runId: ReturnType<typeof parseRunId>) =>
    Effect.sync(() => {
      calls.push(runId);
      return DeliveryPublicationConfirmed.make({
        baseBranch: "main",
        baseRevision: "a".repeat(40),
        branchName: `gaia/${runId}`,
        commitMessage: `feat: deliver ${runId}`,
        commitSha: "b".repeat(40),
        commitTimestamp: "2026-07-11T00:00:00.000Z",
        digestVersion: 1,
        draft: true,
        headSha: "b".repeat(40),
        operationId: `publish-${runId}-1`,
        payloadDigest: "c".repeat(64),
        prNumber: 91,
        prUrl: "https://github.com/cill-i-am/gaia/pull/91",
        sourcePaths: ["src/feature.ts"],
        state: "confirmed",
        treeSha: "d".repeat(40),
      });
    });
}

function digest(value: string) {
  return parseWorkerRecoveryDigest(
    createHash("sha256").update(value).digest("hex")
  );
}

const WorkerRecoveryTurnCheckpointInputSchema = Schema.Struct({
  actionId: WorkerRecoveryActionIdSchema,
  expectedFailureSequence: RunEvent.fields.sequence,
  expectedSessionId: HarnessSessionIdSchema,
  harnessProfileId: HarnessProfileIdSchema,
  model: WorkerRecoveryModelIdSchema,
  payloadDigest: WorkerRecoveryDigestSchema,
});
const decodeWorkerRecoveryTurnCheckpointInput = Schema.decodeUnknownSync(
  WorkerRecoveryTurnCheckpointInputSchema
);

function workerRecoveryTurnCheckpoint(
  turnIdInput: typeof CodexTurnIdSchema.Encoded,
  recoveryInput: typeof WorkerRecoveryTurnCheckpointInputSchema.Encoded
) {
  const turnId = parseCodexTurnId(turnIdInput);
  const recovery = decodeWorkerRecoveryTurnCheckpointInput(recoveryInput);
  return JSON.stringify({
    actionId: recovery.actionId,
    checkpoint: parseHarnessCheckpointToken(`hchk1_${turnId}`),
    expectedFailureSequence: recovery.expectedFailureSequence,
    expectedSessionId: recovery.expectedSessionId,
    harnessProfileId: recovery.harnessProfileId,
    model: recovery.model,
    nativeTurnIdDigest: digest(turnId),
    payloadDigest: recovery.payloadDigest,
    version: 3,
  });
}

const DeliveryProvenanceDigestInputSchema = Schema.Struct({
  baseBranch: DeliveryBranchNamePublicSchema,
  baseRevision: DeliveryGitShaPublicSchema,
  headBranch: DeliveryBranchNamePublicSchema,
  remote: DeliveryRemoteNamePublicSchema,
});

function deliveryProvenanceDigest(
  input: typeof DeliveryProvenanceDigestInputSchema.Type
) {
  return digest(
    [
      "gaia-worker-continuation-delivery-provenance-v1",
      input.baseBranch,
      input.baseRevision,
      input.headBranch,
      input.remote,
    ].join("\0")
  );
}

function makeDisposableGitRemote() {
  const root = mkdtempSync(join(tmpdir(), "gaia-90-worktree-"));
  const source = join(root, "source");
  const bare = join(root, "origin.git");
  mkdirSync(source);
  git(source, "init", "-b", "main");
  git(source, "config", "user.email", "gaia-smoke@example.test");
  git(source, "config", "user.name", "Gaia Smoke");
  writeFileSync(join(source, ".gitignore"), ".gaia/\n");
  writeFileSync(join(source, "README.md"), "# smoke\n");
  git(source, "add", "README.md");
  git(source, "add", ".gitignore");
  git(source, "commit", "-m", "initial smoke base");
  git(root, "init", "--bare", bare);
  git(source, "remote", "add", "origin", bare);
  git(source, "push", "-u", "origin", "main");
  return {
    baseRevision: git(source, "rev-parse", "origin/main"),
    bare,
    root,
    source,
  };
}

function git(cwd: string, ...args: ReadonlyArray<string>) {
  return execFileSync("git", [...args], { cwd, encoding: "utf8" }).trim();
}

function gitState(cwd: string) {
  return {
    branch: git(cwd, "branch", "--show-current"),
    head: git(cwd, "rev-parse", "HEAD"),
    status: git(cwd, "status", "--short", "--branch"),
  };
}
