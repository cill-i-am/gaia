import { NodeServices } from "@effect/platform-node";
import type { HarnessDetection } from "@gaia/core";
import { Effect, Fiber, Ref, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { supportedCodexCliVersion } from "./codex-app-server-protocol.js";
import { CodexHarnessCapabilities } from "./codex-harness-provider.js";

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

/** Build the live bounded detector from the shared Effect process capability. */
export function makeInstalledCodexAppServerDetection(input: {
  readonly command: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
}) {
  const run: CodexDetectionProbeRunner = (args) =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* input.spawner.spawn(
          ChildProcess.make(input.command, args, {
            cwd: input.cwd,
            env: { ...input.env },
            extendEnv: false,
            stderr: "pipe",
            stdin: "ignore",
            stdout: "pipe",
          })
        );
        const observedBytes = yield* Ref.make(0);
        const collectBounded = (stream: Stream.Stream<Uint8Array, unknown>) =>
          Stream.runFoldEffect(
            stream,
            () => [] as Array<Uint8Array>,
            (chunks, chunk) =>
              Ref.modify(observedBytes, (current) => {
                const next = current + chunk.byteLength;
                return [next <= probeMaxBufferBytes, next] as const;
              }).pipe(
                Effect.flatMap((withinLimit) =>
                  withinLimit
                    ? Effect.succeed([...chunks, chunk])
                    : Effect.fail(undefined)
                )
              )
          ).pipe(
            Effect.map((chunks) => Buffer.concat(chunks).toString("utf8"))
          );
        const stdoutFiber = yield* collectBounded(handle.stdout).pipe(
          Effect.forkScoped
        );
        const stderrFiber = yield* collectBounded(handle.stderr).pipe(
          Effect.forkScoped
        );
        const exitCode = yield* handle.exitCode;
        const stdout = yield* Fiber.join(stdoutFiber);
        const stderr = yield* Fiber.join(stderrFiber);
        const output = `${stdout}\n${stderr}`;
        if (Number(exitCode) !== 0) return yield* Effect.fail(undefined);
        return output;
      })
    ).pipe(Effect.timeout(`${probeTimeoutMs} millis`));
  return makeCodexAppServerDetectionProbe(run);
}

/** Bounded local CLI probe that returns only safe finite detection states. */
export const detectInstalledCodexAppServer = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* makeInstalledCodexAppServerDetection({
    command: "codex",
    cwd: ".",
    env: {},
    spawner,
  });
}).pipe(Effect.provide(NodeServices.layer));
