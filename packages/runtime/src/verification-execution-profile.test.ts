import { readFileSync } from "node:fs";

import { assert, describe, it } from "@effect/vitest";

import {
  parseVerificationExecutionProfile,
  verificationExecutionProfileDigests,
} from "./verification-execution-profile.js";

describe("VerificationExecutionProfileV1", () => {
  it("pins the sole production provider, image, policy, credentials, and executable", () => {
    const profile = parseVerificationExecutionProfile(
      JSON.parse(
        readFileSync(
          new URL("../../../profiles/claim-verification.json", import.meta.url),
          "utf8"
        )
      )
    );
    const digests = verificationExecutionProfileDigests(profile);

    assert.strictEqual(profile.provider.version, "0.35.0");
    assert.strictEqual(profile.policy.network, "denied");
    assert.strictEqual(profile.credentials.mode, "none");
    assert.strictEqual(profile.executables[0]?.executableId, "posix-printf-v1");
    assert.match(digests.profileDigest, /^[a-f0-9]{64}$/u);
  });

  it("rejects provider flags and excess source-selectable authority", () => {
    assert.throws(() =>
      parseVerificationExecutionProfile({
        ...JSON.parse(
          readFileSync(
            new URL(
              "../../../profiles/claim-verification.json",
              import.meta.url
            ),
            "utf8"
          )
        ),
        fallbackExecutable: "/bin/sh",
      })
    );
  });
});
