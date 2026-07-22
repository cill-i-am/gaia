import { createHash } from "node:crypto";

import { NodeServices } from "@effect/platform-node";
import { assert, describe, it, layer } from "@effect/vitest";
import {
  MODEL_OUTPUT_CONTRACT_CWD_RUN_MARKER_V1,
  makeModelContextContentV1,
  makeModelContextManifestV1,
  makeModelInvocationManifestV1,
  parseRunId,
  renderModelInputV1,
} from "@gaia/core";
import { Effect, FileSystem } from "effect";

import { makeCodexHarnessConfig } from "./codex-harness.js";
import { GaiaRuntimeError } from "./errors.js";
import { makeProcessHarnessConfig } from "./harness.js";
import {
  decodeCodexBatchSemanticConfig,
  decodeProcessHarnessSemanticConfig,
  commitModelInvocationPair,
  loadModelInvocationPair,
  prepareSpecRunAcceptance,
} from "./model-invocation.js";
import { makeRunPaths } from "./paths.js";
import { localRunProfileSource } from "./run-profile.js";
import { runSpecFile } from "./workflows.js";

describe("model invocation acceptance preparation", () => {
  layer(NodeServices.layer)((it) => {
    it.effect(
      "rejects a secret-bearing spec before allocating run-store state",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectory({
            prefix: "gaia-preflight-",
          });
          const specPath = `${root}/spec.md`;
          yield* fs.writeFileString(
            specPath,
            "---\ntitle: Secret input\n---\n\nAuthorization: Bearer abc123\n"
          );

          const error = yield* Effect.flip(
            runSpecFile(specPath, { rootDirectory: root })
          );
          assert.instanceOf(error, GaiaRuntimeError);
          if (!(error instanceof GaiaRuntimeError)) return;
          assert.strictEqual(error.code, "AcceptedInputRejected");
          assert.notInclude(error.message, "abc123");
          assert.isFalse(yield* fs.exists(`${root}/.gaia`));
          yield* fs.writeFileString(
            specPath,
            "---\ntitle: Safe input\n---\n\nDo the bounded thing.\n"
          );
          const profilePath = `${root}/unsafe-profile.json`;
          yield* fs.writeFileString(
            profilePath,
            JSON.stringify({
              browser: {
                targetUrl: "https://example.test/evidence?token=abc123",
              },
              checks: { browserEvidence: "optional" },
              name: "unsafe-profile",
              version: 1,
            })
          );
          const unsafeOptions = [
            { browserEvidenceTargetUrl: "https://user:secret@example.test" },
            {
              browserEvidenceTargetUrl:
                "https://example.test/evidence?token=abc123",
            },
            {
              browserEvidenceTargetUrl:
                "https://example.test/callback?code=abc123",
            },
            {
              browserEvidenceTargetUrl:
                "https://example.test/?X-Amz-Security-Token=abc123",
            },
            {
              browserEvidenceTargetUrl:
                "https://example.test/?X-Amz-Signature=abc123",
            },
            {
              browserEvidenceTargetUrl:
                "https://example.test/#access_token=abc123",
            },
            {
              browserEvidenceTargetUrl: "https://example.test/auth/abc123",
            },
            {
              processHarness: makeProcessHarnessConfig("node", [
                "AUTH_TOKEN=abc123",
              ]),
            },
            {
              processHarness: makeProcessHarnessConfig("node", [
                "--password",
                "abc123",
              ]),
            },
            {
              processHarness: makeProcessHarnessConfig("node", [
                "--endpoint",
                "https://user:abc123@example.test/run",
              ]),
            },
            { runProfileSource: localRunProfileSource(profilePath) },
            {
              codexHarness: {
                config: makeCodexHarnessConfig({ model: "password=abc123" }),
              },
            },
            { skillInstaller: { command: "/tmp/.ssh/id_rsa" } },
          ] as const;
          for (const options of unsafeOptions) {
            const rejected = yield* Effect.flip(
              runSpecFile(specPath, { ...options, rootDirectory: root })
            );
            assert.instanceOf(rejected, GaiaRuntimeError);
            if (!(rejected instanceof GaiaRuntimeError)) continue;
            assert.strictEqual(rejected.code, "AcceptedInputRejected");
            assert.notInclude(rejected.message, "abc123");
            assert.isFalse(yield* fs.exists(`${root}/.gaia`));
          }
        })
    );

    it.effect(
      "reads and carries accepted spec/profile/skill semantics before mutation",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectory({ prefix: "gaia-prepare-" });
          const specPath = `${root}/spec.md`;
          yield* fs.writeFileString(
            specPath,
            "---\ntitle: Prepared input\n---\n\nDo the bounded thing.\n"
          );
          const prepared = yield* prepareSpecRunAcceptance(specPath, {
            browserEvidenceTargetUrl:
              "https://example.test/evidence?view=summary&tab=details",
          });
          yield* fs.writeFileString(specPath, "changed after acceptance");

          assert.include(prepared.input, "Do the bounded thing.");
          assert.strictEqual(
            prepared.explicitBrowserEvidenceTargetUrl,
            "https://example.test/evidence?view=summary&tab=details"
          );
          assert.strictEqual(prepared.runProfile.name, "default");
          assert.deepEqual(prepared.skillManifest.skills, []);
          assert.isFalse(yield* fs.exists(`${root}/.gaia`));
        })
    );

    it.effect(
      "adopts exact reservation-only and post-pair crash state without rewriting bytes",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectory({
            prefix: "gaia-pair-adopt-",
          });
          const runId = parseRunId("run-1234567890");
          const paths = yield* makeRunPaths(runId, { rootDirectory: root });
          yield* fs.makeDirectory(paths.root, { recursive: true });
          const pair = makePair(runId, "workerInitial");
          const episodeKey = "workerInitial";
          const episodeId = `episode1_${createHash("sha256")
            .update(`${runId}\0${episodeKey}`)
            .digest("hex")}`;
          const episodeDirectory = `${paths.modelInvocations}/${episodeId}`;
          const reservationPath = `${paths.modelInvocations}/.${episodeId}.reservation.json`;
          const reservationBody = `${JSON.stringify({
            episodeId,
            episodeKey,
            runId,
            version: 1,
          })}\n`;
          yield* fs.makeDirectory(episodeDirectory, { recursive: true });
          yield* fs.writeFileString(reservationPath, reservationBody);
          const reservationMtime = (yield* fs.stat(reservationPath)).mtime;
          assert.isFalse(
            yield* fs.exists(`${episodeDirectory}/context-manifest.json`)
          );
          assert.isFalse(
            yield* fs.exists(`${episodeDirectory}/invocation-manifest.json`)
          );

          const first = yield* commitModelInvocationPair({
            ...pair,
            episodeKey,
            paths,
          });
          assert.strictEqual(
            yield* fs.readFileString(reservationPath),
            reservationBody
          );
          assert.deepEqual(
            (yield* fs.stat(reservationPath)).mtime,
            reservationMtime
          );
          const contextPath = `${paths.root}/${first.contextRef.path}`;
          const invocationPath = `${paths.root}/${first.invocationRef.path}`;
          const before = {
            context: yield* fs.readFileString(contextPath),
            contextMtime: (yield* fs.stat(contextPath)).mtime,
            invocation: yield* fs.readFileString(invocationPath),
            invocationMtime: (yield* fs.stat(invocationPath)).mtime,
          };

          const adopted = yield* commitModelInvocationPair({
            ...pair,
            episodeKey,
            paths,
          });
          const loaded = yield* loadModelInvocationPair(paths, adopted);

          assert.deepEqual(adopted, first);
          assert.strictEqual(
            yield* fs.readFileString(contextPath),
            before.context
          );
          assert.strictEqual(
            yield* fs.readFileString(invocationPath),
            before.invocation
          );
          assert.deepEqual(
            (yield* fs.stat(contextPath)).mtime,
            before.contextMtime
          );
          assert.deepEqual(
            (yield* fs.stat(invocationPath)).mtime,
            before.invocationMtime
          );
          assert.strictEqual(
            loaded.rendered.text,
            pair.invocation.payload.rendered.text
          );

          for (const [rawRunId, invalidBodyKind] of [
            ["run-1234567891", "mismatched"],
            ["run-1234567892", "malformed"],
            ["run-1234567893", "nonCanonical"],
          ] as const) {
            const invalidRunId = parseRunId(rawRunId);
            const invalidPaths = yield* makeRunPaths(invalidRunId, {
              rootDirectory: root,
            });
            const invalidEpisodeId = `episode1_${createHash("sha256")
              .update(`${invalidRunId}\0${episodeKey}`)
              .digest("hex")}`;
            const invalidEpisodeDirectory = `${invalidPaths.modelInvocations}/${invalidEpisodeId}`;
            const invalidReservationPath = `${invalidPaths.modelInvocations}/.${invalidEpisodeId}.reservation.json`;
            const expectedReservation = {
              episodeId: invalidEpisodeId,
              episodeKey,
              runId: invalidRunId,
              version: 1,
            } as const;
            const invalidBody =
              invalidBodyKind === "mismatched"
                ? `${JSON.stringify({
                    ...expectedReservation,
                    runId: "run-0000000000",
                  })}\n`
                : invalidBodyKind === "malformed"
                  ? "{\n"
                  : `${JSON.stringify({
                      version: 1,
                      runId: invalidRunId,
                      episodeKey,
                      episodeId: invalidEpisodeId,
                    })}\n`;
            yield* fs.makeDirectory(invalidEpisodeDirectory, {
              recursive: true,
            });
            yield* fs.writeFileString(invalidReservationPath, invalidBody);

            const invalidReservation = yield* Effect.flip(
              commitModelInvocationPair({
                ...makePair(invalidRunId, episodeKey),
                episodeKey,
                paths: invalidPaths,
              })
            );
            assert.strictEqual(
              invalidReservation.code,
              "ModelInvocationPairConflict"
            );
          }

          const symlinkRunId = parseRunId("run-1234567894");
          const symlinkPaths = yield* makeRunPaths(symlinkRunId, {
            rootDirectory: root,
          });
          const symlinkEpisodeId = `episode1_${createHash("sha256")
            .update(`${symlinkRunId}\0${episodeKey}`)
            .digest("hex")}`;
          const symlinkEpisodeDirectory = `${symlinkPaths.modelInvocations}/${symlinkEpisodeId}`;
          const symlinkReservationPath = `${symlinkPaths.modelInvocations}/.${symlinkEpisodeId}.reservation.json`;
          const symlinkReservationBody = `${JSON.stringify({
            episodeId: symlinkEpisodeId,
            episodeKey,
            runId: symlinkRunId,
            version: 1,
          })}\n`;
          const outsideReservation = `${root}/outside-reservation.json`;
          yield* fs.makeDirectory(symlinkEpisodeDirectory, { recursive: true });
          yield* fs.writeFileString(outsideReservation, symlinkReservationBody);
          yield* fs.symlink(outsideReservation, symlinkReservationPath);

          const symlinkReservation = yield* Effect.flip(
            commitModelInvocationPair({
              ...makePair(symlinkRunId, episodeKey),
              episodeKey,
              paths: symlinkPaths,
            })
          );
          assert.strictEqual(
            symlinkReservation.code,
            "ModelInvocationPairConflict"
          );
          assert.isFalse(
            yield* fs.exists(`${symlinkEpisodeDirectory}/context-manifest.json`)
          );
          assert.isFalse(
            yield* fs.exists(
              `${symlinkEpisodeDirectory}/invocation-manifest.json`
            )
          );
        })
    );

    it.effect(
      "rejects orphans and parent or episode symlink escapes on commit and read",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectory({
            prefix: "gaia-pair-orphan-",
          });
          const runId = parseRunId("run-1234567890");
          const paths = yield* makeRunPaths(runId, { rootDirectory: root });
          const episodeKey = "workerInitial";
          const episodeId = `episode1_${createHash("sha256")
            .update(`${runId}\0${episodeKey}`)
            .digest("hex")}`;
          yield* fs.makeDirectory(`${paths.modelInvocations}/${episodeId}`, {
            recursive: true,
          });
          yield* fs.writeFileString(
            `${paths.modelInvocations}/${episodeId}/context-manifest.json`,
            "orphan\n"
          );
          const error = yield* Effect.flip(
            commitModelInvocationPair({
              ...makePair(runId, episodeKey),
              episodeKey,
              paths,
            })
          );
          assert.strictEqual(error.code, "ModelInvocationPairConflict");

          const parentEscapeRoot = yield* fs.makeTempDirectory({
            prefix: "gaia-pair-parent-escape-",
          });
          const parentEscapePaths = yield* makeRunPaths(runId, {
            rootDirectory: parentEscapeRoot,
          });
          const parentOutside = yield* fs.makeTempDirectory({
            prefix: "gaia-pair-parent-outside-",
          });
          yield* fs.makeDirectory(parentEscapePaths.root, { recursive: true });
          yield* fs.symlink(parentOutside, parentEscapePaths.modelInvocations);
          const parentCommit = yield* Effect.flip(
            commitModelInvocationPair({
              ...makePair(runId, episodeKey),
              episodeKey,
              paths: parentEscapePaths,
            })
          );
          assert.match(parentCommit.code, /ModelInvocation/u);
          assert.deepEqual(yield* fs.readDirectory(parentOutside), []);

          const episodeEscapeRoot = yield* fs.makeTempDirectory({
            prefix: "gaia-pair-episode-escape-",
          });
          const episodeEscapePaths = yield* makeRunPaths(runId, {
            rootDirectory: episodeEscapeRoot,
          });
          const episodeOutside = yield* fs.makeTempDirectory({
            prefix: "gaia-pair-episode-outside-",
          });
          yield* fs.makeDirectory(episodeEscapePaths.modelInvocations, {
            recursive: true,
          });
          yield* fs.symlink(
            episodeOutside,
            `${episodeEscapePaths.modelInvocations}/${episodeId}`
          );
          const episodeCommit = yield* Effect.flip(
            commitModelInvocationPair({
              ...makePair(runId, episodeKey),
              episodeKey,
              paths: episodeEscapePaths,
            })
          );
          assert.match(episodeCommit.code, /ModelInvocation/u);
          assert.deepEqual(yield* fs.readDirectory(episodeOutside), []);

          const sourceRoot = yield* fs.makeTempDirectory({
            prefix: "gaia-pair-read-source-",
          });
          const sourcePaths = yield* makeRunPaths(runId, {
            rootDirectory: sourceRoot,
          });
          yield* fs.makeDirectory(sourcePaths.root, { recursive: true });
          const sourcePair = yield* commitModelInvocationPair({
            ...makePair(runId, episodeKey),
            episodeKey,
            paths: sourcePaths,
          });
          const parentReadRoot = yield* fs.makeTempDirectory({
            prefix: "gaia-pair-parent-read-",
          });
          const parentReadPaths = yield* makeRunPaths(runId, {
            rootDirectory: parentReadRoot,
          });
          yield* fs.makeDirectory(parentReadPaths.root, { recursive: true });
          yield* fs.symlink(
            sourcePaths.modelInvocations,
            parentReadPaths.modelInvocations
          );
          const parentRead = yield* Effect.flip(
            loadModelInvocationPair(parentReadPaths, sourcePair)
          );
          assert.match(parentRead.code, /ModelInvocation/u);

          const episodeReadRoot = yield* fs.makeTempDirectory({
            prefix: "gaia-pair-episode-read-",
          });
          const episodeReadPaths = yield* makeRunPaths(runId, {
            rootDirectory: episodeReadRoot,
          });
          yield* fs.makeDirectory(episodeReadPaths.modelInvocations, {
            recursive: true,
          });
          yield* fs.symlink(
            `${sourcePaths.modelInvocations}/${episodeId}`,
            `${episodeReadPaths.modelInvocations}/${episodeId}`
          );
          const episodeRead = yield* Effect.flip(
            loadModelInvocationPair(episodeReadPaths, sourcePair)
          );
          assert.match(episodeRead.code, /ModelInvocation/u);
        })
    );
  });

  it("preserves documented Codex args in ordered semantic identity", () => {
    const prepared = decodeCodexBatchSemanticConfig({
      config: makeCodexHarnessConfig({
        command: "/usr/local/bin/codex",
        extraArgs: ["--color", "always", "--enable", "responses"],
      }),
    });
    assert.deepEqual(prepared?.extraArgs, [
      "--color",
      "always",
      "--enable",
      "responses",
    ]);
    assert.match(prepared?.semanticDigest ?? "", /^[a-f0-9]{64}$/u);
  });

  it("preserves the exact process command and ordered argument identity", () => {
    const prepared = decodeProcessHarnessSemanticConfig(
      makeProcessHarnessConfig("node", [
        "/tmp/process-harness.mjs",
        "--endpoint",
        "https://example.test/run?mode=safe",
      ])
    );
    assert.strictEqual(prepared?.command, "node");
    assert.deepEqual(prepared?.args, [
      "/tmp/process-harness.mjs",
      "--endpoint",
      "https://example.test/run?mode=safe",
    ]);
  });
});

function makePair(
  runId: ReturnType<typeof parseRunId>,
  episodeKey: "workerInitial"
) {
  const workspaceBinding = {
    canonicalRunStoreRootDigest: "a".repeat(64),
    canonicalWorkspacePathDigest: "b".repeat(64),
    runId,
    shape: ".gaia/runs/<runId>/workspace" as const,
    version: 1 as const,
    workspaceRole: "workerWorkspace" as const,
  };
  const content = makeModelContextContentV1({
    acceptedOutcomes: ["Return one bounded result."],
    authority: ["Edit only the accepted issue."],
    budget: { maxOutputBytes: 16_384, maxTurns: 1 },
    contentRefs: [],
    episodeRole: "workerInitial",
    instructions: ["Follow the accepted instructions."],
    nonGoals: ["Do not deploy."],
    outputContract: MODEL_OUTPUT_CONTRACT_CWD_RUN_MARKER_V1,
    planningFacts: ["events.jsonl is authoritative."],
    safeExclusions: ["credentials"],
    skills: ["effect-ts"],
    stops: ["Stop on scope drift."],
    taskInput: "Implement the accepted slice.",
    verificationCommands: ["pnpm test"],
  });
  const context = makeModelContextManifestV1({
    authoritativeRefs: [],
    binding: { episodeKey, runId },
    content,
    workspaceBinding,
  });
  return {
    context,
    invocation: makeModelInvocationManifestV1({
      acceptedProviderCapabilityObservation: "notApplicable",
      adapterInputClass: "deterministicInput",
      adapterSemantics: {
        kind: "deterministicFake",
        semanticDigest: "c".repeat(64),
      },
      authorityRef: { digest: "d".repeat(64), kind: "authority" },
      binding: context.payload.binding,
      budget: content.payload.budget,
      context,
      outputContract: content.payload.outputContract,
      rendered: renderModelInputV1(content),
      runContractRef: { digest: "e".repeat(64), kind: "runContract" },
      template: { id: "gaia.worker-input.v1", version: 1 },
      workspaceBinding,
    }),
  };
}
