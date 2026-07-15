import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  resolveDeliveryGitHubRepository,
  resolveDeliveryProvenance,
  type GitDeliveryCommandInput,
  type GitDeliveryCommandResult,
  type GitDeliveryCommandRunner,
} from "./git-delivery.js";

const baseRevision = "a".repeat(40);

describe("git delivery boundary parsing", () => {
  it.effect(
    "parses GitHub remote output into a public owner/repository identity",
    () =>
      Effect.gen(function* () {
        const https = yield* resolveDeliveryGitHubRepository({
          commandRunner: remoteRunner(
            "https://github.com/cill-i-am/gaia.git\n"
          ),
          rootDirectory: "/repo",
        });
        const ssh = yield* resolveDeliveryGitHubRepository({
          commandRunner: remoteRunner("git@github.com:cill-i-am/gaia.git\n"),
          rootDirectory: "/repo",
        });
        const nonGitHub = yield* resolveDeliveryGitHubRepository({
          commandRunner: remoteRunner(
            "https://gitlab.com/cill-i-am/gaia.git\n"
          ),
          rootDirectory: "/repo",
        });

        assert.strictEqual(https, "cill-i-am/gaia");
        assert.strictEqual(ssh, "cill-i-am/gaia");
        assert.isUndefined(nonGitHub);
      })
  );

  it.effect(
    "resolves provenance from raw git output only after exact SHA validation",
    () =>
      Effect.gen(function* () {
        const commands: Array<ReadonlyArray<string>> = [];
        const provenance = yield* resolveDeliveryProvenance(
          "run-1234567890",
          {
            commandRunner: provenanceRunner(commands, baseRevision),
            rootDirectory: "/repo",
          },
          {
            baseBranch: "main",
            headBranch: "gaia/run-1234567890",
            remote: "origin",
            version: 1,
          }
        );

        assert.deepEqual(provenance, {
          baseBranch: "main",
          baseRevision,
          headBranch: "gaia/run-1234567890",
          mode: "pullRequest",
          remote: "origin",
        });
      })
  );

  it.effect("fails closed when git returns a non-canonical base revision", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        resolveDeliveryProvenance(
          "run-1234567890",
          {
            commandRunner: provenanceRunner([], "not-a-git-sha"),
            rootDirectory: "/repo",
          },
          {
            baseBranch: "main",
            headBranch: "gaia/run-1234567890",
            remote: "origin",
            version: 1,
          }
        )
      );

      assert.strictEqual(exit._tag, "Failure");
    })
  );
});

function remoteRunner(stdout: string): GitDeliveryCommandRunner {
  return commandRunner(({ args }) => {
    assert.deepEqual(args, ["remote", "get-url", "origin"]);
    return { stderr: "", stdout };
  });
}

function provenanceRunner(
  commands: Array<ReadonlyArray<string>>,
  revisionStdout: string
): GitDeliveryCommandRunner {
  return commandRunner(({ args }) => {
    commands.push(args);
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
      return { stderr: "", stdout: "/repo\n" };
    }
    if (args[0] === "remote") {
      return { stderr: "", stdout: "https://github.com/cill-i-am/gaia.git\n" };
    }
    if (args[0] === "fetch") {
      return { stderr: "", stdout: "" };
    }
    if (args[0] === "rev-parse") {
      return { stderr: "", stdout: `${revisionStdout}\n` };
    }
    if (args[0] === "check-ref-format") {
      return { stderr: "", stdout: "" };
    }
    return { stderr: "", stdout: "" };
  });
}

function commandRunner(
  run: (input: GitDeliveryCommandInput) => GitDeliveryCommandResult
): GitDeliveryCommandRunner {
  return (input) => Effect.succeed(run(input));
}
