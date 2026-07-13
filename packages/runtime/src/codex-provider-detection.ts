import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { HarnessDetection } from "@gaia/core";
import { Effect } from "effect";

import { supportedCodexCliVersion } from "./codex-app-server-protocol.js";
import { CodexHarnessCapabilities } from "./codex-harness-provider.js";

const execFileAsync = promisify(execFile);
const probeTimeoutMs = 5_000;
const probeMaxBufferBytes = 16_384;
const missingDetection = (): HarnessDetection => ({ state: "missing" });

export type CodexDetectionProbeRunner = (
  args: ReadonlyArray<string>
) => Effect.Effect<string, unknown>;

/** Build a bounded finite detector around an injectable safe command seam. */
export function makeCodexAppServerDetectionProbe(
  run: CodexDetectionProbeRunner
): Effect.Effect<HarnessDetection> {
  return Effect.gen(function* () {
    const versionExit = yield* Effect.exit(run(["--version"]));
    if (versionExit._tag === "Failure") return missingDetection();

    const match =
      /^codex-cli\s+(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\s*$/u.exec(
        versionExit.value
      );
    const actualVersion = (match?.[1] ?? "unknown").slice(0, 200);
    if (actualVersion !== supportedCodexCliVersion) {
      return {
        reason:
          "Installed Codex CLI version is incompatible with this Gaia adapter.",
        state: "incompatible",
        version: actualVersion,
      };
    }

    const loginExit = yield* Effect.exit(run(["login", "status"]));
    if (
      loginExit._tag === "Failure" ||
      !/^Logged in\b/u.test(loginExit.value.trim())
    ) {
      return {
        state: "authenticationRequired",
        version: actualVersion,
      };
    }

    return {
      auth: { state: "authenticated" },
      capabilities: CodexHarnessCapabilities,
      state: "available",
      version: actualVersion,
    };
  });
}

const runInstalledCodexProbe: CodexDetectionProbeRunner = (args) =>
  Effect.tryPromise({
    try: async () => {
      const result = await execFileAsync("codex", [...args], {
        maxBuffer: probeMaxBufferBytes,
        timeout: probeTimeoutMs,
      });
      return `${result.stdout}\n${result.stderr}`;
    },
    catch: () => undefined,
  });

/** Bounded local CLI probe that returns only safe finite detection states. */
export const detectInstalledCodexAppServer = makeCodexAppServerDetectionProbe(
  runInstalledCodexProbe
);
