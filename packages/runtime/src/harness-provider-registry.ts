import {
  HarnessEnvironmentAssignmentV1,
  HarnessProfileIdSchema,
  ResolvedHarnessExecution,
  missingHarnessCapabilities,
  type HarnessCapabilities,
  type HarnessCapability,
  type HarnessExecutionSelection,
  type HarnessProfileId,
  type HarnessProviderDescriptor,
} from "@gaia/core";
import { Effect, Schema } from "effect";

import {
  HarnessCapabilityMismatchError,
  HarnessIncompatibleError,
  HarnessUnavailableError,
  type HarnessProvider,
} from "./harness-session.js";
import type { HarnessLaunchObservationService } from "./worker-runtime-environment.js";

/** Capabilities required by the issue-delivery worker role in this slice. */
export const issueDeliveryWorkerHarnessCapabilities = [
  "streamingMessages",
  "resumableSessions",
  "fileChangeEvents",
  "interruption",
] as const satisfies ReadonlyArray<HarnessCapability>;

/** Fixed profile has no registered provider in the active runtime composition. */
export class HarnessProfileNotFoundError extends Schema.TaggedErrorClass<HarnessProfileNotFoundError>()(
  "HarnessProfileNotFoundError",
  { harnessProfileId: HarnessProfileIdSchema }
) {}

/** A detected compatible provider plus the safe immutable run assignment. */
export type ResolvedHarnessProvider = {
  readonly execution: ResolvedHarnessExecution;
  readonly launchObservation?: HarnessLaunchObservationService["Service"];
  readonly provider: HarnessProvider;
};

/** Static profile-to-provider binding used by the local execution runtime. */
export type HarnessProviderRegistration = {
  readonly environmentAssignment?: (input: {
    readonly capabilities: HarnessCapabilities;
    readonly provider: HarnessProviderDescriptor;
    readonly version: string;
  }) => Effect.Effect<HarnessEnvironmentAssignmentV1, unknown>;
  readonly launchObservation?: HarnessLaunchObservationService["Service"];
  readonly profileId: HarnessProfileId;
  readonly provider: HarnessProvider;
};

/** New production Codex acceptance is missing its complete environment proof. */
export class HarnessEnvironmentAssignmentError extends Schema.TaggedErrorClass<HarnessEnvironmentAssignmentError>()(
  "HarnessEnvironmentAssignmentError",
  {
    message: Schema.Literal(
      "Production harness environment assignment is unavailable."
    ),
  }
) {}

/** Build the bounded static provider registry for local issue delivery. */
export function makeHarnessProviderRegistry(
  registrations: ReadonlyArray<HarnessProviderRegistration>
) {
  const providers = new Map(
    registrations.map((entry) => [entry.profileId, entry])
  );

  return {
    resolve: (
      selection: HarnessExecutionSelection,
      requiredCapabilities: ReadonlyArray<HarnessCapability>
    ) =>
      Effect.gen(function* () {
        const registration = providers.get(selection.harnessProfileId);
        if (registration === undefined) {
          return yield* new HarnessProfileNotFoundError({
            harnessProfileId: selection.harnessProfileId,
          });
        }
        const { provider } = registration;

        const detection = yield* provider.detect;
        switch (detection.state) {
          case "available": {
            const missing = missingHarnessCapabilities(
              detection.capabilities,
              requiredCapabilities
            );
            if (missing.length > 0) {
              return yield* new HarnessCapabilityMismatchError({
                missing,
                providerId: provider.descriptor.providerId,
              });
            }
            if (!provider.descriptor.executionModes.includes("local")) {
              return yield* new HarnessIncompatibleError({
                message: "Harness profile does not support local execution.",
                providerId: provider.descriptor.providerId,
                version: detection.version,
              });
            }
            const environmentAssignment =
              registration.environmentAssignment === undefined
                ? undefined
                : yield* registration.environmentAssignment({
                    capabilities: detection.capabilities,
                    provider: provider.descriptor,
                    version: detection.version,
                  });
            if (
              provider.descriptor.providerId === "codex-app-server" &&
              environmentAssignment === undefined
            )
              return yield* new HarnessEnvironmentAssignmentError({
                message:
                  "Production harness environment assignment is unavailable.",
              });
            return {
              execution: ResolvedHarnessExecution.make({
                capabilities: detection.capabilities,
                ...(environmentAssignment === undefined
                  ? {}
                  : { environmentAssignment }),
                executionMode: "local",
                harnessProfileId: selection.harnessProfileId,
                provider: provider.descriptor,
                version: detection.version,
              }),
              ...(registration.launchObservation === undefined
                ? {}
                : { launchObservation: registration.launchObservation }),
              provider,
            } satisfies ResolvedHarnessProvider;
          }
          case "missing":
            return yield* new HarnessUnavailableError({
              providerId: provider.descriptor.providerId,
              state: "missing",
            });
          case "authenticationRequired":
            return yield* new HarnessUnavailableError({
              providerId: provider.descriptor.providerId,
              state: "authenticationRequired",
              version: detection.version,
            });
          case "incompatible":
            return yield* new HarnessIncompatibleError({
              message: detection.reason,
              providerId: provider.descriptor.providerId,
              version: detection.version,
            });
        }
      }),
  } as const;
}

/** Runtime registry surface consumed by run acceptance and restart recovery. */
export type HarnessProviderRegistry = ReturnType<
  typeof makeHarnessProviderRegistry
>;
