import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  makeDockerSandboxCli,
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
