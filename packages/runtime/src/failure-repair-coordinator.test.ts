import { readFileSync } from "node:fs";

import { NodeServices } from "@effect/platform-node";
import { layer } from "@effect/vitest";
import {
  ClaimEvidenceV2Schema,
  FailureRepairIntent,
  FAILURE_REPAIR_EVIDENCE_INPUT_BUDGET_BYTES,
  HarnessCapabilities,
  HarnessProviderDescriptor,
  HarnessSessionSnapshot,
  MODEL_OUTPUT_CONTRACT_CWD_RUN_MARKER_V1,
  ModelInvocationEpisodeStartV1,
  ModelInvocationObservationV1,
  ResolvedHarnessExecution,
  codexAppServerHarnessProfileId,
  deriveExplicitSpecItemDigest,
  encodeAnyRunContractJson,
  encodeAnyRunProofResultJson,
  encodeFailureDigestV1Json,
  encodeFailureRepairReceiptJson,
  makeFailureDigestV1,
  makeModelContextContentV1,
  makeModelContextManifestV1,
  makeModelInvocationManifestV1,
  makeProofEvidenceIdV2,
  makeRunContractV2,
  makeRunProofResultV2,
  makeVerificationCommandRequestDigest,
  parseFailureRepairReceipt,
  parseHarnessItemId,
  parseHarnessProviderId,
  parseHarnessSessionId,
  parseHarnessTurnId,
  parseMarkdownSpec,
  parseRunEventSequence,
  parseRunId,
  ProofClaimResultV2Schema,
  projectFailureEvidenceV1,
  renderFailureEvidenceV1,
  renderModelInputV1,
  resolveModelInvocationEpisodes,
  snapshotFromReplay,
  type HarnessEvent,
  type RunContractV2,
} from "@gaia/core";
import {
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Option,
  Schema,
  Stream,
} from "effect";
import { describe, expect, it } from "vitest";

import { makeLiveHarnessSessionCoordinator } from "./agent-session-runtime.js";
import {
  appendEvent,
  appendHarnessSessionEvent,
  readEvents,
} from "./event-store.js";
import { issueDeliveryAgentIds } from "./factory-workflows.js";
import {
  continueFailureRepair,
  continueFailureRepairWithinLease,
  makeFailureRepairTaskInput,
} from "./failure-repair-coordinator.js";
import { makeHarnessProviderRegistry } from "./harness-provider-registry.js";
import type { HarnessProvider, HarnessSession } from "./harness-session.js";
import {
  commitModelInvocationPair,
  deriveModelWorkspaceBinding,
  loadModelInvocationPair,
} from "./model-invocation.js";
import { makeRunPaths } from "./paths.js";
import type { RunPaths } from "./paths.js";

const runId = parseRunId("run-Gaia149rt1");
const capabilities = HarnessCapabilities.make({
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
const descriptor = HarnessProviderDescriptor.make({
  displayName: "Recording repair provider",
  executionModes: ["local"],
  providerId: parseHarnessProviderId("recording-repair"),
});

function maximumArtifactPaths() {
  return Array.from(
    { length: 8 },
    (_, index) => `${index}/${"a".repeat(1_298)}`
  );
}

function maximumValidArtifactEvidence(claimId?: string) {
  const artifacts = maximumArtifactPaths().map((path, index) => ({
    contentDigest: index.toString(16).repeat(64),
    path,
  }));
  return Schema.decodeUnknownSync(Schema.Array(ClaimEvidenceV2Schema))([
    {
      artifacts,
      evidenceId: makeProofEvidenceIdV2(
        "artifact",
        claimId === undefined ? ["bounded-repair"] : [claimId, artifacts]
      ),
      kind: "artifact-integrity",
    },
  ]);
}

function specWithMaximumArtifactClaim() {
  const outcomeStatement = "The bounded artifact set is intact.";
  const artifactStatement = "Verify the bounded artifact set.";
  const commandStatement =
    "Run the pinned POSIX printf command with no network or credentials.";
  const paths = maximumArtifactPaths()
    .map((path) => `            - "${path}"`)
    .join("\n");
  return `---
title: Bounded repair production-path fixture
verification:
  version: 2
  outcomes:
    - key: artifact-output
      statement: ${outcomeStatement}
      sourceItemDigest: "${deriveExplicitSpecItemDigest({
        section: "acceptanceCriteria",
        statement: outcomeStatement,
      })}"
      prePublicationRequiredClaims: [artifact-proof]
      postPublicationRequiredClaims: []
      conditionalClaims: [smoke-command]
  claims:
    - key: artifact-proof
      statement: ${artifactStatement}
      sourceItemDigest: "${deriveExplicitSpecItemDigest({
        section: "verificationChecks",
        statement: artifactStatement,
      })}"
      phase: prePublication
      kind: artifact-integrity
      selector:
        paths:
${paths}
    - key: smoke-command
      statement: ${commandStatement}
      sourceItemDigest: "${deriveExplicitSpecItemDigest({
        section: "verificationChecks",
        statement: commandStatement,
      })}"
      phase: prePublication
      kind: command
      command:
        executableId: posix-printf-v1
        argv: ["%s", "gaia-claim-ok\\n"]
        workingDirectory: .
        timeoutMs: 30000
        outputLimitBytes: 1048576
        workspaceAccess: read-write
        network: denied
        credentials: none
        expectedExitCode: 0
        expectedStdoutByteLength: 14
        expectedStdoutSha256: c67d2c0ac3e5ea53ed76dadc9aab773e884efedcaac2be11aaa4b096576f5849
---

## Acceptance Criteria

- ${outcomeStatement}

## Verification

- ${artifactStatement}
- ${commandStatement}
`;
}

describe("failure repair coordinator", () => {
  it("keeps the maximum valid artifact evidence projection inside the model-input byte bound", () => {
    const evidence = maximumValidArtifactEvidence();
    const evidenceRefs = projectFailureEvidenceV1(evidence);
    const evidenceBytes = evidenceRefs.reduce(
      (total, evidenceRef) =>
        total +
        new TextEncoder().encode(
          renderFailureEvidenceV1(evidenceRef).join("\n")
        ).byteLength +
        1,
      0
    );
    const digest = makeFailureDigestV1({
      attempt: 1,
      evidenceRefs,
      failedRef: {
        claimId: `proof-claim:sha256:${"a".repeat(64)}`,
        kind: "claim",
      },
      maxAttempts: 2,
      outcomeCertainty: "confirmed",
      retryability: "repairable",
      stage: "verifying",
      tag: "verificationClaimFailed",
    });
    const taskInput = makeFailureRepairTaskInput(
      FailureRepairIntent.make({
        digest,
        episodeKey: `failureRepair:${digest.fingerprint}:1`,
        failedProofResultSequence: parseRunEventSequence(4),
        runId,
        state: "intentRecorded",
      })
    );

    expect(evidenceRefs).toHaveLength(8);
    expect(evidenceBytes).toBe(FAILURE_REPAIR_EVIDENCE_INPUT_BUDGET_BYTES);
    expect(new TextEncoder().encode(taskInput).byteLength).toBeLessThanOrEqual(
      16_384
    );
    expect(() =>
      makeModelContextContentV1({
        acceptedOutcomes: ["Repair the exact failed claim."],
        authority: ["Edit only the accepted worker workspace."],
        budget: { maxOutputBytes: 16_384, maxTurns: 1 },
        contentRefs: [],
        episodeRole: "failureRepair",
        instructions: ["Follow the accepted instructions."],
        nonGoals: ["Do not publish or deploy."],
        outputContract: MODEL_OUTPUT_CONTRACT_CWD_RUN_MARKER_V1,
        planningFacts: ["events.jsonl is authoritative."],
        safeExclusions: ["credentials"],
        skills: ["effect-ts"],
        stops: ["Stop on scope drift."],
        taskInput,
        verificationCommands: ["pnpm test"],
      })
    ).not.toThrow();
  });

  layer(NodeServices.layer)((it) => {
    it.effect(
      "bounds the committed repair invocation and exact provider input when inherited context plus evidence overflow",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const seeded = yield* setupFailedRun({
              initialAcceptedOutcomes: ["a".repeat(4_096), "b".repeat(4_096)],
              maximumArtifactFailureEvidence: true,
            });
            if (seeded.workerEpisode === undefined)
              return yield* Effect.die("worker model episode missing");
            const initialModel = yield* loadModelInvocationPair(
              seeded.paths,
              seeded.workerEpisode
            );
            const provider = recordingProvider(seeded.paths.workspace);

            expect(
              new TextEncoder().encode(initialModel.rendered.text).byteLength
            ).toBeLessThanOrEqual(16_384);

            const result = yield* continueFailureRepair(runId, {
              harnessProviderRegistry: makeHarnessProviderRegistry([
                {
                  profileId: codexAppServerHarnessProfileId,
                  provider,
                },
              ]),
              reverify: ({ paths }) => appendProof(paths, seeded, true),
              rootDirectory: seeded.root,
              sessionCoordinator: makeLiveHarnessSessionCoordinator(),
            });

            const events = yield* readEvents(seeded.paths);
            const resolution = resolveModelInvocationEpisodes(events);
            if (resolution.protocol !== "v1")
              return yield* Effect.die("model protocol missing");
            const repairEpisode = resolution.episodes.find(({ start }) =>
              start.episodeKey.startsWith("failureRepair:")
            );
            if (repairEpisode === undefined)
              return yield* Effect.die("repair model episode missing");
            const repairModel = yield* loadModelInvocationPair(
              seeded.paths,
              repairEpisode.start
            );
            const repairBytes = new TextEncoder().encode(
              repairModel.rendered.text
            ).byteLength;
            const repairContent = repairModel.context.payload.content;
            const renderedContext = [
              ...repairContent.acceptedOutcomes,
              ...repairContent.authority,
              ...repairContent.instructions,
              ...repairContent.nonGoals,
              ...repairContent.planningFacts,
              ...repairContent.safeExclusions,
              ...repairContent.skills,
              ...repairContent.stops,
              ...repairContent.verificationCommands,
            ].join("\n");

            expect(result?.state).toBe("verified");
            expect(
              initialModel.context.payload.content.acceptedOutcomes
            ).toEqual(["a".repeat(4_096), "b".repeat(4_096)]);
            expect(repairModel.rendered.text).not.toContain("a".repeat(4_096));
            expect(repairModel.rendered.text).not.toContain("b".repeat(4_096));
            expect(repairModel.rendered.byteLength).toBe(repairBytes);
            expect(repairBytes).toBeLessThanOrEqual(16_384);
            expect(provider.sent).toEqual([repairModel.rendered.text]);
            expect(
              repairModel.context.payload.authoritativeRefs
            ).toContainEqual({
              digest: initialModel.context.contextDigest,
              kind: "baseContext",
            });
            expect(repairModel.rendered.text).toContain(
              `Failed claim: ${seeded.failedClaimId}.`
            );
            expect(repairModel.rendered.text).toContain("Failure fingerprint:");
            expect(repairModel.rendered.text).toContain("Attempt: 1/2.");
            expect(repairModel.rendered.text).toContain(
              "Evidence is replay-authenticated against the authoritative failed proof."
            );
            expect(renderedContext).toContain(
              "every original accepted outcome remains binding"
            );
            expect(renderedContext).toContain(
              "Use only the original authority and accepted worker workspace"
            );
            expect(renderedContext).toContain("Do not broaden scope");
            expect(renderedContext).toContain(
              "Stop before action on authority or scope drift"
            );
            expect(renderedContext).toContain(
              "events.jsonl and the authenticated base context"
            );
            expect(renderedContext).toContain(
              "raw stdout, stderr, secrets, credentials, absolute local paths, or unbounded text"
            );
            expect(renderedContext).toContain(
              "Run only focused claim-matched verification"
            );
          })
        )
    );

    it.effect(
      "resumes the accepted released session, sends once, captures one terminal, and verifies with a distinct episode",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const seeded = yield* setupFailedRun();
            const provider = recordingProvider(seeded.paths.workspace);
            const coordinator = makeLiveHarnessSessionCoordinator();
            let verificationCount = 0;

            const result = yield* continueFailureRepair(runId, {
              harnessProviderRegistry: makeHarnessProviderRegistry([
                {
                  profileId: codexAppServerHarnessProfileId,
                  provider,
                },
              ]),
              reverify: ({ paths }) =>
                Effect.gen(function* () {
                  verificationCount += 1;
                  return yield* appendProof(paths, seeded, true);
                }),
              rootDirectory: seeded.root,
              sessionCoordinator: coordinator,
            });

            const events = yield* readEvents(seeded.paths);
            const receipts = events.flatMap((event) =>
              event.type === "FAILURE_REPAIR_RECORDED"
                ? [parseFailureRepairReceipt(event.payload["failureRepair"])]
                : []
            );
            const resolution = resolveModelInvocationEpisodes(events);
            if (resolution.protocol !== "v1")
              return yield* Effect.die("model protocol missing");
            const repairEpisodes = resolution.episodes.filter(({ start }) =>
              start.episodeKey.startsWith("failureRepair:")
            );

            expect(result?.state).toBe("verified");
            expect(provider.sent).toHaveLength(1);
            expect(provider.resumeRequests).toEqual([
              {
                sessionId: parseHarnessSessionId(`session-${runId}`),
                workspacePath: `.gaia/runs/${runId}/workspace`,
              },
            ]);
            expect(verificationCount).toBe(1);
            expect(receipts.map(({ state }) => state)).toEqual([
              "intentRecorded",
              "dispatchAttempted",
              "turnCompleted",
              "verified",
            ]);
            expect(repairEpisodes).toHaveLength(1);
            const repairEpisode = repairEpisodes[0];
            if (repairEpisode === undefined)
              return yield* Effect.die("repair model episode missing");
            expect(repairEpisode.start.episodeKey).not.toBe("workerInitial");
            if (seeded.workerEpisode === undefined)
              return yield* Effect.die("worker model episode missing");
            expect(repairEpisode.start.contextRef.identityDigest).not.toBe(
              seeded.workerEpisode.contextRef.identityDigest
            );
            expect(repairEpisode.start.invocationRef.identityDigest).not.toBe(
              seeded.workerEpisode.invocationRef.identityDigest
            );
            const repairModel = yield* loadModelInvocationPair(
              seeded.paths,
              repairEpisode.start
            );
            const repairTaskInput =
              repairModel.context.payload.content.taskInput;
            expect(repairTaskInput).toContain(
              `Evidence ID: ${makeProofEvidenceIdV2("command", [
                "6".repeat(64),
              ])}.`
            );
            expect(repairTaskInput).toContain(
              `Request digest: ${makeVerificationCommandRequestDigest(
                seeded.claim.command
              )}.`
            );
            expect(repairTaskInput).toContain(
              `Receipt digest: ${"6".repeat(64)}.`
            );
            expect(repairTaskInput).toContain("Command status: nonZero.");
            expect(repairTaskInput).toContain(
              `Terminal sequence: ${seeded.contentAuthoritySequence}.`
            );
            expect(repairTaskInput.length).toBeLessThanOrEqual(2_048);
            expect(repairTaskInput).not.toContain("stdout");
            expect(repairTaskInput).not.toContain("stderr");
            expect(repairTaskInput).not.toContain("provider-token");
            expect(repairTaskInput).not.toContain("/Users/");
            expect(provider.sent[0]).toContain(repairTaskInput);
            expect(result?.state).toBe("verified");
            expect(
              yield* coordinator.get({
                agentId: issueDeliveryAgentIds.worker,
                runId,
                sessionId: parseHarnessSessionId(`session-${runId}`),
              })
            ).toBeUndefined();
          })
        )
    );

    it.effect(
      "makes a restarted attempted dispatch sticky without a second send or verification",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const seeded = yield* setupFailedRun();
            const sendStarted = yield* Deferred.make<void>();
            const provider = recordingProvider(
              seeded.paths.workspace,
              sendStarted
            );
            const coordinator = makeLiveHarnessSessionCoordinator();
            let verificationCount = 0;
            const options = {
              harnessProviderRegistry: makeHarnessProviderRegistry([
                {
                  profileId: codexAppServerHarnessProfileId,
                  provider,
                },
              ]),
              reverify: () =>
                Effect.sync(() => {
                  verificationCount += 1;
                  return seeded.failedProof;
                }),
              rootDirectory: seeded.root,
              sessionCoordinator: coordinator,
            };
            const first = yield* continueFailureRepairWithinLease(
              runId,
              options
            ).pipe(Effect.forkChild);
            yield* Deferred.await(sendStarted);
            yield* Fiber.interrupt(first);
            const attemptedEvent = (yield* readEvents(seeded.paths)).findLast(
              ({ type }) => type === "FAILURE_REPAIR_RECORDED"
            );
            const attempted = parseFailureRepairReceipt(
              attemptedEvent?.payload["failureRepair"]
            );
            expect(attempted.state).toBe("dispatchAttempted");

            const restarted = yield* continueFailureRepairWithinLease(
              runId,
              options
            );
            const terminalReplay = yield* continueFailureRepairWithinLease(
              runId,
              options
            );

            expect(restarted?.state).toBe("outcomeUnknown");
            expect(terminalReplay?.state).toBe("outcomeUnknown");
            if (restarted?.state !== "outcomeUnknown")
              return yield* Effect.die("unknown repair outcome missing");
            const encodedUnknown = Schema.decodeUnknownSync(
              Schema.Record(Schema.String, Schema.Json)
            )(encodeFailureRepairReceiptJson(restarted));
            expect(encodedUnknown["terminalPolicy"]).toEqual({
              nextSafeAction: "reconciliation",
              outcomeCertainty: "unknown",
              retryability: "reconciliationRequired",
              tag: "externalOutcomeUnknown",
              version: 1,
            });
            expect(restarted.digest.fingerprint).toBe(
              attempted.digest.fingerprint
            );
            expect(restarted.digest.attempt).toBe(attempted.digest.attempt);
            expect(restarted.digest.failedRef).toEqual(
              attempted.digest.failedRef
            );
            expect(restarted.failedProofResultSequence).toBe(
              attempted.failedProofResultSequence
            );
            expect(encodeFailureDigestV1Json(restarted.digest)).toEqual(
              encodeFailureDigestV1Json(attempted.digest)
            );
            expect(provider.sent).toHaveLength(1);
            expect(provider.resumeRequests).toHaveLength(1);
            expect(verificationCount).toBe(0);
            expect(
              snapshotFromReplay(yield* readEvents(seeded.paths)).state
            ).toBe("failed");
          })
        )
    );

    for (const attribution of ["missing", "wrong"] as const) {
      it.effect(
        `makes a restarted ${attribution}-episode terminal sticky without verification`,
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const seeded = yield* setupFailedRun();
              const sendStarted = yield* Deferred.make<void>();
              const provider = recordingProvider(
                seeded.paths.workspace,
                sendStarted
              );
              const coordinator = makeLiveHarnessSessionCoordinator();
              let verificationCount = 0;
              const options = {
                harnessProviderRegistry: makeHarnessProviderRegistry([
                  {
                    profileId: codexAppServerHarnessProfileId,
                    provider,
                  },
                ]),
                reverify: () =>
                  Effect.sync(() => {
                    verificationCount += 1;
                    return seeded.failedProof;
                  }),
                rootDirectory: seeded.root,
                sessionCoordinator: coordinator,
              };
              const first = yield* continueFailureRepairWithinLease(
                runId,
                options
              ).pipe(Effect.forkChild);
              yield* Deferred.await(sendStarted);
              yield* Fiber.interrupt(first);
              const attemptedEvent = (yield* readEvents(seeded.paths)).findLast(
                ({ type }) => type === "FAILURE_REPAIR_RECORDED"
              );
              const attempted = parseFailureRepairReceipt(
                attemptedEvent?.payload["failureRepair"]
              );
              if (attempted.state !== "dispatchAttempted")
                return yield* Effect.die("dispatch attempt missing");
              const sessionId = parseHarnessSessionId(`session-${runId}`);
              const turnId = parseHarnessTurnId(
                `turn-${attribution}-repair-attribution`
              );
              yield* appendHarnessSessionEvent(
                runId,
                seeded.paths,
                { kind: "turnStarted", sessionId, turnId },
                undefined,
                attribution === "wrong"
                  ? ModelInvocationObservationV1.make({
                      episodeKey: "workerInitial",
                      kind: "offered",
                      source: "codexAppServerTransport",
                      trust: "high",
                      version: 1,
                    })
                  : undefined
              );
              yield* appendHarnessSessionEvent(runId, seeded.paths, {
                kind: "turnCompleted",
                sessionId,
                status: "completed",
                turnId,
              });

              const restarted = yield* continueFailureRepairWithinLease(
                runId,
                options
              );

              expect(restarted?.state).toBe("outcomeUnknown");
              expect(provider.sent).toHaveLength(1);
              expect(provider.resumeRequests).toHaveLength(1);
              expect(verificationCount).toBe(0);
              expect(
                snapshotFromReplay(yield* readEvents(seeded.paths)).state
              ).toBe("failed");
            })
          )
      );
    }

    it.effect(
      "exhausts after exactly two failed repairs and never sends a third time",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const seeded = yield* setupFailedRun();
            const provider = recordingProvider(seeded.paths.workspace);
            const coordinator = makeLiveHarnessSessionCoordinator();
            let verificationCount = 0;
            const options = {
              harnessProviderRegistry: makeHarnessProviderRegistry([
                {
                  profileId: codexAppServerHarnessProfileId,
                  provider,
                },
              ]),
              reverify: ({ paths }: { readonly paths: RunPaths }) =>
                Effect.gen(function* () {
                  verificationCount += 1;
                  return yield* appendProof(paths, seeded, false);
                }),
              rootDirectory: seeded.root,
              sessionCoordinator: coordinator,
            };

            const exhausted = yield* continueFailureRepair(runId, options);
            const replayed = yield* continueFailureRepair(runId, options);
            const receipts = (yield* readEvents(seeded.paths)).flatMap(
              (event) =>
                event.type === "FAILURE_REPAIR_RECORDED"
                  ? [parseFailureRepairReceipt(event.payload["failureRepair"])]
                  : []
            );

            expect(exhausted?.state).toBe("exhausted");
            expect(replayed?.state).toBe("exhausted");
            expect(provider.sent).toHaveLength(2);
            expect(provider.resumeRequests).toHaveLength(2);
            expect(verificationCount).toBe(2);
            expect(receipts.map(({ state }) => state)).toEqual([
              "intentRecorded",
              "dispatchAttempted",
              "turnCompleted",
              "failed",
              "intentRecorded",
              "dispatchAttempted",
              "turnCompleted",
              "failed",
              "exhausted",
            ]);
            expect(
              snapshotFromReplay(yield* readEvents(seeded.paths)).state
            ).toBe("failed");
          })
        )
    );

    it.effect(
      "makes unavailable fresh verification terminal without another action on re-entry",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const seeded = yield* setupFailedRun();
            const provider = recordingProvider(seeded.paths.workspace);
            const coordinator = makeLiveHarnessSessionCoordinator();
            let verificationCount = 0;
            const options = {
              harnessProviderRegistry: makeHarnessProviderRegistry([
                {
                  profileId: codexAppServerHarnessProfileId,
                  provider,
                },
              ]),
              reverify: () =>
                Effect.suspend(() => {
                  verificationCount += 1;
                  return Effect.fail("verification unavailable");
                }),
              rootDirectory: seeded.root,
              sessionCoordinator: coordinator,
            };

            const failed = yield* continueFailureRepair(runId, options);
            const replayed = yield* continueFailureRepair(runId, options);

            expect(failed?.state).toBe("failed");
            expect(replayed?.state).toBe("failed");
            expect(provider.sent).toHaveLength(1);
            expect(provider.resumeRequests).toHaveLength(1);
            expect(verificationCount).toBe(1);
            expect(
              snapshotFromReplay(yield* readEvents(seeded.paths)).state
            ).toBe("failed");
          })
        )
    );

    it.effect(
      "fails closed before provider resume when no repair invocation episode can be committed",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const seeded = yield* setupFailedRun({
              legacyModelInvocation: true,
            });
            const provider = recordingProvider(seeded.paths.workspace);
            let verificationCount = 0;

            const failed = yield* continueFailureRepair(runId, {
              harnessProviderRegistry: makeHarnessProviderRegistry([
                {
                  profileId: codexAppServerHarnessProfileId,
                  provider,
                },
              ]),
              reverify: () =>
                Effect.sync(() => {
                  verificationCount += 1;
                  return seeded.failedProof;
                }),
              rootDirectory: seeded.root,
              sessionCoordinator: makeLiveHarnessSessionCoordinator(),
            });

            expect(failed?.state).toBe("failed");
            expect(provider.resumeRequests).toHaveLength(0);
            expect(provider.sent).toHaveLength(0);
            expect(verificationCount).toBe(0);
            expect(
              snapshotFromReplay(yield* readEvents(seeded.paths)).state
            ).toBe("failed");
          })
        )
    );

    it.effect(
      "does not repair an older failed proof after the latest authoritative proof passes",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const seeded = yield* setupFailedRun({
              deliveryMode: true,
              initialProofPassed: true,
            });
            const delivery = {
              baseBranch: "main",
              baseRevision: "1".repeat(40),
              headBranch: "codex/gaia-149-proof-order",
              mode: "pullRequest",
              remote: "origin",
              stage: "readyToPublish",
            };
            yield* appendEvent(runId, seeded.paths, {
              payload: { delivery, reportPath: "report.md" },
              type: "DELIVERY_READY_TO_PUBLISH",
            });
            yield* appendProof(
              seeded.paths,
              seeded,
              false,
              seeded.contentAuthoritySequence
            );
            yield* appendProof(
              seeded.paths,
              seeded,
              true,
              seeded.contentAuthoritySequence
            );
            const provider = recordingProvider(seeded.paths.workspace);
            let verificationCount = 0;

            const result = yield* continueFailureRepair(runId, {
              harnessProviderRegistry: makeHarnessProviderRegistry([
                {
                  profileId: codexAppServerHarnessProfileId,
                  provider,
                },
              ]),
              reverify: () =>
                Effect.sync(() => {
                  verificationCount += 1;
                  return seeded.initialProof;
                }),
              rootDirectory: seeded.root,
              sessionCoordinator: makeLiveHarnessSessionCoordinator(),
            });
            const repairEvents = (yield* readEvents(seeded.paths)).filter(
              ({ type }) => type === "FAILURE_REPAIR_RECORDED"
            );

            expect(result).toBeUndefined();
            expect(repairEvents).toHaveLength(0);
            expect(provider.detectionCount()).toBe(0);
            expect(provider.resumeRequests).toHaveLength(0);
            expect(provider.sent).toHaveLength(0);
            expect(verificationCount).toBe(0);
          })
        )
    );

    it.effect(
      "does not repair a post-publication failure owned by delivery remediation",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const seeded = yield* setupFailedRun({
              deliveryMode: true,
              initialProofPassed: true,
            });
            yield* appendEvent(runId, seeded.paths, {
              payload: {
                delivery: {
                  baseBranch: "main",
                  baseRevision: "1".repeat(40),
                  headBranch: "codex/gaia-149-proof-order",
                  mode: "pullRequest",
                  remote: "origin",
                  stage: "readyToPublish",
                },
                reportPath: "report.md",
              },
              type: "DELIVERY_READY_TO_PUBLISH",
            });
            yield* appendProof(
              seeded.paths,
              seeded,
              false,
              seeded.contentAuthoritySequence
            );
            const provider = recordingProvider(seeded.paths.workspace);
            let verificationCount = 0;

            const result = yield* continueFailureRepair(runId, {
              harnessProviderRegistry: makeHarnessProviderRegistry([
                {
                  profileId: codexAppServerHarnessProfileId,
                  provider,
                },
              ]),
              reverify: () =>
                Effect.sync(() => {
                  verificationCount += 1;
                  return seeded.initialProof;
                }),
              rootDirectory: seeded.root,
              sessionCoordinator: makeLiveHarnessSessionCoordinator(),
            });

            expect(result).toBeUndefined();
            expect(provider.detectionCount()).toBe(0);
            expect(provider.resumeRequests).toHaveLength(0);
            expect(provider.sent).toHaveLength(0);
            expect(verificationCount).toBe(0);
          })
        )
    );

    it.effect(
      "does not execute a durable repair intent after the run becomes terminal",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const seeded = yield* setupFailedRun();
            const detectionStarted = yield* Deferred.make<void>();
            const seedProvider = recordingProvider(seeded.paths.workspace);
            const blockingProvider: HarnessProvider = {
              ...seedProvider,
              detect: Effect.gen(function* () {
                yield* Deferred.succeed(detectionStarted, undefined);
                return yield* Effect.never;
              }),
            };
            const first = yield* continueFailureRepairWithinLease(runId, {
              harnessProviderRegistry: makeHarnessProviderRegistry([
                {
                  profileId: codexAppServerHarnessProfileId,
                  provider: blockingProvider,
                },
              ]),
              reverify: () => Effect.succeed(seeded.failedProof),
              rootDirectory: seeded.root,
              sessionCoordinator: makeLiveHarnessSessionCoordinator(),
            }).pipe(Effect.forkChild);
            yield* Deferred.await(detectionStarted);
            yield* Fiber.interrupt(first);
            expect(
              parseFailureRepairReceipt(
                (yield* readEvents(seeded.paths)).findLast(
                  ({ type }) => type === "FAILURE_REPAIR_RECORDED"
                )?.payload["failureRepair"]
              ).state
            ).toBe("intentRecorded");
            yield* appendEvent(runId, seeded.paths, {
              payload: {
                code: "TerminalLifecycleDrift",
                message: "The run terminated before repair dispatch.",
                recoverable: false,
                stage: "runningWorker",
              },
              type: "RUN_FAILED",
            });
            const provider = recordingProvider(seeded.paths.workspace);
            let verificationCount = 0;

            const result = yield* continueFailureRepairWithinLease(runId, {
              harnessProviderRegistry: makeHarnessProviderRegistry([
                {
                  profileId: codexAppServerHarnessProfileId,
                  provider,
                },
              ]),
              reverify: () =>
                Effect.sync(() => {
                  verificationCount += 1;
                  return seeded.failedProof;
                }),
              rootDirectory: seeded.root,
              sessionCoordinator: makeLiveHarnessSessionCoordinator(),
            });

            expect(result?.state).toBe("failed");
            expect(provider.detectionCount()).toBe(0);
            expect(provider.resumeRequests).toHaveLength(0);
            expect(provider.sent).toHaveLength(0);
            expect(verificationCount).toBe(0);
          })
        )
    );

    it.effect(
      "does not verify a completed repair turn after the run becomes terminal",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const seeded = yield* setupFailedRun();
            const sendStarted = yield* Deferred.make<void>();
            const provider = recordingProvider(
              seeded.paths.workspace,
              sendStarted
            );
            let verificationCount = 0;
            const options = {
              harnessProviderRegistry: makeHarnessProviderRegistry([
                {
                  profileId: codexAppServerHarnessProfileId,
                  provider,
                },
              ]),
              reverify: () =>
                Effect.sync(() => {
                  verificationCount += 1;
                  return seeded.failedProof;
                }),
              rootDirectory: seeded.root,
              sessionCoordinator: makeLiveHarnessSessionCoordinator(),
            };
            const first = yield* continueFailureRepairWithinLease(
              runId,
              options
            ).pipe(Effect.forkChild);
            yield* Deferred.await(sendStarted);
            yield* Fiber.interrupt(first);
            const attempted = parseFailureRepairReceipt(
              (yield* readEvents(seeded.paths)).findLast(
                ({ type }) => type === "FAILURE_REPAIR_RECORDED"
              )?.payload["failureRepair"]
            );
            if (attempted.state !== "dispatchAttempted")
              return yield* Effect.die("dispatch attempt missing");
            const sessionId = parseHarnessSessionId(`session-${runId}`);
            const turnId = parseHarnessTurnId(
              "turn-terminal-before-verification"
            );
            yield* appendHarnessSessionEvent(
              runId,
              seeded.paths,
              { kind: "turnStarted", sessionId, turnId },
              undefined,
              ModelInvocationObservationV1.make({
                episodeKey: attempted.episodeKey,
                kind: "offered",
                source: "codexAppServerTransport",
                trust: "high",
                version: 1,
              })
            );
            yield* appendHarnessSessionEvent(runId, seeded.paths, {
              kind: "turnCompleted",
              sessionId,
              status: "completed",
              turnId,
            });
            yield* appendEvent(runId, seeded.paths, {
              payload: {
                code: "TerminalBeforeRepairVerification",
                message: "The run terminated before repair verification.",
                recoverable: false,
                stage: "runningWorker",
              },
              type: "RUN_FAILED",
            });

            const result = yield* continueFailureRepairWithinLease(
              runId,
              options
            );

            expect(result?.state).toBe("failed");
            expect(provider.sent).toHaveLength(1);
            expect(verificationCount).toBe(0);
            expect(
              snapshotFromReplay(yield* readEvents(seeded.paths)).state
            ).toBe("failed");
          })
        )
    );

    it.effect(
      "terminally supersedes a failed attempt when newer authoritative proof passes",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const seeded = yield* setupFailedRun({ deliveryMode: true });
            const provider = recordingProvider(seeded.paths.workspace);
            let verificationCount = 0;
            const options = {
              harnessProviderRegistry: makeHarnessProviderRegistry([
                {
                  profileId: codexAppServerHarnessProfileId,
                  provider,
                },
              ]),
              reverify: ({ paths }: { readonly paths: RunPaths }) =>
                Effect.gen(function* () {
                  verificationCount += 1;
                  const failed = yield* appendProof(paths, seeded, false);
                  yield* appendEvent(runId, paths, {
                    payload: {
                      delivery: {
                        baseBranch: "main",
                        baseRevision: "1".repeat(40),
                        headBranch: "codex/gaia-149-proof-order",
                        mode: "pullRequest",
                        remote: "origin",
                        stage: "readyToPublish",
                      },
                      reportPath: "report.md",
                    },
                    type: "DELIVERY_READY_TO_PUBLISH",
                  });
                  return failed;
                }),
              rootDirectory: seeded.root,
              sessionCoordinator: makeLiveHarnessSessionCoordinator(),
            };

            const first = yield* continueFailureRepair(runId, options);
            expect(first?.state).toBe("failed");
            expect(provider.sent).toHaveLength(1);
            const detectionsAfterFirst = provider.detectionCount();
            yield* appendEvent(runId, seeded.paths, {
              payload: { workspacePath: "workspace" },
              type: "WORKSPACE_PREPARED",
            });
            const completed = yield* appendEvent(runId, seeded.paths, {
              payload: { workerResultPath: "worker-result.json" },
              type: "WORKER_COMPLETED",
            });
            yield* appendProof(
              seeded.paths,
              seeded,
              true,
              completed.event.sequence
            );

            const superseded = yield* continueFailureRepair(runId, options);
            const replayed = yield* continueFailureRepair(runId, options);

            expect(superseded?.state).toBe("superseded");
            expect(replayed?.state).toBe("superseded");
            expect(provider.detectionCount()).toBe(detectionsAfterFirst);
            expect(provider.resumeRequests).toHaveLength(1);
            expect(provider.sent).toHaveLength(1);
            expect(verificationCount).toBe(1);
          })
        )
    );

    it.effect(
      "uses a newer authoritative failed proof for the remaining bounded attempt",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const seeded = yield* setupFailedRun({ deliveryMode: true });
            const provider = recordingProvider(seeded.paths.workspace);
            let verificationCount = 0;
            const options = {
              harnessProviderRegistry: makeHarnessProviderRegistry([
                {
                  profileId: codexAppServerHarnessProfileId,
                  provider,
                },
              ]),
              reverify: ({ paths }: { readonly paths: RunPaths }) =>
                Effect.gen(function* () {
                  verificationCount += 1;
                  const failed = yield* appendProof(paths, seeded, false);
                  yield* appendEvent(runId, paths, {
                    payload: {
                      delivery: {
                        baseBranch: "main",
                        baseRevision: "1".repeat(40),
                        headBranch: "codex/gaia-149-proof-order",
                        mode: "pullRequest",
                        remote: "origin",
                        stage: "readyToPublish",
                      },
                      reportPath: "report.md",
                    },
                    type: "DELIVERY_READY_TO_PUBLISH",
                  });
                  return failed;
                }),
              rootDirectory: seeded.root,
              sessionCoordinator: makeLiveHarnessSessionCoordinator(),
            };

            const first = yield* continueFailureRepair(runId, options);
            expect(first?.state).toBe("failed");
            yield* appendEvent(runId, seeded.paths, {
              payload: { workspacePath: "workspace" },
              type: "WORKSPACE_PREPARED",
            });
            const completed = yield* appendEvent(runId, seeded.paths, {
              payload: { workerResultPath: "worker-result.json" },
              type: "WORKER_COMPLETED",
            });
            const newerFailed = yield* appendProof(
              seeded.paths,
              seeded,
              false,
              completed.event.sequence
            );

            const exhausted = yield* continueFailureRepair(runId, options);
            const secondIntent = (yield* readEvents(seeded.paths))
              .flatMap((event) =>
                event.type === "FAILURE_REPAIR_RECORDED"
                  ? [parseFailureRepairReceipt(event.payload["failureRepair"])]
                  : []
              )
              .find(
                (receipt) =>
                  receipt.state === "intentRecorded" &&
                  receipt.digest.attempt === 2
              );

            expect(exhausted?.state).toBe("exhausted");
            expect(secondIntent?.failedProofResultSequence).toBe(
              newerFailed.recordedBy.sequence
            );
            expect(provider.sent).toHaveLength(2);
            expect(verificationCount).toBe(2);
          })
        )
    );
  });
});

function setupFailedRun(
  options: {
    readonly deliveryMode?: boolean;
    readonly initialAcceptedOutcomes?: ReadonlyArray<string>;
    readonly initialProofPassed?: boolean;
    readonly legacyModelInvocation?: boolean;
    readonly maximumArtifactFailureEvidence?: boolean;
  } = {}
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectory({
      prefix: "gaia-failure-repair-",
    });
    const paths = yield* makeRunPaths(runId, { rootDirectory: root });
    yield* fs.makeDirectory(paths.workspace, { recursive: true });
    yield* fs.writeFileString(paths.input, "# Repair\n\nRepair one claim.\n");

    const spec = parseMarkdownSpec(
      options.maximumArtifactFailureEvidence === true
        ? specWithMaximumArtifactClaim()
        : readFileSync(
            new URL(
              "../../../examples/specs/claim-verification-v2.md",
              import.meta.url
            ),
            "utf8"
          ),
      "failure repair"
    );
    const contract = makeRunContractV2({
      baseDigest: "1".repeat(64),
      baseIdentity: { kind: "unversionedSnapshot", workspacePath: "." },
      runId,
      spec,
      targetDigest: "2".repeat(64),
      targetIdentity: { kind: "unversionedWorkspace", workspacePath: "." },
    });
    const claim = contract.proofClaims.find(
      (entry) => entry.kind === "command"
    );
    if (claim === undefined) return yield* Effect.die("command claim missing");
    const failedClaim =
      options.maximumArtifactFailureEvidence === true
        ? contract.proofClaims.find(
            (entry) => entry.kind === "artifact-integrity"
          )
        : claim;
    if (failedClaim === undefined)
      return yield* Effect.die("failed claim missing");
    const resolved = ResolvedHarnessExecution.make({
      capabilities,
      executionMode: "local",
      harnessProfileId: codexAppServerHarnessProfileId,
      provider: descriptor,
      version: "test-1",
    });
    yield* appendEvent(runId, paths, {
      payload: {
        execution: {
          resolved: Schema.encodeSync(ResolvedHarnessExecution)(resolved),
          selection: { harnessProfileId: codexAppServerHarnessProfileId },
        },
        ...(options.legacyModelInvocation === true
          ? {}
          : { modelInvocationProtocol: "v1" }),
        source: "server",
        specPath: "input.md",
        workflow: "issueDelivery",
      },
      type: "RUN_CREATED",
    });
    if (options.deliveryMode === true)
      yield* appendEvent(runId, paths, {
        payload: {
          delivery: {
            baseBranch: "main",
            baseRevision: "1".repeat(40),
            headBranch: "codex/gaia-149-proof-order",
            mode: "pullRequest",
            remote: "origin",
            stage: "delivering",
          },
        },
        type: "DELIVERY_STARTED",
      });
    yield* appendEvent(runId, paths, {
      payload: { contract: encodeAnyRunContractJson(contract) },
      type: "RUN_CONTRACT_RECORDED",
    });
    yield* appendEvent(runId, paths, {
      payload: { workspacePath: "workspace" },
      type: "WORKSPACE_PREPARED",
    });

    const content = makeModelContextContentV1({
      acceptedOutcomes: options.initialAcceptedOutcomes ?? [
        "Repair the exact failed claim.",
      ],
      authority: ["Edit only the accepted worker workspace."],
      budget: { maxOutputBytes: 16_384, maxTurns: 1 },
      contentRefs: [],
      episodeRole: "workerInitial",
      instructions: ["Follow the accepted instructions."],
      nonGoals: ["Do not publish or deploy."],
      outputContract: MODEL_OUTPUT_CONTRACT_CWD_RUN_MARKER_V1,
      planningFacts: ["events.jsonl is authoritative."],
      safeExclusions: ["credentials"],
      skills: ["effect-ts"],
      stops: ["Stop on scope drift."],
      taskInput: "Implement the accepted slice.",
      verificationCommands: ["pnpm test"],
    });
    const workspaceBinding = yield* deriveModelWorkspaceBinding(paths);
    const context = makeModelContextManifestV1({
      authoritativeRefs: [],
      binding: { episodeKey: "workerInitial", runId },
      content,
      workspaceBinding,
    });
    const invocation = makeModelInvocationManifestV1({
      acceptedProviderCapabilityObservation: "unobservable",
      adapterInputClass: "codexAppTurn",
      adapterSemantics: {
        kind: "codexAppServer",
        semanticDigest: "3".repeat(64),
      },
      authorityRef: { digest: "4".repeat(64), kind: "authority" },
      binding: context.payload.binding,
      budget: content.payload.budget,
      context,
      outputContract: content.payload.outputContract,
      rendered: renderModelInputV1(content),
      runContractRef: { digest: contract.contractDigest, kind: "runContract" },
      template: { id: "gaia.worker-input.v1", version: 1 },
      workspaceBinding,
    });
    const workerEpisode =
      options.legacyModelInvocation === true
        ? undefined
        : yield* commitModelInvocationPair({
            context,
            episodeKey: "workerInitial",
            invocation,
            paths,
          });
    yield* appendEvent(runId, paths, {
      ...(workerEpisode === undefined
        ? {}
        : {
            payload: {
              modelInvocationEpisode: Schema.encodeSync(
                ModelInvocationEpisodeStartV1
              )(workerEpisode),
            },
          }),
      type: "WORKER_STARTED",
    });
    const sessionId = parseHarnessSessionId(`session-${runId}`);
    const oldTurnId = parseHarnessTurnId("turn-initial");
    yield* appendHarnessSessionEvent(runId, paths, {
      capabilities,
      kind: "sessionStarted",
      provider: descriptor,
      sessionId,
      state: "running",
    });
    yield* appendHarnessSessionEvent(runId, paths, {
      kind: "turnStarted",
      sessionId,
      turnId: oldTurnId,
    });
    yield* appendHarnessSessionEvent(runId, paths, {
      kind: "turnCompleted",
      sessionId,
      status: "completed",
      turnId: oldTurnId,
    });
    const completed = yield* appendEvent(runId, paths, {
      payload: { workerResultPath: "worker-result.json" },
      type: "WORKER_COMPLETED",
    });
    const initialProof = yield* appendProof(
      paths,
      {
        claim,
        contract,
        failedClaimId: failedClaim.claimId,
      },
      options.initialProofPassed ?? false,
      completed.event.sequence
    );
    return {
      claim,
      contract,
      contentAuthoritySequence: completed.event.sequence,
      failedClaimId: failedClaim.claimId,
      failedProof: initialProof,
      initialProof,
      paths,
      root,
      workerEpisode,
    } as const;
  });
}

function appendProof(
  paths: RunPaths,
  fixture: {
    readonly claim: Extract<
      RunContractV2["proofClaims"][number],
      { readonly kind: "command" }
    >;
    readonly contract: RunContractV2;
    readonly failedClaimId?: string;
  },
  passed: boolean,
  contentAuthoritySequence?: number
) {
  return Effect.gen(function* () {
    const events = yield* readEvents(paths);
    const sequence = events.length + 1;
    const authority =
      contentAuthoritySequence ??
      events.findLast(
        (event) =>
          event.type === "FAILURE_REPAIR_RECORDED" &&
          parseFailureRepairReceipt(event.payload["failureRepair"]).state ===
            "turnCompleted"
      )?.sequence;
    if (authority === undefined)
      return yield* Effect.die("content authority missing");
    const failedClaimId = fixture.failedClaimId ?? fixture.claim.claimId;
    const result = makeRunProofResultV2({
      contentAuthoritySequence: parseRunEventSequence(authority),
      contract: fixture.contract,
      observedTargetDigest: fixture.contract.targetDigest,
      recordedBy: {
        runId,
        sequence,
        type: "RUN_PROOF_RESULT_RECORDED",
      },
      results: Schema.decodeUnknownSync(Schema.Array(ProofClaimResultV2Schema))(
        fixture.contract.proofClaims.map((claim) =>
          claim.claimId === failedClaimId
            ? claim.kind === "artifact-integrity"
              ? {
                  claimId: claim.claimId,
                  evidence: maximumValidArtifactEvidence(claim.claimId),
                  ...(passed
                    ? { status: "passed" as const }
                    : {
                        reason:
                          "stdout: raw output; stderr: provider-token at /Users/example/workspace.",
                        status: "failed" as const,
                      }),
                }
              : claim.kind === "command"
                ? passed
                  ? {
                      claimId: claim.claimId,
                      evidence: [
                        {
                          evidenceId: makeProofEvidenceIdV2("command", [
                            "5".repeat(64),
                          ]),
                          kind: "command",
                          receiptDigest: "5".repeat(64),
                          requestDigest: makeVerificationCommandRequestDigest(
                            claim.command
                          ),
                          status: "succeeded",
                          terminalSequence: authority,
                        },
                      ],
                      status: "passed",
                    }
                  : {
                      claimId: claim.claimId,
                      evidence: [
                        {
                          evidenceId: makeProofEvidenceIdV2("command", [
                            "6".repeat(64),
                          ]),
                          kind: "command",
                          receiptDigest: "6".repeat(64),
                          requestDigest: makeVerificationCommandRequestDigest(
                            claim.command
                          ),
                          status: "nonZero",
                          terminalSequence: authority,
                        },
                      ],
                      reason:
                        "stdout: raw output; stderr: provider-token at /Users/example/workspace.",
                      status: "failed",
                    }
                : {
                    claimId: claim.claimId,
                    reason: "Unsupported production-path failure fixture.",
                    status: "not-run",
                  }
            : claim.kind === "human-judgment"
              ? {
                  claimId: claim.claimId,
                  reason: "An explicit paired-review decision is required.",
                  requiredAuthority: "human",
                  status: "requires-decision",
                }
              : {
                  claimId: claim.claimId,
                  reason: "Post-publication evidence is not available yet.",
                  status: "not-run",
                }
        )
      ),
    });
    yield* appendEvent(runId, paths, {
      payload: {
        result: encodeAnyRunProofResultJson(result),
        verificationResultPath: `verification/run-proof-${sequence}.json`,
      },
      type: "RUN_PROOF_RESULT_RECORDED",
    });
    return result;
  });
}

function recordingProvider(
  workspacePath: string,
  sendStarted?: Deferred.Deferred<void>
): HarnessProvider & {
  readonly detectionCount: () => number;
  readonly resumeRequests: Array<{
    readonly sessionId: ReturnType<typeof parseHarnessSessionId>;
    readonly workspacePath: string;
  }>;
  readonly sent: string[];
} {
  const resumeRequests: Array<{
    readonly sessionId: ReturnType<typeof parseHarnessSessionId>;
    readonly workspacePath: string;
  }> = [];
  const sent: string[] = [];
  let detections = 0;
  return {
    createSession: () => Effect.die("not used"),
    descriptor,
    detect: Effect.sync(() => {
      detections += 1;
      return {
        auth: { state: "notRequired" } as const,
        capabilities,
        state: "available" as const,
        version: "test-1",
      };
    }),
    detectionCount: () => detections,
    resumeRequests,
    resumeSession: (request) => {
      resumeRequests.push({
        sessionId: request.sessionId,
        workspacePath: request.workspacePath,
      });
      return Effect.succeed(
        recordingSession(
          request.sessionId,
          workspacePath,
          resumeRequests.length,
          sent,
          sendStarted
        )
      );
    },
    sent,
  };
}

function recordingSession(
  sessionId: ReturnType<typeof parseHarnessSessionId>,
  _workspacePath: string,
  attempt: number,
  sent: string[],
  sendStarted?: Deferred.Deferred<void>
): HarnessSession {
  const oldTurnId = parseHarnessTurnId("turn-initial");
  const repairTurnId = parseHarnessTurnId(`turn-failure-repair-${attempt}`);
  const events: ReadonlyArray<HarnessEvent> = [
    {
      capabilities,
      kind: "sessionStarted",
      provider: descriptor,
      sessionId,
      state: "running",
    },
    { kind: "sessionRecovered", sessionId },
    { kind: "turnStarted", sessionId, turnId: oldTurnId },
    {
      kind: "turnCompleted",
      sessionId,
      status: "completed",
      turnId: oldTurnId,
    },
    { kind: "turnStarted", sessionId, turnId: repairTurnId },
    {
      chunk: "Bounded repair progress.",
      deltaKind: "message",
      itemId: parseHarnessItemId(`item-failure-repair-${attempt}`),
      kind: "itemDeltaRecorded",
      sessionId,
      turnId: repairTurnId,
    },
    {
      kind: "turnCompleted",
      sessionId,
      status: "completed",
      turnId: repairTurnId,
    },
  ];
  return {
    events: Stream.fromIterable(events),
    interrupt: Option.some(Effect.void),
    resolveInteraction: () => Effect.void,
    send: (input) =>
      Effect.gen(function* () {
        sent.push(input.text);
        if (sendStarted !== undefined) {
          yield* Deferred.succeed(sendStarted, undefined);
          return yield* Effect.never;
        }
        return undefined;
      }),
    snapshot: Effect.succeed(
      HarnessSessionSnapshot.make({
        capabilities,
        items: [],
        pendingInteractions: [],
        provider: descriptor,
        recovered: true,
        resolvedInteractions: [],
        sessionId,
        state: "running",
        turns: [],
      })
    ),
    steer: Option.none(),
  };
}
