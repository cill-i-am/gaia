import { assert, describe, it, layer } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import {
  codexAppServerExecutionSelection,
  HarnessCapabilities,
  HarnessProviderDescriptor,
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
