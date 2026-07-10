import {
  HarnessProfileIdSchema,
  ResolvedHarnessExecution,
  missingHarnessCapabilities,
  type HarnessCapability,
  type HarnessExecutionSelection,
  type HarnessProfileId,
} from "@gaia/core";
import { Effect, Schema } from "effect";
import {
  HarnessCapabilityMismatchError,
  HarnessIncompatibleError,
  HarnessUnavailableError,
  type HarnessProvider,
} from "./harness-session.js";

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
  { harnessProfileId: HarnessProfileIdSchema },
) {}

/** A detected compatible provider plus the safe immutable run assignment. */
export type ResolvedHarnessProvider = {
  readonly execution: ResolvedHarnessExecution;
  readonly provider: HarnessProvider;
};

/** Static profile-to-provider binding used by the local execution runtime. */
export type HarnessProviderRegistration = {
  readonly profileId: HarnessProfileId;
  readonly provider: HarnessProvider;
};

/** Build the bounded static provider registry for local issue delivery. */
export function makeHarnessProviderRegistry(
  registrations: ReadonlyArray<HarnessProviderRegistration>,
) {
  const providers = new Map(
    registrations.map(({ profileId, provider }) => [profileId, provider]),
  );

  return {
    resolve: (
      selection: HarnessExecutionSelection,
      requiredCapabilities: ReadonlyArray<HarnessCapability>,
    ) =>
      Effect.gen(function* () {
        const provider = providers.get(selection.harnessProfileId);
        if (provider === undefined) {
          return yield* new HarnessProfileNotFoundError({
            harnessProfileId: selection.harnessProfileId,
          });
        }

        const detection = yield* provider.detect;
        switch (detection.state) {
          case "available": {
            const missing = missingHarnessCapabilities(
              detection.capabilities,
              requiredCapabilities,
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
            return {
              execution: ResolvedHarnessExecution.make({
                capabilities: detection.capabilities,
                executionMode: "local",
                harnessProfileId: selection.harnessProfileId,
                provider: provider.descriptor,
                version: detection.version,
              }),
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
