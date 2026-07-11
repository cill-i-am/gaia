import { NodeServices } from "@effect/platform-node";
import { assert, describe, it, layer } from "@effect/vitest";
import {
  DeliveryPublicationIntent,
  encodeDeliveryPublicationJson,
  parseRunId,
} from "@gaia/core";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { Effect, FileSystem } from "effect";
import { appendEvent, readEvents } from "./event-store.js";
import {
  prepareDeliveryWorktree,
  type DeliveryProvenance,
  type GitDeliveryCommandRunner,
} from "./git-delivery.js";
import {
  nodeGitHubCommandRunner,
  type CommandExecutionResult,
  type GitHubCommandInput,
  type GitHubCommandRunner,
} from "./github-publisher.js";
import { codexAppServerHarnessName, HarnessRunResult } from "./harness.js";
import { makeRunPaths, type RunPaths } from "./paths.js";
import { productOnlyWorkspaceDiff } from "./workspace-snapshot.js";
import {
  publishReadyDeliveryRun,
  retryFailedDeliveryPublication,
} from "./delivery-publication.js";
import { GaiaRuntimeError, makeRuntimeError } from "./errors.js";

const baseRevision = "a".repeat(40);
const commitSha = "c".repeat(40);
const treeSha = "d".repeat(40);

describe("delivery publication", () => {
  layer(NodeServices.layer)((it) => {
    it.effect("publishes one owned draft PR from the verified worktree", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const rootDirectory = yield* fs.makeTempDirectory({
          prefix: "gaia-delivery-publication-",
        });
        const runId = parseRunId("run-V7kP9sQ2xY");
        const paths = yield* makeRunPaths(runId, { rootDirectory });
        const provenance: DeliveryProvenance = {
          baseBranch: "main",
          baseRevision,
          headBranch: `gaia/${runId}`,
          mode: "pullRequest",
          remote: "origin",
        };
        const deliveryGitCommandRunner = worktreeRunner(rootDirectory);
        yield* fs.makeDirectory(paths.root, { recursive: true });
        yield* prepareDeliveryWorktree({
          options: { commandRunner: deliveryGitCommandRunner, rootDirectory },
          paths,
          provenance,
        });
        yield* fs.makeDirectory(`${paths.workspace}/src`, { recursive: true });
        yield* fs.writeFileString(
          `${paths.workspace}/src/feature.ts`,
          "export const delivered = true;\n",
        );
        yield* fs.writeFileString(paths.workspaceOutput, "harness only\n");
        yield* writeReadyRun(runId, paths, provenance);

        const commands: Array<GitHubCommandInput> = [];
        const runner = publicationRunner(commands, paths.root, provenance, {
          verifyDurableMutationIntents: true,
        });
        const publication = yield* publishReadyDeliveryRun(runId, {
          commandRunner: runner,
          deliveryGitCommandRunner,
          rootDirectory,
        });
        const events = yield* readEvents(paths);

        assert.strictEqual(publication.state, "confirmed");
        if (publication.state !== "confirmed") {
          return assert.fail("Expected a confirmed delivery publication.");
        }
        assert.strictEqual(publication.commitSha, commitSha);
        assert.strictEqual(publication.headSha, commitSha);
        assert.strictEqual(publication.prNumber, 91);
        assert.strictEqual(
          publication.prUrl,
          "https://github.com/cill-i-am/gaia/pull/91",
        );
        assert.deepEqual(publication.sourcePaths, ["src/feature.ts"]);
        assert.deepEqual(
          events.slice(7).map(({ type }) => type),
          [
            "DELIVERY_PUBLICATION_INTENT_RECORDED",
            "DELIVERY_PUBLICATION_INTENT_RECORDED",
            "DELIVERY_PUBLICATION_ATTEMPTED",
            "DELIVERY_PUBLICATION_OUTCOME_UNKNOWN",
            "DELIVERY_PUBLICATION_ATTEMPTED",
            "DELIVERY_PUBLICATION_OUTCOME_UNKNOWN",
            "DELIVERY_PUBLICATION_CONFIRMED",
          ],
        );
        const add = commands.find(
          ({ command, args }) =>
            command === "git" && args[0] === "add",
        );
        assert.deepEqual(add?.args, ["add", "-A", "--", "src/feature.ts"]);
        const commit = commands.find(
          ({ command, args }) =>
            command === "git" && args.includes("commit"),
        );
        assert.strictEqual(commit?.env?.GIT_AUTHOR_NAME, "Gaia Delivery");
        assert.strictEqual(commit?.env?.GIT_AUTHOR_EMAIL, "delivery@gaia.local");
        assert.strictEqual(commit?.env?.GIT_COMMITTER_NAME, "Gaia Delivery");
        assert.strictEqual(
          commit?.env?.GIT_COMMITTER_EMAIL,
          "delivery@gaia.local",
        );
        assert.strictEqual(
          commit?.env?.GIT_AUTHOR_DATE,
          commit?.env?.GIT_COMMITTER_DATE,
        );
        assert.isTrue(
          commands.some(
            ({ command, args }) =>
              command === "git" &&
              args.includes(
                `--force-with-lease=refs/heads/${provenance.headBranch}:`,
              ),
          ),
        );
        assert.isFalse(
          commands.some(({ args }) => args.includes("checkout")),
        );
        const body = yield* fs.readFileString(paths.deliveryPullRequestBody);
        assert.include(body, "<!-- gaia-delivery:v1");
        assert.include(body, '"src/feature.ts"');
        assert.notInclude(body, "harness only");
        assert.notInclude(body, rootDirectory);
      }),
    );

    it.effect("records unknown after an unreadable push outcome and never pushes again", () =>
      Effect.gen(function* () {
        const fixture = yield* readyFixture();
        const commands: Array<GitHubCommandInput> = [];
        const runner = publicationRunner(
          commands,
          fixture.paths.root,
          fixture.provenance,
          { remoteUnreadableAfterPush: true },
        );

        const first = yield* publishReadyDeliveryRun(fixture.runId, {
          commandRunner: runner,
          deliveryGitCommandRunner: fixture.deliveryGitCommandRunner,
          rootDirectory: fixture.rootDirectory,
        });
        const second = yield* publishReadyDeliveryRun(fixture.runId, {
          commandRunner: runner,
          deliveryGitCommandRunner: fixture.deliveryGitCommandRunner,
          rootDirectory: fixture.rootDirectory,
        });

        assert.strictEqual(first.state, "outcomeUnknown");
        assert.strictEqual(second.state, "outcomeUnknown");
        assert.strictEqual(
          commands.filter(
            ({ command, args }) => command === "git" && args[0] === "push",
          ).length,
          1,
        );
        assert.strictEqual(
          commands.filter(
            ({ command, args }) =>
              command === "gh" && args[0] === "pr" && args[1] === "create",
          ).length,
          0,
        );
      }),
    );

    it.effect("does not repeat an unconfirmed PR create and reconciles it to failed", () =>
      Effect.gen(function* () {
        const fixture = yield* readyFixture();
        const commands: Array<GitHubCommandInput> = [];
        const runner = publicationRunner(
          commands,
          fixture.paths.root,
          fixture.provenance,
          { prCreateUnconfirmed: true },
        );

        const first = yield* publishReadyDeliveryRun(fixture.runId, {
          commandRunner: runner,
          deliveryGitCommandRunner: fixture.deliveryGitCommandRunner,
          rootDirectory: fixture.rootDirectory,
        });
        const second = yield* publishReadyDeliveryRun(fixture.runId, {
          commandRunner: runner,
          deliveryGitCommandRunner: fixture.deliveryGitCommandRunner,
          rootDirectory: fixture.rootDirectory,
        });

        assert.strictEqual(first.state, "outcomeUnknown");
        assert.strictEqual(second.state, "failed");
        if (second.state !== "failed") {
          return assert.fail("Expected exact reconciliation to fail definitively.");
        }
        assert.strictEqual(second.code, "DeliveryPullRequestNotCreated");
        assert.strictEqual(
          commands.filter(
            ({ command, args }) =>
              command === "gh" && args[0] === "pr" && args[1] === "create",
          ).length,
          1,
        );
      }),
    );

    it.effect("retries a definitive recoverable failure as a new owned operation", () =>
      Effect.gen(function* () {
        const fixture = yield* readyFixture();
        const commands: Array<GitHubCommandInput> = [];
        const runner = publicationRunner(
          commands,
          fixture.paths.root,
          fixture.provenance,
          { confirmPrOnCreateAttempt: 2 },
        );

        const unknown = yield* publishReadyDeliveryRun(fixture.runId, {
          commandRunner: runner,
          deliveryGitCommandRunner: fixture.deliveryGitCommandRunner,
          rootDirectory: fixture.rootDirectory,
        });
        const failed = yield* publishReadyDeliveryRun(fixture.runId, {
          commandRunner: runner,
          deliveryGitCommandRunner: fixture.deliveryGitCommandRunner,
          rootDirectory: fixture.rootDirectory,
        });
        const retried = yield* retryFailedDeliveryPublication(fixture.runId, {
          commandRunner: runner,
          deliveryGitCommandRunner: fixture.deliveryGitCommandRunner,
          rootDirectory: fixture.rootDirectory,
        });

        assert.strictEqual(unknown.state, "outcomeUnknown");
        assert.strictEqual(failed.state, "failed");
        assert.strictEqual(retried.state, "confirmed");
        assert.notStrictEqual(retried.operationId, failed.operationId);
        assert.strictEqual(
          commands.filter(
            ({ command, args }) => command === "git" && args[0] === "push",
          ).length,
          1,
        );
        assert.strictEqual(
          commands.filter(
            ({ command, args }) =>
              command === "gh" && args[0] === "pr" && args[1] === "create",
          ).length,
          2,
        );
      }),
    );

    it.effect("fails closed on malformed NUL-delimited git paths before mutation", () =>
      Effect.gen(function* () {
        const fixture = yield* readyFixture();
        const commands: Array<GitHubCommandInput> = [];
        const error = yield* Effect.flip(
          publishReadyDeliveryRun(fixture.runId, {
            commandRunner: publicationRunner(
              commands,
              fixture.paths.root,
              fixture.provenance,
              { diffOutput: "M\0src/feature.ts" },
            ),
            deliveryGitCommandRunner: fixture.deliveryGitCommandRunner,
            rootDirectory: fixture.rootDirectory,
          }),
        );

        assert.instanceOf(error, GaiaRuntimeError);
        assert.strictEqual(error.code, "DeliveryGitPathOutputInvalid");
        assert.isFalse(
          commands.some(({ args }) =>
            args.includes("commit") || args[0] === "push"),
        );
        assert.strictEqual(
          (yield* readEvents(fixture.paths)).at(-1)?.type,
          "DELIVERY_READY_TO_PUBLISH",
        );
      }),
    );

    it.effect("refuses an unexpected remote head observed after a lease push", () =>
      Effect.gen(function* () {
        const fixture = yield* readyFixture();
        const commands: Array<GitHubCommandInput> = [];
        const publication = yield* publishReadyDeliveryRun(fixture.runId, {
          commandRunner: publicationRunner(
            commands,
            fixture.paths.root,
            fixture.provenance,
            { pushedRemoteHead: "e".repeat(40) },
          ),
          deliveryGitCommandRunner: fixture.deliveryGitCommandRunner,
          rootDirectory: fixture.rootDirectory,
        });

        assert.strictEqual(publication.state, "failed");
        if (publication.state !== "failed") {
          return assert.fail("Expected an owned remote-head conflict failure.");
        }
        assert.strictEqual(publication.code, "DeliveryRemoteBranchConflict");
        assert.strictEqual(
          commands.filter(({ args }) => args[0] === "push").length,
          1,
        );
        assert.isFalse(
          commands.some(
            ({ command, args }) =>
              command === "gh" && args[0] === "pr" && args[1] === "create",
          ),
        );
      }),
    );

    it.effect("records a typed failure before local mutation when the remote branch exists", () =>
      Effect.gen(function* () {
        const fixture = yield* readyFixture();
        const commands: Array<GitHubCommandInput> = [];
        const publication = yield* publishReadyDeliveryRun(fixture.runId, {
          commandRunner: publicationRunner(
            commands,
            fixture.paths.root,
            fixture.provenance,
            { initialRemoteHead: "e".repeat(40) },
          ),
          deliveryGitCommandRunner: fixture.deliveryGitCommandRunner,
          rootDirectory: fixture.rootDirectory,
        });

        assert.strictEqual(publication.state, "failed");
        if (publication.state !== "failed") {
          return assert.fail("Expected a typed preflight ownership failure.");
        }
        assert.strictEqual(publication.code, "DeliveryRemoteBranchConflict");
        assert.strictEqual(
          (yield* readEvents(fixture.paths)).at(-1)?.type,
          "DELIVERY_PUBLICATION_FAILED",
        );
        assert.isFalse(
          commands.some(({ args }) =>
            args.includes("switch") || args.includes("commit") || args[0] === "push"),
        );
      }),
    );

    it.effect("retries a recoverable target-read failure as a new pre-commit operation", () =>
      Effect.gen(function* () {
        const fixture = yield* readyFixture();
        const commands: Array<GitHubCommandInput> = [];
        const runner = publicationRunner(
          commands,
          fixture.paths.root,
          fixture.provenance,
          { remoteReadFailuresBeforeMutation: 1 },
        );
        const failed = yield* publishReadyDeliveryRun(fixture.runId, {
          commandRunner: runner,
          deliveryGitCommandRunner: fixture.deliveryGitCommandRunner,
          rootDirectory: fixture.rootDirectory,
        });
        const retried = yield* retryFailedDeliveryPublication(fixture.runId, {
          commandRunner: runner,
          deliveryGitCommandRunner: fixture.deliveryGitCommandRunner,
          rootDirectory: fixture.rootDirectory,
        });

        assert.strictEqual(failed.state, "failed");
        assert.strictEqual(retried.state, "confirmed");
        assert.notStrictEqual(retried.operationId, failed.operationId);
        assert.strictEqual(
          commands.filter(({ args }) => args.includes("commit")).length,
          1,
        );
        assert.strictEqual(
          commands.filter(({ args }) => args[0] === "push").length,
          1,
        );
      }),
    );

    it.effect("resumes a verified commit after a crash before attempted was recorded", () =>
      Effect.gen(function* () {
        const fixture = yield* readyFixture();
        const commands: Array<GitHubCommandInput> = [];
        const commitTimestamp = "2026-07-11T00:00:00.000Z";
        const intent = DeliveryPublicationIntent.make({
          baseBranch: fixture.provenance.baseBranch,
          baseRevision: fixture.provenance.baseRevision,
          branchName: fixture.provenance.headBranch,
          commitMessage: `feat: deliver ${fixture.runId}`,
          commitTimestamp,
          digestVersion: 1,
          operationId: `publish-${fixture.runId}-1`,
          payloadDigest: "f".repeat(64),
          sourcePaths: ["src/feature.ts"],
          state: "intentRecorded",
          treeSha,
        });
        yield* appendEvent(fixture.runId, fixture.paths, {
          payload: { publication: encodeDeliveryPublicationJson(intent) },
          type: "DELIVERY_PUBLICATION_INTENT_RECORDED",
        });
        const publication = yield* publishReadyDeliveryRun(fixture.runId, {
          commandRunner: publicationRunner(
            commands,
            fixture.paths.root,
            fixture.provenance,
            { localBranchHead: commitSha, persistedCommitTimestamp: commitTimestamp },
          ),
          deliveryGitCommandRunner: fixture.deliveryGitCommandRunner,
          rootDirectory: fixture.rootDirectory,
        });

        assert.strictEqual(publication.state, "confirmed");
        assert.isFalse(
          commands.some(({ args }) => args.includes("commit")),
        );
      }),
    );

    it.effect("commits and lease-pushes only approved source paths to a disposable bare remote", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectory({
          prefix: "gaia-delivery-bare-remote-",
        });
        const source = `${root}/source`;
        const bare = `${root}/origin.git`;
        mkdirSync(`${source}/src`, { recursive: true });
        writeFileSync(
          `${source}/.gitignore`,
          [".gaia/", ".turbo/", "dist/", "gaia-runs/", "node_modules/"].join("\n") + "\n",
        );
        writeFileSync(
          `${source}/src/feature.ts`,
          "export const delivered = false;\n",
        );
        writeFileSync(
          `${source}/src/removed.ts`,
          "export const removeMe = true;\n",
        );
        writeFileSync(
          `${source}/src/rename-me.ts`,
          "export const renamed = true;\n",
        );
        git(source, "init", "--initial-branch=main");
        git(source, "config", "user.name", "Fixture");
        git(source, "config", "user.email", "fixture@example.com");
        git(source, "add", ".");
        git(source, "commit", "-m", "chore: seed fixture");
        git(root, "init", "--bare", bare);
        git(source, "remote", "add", "origin", bare);
        git(source, "push", "-u", "origin", "main");
        const acceptedBase = git(source, "rev-parse", "HEAD");
        const runId = parseRunId("run-BareGit001");
        const paths = yield* makeRunPaths(runId, { rootDirectory: source });
        const provenance: DeliveryProvenance = {
          baseBranch: "main",
          baseRevision: acceptedBase,
          headBranch: `gaia/${runId}`,
          mode: "pullRequest",
          remote: "origin",
        };
        yield* fs.makeDirectory(paths.root, { recursive: true });
        yield* prepareDeliveryWorktree({
          options: { rootDirectory: source },
          paths,
          provenance,
        });
        yield* fs.writeFileString(
          `${paths.workspace}/src/feature.ts`,
          "export const delivered = true;\n",
        );
        rmSync(`${paths.workspace}/src/removed.ts`);
        renameSync(
          `${paths.workspace}/src/rename-me.ts`,
          `${paths.workspace}/src/renamed.ts`,
        );
        yield* fs.writeFileString(paths.workspaceOutput, "harness only\n");
        yield* writeReadyRun(runId, paths, provenance, [
          "output.txt",
          "src/feature.ts",
          "src/rename-me.ts",
          "src/renamed.ts",
          "src/removed.ts",
        ]);
        const primaryBefore = primaryGitState(source);
        const publication = yield* publishReadyDeliveryRun(runId, {
          commandRunner: bareRemotePublicationRunner(paths, provenance),
          rootDirectory: source,
        });
        const primaryAfter = primaryGitState(source);

        assert.strictEqual(publication.state, "confirmed");
        if (publication.state !== "confirmed") {
          return assert.fail("Expected bare-remote publication confirmation.");
        }
        assert.deepEqual(primaryAfter, primaryBefore);
        assert.strictEqual(
          git(
            source,
            "ls-remote",
            "--heads",
            "origin",
            `refs/heads/${provenance.headBranch}`,
          ).split(/\s+/u)[0],
          publication.commitSha,
        );
        assert.deepEqual(
          git(
            paths.workspace,
            "diff-tree",
            "--no-commit-id",
            "--name-only",
            "-r",
            publication.commitSha,
          ).split("\n").toSorted(),
          [
            "src/feature.ts",
            "src/removed.ts",
            "src/rename-me.ts",
            "src/renamed.ts",
          ],
        );
        assert.strictEqual(
          git(
            paths.workspace,
            "show",
            "-s",
            "--format=%an <%ae>",
            publication.commitSha,
          ),
          "Gaia Delivery <delivery@gaia.local>",
        );
        assert.strictEqual(
          git(
            paths.workspace,
            "show",
            "-s",
            "--format=%cn <%ce>",
            publication.commitSha,
          ),
          "Gaia Delivery <delivery@gaia.local>",
        );
      }),
    );
  });
});

function worktreeRunner(rootDirectory: string): GitDeliveryCommandRunner {
  return ({ args, cwd }) =>
    Effect.sync(() => {
      const command = args.join(" ");
      if (command.startsWith("worktree add --detach ")) {
        const workspace = args[3];
        if (workspace !== undefined) mkdirSync(workspace, { recursive: true });
        return { stderr: "", stdout: "" };
      }
      if (command === "rev-parse --show-toplevel") {
        return {
          stderr: "",
          stdout: `${cwd === rootDirectory ? rootDirectory : cwd}\n`,
        };
      }
      if (command === "rev-parse --path-format=absolute --git-common-dir") {
        return { stderr: "", stdout: `${rootDirectory}/.git\n` };
      }
      if (command === "remote get-url origin") {
        return {
          stderr: "",
          stdout: "https://github.com/cill-i-am/gaia.git\n",
        };
      }
      if (command === "rev-parse HEAD") {
        return { stderr: "", stdout: `${baseRevision}\n` };
      }
      return { stderr: "", stdout: "" };
    });
}

function publicationRunner(
  commands: Array<GitHubCommandInput>,
  runRoot: string,
  provenance: DeliveryProvenance,
  options: {
    readonly confirmPrOnCreateAttempt?: number;
    readonly diffOutput?: string;
    readonly initialRemoteHead?: string;
    readonly localBranchHead?: string;
    readonly persistedCommitTimestamp?: string;
    readonly prCreateUnconfirmed?: boolean;
    readonly pushedRemoteHead?: string;
    readonly remoteUnreadableAfterPush?: boolean;
    readonly remoteReadFailuresBeforeMutation?: number;
    readonly verifyDurableMutationIntents?: boolean;
  } = {},
): GitHubCommandRunner {
  let remoteHead: string | undefined = options.initialRemoteHead;
  let prCreated = false;
  let prCreateCount = 0;
  let pushed = false;
  let commitTimestamp = options.persistedCommitTimestamp ?? "";
  let remoteReadFailuresBeforeMutation =
    options.remoteReadFailuresBeforeMutation ?? 0;
  return (input) => {
      commands.push(input);
      const args = input.args.join(" ");
      if (
        input.command === "git" &&
        args.startsWith("ls-remote --heads ") &&
        !pushed &&
        remoteReadFailuresBeforeMutation > 0
      ) {
        remoteReadFailuresBeforeMutation -= 1;
        return Effect.fail(
          makeRuntimeError({
            code: "SyntheticRemoteReadFailure",
            message: "Synthetic preflight remote read failure.",
            recoverable: true,
          }),
        );
      }
      if (
        input.command === "git" &&
        args.startsWith("ls-remote --heads ") &&
        pushed &&
        options.remoteUnreadableAfterPush
      ) {
        return Effect.fail(
          makeRuntimeError({
            code: "SyntheticRemoteReadFailure",
            message: "Synthetic remote read failure.",
            recoverable: true,
          }),
        );
      }
      return Effect.sync(() => {
      if (input.command === "git") {
        if (args === `diff --name-status -z --find-renames ${baseRevision} --`) {
          return success(options.diffOutput ?? "M\0src/feature.ts\0");
        }
        if (args === "ls-files --others --exclude-standard -z") {
          return success("");
        }
        if (args.startsWith("show-ref --verify --quiet ")) {
          return {
            exitCode: options.localBranchHead === undefined ? 1 : 0,
            stderr: "",
            stdout: "",
          };
        }
        if (args === `diff --cached --name-status -z ${baseRevision} --`) {
          return success(
            commands.some(({ command, args: commandArgs }) =>
              command === "git" && commandArgs[0] === "add",
            )
              ? "M\0src/feature.ts\0"
              : "",
          );
        }
        if (input.args.includes("commit")) {
          commitTimestamp = input.env?.GIT_AUTHOR_DATE ?? "";
          return success("");
        }
        if (args === "rev-parse HEAD") return success(`${commitSha}\n`);
        if (args.startsWith("rev-parse refs/heads/")) {
          return success(`${options.localBranchHead ?? baseRevision}\n`);
        }
        if (args === "rev-parse HEAD^{tree}") return success(`${treeSha}\n`);
        if (args === "write-tree") return success(`${treeSha}\n`);
        if (args.startsWith("show -s --format=")) {
          return success(
            [
              baseRevision,
              treeSha,
              `feat: deliver ${provenance.headBranch.slice("gaia/".length)}\n`,
              "Gaia Delivery",
              "delivery@gaia.local",
              commitTimestamp,
              "Gaia Delivery",
              "delivery@gaia.local",
              commitTimestamp,
            ].join("\0"),
          );
        }
        if (args.startsWith("diff-tree --no-commit-id --name-status -z ")) {
          return success("M\0src/feature.ts\0");
        }
        if (args.startsWith("ls-remote --heads ")) {
          return success(
            remoteHead === undefined
              ? ""
              : `${remoteHead}\trefs/heads/${provenance.headBranch}\n`,
          );
        }
        if (input.args[0] === "push") {
          if (
            options.verifyDurableMutationIntents &&
            lastEventType(runRoot) !== "DELIVERY_PUBLICATION_OUTCOME_UNKNOWN"
          ) {
            throw new Error("Push mutation did not have a durable unknown receipt.");
          }
          pushed = true;
          remoteHead = options.pushedRemoteHead ?? commitSha;
          return success("");
        }
        return success("");
      }
      if (input.command === "gh" && input.args[0] === "pr") {
        if (input.args[1] === "create") {
          if (
            options.verifyDurableMutationIntents &&
            lastEventType(runRoot) !== "DELIVERY_PUBLICATION_OUTCOME_UNKNOWN"
          ) {
            throw new Error("PR mutation did not have a durable unknown receipt.");
          }
          prCreated = true;
          prCreateCount += 1;
          return success("https://github.com/cill-i-am/gaia/pull/91\n");
        }
        if (input.args[1] === "list") {
          if (
            !prCreated ||
            options.prCreateUnconfirmed ||
            (options.confirmPrOnCreateAttempt !== undefined &&
              prCreateCount < options.confirmPrOnCreateAttempt)
          ) {
            return success("[]\n");
          }
          const body = readFileSync(`${runRoot}/delivery-pr-body.md`, "utf8");
          return success(
            `${JSON.stringify([
              {
                baseRefName: "main",
                body,
                headRefName: provenance.headBranch,
                headRefOid: commitSha,
                isDraft: true,
                number: 91,
                state: "OPEN",
                url: "https://github.com/cill-i-am/gaia/pull/91",
              },
            ])}\n`,
          );
        }
      }
      return success("");
      });
    };
}

function readyFixture() {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const rootDirectory = yield* fs.makeTempDirectory({
      prefix: "gaia-delivery-publication-",
    });
    const runId = parseRunId("run-R3c0v3ry01");
    const paths = yield* makeRunPaths(runId, { rootDirectory });
    const provenance: DeliveryProvenance = {
      baseBranch: "main",
      baseRevision,
      headBranch: `gaia/${runId}`,
      mode: "pullRequest",
      remote: "origin",
    };
    const deliveryGitCommandRunner = worktreeRunner(rootDirectory);
    yield* fs.makeDirectory(paths.root, { recursive: true });
    yield* prepareDeliveryWorktree({
      options: { commandRunner: deliveryGitCommandRunner, rootDirectory },
      paths,
      provenance,
    });
    yield* fs.makeDirectory(`${paths.workspace}/src`, { recursive: true });
    yield* fs.writeFileString(
      `${paths.workspace}/src/feature.ts`,
      "export const delivered = true;\n",
    );
    yield* fs.writeFileString(paths.workspaceOutput, "harness only\n");
    yield* writeReadyRun(runId, paths, provenance);
    return {
      deliveryGitCommandRunner,
      paths,
      provenance,
      rootDirectory,
      runId,
    };
  });
}

function bareRemotePublicationRunner(
  paths: RunPaths,
  provenance: DeliveryProvenance,
): GitHubCommandRunner {
  let prCreated = false;
  return (input) => {
    if (input.command === "git") return nodeGitHubCommandRunner(input);
    if (input.command === "gh" && input.args[0] === "pr") {
      if (input.args[1] === "create") {
        prCreated = true;
        return Effect.succeed(
          success("https://github.com/cill-i-am/gaia/pull/91\n"),
        );
      }
      if (input.args[1] === "list") {
        if (!prCreated) return Effect.succeed(success("[]\n"));
        const head = git(paths.workspace, "rev-parse", "HEAD");
        const body = readFileSync(paths.deliveryPullRequestBody, "utf8");
        return Effect.succeed(
          success(
            `${JSON.stringify([
              {
                baseRefName: provenance.baseBranch,
                body,
                headRefName: provenance.headBranch,
                headRefOid: head,
                isDraft: true,
                number: 91,
                state: "OPEN",
                url: "https://github.com/cill-i-am/gaia/pull/91",
              },
            ])}\n`,
          ),
        );
      }
    }
    return Effect.succeed(success(""));
  };
}

function git(cwd: string, ...args: ReadonlyArray<string>) {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
  }).trim();
}

function primaryGitState(cwd: string) {
  return {
    branch: git(cwd, "branch", "--show-current"),
    cached: git(cwd, "diff", "--cached", "--binary"),
    head: git(cwd, "rev-parse", "HEAD"),
    status: git(cwd, "status", "--porcelain=v2"),
    worktree: git(cwd, "diff", "--binary"),
  };
}

function success(stdout: string): CommandExecutionResult {
  return { exitCode: 0, stderr: "", stdout };
}

function lastEventType(runRoot: string) {
  const lines = readFileSync(`${runRoot}/events.jsonl`, "utf8")
    .trim()
    .split("\n");
  const last = lines.at(-1);
  return last === undefined
    ? undefined
    : (JSON.parse(last) as { readonly type?: string }).type;
}

function writeReadyRun(
  runId: ReturnType<typeof parseRunId>,
  paths: RunPaths,
  provenance: DeliveryProvenance,
  changedPaths: ReadonlyArray<string> = ["output.txt", "src/feature.ts"],
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const workspaceDiff = productOnlyWorkspaceDiff(changedPaths);
    const result = HarnessRunResult.make({
      changedWorkspacePaths: workspaceDiff.productChangedPaths,
      exitCode: 0,
      harnessName: codexAppServerHarnessName,
      outputArtifacts: ["workspace/output.txt"],
      resultPath: "worker-result.json",
      runId,
      status: "completed",
      summary: "Delivered one source change.",
      workspaceDiff,
    });
    yield* fs.writeFileString(paths.workerResult, `${JSON.stringify(result)}\n`);
    yield* fs.writeFileString(paths.verificationResult, '{"status":"passed"}\n');
    yield* fs.writeFileString(paths.evidenceReviewResult, '{"status":"passed"}\n');
    yield* fs.writeFileString(paths.reportMarkdown, "# Safe report\n");
    yield* appendEvent(runId, paths, {
      payload: { delivery: provenance, source: "server", specPath: "input.md" },
      type: "RUN_CREATED",
    });
    yield* appendEvent(runId, paths, {
      payload: { delivery: { ...provenance, stage: "delivering" } },
      type: "DELIVERY_STARTED",
    });
    yield* appendEvent(runId, paths, {
      payload: { workspacePath: "workspace" },
      type: "WORKSPACE_PREPARED",
    });
    yield* appendEvent(runId, paths, {
      payload: {
        changedWorkspacePaths: workspaceDiff.productChangedPaths,
        harnessName: "codex-app-server",
        outputArtifacts: result.outputArtifacts,
        workerResultPath: "worker-result.json",
        workspaceDiff: JSON.parse(JSON.stringify(workspaceDiff)),
      },
      type: "WORKER_COMPLETED",
    });
    yield* appendEvent(runId, paths, {
      payload: { verificationResultPath: "verification-result.json" },
      type: "VERIFICATION_COMPLETED",
    });
    yield* appendEvent(runId, paths, {
      payload: { phase: "evidence", reviewPath: "evidence-review.md" },
      type: "REVIEW_COMPLETED",
    });
    yield* appendEvent(runId, paths, {
      payload: {
        delivery: { ...provenance, stage: "readyToPublish" },
        reportPath: "report.md",
      },
      type: "DELIVERY_READY_TO_PUBLISH",
    });
  });
}
