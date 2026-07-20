import { createHash } from "node:crypto";

import { NodeServices } from "@effect/platform-node";
import { assert, describe, it, layer } from "@effect/vitest";
import {
  canonicalV1,
  deriveExplicitSpecItemDigest,
  deriveProofClaimId,
  encodeMergeDecisionV2Json,
  encodeRunContractJson,
  encodeRunProofResultJson,
  makeMergeDecisionV2,
  makeRunContract,
  makeRunProofResult,
  MergeDecisionBlockerV2,
  parseRunId,
  parseRunEventSequence,
  parseRunRelativeArtifactPath,
  workspaceStructuralDigestV1,
} from "@gaia/core";
import { Effect, FileSystem } from "effect";

import { GaiaRuntimeError } from "./errors.js";
import { loadRun, readEvents } from "./event-store.js";
import { makeRunPaths } from "./paths.js";

describe("event store persistence paths", () => {
  layer(NodeServices.layer)((it) => {
    it.effect(
      "reports invalid events.jsonl records through the typed error channel",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-event-store-",
          });
          const runId = parseRunId("run-EventPath1");
          const paths = yield* makeRunPaths(runId, { rootDirectory: cwd });
          yield* fs.makeDirectory(paths.root, { recursive: true });
          yield* fs.writeFileString(paths.events, "{ not json\n");

          const failure = yield* Effect.flip(readEvents(paths));

          assert.instanceOf(failure, GaiaRuntimeError);
          assert.strictEqual(failure.code, "InvalidJsonLine");
          assert.include(failure.message, "events.jsonl at line 1");
          assert.notInclude(failure.message, cwd);
        })
    );

    it.effect(
      "reports schema-invalid events.jsonl records through the typed error channel",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-event-store-",
          });
          const runId = parseRunId("run-EventPath2");
          const paths = yield* makeRunPaths(runId, { rootDirectory: cwd });
          yield* fs.makeDirectory(paths.root, { recursive: true });
          yield* fs.writeFileString(
            paths.events,
            `${JSON.stringify({ type: "RUN_CREATED" })}\n`
          );

          const failure = yield* Effect.flip(readEvents(paths));

          assert.instanceOf(failure, GaiaRuntimeError);
          assert.strictEqual(failure.code, "InvalidEventLine");
          assert.include(failure.message, "events.jsonl at line 1");
          assert.notInclude(failure.message, cwd);
        })
    );

    it.effect(
      "rejects literal JSONL that does not begin with RUN_CREATED",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-event-store-missing-created-",
          });
          const runId = parseRunId("run-NoCreated1");
          const paths = yield* makeRunPaths(runId, { rootDirectory: cwd });
          yield* fs.makeDirectory(paths.root, { recursive: true });
          yield* fs.writeFileString(
            paths.events,
            `${JSON.stringify({
              payload: {},
              runId,
              sequence: 1,
              timestamp: "2026-07-20T08:00:01.000Z",
              type: "WORKER_STARTED",
              version: 1,
            })}\n`
          );

          const failures = [
            yield* Effect.flip(readEvents(paths)),
            yield* Effect.flip(loadRun(paths)),
          ];
          for (const failure of failures) {
            assert.instanceOf(failure, GaiaRuntimeError);
            assert.strictEqual(failure.code, "InvalidRunEventHistory");
          }
        })
    );

    it.effect(
      "loads literal historical JSONL as no-contract completed-unverified and ignores stale snapshots",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-event-store-legacy-",
          });
          const runId = parseRunId("run-LegacyJs01");
          const paths = yield* makeRunPaths(runId, { rootDirectory: cwd });
          yield* fs.makeDirectory(paths.root, { recursive: true });
          const line = (
            sequence: number,
            type: string,
            payload: Readonly<Record<string, unknown>> = {}
          ) =>
            JSON.stringify({
              payload,
              runId,
              sequence,
              timestamp: `2026-07-19T12:00:0${sequence}.000Z`,
              type,
              version: 1,
            });
          yield* fs.writeFileString(
            paths.events,
            `${[
              line(1, "RUN_CREATED", { specPath: "input.md" }),
              line(2, "WORKSPACE_PREPARED", { workspacePath: "workspace" }),
              line(3, "WORKER_STARTED"),
              line(4, "WORKER_COMPLETED", {
                workerResultPath: "worker-result.json",
              }),
              line(5, "VERIFICATION_STARTED"),
              line(6, "VERIFICATION_COMPLETED", {
                verificationResultPath: "verification-result.json",
              }),
              line(7, "REPORT_STARTED"),
              line(8, "REPORT_COMPLETED", { reportPath: "report.md" }),
            ].join("\n")}\n`
          );
          yield* fs.writeFileString(
            paths.snapshots,
            '{"context":{"verification":"verified"},"version":1}\n'
          );

          const events = yield* readEvents(paths);
          const loaded = yield* loadRun(paths);

          assert.strictEqual(events.length, 8);
          assert.strictEqual(loaded.latestSnapshot?.state, "completed");
          assert.deepInclude(loaded.latestSnapshot?.context["runProof"], {
            aggregate: "completed-unverified",
            kind: "no-contract",
          });
        })
    );

    it.effect(
      "reports literal mixed legacy and contract proof history through the typed channel",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-event-store-mixed-",
          });
          const runId = parseRunId("run-MixedJson1");
          const paths = yield* makeRunPaths(runId, { rootDirectory: cwd });
          yield* fs.makeDirectory(paths.root, { recursive: true });
          const digest = workspaceStructuralDigestV1({
            entries: [],
            version: 1,
          });
          const contract = makeRunContract({
            acceptedOutcomes: [],
            baseDigest: digest,
            baseIdentity: { kind: "unversionedSnapshot", workspacePath: "." },
            nonGoals: [],
            proofClaims: [],
            runId,
            stopConditions: [],
            targetDigest: digest,
            targetIdentity: {
              kind: "unversionedWorkspace",
              workspacePath: ".",
            },
          });
          const line = (
            sequence: number,
            type: string,
            payload: Readonly<Record<string, unknown>> = {}
          ) =>
            JSON.stringify({
              payload,
              runId,
              sequence,
              timestamp: `2026-07-20T08:00:0${sequence}.000Z`,
              type,
              version: 1,
            });
          yield* fs.writeFileString(
            paths.events,
            `${[
              line(1, "RUN_CREATED", { specPath: "input.md" }),
              line(2, "RUN_CONTRACT_RECORDED", {
                contract: encodeRunContractJson(contract),
              }),
              line(3, "WORKSPACE_PREPARED", { workspacePath: "workspace" }),
              line(4, "WORKER_STARTED"),
              line(5, "WORKER_COMPLETED", {
                workerResultPath: "worker-result.json",
              }),
              line(6, "VERIFICATION_STARTED"),
              line(7, "VERIFICATION_COMPLETED", {
                verificationResultPath: "verification-result.json",
              }),
            ].join("\n")}\n`
          );

          const failures = [
            yield* Effect.flip(readEvents(paths)),
            yield* Effect.flip(loadRun(paths)),
          ];
          for (const failure of failures) {
            assert.instanceOf(failure, GaiaRuntimeError);
            assert.strictEqual(failure.code, "InvalidRunEventHistory");
          }
        })
    );

    it.effect(
      "rejects literal JSONL whose foreign V2 chain matches its own enclosing events",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-event-store-foreign-run-",
          });
          const historyRunId = parseRunId("run-HistJson01");
          const foreignRunId = parseRunId("run-ForJson001");
          const paths = yield* makeRunPaths(historyRunId, {
            rootDirectory: cwd,
          });
          yield* fs.makeDirectory(paths.root, { recursive: true });
          const blocker = MergeDecisionBlockerV2.make({
            action: "Record contract-bound proof.",
            kind: "run-contract-missing",
            summary: "The run contract is missing.",
          });
          const decision = makeMergeDecisionV2({
            blockerCount: 1,
            blockers: [blocker],
            contentAuthoritySequence: parseRunEventSequence(1),
            decidedAt: "2026-07-20T08:00:02.000Z",
            evidenceReviewPath:
              parseRunRelativeArtifactPath("evidence-review.md"),
            evidenceReviewerSessionPath: parseRunRelativeArtifactPath(
              "evidence-reviewer-session.json"
            ),
            nextAction: "resolve-blockers",
            planReviewPath: parseRunRelativeArtifactPath("plan-review.md"),
            planReviewerSessionPath: parseRunRelativeArtifactPath(
              "plan-reviewer-session.json"
            ),
            proof: {
              aggregate: "completed-unverified",
              kind: "noContract",
            },
            runId: foreignRunId,
            runProfilePath: parseRunRelativeArtifactPath("run-profile.json"),
            status: "blocked",
            version: 2,
          });
          const line = (
            sequence: number,
            type: string,
            payload: Readonly<Record<string, unknown>>,
            runId: typeof historyRunId
          ) =>
            JSON.stringify({
              payload,
              runId,
              sequence,
              timestamp: `2026-07-20T08:00:0${sequence}.000Z`,
              type,
              version: 1,
            });
          yield* fs.writeFileString(
            paths.events,
            `${[
              line(1, "RUN_CREATED", { specPath: "input.md" }, historyRunId),
              line(
                2,
                "DELIVERY_STARTED",
                {
                  delivery: {
                    baseBranch: "main",
                    baseRevision: "0".repeat(40),
                    headBranch: "gaia/foreign-json",
                    mode: "pullRequest",
                    remote: "origin",
                    stage: "delivering",
                  },
                },
                foreignRunId
              ),
              line(
                3,
                "MERGE_DECISION_RECORDED",
                {
                  decision: encodeMergeDecisionV2Json(decision),
                  mergeDecisionPath: "merge-decision.json",
                },
                foreignRunId
              ),
            ].join("\n")}\n`
          );

          const failures = [
            yield* Effect.flip(readEvents(paths)),
            yield* Effect.flip(loadRun(paths)),
          ];
          for (const failure of failures) {
            assert.instanceOf(failure, GaiaRuntimeError);
            assert.strictEqual(failure.code, "InvalidRunEventHistory");
          }
        })
    );

    it.effect(
      "rejects an internally consistent foreign history stored under another run",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-event-store-substituted-run-",
          });
          const requestedRunId = parseRunId("run-Requested1");
          const foreignRunId = parseRunId("run-Foreign001");
          const paths = yield* makeRunPaths(requestedRunId, {
            rootDirectory: cwd,
          });
          yield* fs.makeDirectory(paths.root, { recursive: true });
          yield* fs.writeFileString(
            paths.events,
            `${JSON.stringify({
              payload: { specPath: "foreign.md" },
              runId: foreignRunId,
              sequence: 1,
              timestamp: "2026-07-20T08:00:01.000Z",
              type: "RUN_CREATED",
              version: 1,
            })}\n`
          );

          const failures = [
            yield* Effect.flip(readEvents(paths)),
            yield* Effect.flip(loadRun(paths)),
          ];
          for (const failure of failures) {
            assert.instanceOf(failure, GaiaRuntimeError);
            assert.strictEqual(failure.code, "InvalidRunEventHistory");
          }
        })
    );

    it.effect(
      "rejects literal JSONL proof recorded before a worker execution boundary",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-event-store-pre-worker-proof-",
          });
          const runId = parseRunId("run-PreWork001");
          const paths = yield* makeRunPaths(runId, { rootDirectory: cwd });
          yield* fs.makeDirectory(paths.root, { recursive: true });
          const digest = workspaceStructuralDigestV1({
            entries: [],
            version: 1,
          });
          const contract = makeRunContract({
            acceptedOutcomes: [],
            baseDigest: digest,
            baseIdentity: { kind: "unversionedSnapshot", workspacePath: "." },
            nonGoals: [],
            proofClaims: [],
            runId,
            stopConditions: [],
            targetDigest: digest,
            targetIdentity: {
              kind: "unversionedWorkspace",
              workspacePath: ".",
            },
          });
          const result = makeRunProofResult({
            contract,
            observedTargetDigest: digest,
            recordedBy: {
              runId,
              sequence: 4,
              type: "RUN_PROOF_RESULT_RECORDED",
            },
            results: [],
            supplementalProtocolEvidence: [],
          });
          const line = (
            sequence: number,
            type: string,
            payload: Readonly<Record<string, unknown>>
          ) =>
            JSON.stringify({
              payload,
              runId,
              sequence,
              timestamp: `2026-07-20T08:00:0${sequence}.000Z`,
              type,
              version: 1,
            });
          yield* fs.writeFileString(
            paths.events,
            `${[
              line(1, "RUN_CREATED", { specPath: "input.md" }),
              line(2, "DELIVERY_STARTED", {
                delivery: {
                  baseBranch: "main",
                  baseRevision: "0".repeat(40),
                  headBranch: "gaia/pre-worker-proof",
                  mode: "pullRequest",
                  remote: "origin",
                  stage: "delivering",
                },
              }),
              line(3, "RUN_CONTRACT_RECORDED", {
                contract: encodeRunContractJson(contract),
              }),
              line(4, "RUN_PROOF_RESULT_RECORDED", {
                result: encodeRunProofResultJson(result),
                verificationResultPath: "verification-result.json",
              }),
            ].join("\n")}\n`
          );

          const failures = [
            yield* Effect.flip(readEvents(paths)),
            yield* Effect.flip(loadRun(paths)),
          ];
          for (const failure of failures) {
            assert.instanceOf(failure, GaiaRuntimeError);
            assert.strictEqual(failure.code, "InvalidRunEventHistory");
          }
        })
    );

    for (const requirement of ["required", "conditional"] as const) {
      it.effect(
        `rejects literal proof JSON that omits a ${requirement} contract claim`,
        () =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const cwd = yield* fs.makeTempDirectory({
              prefix: "gaia-event-store-proof-coverage-",
            });
            const runId = parseRunId(
              requirement === "required" ? "run-ReqOmit001" : "run-CondOmit01"
            );
            const paths = yield* makeRunPaths(runId, { rootDirectory: cwd });
            yield* fs.makeDirectory(paths.root, { recursive: true });
            const digest = workspaceStructuralDigestV1({
              entries: [],
              version: 1,
            });
            const claimStatement = `Verify the ${requirement} outcome.`;
            const claimSource = {
              itemDigest: deriveExplicitSpecItemDigest({
                section: "verificationChecks",
                statement: claimStatement,
              }),
              kind: "explicitSpecItem" as const,
              section: "verificationChecks" as const,
              specDigest: "3".repeat(64),
              version: 1 as const,
            };
            const claimId = deriveProofClaimId({
              authorityRequirements: ["harness"],
              kind: "command",
              requirement,
              source: claimSource,
              statement: claimStatement,
            });
            const contract = makeRunContract({
              acceptedOutcomes: [],
              baseDigest: digest,
              baseIdentity: {
                kind: "unversionedSnapshot",
                workspacePath: ".",
              },
              nonGoals: [],
              proofClaims: [
                {
                  authorityRequirements: ["harness"],
                  claimId,
                  kind: "command",
                  requirement,
                  source: claimSource,
                  statement: claimStatement,
                },
              ],
              runId,
              stopConditions: [],
              targetDigest: digest,
              targetIdentity: {
                kind: "unversionedWorkspace",
                workspacePath: ".",
              },
            });
            const complete = makeRunProofResult({
              contract,
              observedTargetDigest: digest,
              recordedBy: {
                runId,
                sequence: 7,
                type: "RUN_PROOF_RESULT_RECORDED",
              },
              results: [
                requirement === "required"
                  ? {
                      claimId,
                      evidence: [
                        {
                          artifactPath: "worker-result.json",
                          contentDigest: "4".repeat(64),
                          kind: "command",
                        },
                      ],
                      status: "passed",
                    }
                  : {
                      claimId,
                      reason: "The conditional claim does not apply.",
                      status: "not-applicable",
                    },
              ],
              supplementalProtocolEvidence: [],
            });
            const encoded = encodeRunProofResultJson(complete);
            if (
              typeof encoded !== "object" ||
              encoded === null ||
              Array.isArray(encoded)
            )
              throw new Error("Expected encoded RunProofResultV1 object.");
            const incompleteBase = {
              ...Object.fromEntries(
                Object.entries(encoded).filter(
                  ([key]) => key !== "resultDigest"
                )
              ),
              results: [],
            };
            const incomplete = {
              ...incompleteBase,
              resultDigest: createHash("sha256")
                .update(
                  canonicalV1("gaia.run-proof-result.v1", [incompleteBase])
                )
                .digest("hex"),
            };
            const line = (
              sequence: number,
              type: string,
              payload: Readonly<Record<string, unknown>> = {}
            ) =>
              JSON.stringify({
                payload,
                runId,
                sequence,
                timestamp: `2026-07-20T09:00:0${sequence}.000Z`,
                type,
                version: 1,
              });
            yield* fs.writeFileString(
              paths.events,
              `${[
                line(1, "RUN_CREATED", { specPath: "input.md" }),
                line(2, "RUN_CONTRACT_RECORDED", {
                  contract: encodeRunContractJson(contract),
                }),
                line(3, "WORKSPACE_PREPARED", {
                  workspacePath: "workspace",
                }),
                line(4, "WORKER_STARTED"),
                line(5, "WORKER_COMPLETED", {
                  workerResultPath: "worker-result.json",
                }),
                line(6, "VERIFICATION_STARTED"),
                line(7, "RUN_PROOF_RESULT_RECORDED", {
                  result: incomplete,
                  verificationResultPath: "verification-result.json",
                }),
              ].join("\n")}\n`
            );

            const failures = [
              yield* Effect.flip(readEvents(paths)),
              yield* Effect.flip(loadRun(paths)),
            ];
            for (const failure of failures) {
              assert.instanceOf(failure, GaiaRuntimeError);
              assert.strictEqual(failure.code, "InvalidRunEventHistory");
            }
          })
      );
    }
  });
});
