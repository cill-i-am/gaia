import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  makeDockerSandboxCli,
  nodeDockerSandboxCliRunner,
  type DockerSandboxCliCommand,
} from "./docker-sandbox-cli.js";

describe("DockerSandboxCli", () => {
  it.effect("uses only the fixed argv algebra", () =>
    Effect.gen(function* () {
      const seen: DockerSandboxCliCommand[] = [];
      const cli = makeDockerSandboxCli((command) => {
        seen.push(command);
        return Effect.succeed({ exitCode: 0, stderr: "", stdout: "[]" });
      });

      yield* cli.version;
      yield* cli.list;
      yield* cli.create({
        name: "gaia-sandbox-1",
        templateReference:
          "docker/sandbox-templates:shell-docker@sha256:" + "1".repeat(64),
        workspace: "/tmp/gaia-run/workspace",
      });
      yield* cli.inspect("gaia-sandbox-1");
      yield* cli.inspectAuthority("gaia-sandbox-1");
      yield* cli.execute({
        argv: [
          "/usr/bin/env",
          "-i",
          "PATH=/usr/bin:/bin",
          "/usr/bin/printf",
          "%s",
          "ok\n",
        ],
        name: "gaia-sandbox-1",
        outputLimitBytes: 1_024,
        timeoutMs: 1_000,
        workdir: "/tmp/gaia-run/workspace",
      });
      yield* cli.stop("gaia-sandbox-1");
      yield* cli.remove("gaia-sandbox-1");

      assert.deepEqual(
        seen.map((entry) => entry.args),
        [
          ["version"],
          ["ls", "--json"],
          [
            "create",
            "shell",
            "/tmp/gaia-run/workspace",
            "--name",
            "gaia-sandbox-1",
            "--template",
            "docker/sandbox-templates:shell-docker@sha256:" + "1".repeat(64),
            "--quiet",
          ],
          ["inspect", "gaia-sandbox-1", "--json"],
          ["inspect", "gaia-sandbox-1"],
          [
            "exec",
            "--workdir",
            "/tmp/gaia-run/workspace",
            "gaia-sandbox-1",
            "/usr/bin/env",
            "-i",
            "PATH=/usr/bin:/bin",
            "/usr/bin/printf",
            "%s",
            "ok\n",
          ],
          ["stop", "gaia-sandbox-1"],
          ["rm", "--force", "gaia-sandbox-1"],
        ]
      );
    })
  );
});

describe("Docker Sandbox CLI child lifecycle", () => {
  it.effect(
    "bounds output at the request cap and reports structural overflow",
    () =>
      Effect.gen(function* () {
        const result = yield* nodeDockerSandboxCliRunner({
          args: ["-e", 'process.stdout.write("x".repeat(10_000))'],
          executable: process.execPath,
          outputLimitBytes: 16,
          timeoutMs: 5_000,
        });

        assert.strictEqual(result.terminationReason, "outputLimitExceeded");
        assert.isAtMost(Buffer.byteLength(result.stdout), 16);
        assert.isAbove(result.stdoutObservedByteCount ?? 0, 16);
      })
  );

  it.effect(
    "bounds provider calls and reports structural timeout after close",
    () =>
      Effect.gen(function* () {
        const startedAt = Date.now();
        const result = yield* nodeDockerSandboxCliRunner({
          args: ["-e", "setInterval(() => {}, 1_000)"],
          executable: process.execPath,
          outputLimitBytes: 16,
          timeoutMs: 25,
        });

        assert.strictEqual(result.terminationReason, "timedOut");
        assert.isBelow(Date.now() - startedAt, 5_000);
      })
  );

  it.effect("reports an externally interrupted child structurally", () =>
    Effect.gen(function* () {
      const result = yield* nodeDockerSandboxCliRunner({
        args: ["-e", 'process.kill(process.pid, "SIGTERM")'],
        executable: process.execPath,
        outputLimitBytes: 16,
        timeoutMs: 5_000,
      });

      assert.strictEqual(result.terminationReason, "interrupted");
    })
  );
});
