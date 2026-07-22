import { assert, describe, it } from "@effect/vitest";
import {
  HarnessCapabilities,
  HarnessExecutionSelection,
  HarnessProviderDescriptor,
  ResolvedHarnessExecution,
  parseHarnessProfileId,
  parseHarnessProviderId,
  type HarnessDetection,
} from "@gaia/core";
import { Effect, Schema } from "effect";

import {
  HarnessProfileNotFoundError,
  HarnessEnvironmentAssignmentError,
  issueDeliveryWorkerHarnessCapabilities,
  makeHarnessProviderRegistry,
} from "./harness-provider-registry.js";
import {
  HarnessCapabilityMismatchError,
  HarnessIncompatibleError,
  HarnessUnavailableError,
  type HarnessProvider,
} from "./harness-session.js";

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

describe("HarnessProvider registry", () => {
  it.effect(
    "resolves a detected compatible provider into a safe assignment",
    () =>
      Effect.gen(function* () {
        const provider = syntheticProvider({
          auth: { state: "authenticated" },
          capabilities,
          state: "available",
          version: "synthetic-1",
        });
        const registry = makeHarnessProviderRegistry([
          {
            profileId: parseHarnessProfileId("codexAppServer"),
            provider,
          },
        ]);

        const resolved = yield* registry.resolve(
          HarnessExecutionSelection.make({
            harnessProfileId: parseHarnessProfileId("codexAppServer"),
          }),
          issueDeliveryWorkerHarnessCapabilities
        );

        assert.strictEqual(resolved.provider, provider);
        assert.deepEqual(
          Schema.encodeSync(ResolvedHarnessExecution)(resolved.execution),
          {
            capabilities: Schema.encodeSync(HarnessCapabilities)(capabilities),
            executionMode: "local",
            harnessProfileId: "codexAppServer",
            provider: Schema.encodeSync(HarnessProviderDescriptor)(
              provider.descriptor
            ),
            version: "synthetic-1",
          }
        );
      })
  );

  it.effect(
    "fails closed for a production Codex registration without an environment assignment",
    () =>
      Effect.gen(function* () {
        const selection = HarnessExecutionSelection.make({
          harnessProfileId: parseHarnessProfileId("codexAppServer"),
        });
        const provider = {
          ...syntheticProvider({
            auth: { state: "authenticated" },
            capabilities,
            state: "available",
            version: "0.137.0",
          }),
          descriptor: HarnessProviderDescriptor.make({
            displayName: "Codex App Server",
            executionModes: ["local"],
            providerId: parseHarnessProviderId("codex-app-server"),
          }),
        };
        const error = yield* Effect.flip(
          makeHarnessProviderRegistry([
            { profileId: selection.harnessProfileId, provider },
          ]).resolve(selection, issueDeliveryWorkerHarnessCapabilities)
        );

        assert.isTrue(error instanceof HarnessEnvironmentAssignmentError);
      })
  );

  it.effect(
    "rejects missing profiles and capability mismatches without fallback",
    () =>
      Effect.gen(function* () {
        const selection = HarnessExecutionSelection.make({
          harnessProfileId: parseHarnessProfileId("codexAppServer"),
        });
        const missing = yield* Effect.flip(
          makeHarnessProviderRegistry([]).resolve(
            selection,
            issueDeliveryWorkerHarnessCapabilities
          )
        );
        const capabilityMismatch = yield* Effect.flip(
          makeHarnessProviderRegistry([
            {
              profileId: selection.harnessProfileId,
              provider: syntheticProvider({
                auth: { state: "authenticated" },
                capabilities: HarnessCapabilities.make({
                  ...capabilities,
                  interruption: false,
                }),
                state: "available",
                version: "synthetic-1",
              }),
            },
          ]).resolve(selection, issueDeliveryWorkerHarnessCapabilities)
        );

        assert.isTrue(missing instanceof HarnessProfileNotFoundError);
        assert.isTrue(
          capabilityMismatch instanceof HarnessCapabilityMismatchError
        );
      })
  );

  it.effect(
    "keeps unavailable, authentication-required, and incompatible detection finite",
    () =>
      Effect.gen(function* () {
        const selection = HarnessExecutionSelection.make({
          harnessProfileId: parseHarnessProfileId("codexAppServer"),
        });
        const resolveDetection = (detection: HarnessDetection) =>
          Effect.flip(
            makeHarnessProviderRegistry([
              {
                profileId: selection.harnessProfileId,
                provider: syntheticProvider(detection),
              },
            ]).resolve(selection, issueDeliveryWorkerHarnessCapabilities)
          );

        const missing = yield* resolveDetection({ state: "missing" });
        const authenticationRequired = yield* resolveDetection({
          state: "authenticationRequired",
          version: "synthetic-1",
        });
        const incompatible = yield* resolveDetection({
          reason: "Unsupported synthetic version.",
          state: "incompatible",
          version: "synthetic-0",
        });

        assert.isTrue(missing instanceof HarnessUnavailableError);
        assert.deepInclude(missing, { state: "missing" });
        assert.isTrue(
          authenticationRequired instanceof HarnessUnavailableError
        );
        assert.deepInclude(authenticationRequired, {
          state: "authenticationRequired",
        });
        assert.isTrue(incompatible instanceof HarnessIncompatibleError);
      })
  );
});

function syntheticProvider(detection: HarnessDetection): HarnessProvider {
  return {
    createSession: () => Effect.die("not used by registry test"),
    descriptor: HarnessProviderDescriptor.make({
      displayName: "Synthetic Harness",
      executionModes: ["local"],
      providerId: parseHarnessProviderId("synthetic"),
    }),
    detect: Effect.succeed(detection),
    resumeSession: () => Effect.die("not used by registry test"),
  };
}
