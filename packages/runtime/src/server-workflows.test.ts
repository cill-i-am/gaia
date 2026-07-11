import { assert, describe, it, layer } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  codexAppServerExecutionSelection,
  HarnessCapabilities,
  HarnessProviderDescriptor,
  parseRunId,
  parseHarnessProviderId,
  ResolvedHarnessExecution,
} from "@gaia/core";
import { Effect, FileSystem, Schema } from "effect";
import {
  ReviewFinding,
  ReviewResult,
  ReviewerNameSchema,
  type GaiaReviewer,
} from "./reviewer.js";
import { GaiaRuntimeError } from "./errors.js";
import { readLocalRun, readLocalRunEvents } from "./run-read-api.js";
import {
  acceptFactoryRun,
  acceptServerRun,
  continueServerRun,
  reconcileInterruptedServerRuns,
} from "./server-workflows.js";
import { makeHarnessProviderRegistry } from "./harness-provider-registry.js";
import type { HarnessProvider } from "./harness-session.js";
import { makeRunPaths } from "./paths.js";
import { makeTestHarnessProviderRegistry } from "./test-support.js";
import { prepareDeliveryWorktree, type GitDeliveryCommandInput } from "./git-delivery.js";

describe("server workflows", () => {
  layer(NodeServices.layer)((it) => {
    it.effect("durably accepts Markdown content before continuation", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-server-workflow-" });

        const accepted = yield* acceptServerRun(
          { specMarkdown: "Accept this server run.\n" },
          { rootDirectory: cwd },
        );
        const input = yield* fs.readFileString(`${accepted.runDirectory}/input.md`);
        const events = yield* readLocalRunEvents(accepted.runId, {
          rootDirectory: cwd,
        });

        assert.strictEqual(input, "Accept this server run.\n");
        assert.strictEqual(events.events.length, 1);
        assert.strictEqual(events.events[0]?.type, "RUN_CREATED");
        assert.strictEqual(events.events[0]?.payload["source"], "server");
        assert.strictEqual(events.events[0]?.sequence, accepted.eventSequence);
      }),
    );

    it.effect("resolves and persists only safe execution metadata before accepting a factory run", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-factory-accept-" });
        const registry = makeHarnessProviderRegistry([
          {
            profileId: codexAppServerExecutionSelection.harnessProfileId,
            provider: acceptanceProvider,
          },
        ]);

        const accepted = yield* acceptFactoryRun(
          {
            execution: codexAppServerExecutionSelection,
            workflow: "issueDelivery",
            workItem: {
              description: "Deliver through the selected provider.",
              kind: "issue",
              title: "Selected provider acceptance",
            },
          },
          { harnessProviderRegistry: registry, rootDirectory: cwd },
        );
        const events = yield* readLocalRunEvents(accepted.runId, {
          rootDirectory: cwd,
        });
        const serialized = JSON.stringify(events.events[0]?.payload);

        assert.deepEqual(events.events[0]?.payload["execution"], {
          resolved: Schema.encodeSync(ResolvedHarnessExecution)(
            ResolvedHarnessExecution.make({
            capabilities: acceptanceCapabilities,
            executionMode: "local",
            harnessProfileId: codexAppServerExecutionSelection.harnessProfileId,
            provider: acceptanceProvider.descriptor,
            version: "synthetic-1",
            }),
          ),
          selection: { harnessProfileId: "codexAppServer" },
        });
        assert.notInclude(serialized, "credential");
        assert.notInclude(serialized, "/usr/local/bin");
      }),
    );

    it.effect("continues an accepted server run through the default workflow", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-server-workflow-" });
        const accepted = yield* acceptServerRun(
          { specMarkdown: "Complete this server run.\n" },
          { rootDirectory: cwd },
        );

        const summary = yield* continueServerRun(accepted.runId, {
          rootDirectory: cwd,
        });
        const read = yield* readLocalRun(accepted.runId, { rootDirectory: cwd });

        assert.strictEqual(summary.status, "completed");
        assert.strictEqual(read.status, "completed");
        assert.strictEqual(read.latestEventType, "REPORT_COMPLETED");
      }),
    );

    it.effect("records a canonical failure when provider availability changes after acceptance", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-provider-change-" });
        let providerAvailable = true;
        const provider: HarnessProvider = {
          ...acceptanceProvider,
          detect: Effect.sync(() =>
            providerAvailable
              ? {
                  auth: { state: "authenticated" },
                  capabilities: acceptanceCapabilities,
                  state: "available",
                  version: "synthetic-1",
                } as const
              : { state: "missing" } as const,
          ),
        };
        const registry = makeHarnessProviderRegistry([
          {
            profileId: codexAppServerExecutionSelection.harnessProfileId,
            provider,
          },
        ]);
        const accepted = yield* acceptFactoryRun(
          {
            execution: codexAppServerExecutionSelection,
            workflow: "issueDelivery",
            workItem: {
              description: "Fail when the accepted provider becomes unavailable.",
              kind: "issue",
              title: "Post-acceptance provider change",
            },
          },
          { harnessProviderRegistry: registry, rootDirectory: cwd },
        );
        providerAvailable = false;

        const continuation = yield* continueServerRun(accepted.runId, {
          harnessProviderRegistry: registry,
          rootDirectory: cwd,
        }).pipe(Effect.exit);
        const events = yield* readLocalRunEvents(accepted.runId, {
          rootDirectory: cwd,
        });

        assert.strictEqual(continuation._tag, "Failure");
        assert.strictEqual(events.events.at(-1)?.type, "RUN_FAILED");
        assert.strictEqual(
          events.events.at(-1)?.payload["code"],
          "HarnessUnavailable",
        );
      }),
    );

    it.effect("keeps default issue delivery local even inside a git repository", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-delivery-local-" });
        const commands: Array<GitDeliveryCommandInput> = [];
        const accepted = yield* acceptFactoryRun(
          {
            execution: codexAppServerExecutionSelection,
            workflow: "issueDelivery",
            workItem: {
              description: "Run locally unless pull-request delivery is requested.",
              kind: "issue",
              title: "Local delivery policy",
            },
          },
          {
            deliveryGitCommandRunner: recordingGitRunner(commands, {
              baseRevision: "eea77bffa399d93ae0c90e71e9a39f1fb9a4aa92",
            }),
            harnessProviderRegistry: makeTestHarnessProviderRegistry(),
            rootDirectory: cwd,
          },
        );
        const summary = yield* continueServerRun(accepted.runId, {
          deliveryGitCommandRunner: recordingGitRunner(commands, {
            baseRevision: "eea77bffa399d93ae0c90e71e9a39f1fb9a4aa92",
          }),
          harnessProviderRegistry: makeTestHarnessProviderRegistry(),
          rootDirectory: cwd,
        });
        const events = yield* readLocalRunEvents(accepted.runId, {
          rootDirectory: cwd,
        });

        assert.strictEqual(summary.state, "completed");
        assert.strictEqual(events.events.at(-1)?.type, "REPORT_COMPLETED");
        assert.deepEqual(commands, []);
        assert.deepEqual(events.events[0]?.payload["delivery"], { mode: "local" });
      }),
    );

    it.effect("runs issue delivery in an owned worktree at the accepted remote base", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-delivery-worktree-" });
        const commands: Array<GitDeliveryCommandInput> = [];
        const gitRunner = recordingGitRunner(commands, {
          baseRevision: "eea77bffa399d93ae0c90e71e9a39f1fb9a4aa92",
        });

        const accepted = yield* acceptFactoryRun(
          {
            delivery: { mode: "pullRequest" },
            execution: codexAppServerExecutionSelection,
            workflow: "issueDelivery",
            workItem: {
              description: "Deliver in a run-owned worktree.",
              kind: "issue",
              title: "Owned worktree delivery",
            },
          },
          {
            deliveryGitCommandRunner: gitRunner,
            harnessProviderRegistry: makeTestHarnessProviderRegistry(),
            rootDirectory: cwd,
          },
        );
        const summary = yield* continueServerRun(accepted.runId, {
          deliveryGitCommandRunner: gitRunner,
          harnessProviderRegistry: makeTestHarnessProviderRegistry(),
          rootDirectory: cwd,
        });
        const events = yield* readLocalRunEvents(accepted.runId, {
          rootDirectory: cwd,
        });
        const serialized = JSON.stringify(events.events);

        assert.strictEqual(summary.state, "delivering");
        assert.strictEqual(events.events.at(-1)?.type, "DELIVERY_READY_TO_PUBLISH");
        assert.isTrue(
          commands.some(
            ({ args }) =>
              args[0] === "worktree" &&
              args[1] === "add" &&
              args.includes("eea77bffa399d93ae0c90e71e9a39f1fb9a4aa92"),
          ),
        );
        assert.include(serialized, "\"remote\":\"origin\"");
        assert.include(serialized, "\"baseBranch\":\"main\"");
        assert.notInclude(serialized, cwd);
      }),
    );

    it.effect("fails closed when a persisted delivery worktree has the wrong head", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-delivery-collision-" });
        const acceptedBase = "eea77bffa399d93ae0c90e71e9a39f1fb9a4aa92";
        const gitRunner = recordingGitRunner([], {
          baseRevision: acceptedBase,
          workspaceHead: "1111111111111111111111111111111111111111",
        });

        const accepted = yield* acceptFactoryRun(
          {
            delivery: { mode: "pullRequest" },
            execution: codexAppServerExecutionSelection,
            workflow: "issueDelivery",
            workItem: {
              description: "Reject a colliding worktree.",
              kind: "issue",
              title: "Wrong worktree identity",
            },
          },
          {
            deliveryGitCommandRunner: gitRunner,
            harnessProviderRegistry: makeTestHarnessProviderRegistry(),
            rootDirectory: cwd,
          },
        );
        yield* fs.makeDirectory(`${accepted.runDirectory}/workspace`, {
          recursive: true,
        });

        const exit = yield* continueServerRun(accepted.runId, {
          deliveryGitCommandRunner: gitRunner,
          harnessProviderRegistry: makeTestHarnessProviderRegistry(),
          rootDirectory: cwd,
        }).pipe(Effect.exit);
        const events = yield* readLocalRunEvents(accepted.runId, {
          rootDirectory: cwd,
        });

        assert.strictEqual(exit._tag, "Failure");
        assert.strictEqual(events.events.at(-1)?.type, "RUN_FAILED");
        assert.strictEqual(
          events.events.at(-1)?.payload["code"],
          "DeliveryWorktreeIdentityMismatch",
        );
      }),
    );

    it.effect("fails closed when ownership evidence does not match the repository identity", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-delivery-ownership-" });
        const acceptedBase = "eea77bffa399d93ae0c90e71e9a39f1fb9a4aa92";
        const gitRunner = recordingGitRunner([], {
          baseRevision: acceptedBase,
          workspaceHead: acceptedBase,
        });

        const accepted = yield* acceptFactoryRun(
          {
            delivery: { mode: "pullRequest" },
            execution: codexAppServerExecutionSelection,
            workflow: "issueDelivery",
            workItem: {
              description: "Reject stale ownership evidence.",
              kind: "issue",
              title: "Wrong ownership identity",
            },
          },
          {
            deliveryGitCommandRunner: gitRunner,
            harnessProviderRegistry: makeTestHarnessProviderRegistry(),
            rootDirectory: cwd,
          },
        );
        yield* fs.makeDirectory(`${accepted.runDirectory}/workspace`, {
          recursive: true,
        });
        yield* fs.writeFileString(
          `${accepted.runDirectory}/delivery-ownership.json`,
          `${JSON.stringify({
            baseRevision: acceptedBase,
            repositoryCommonDir: `${cwd}/other-common-dir`,
            repositoryRoot: cwd,
            token: "stale-token",
            version: 1,
            workspaceCommonDir: `${accepted.runDirectory}/workspace/.git`,
            workspaceRoot: `${accepted.runDirectory}/workspace`,
          }, null, 2)}\n`,
        );

        const exit = yield* continueServerRun(accepted.runId, {
          deliveryGitCommandRunner: gitRunner,
          harnessProviderRegistry: makeTestHarnessProviderRegistry(),
          rootDirectory: cwd,
        }).pipe(Effect.exit);
        const events = yield* readLocalRunEvents(accepted.runId, {
          rootDirectory: cwd,
        });

        assert.strictEqual(exit._tag, "Failure");
        assert.strictEqual(events.events.at(-1)?.type, "RUN_FAILED");
        assert.strictEqual(
          events.events.at(-1)?.payload["code"],
          "DeliveryWorktreeIdentityMismatch",
        );
      }),
    );

    it.effect("fails closed when accepted pull-request provenance is corrupt", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-delivery-provenance-" });
        const acceptedBase = "eea77bffa399d93ae0c90e71e9a39f1fb9a4aa92";
        const gitRunner = recordingGitRunner([], { baseRevision: acceptedBase });

        const accepted = yield* acceptFactoryRun(
          {
            delivery: { mode: "pullRequest" },
            execution: codexAppServerExecutionSelection,
            workflow: "issueDelivery",
            workItem: {
              description: "Reject corrupt provenance.",
              kind: "issue",
              title: "Corrupt provenance",
            },
          },
          {
            deliveryGitCommandRunner: gitRunner,
            harnessProviderRegistry: makeTestHarnessProviderRegistry(),
            rootDirectory: cwd,
          },
        );
        const eventLog = `${accepted.runDirectory}/events.jsonl`;
        const firstLine = yield* fs.readFileString(eventLog);
        const created = JSON.parse(firstLine.trim()) as {
          payload: Record<string, unknown>;
        };
        created.payload["delivery"] = { mode: "pullRequest" };
        yield* fs.writeFileString(eventLog, `${JSON.stringify(created)}\n`);

        const exit = yield* continueServerRun(accepted.runId, {
          deliveryGitCommandRunner: gitRunner,
          harnessProviderRegistry: makeTestHarnessProviderRegistry(),
          rootDirectory: cwd,
        }).pipe(Effect.exit);
        const events = yield* readLocalRunEvents(accepted.runId, {
          rootDirectory: cwd,
        });

        assert.strictEqual(exit._tag, "Failure");
        assert.strictEqual(events.events.at(-1)?.type, "RUN_FAILED");
        assert.strictEqual(
          events.events.at(-1)?.payload["code"],
          "DeliveryWorktreeIdentityMismatch",
        );
      }),
    );

    it.effect("fails closed when an unrelated same-head clone forges ownership evidence", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const smoke = makeDisposableGitRemote();
        try {
          const source = realpathSync(smoke.source);
          const runId = parseRunId("run-WrongRepo1");
          const paths = yield* makeRunPaths(runId, { rootDirectory: source });
          const provenance = {
            baseBranch: "main",
            baseRevision: smoke.baseRevision,
            headBranch: "gaia/run-WrongRepo1",
            mode: "pullRequest" as const,
            remote: "origin",
          };
          yield* fs.makeDirectory(paths.root, { recursive: true });

          yield* prepareDeliveryWorktree({
            options: { rootDirectory: source },
            paths,
            provenance,
          });
          const manifest = JSON.parse(
            readFileSync(paths.deliveryOwnershipManifest, "utf8"),
          ) as Record<string, unknown>;
          rmSync(paths.workspace, { force: true, recursive: true });
          git(smoke.root, "clone", smoke.bare, paths.workspace);
          git(paths.workspace, "checkout", "--detach", smoke.baseRevision);
          manifest["workspaceRoot"] = paths.workspace;
          manifest["workspaceCommonDir"] = git(
            paths.workspace,
            "rev-parse",
            "--path-format=absolute",
            "--git-common-dir",
          );
          writeFileSync(
            paths.deliveryOwnershipManifest,
            `${JSON.stringify(manifest, null, 2)}\n`,
          );

          const error = yield* Effect.flip(
            prepareDeliveryWorktree({
              options: { rootDirectory: source },
              paths,
              provenance,
            }),
          );

          assert.instanceOf(error, GaiaRuntimeError);
          assert.strictEqual(error.code, "DeliveryWorktreeIdentityMismatch");
        } finally {
          rmSync(smoke.root, { force: true, recursive: true });
        }
      }),
    );

    it.effect("creates a real disposable detached git worktree without moving the primary checkout", () =>
      Effect.gen(function* () {
        const smoke = makeDisposableGitRemote();
        try {
          const primaryBefore = gitState(smoke.source);
          const accepted = yield* acceptFactoryRun(
            {
              delivery: { mode: "pullRequest" },
              execution: codexAppServerExecutionSelection,
              workflow: "issueDelivery",
              workItem: {
                description: "Real git worktree smoke.",
                kind: "issue",
                title: "Real worktree smoke",
              },
            },
            {
              harnessProviderRegistry: makeTestHarnessProviderRegistry(),
              rootDirectory: smoke.source,
            },
          );
          const summary = yield* continueServerRun(accepted.runId, {
            harnessProviderRegistry: makeTestHarnessProviderRegistry(),
            rootDirectory: smoke.source,
          });
          const workspace = `${accepted.runDirectory}/workspace`;
          const workspaceHead = git(workspace, "rev-parse", "HEAD");
          const workspaceBranch = git(workspace, "branch", "--show-current");
          const primaryAfter = gitState(smoke.source);

          assert.strictEqual(summary.state, "delivering");
          assert.strictEqual(workspaceHead, smoke.baseRevision);
          assert.strictEqual(workspaceBranch, "");
          assert.deepEqual(primaryAfter, primaryBefore);
        } finally {
          rmSync(smoke.root, { force: true, recursive: true });
        }
      }),
    );

    it.effect("appends RUN_FAILED for expected continuation failures", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-server-workflow-" });
        const accepted = yield* acceptServerRun(
          { specMarkdown: "Fail this server run during review.\n" },
          { rootDirectory: cwd },
        );
        const reviewer = blockingReviewer();

        const error = yield* Effect.flip(
          continueServerRun(accepted.runId, { reviewer, rootDirectory: cwd }),
        );
        const events = yield* readLocalRunEvents(accepted.runId, {
          rootDirectory: cwd,
        });
        const failed = events.events.at(-1);

        assert.isTrue(error instanceof GaiaRuntimeError);
        assert.strictEqual(failed?.type, "RUN_FAILED");
        assert.strictEqual(failed?.payload["code"], "ReviewBlocked");
      }),
    );

    it.effect("marks unfinished accepted server runs interrupted on startup reconciliation", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-server-workflow-" });
        const accepted = yield* acceptServerRun(
          { specMarkdown: "Interrupt this server run.\n" },
          { rootDirectory: cwd },
        );

        const reconciled = yield* reconcileInterruptedServerRuns({
          rootDirectory: cwd,
        });
        const events = yield* readLocalRunEvents(accepted.runId, {
          rootDirectory: cwd,
        });
        const failed = events.events.at(-1);

        assert.deepEqual(reconciled.reconciledRunIds, [accepted.runId]);
        assert.strictEqual(failed?.type, "RUN_FAILED");
        assert.strictEqual(failed?.payload["code"], "ServerExecutionInterrupted");
        assert.strictEqual(failed?.payload["stage"], "preparingWorkspace");
      }),
    );
  });
});

const acceptanceCapabilities = HarnessCapabilities.make({
  approvals: [],
  fileChangeEvents: true,
  interruption: true,
  resumableSessions: true,
  review: false,
  steering: false,
  streamingMessages: true,
  structuredOutput: false,
  subagents: false,
  toolEvents: false,
  usageReporting: false,
  userQuestions: false,
});

const acceptanceProvider: HarnessProvider = {
  createSession: () => Effect.die("not used during acceptance"),
  descriptor: HarnessProviderDescriptor.make({
    displayName: "Synthetic Harness",
    executionModes: ["local"],
    providerId: parseHarnessProviderId("synthetic"),
  }),
  detect: Effect.succeed({
    auth: { state: "authenticated" },
    capabilities: acceptanceCapabilities,
    state: "available",
    version: "synthetic-1",
  }),
  resumeSession: () => Effect.die("not used during acceptance"),
};

function blockingReviewer(): GaiaReviewer {
  const reviewerName = Schema.decodeUnknownSync(ReviewerNameSchema)(
    "server-blocking-reviewer",
  );

  return {
    name: reviewerName,
    run: (request) =>
      Effect.succeed(
        ReviewResult.make({
          findings: [
            ReviewFinding.make({
              message: "Server workflow expected failure.",
              severity: "blocker",
            }),
          ],
          phase: request.phase,
          resultPath:
            request.phase === "plan"
              ? "plan-review.json"
              : "evidence-review.json",
          reviewerName,
          runId: request.runId,
          status: request.phase === "plan" ? "blocked" : "approved",
          summary: "Server workflow expected failure.",
        }),
      ),
  };
}

function recordingGitRunner(
  commands: Array<GitDeliveryCommandInput>,
  input: {
    readonly baseRevision: string;
    readonly workspaceHead?: string;
  },
) {
  return (command: GitDeliveryCommandInput) =>
    Effect.sync(() => {
      commands.push(command);
      const [first, ...rest] = command.args;
      if (first === "rev-parse" && rest[0] === "--show-toplevel") {
        return { stderr: "", stdout: `${command.cwd}\n` };
      }
      if (
        first === "rev-parse" &&
        rest[0] === "--path-format=absolute" &&
        rest[1] === "--git-common-dir"
      ) {
        return { stderr: "", stdout: `${command.cwd}/.git\n` };
      }
      if (first === "fetch") {
        return { stderr: "", stdout: "" };
      }
      if (first === "rev-parse" && rest[0] === "origin/main") {
        return { stderr: "", stdout: `${input.baseRevision}\n` };
      }
      if (first === "rev-parse" && rest[0] === "HEAD") {
        return { stderr: "", stdout: `${input.workspaceHead ?? input.baseRevision}\n` };
      }
      if (first === "worktree" && rest[0] === "add") {
        return { stderr: "", stdout: "" };
      }
      throw new Error(`Unexpected git command ${command.args.join(" ")}`);
    });
}

function makeDisposableGitRemote() {
  const root = mkdtempSync(join(tmpdir(), "gaia-90-worktree-"));
  const source = join(root, "source");
  const bare = join(root, "origin.git");
  mkdirSync(source);
  git(source, "init", "-b", "main");
  git(source, "config", "user.email", "gaia-smoke@example.test");
  git(source, "config", "user.name", "Gaia Smoke");
  writeFileSync(join(source, ".gitignore"), ".gaia/\n");
  writeFileSync(join(source, "README.md"), "# smoke\n");
  git(source, "add", "README.md");
  git(source, "add", ".gitignore");
  git(source, "commit", "-m", "initial smoke base");
  git(root, "init", "--bare", bare);
  git(source, "remote", "add", "origin", bare);
  git(source, "push", "-u", "origin", "main");
  return {
    baseRevision: git(source, "rev-parse", "origin/main"),
    bare,
    root,
    source,
  };
}

function git(cwd: string, ...args: ReadonlyArray<string>) {
  return execFileSync("git", [...args], { cwd, encoding: "utf8" }).trim();
}

function gitState(cwd: string) {
  return {
    branch: git(cwd, "branch", "--show-current"),
    head: git(cwd, "rev-parse", "HEAD"),
    status: git(cwd, "status", "--short", "--branch"),
  };
}
