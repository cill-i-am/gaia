import { createHash } from "node:crypto";

import { canonicalV1 } from "@gaia/core";
import { Effect, FileSystem, Schema } from "effect";

import { RuntimePathSchema, type RuntimePath } from "./paths.js";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const imageDigest =
  "sha256:39cf20eca861ec92747487af6197f6d916f774bdb98245d267dbd8dfd3debb05" as const;
const templateReference =
  `docker/sandbox-templates:shell-docker@${imageDigest}` as const;

export class VerificationProviderProfileV1 extends Schema.Class<VerificationProviderProfileV1>(
  "VerificationProviderProfileV1"
)(
  {
    build: Schema.Literal("01e01520456e4126a9653471e7072e4d9b280321"),
    cliExecutableId: Schema.Literal("sbx-v0.35.0"),
    providerId: Schema.Literal("docker-sandboxes-sbx"),
    version: Schema.Literal("0.35.0"),
  },
  strict
) {}

export class VerificationExecutableProfileV1 extends Schema.Class<VerificationExecutableProfileV1>(
  "VerificationExecutableProfileV1"
)(
  {
    executableId: Schema.Literal("posix-printf-v1"),
    sandboxPath: Schema.Literal("/usr/bin/printf"),
  },
  strict
) {}

export class VerificationPolicyProfileV1 extends Schema.Class<VerificationPolicyProfileV1>(
  "VerificationPolicyProfileV1"
)(
  {
    activeAllowCount: Schema.Literal(0),
    network: Schema.Literal("denied"),
    policyId: Schema.Literal("local-deny-all-v1"),
    workspaceMount: Schema.Literal("direct-sole-read-write"),
  },
  strict
) {}

export class VerificationCredentialProfileV1 extends Schema.Class<VerificationCredentialProfileV1>(
  "VerificationCredentialProfileV1"
)(
  {
    credentialProfileId: Schema.Literal("credentials-none-env-i-v1"),
    environmentScrubExecutable: Schema.Literal("/usr/bin/env"),
    expectedCredentialLikeCount: Schema.Literal(0),
    inheritCommandEnvironment: Schema.Literal(false),
    minimalPath: Schema.Literal("/usr/bin:/bin"),
    mode: Schema.Literal("none"),
  },
  strict
) {}

/** Trusted checked-in profile for the sole GAIA-145 live adapter. */
export class VerificationExecutionProfileV1 extends Schema.Class<VerificationExecutionProfileV1>(
  "VerificationExecutionProfileV1"
)(
  {
    credentials: VerificationCredentialProfileV1,
    executables: Schema.Tuple([VerificationExecutableProfileV1]),
    imageDigest: Schema.Literal(imageDigest),
    policy: VerificationPolicyProfileV1,
    profileId: Schema.Literal("docker-sandbox-claim-verification-v1"),
    provider: VerificationProviderProfileV1,
    templateReference: Schema.Literal(templateReference),
    version: Schema.Literal(1),
  },
  strict
) {}

export const parseVerificationExecutionProfile = Schema.decodeUnknownSync(
  VerificationExecutionProfileV1
);

export class VerificationExecutionProfileReadError extends Schema.TaggedErrorClass<VerificationExecutionProfileReadError>()(
  "VerificationExecutionProfileReadError",
  {
    cause: Schema.optionalKey(Schema.Defect()),
    message: Schema.NonEmptyString,
    path: RuntimePathSchema,
  }
) {}

export function readVerificationExecutionProfile(path: RuntimePath) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const body = yield* fs.readFileString(path);
    return yield* Effect.try({
      catch: (cause) =>
        new VerificationExecutionProfileReadError({
          cause,
          message: "Trusted verification execution profile is invalid.",
          path,
        }),
      try: () => parseVerificationExecutionProfile(JSON.parse(body)),
    });
  }).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(
        new VerificationExecutionProfileReadError({
          cause,
          message: "Trusted verification execution profile could not be read.",
          path,
        })
      )
    )
  );
}

export function verificationExecutionProfileDigests(
  profile: VerificationExecutionProfileV1
) {
  return {
    credentialProfileDigest: digest("gaia.verification-credentials.v1", [
      profile.credentials,
    ]),
    policyDigest: digest("gaia.verification-policy.v1", [profile.policy]),
    profileDigest: digest("gaia.verification-execution-profile.v1", [profile]),
  };
}

function digest(domain: string, fields: readonly unknown[]) {
  return createHash("sha256").update(canonicalV1(domain, fields)).digest("hex");
}
