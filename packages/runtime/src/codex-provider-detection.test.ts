import { HarnessDetectionSchema } from "@gaia/core";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { makeCodexAppServerDetectionProbe } from "./codex-provider-detection.js";

const decodeDetection = Schema.decodeUnknownSync(HarnessDetectionSchema);

describe("Codex App Server detection", () => {
  it.effect("classifies bounded version and authentication probes without exposing output", () =>
    Effect.gen(function* () {
      const available = yield* makeCodexAppServerDetectionProbe((args) =>
        Effect.succeed(
          args[0] === "--version"
            ? "codex-cli 0.137.0\n"
            : "Logged in using ChatGPT\n",
        ),
      );
      const authRequired = yield* makeCodexAppServerDetectionProbe((args) =>
        args[0] === "--version"
          ? Effect.succeed("codex-cli 0.137.0\n")
          : Effect.fail("credential-value"),
      );
      const incompatible = yield* makeCodexAppServerDetectionProbe(() =>
        Effect.succeed("codex-cli 99.0.0 /usr/local/bin/codex\n"),
      );
      const unsafeVersion = yield* makeCodexAppServerDetectionProbe(() =>
        Effect.succeed("codex-cli credential-value\n"),
      );
      const missing = yield* makeCodexAppServerDetectionProbe(() =>
        Effect.fail("spawn output with credential-value"),
      );

      assert.strictEqual(decodeDetection(available).state, "available");
      assert.deepEqual(authRequired, {
        state: "authenticationRequired",
        version: "0.137.0",
      });
      assert.deepEqual(incompatible, {
        reason: "Installed Codex CLI version is incompatible with this Gaia adapter.",
        state: "incompatible",
        version: "unknown",
      });
      assert.deepEqual(unsafeVersion, {
        reason: "Installed Codex CLI version is incompatible with this Gaia adapter.",
        state: "incompatible",
        version: "unknown",
      });
      assert.deepEqual(missing, { state: "missing" });
      const serialized = JSON.stringify([
        authRequired,
        incompatible,
        unsafeVersion,
        missing,
      ]);
      assert.notInclude(serialized, "credential-value");
      assert.notInclude(serialized, "/usr/local/bin");
    }),
  );
});
