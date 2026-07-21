import { NodeServices } from "@effect/platform-node";
import { assert, describe, layer } from "@effect/vitest";
import { resolveModelInvocationEpisodes } from "@gaia/core";
import { Effect, FileSystem, Schema } from "effect";

import {
  makeCodexHarnessConfig,
  type CodexCommandRunner,
} from "./codex-harness.js";
import {
  makeCodexReviewer,
  makeCodexReviewerConfig,
} from "./codex-reviewer.js";
import { readEvents } from "./event-store.js";
import { loadModelInvocationPair } from "./model-invocation.js";
import { makeRunPaths } from "./paths.js";
import { runSpecFile } from "./workflows.js";

describe("Codex reviewer model input", () => {
  layer(NodeServices.layer)((it) => {
    it.effect(
      "uses the event-owned rendered bytes with the exact worker cwd",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectory({
            prefix: "gaia-codex-reviewer-",
          });
          const specPath = `${root}/spec.md`;
          const requests: Array<Parameters<CodexCommandRunner>[0]> = [];
          const runner: CodexCommandRunner = (input) =>
            Effect.gen(function* () {
              requests.push(input);
              const index = input.request.args.indexOf("--output-last-message");
              const output = input.request.args[index + 1];
              if (index < 0 || output === undefined)
                return yield* Effect.die("missing last-message path");
              yield* fs.writeFileString(
                output,
                "Status: approved\nSummary: The bounded evidence is coherent.\n"
              );
              return { exitCode: 0, stderr: "", stdout: "" };
            });
          yield* fs.writeFileString(specPath, "Review stable model input.\n");

          const completed = yield* runSpecFile(specPath, {
            reviewer: makeCodexReviewer({
              commandRunner: runner,
              config: makeCodexReviewerConfig({ command: "codex-review-test" }),
            }),
            rootDirectory: root,
          });

          assert.lengthOf(requests, 2);
          for (const { request } of requests) {
            assert.strictEqual(
              request.cwd,
              `${completed.runDirectory}/workspace`
            );
            assert.deepEqual(request.args.slice(0, 4), [
              "exec",
              "--json",
              "--cd",
              `${completed.runDirectory}/workspace`,
            ]);
            assert.include(request.stdin, "Gaia model input template:");
            assert.notInclude(request.stdin, completed.runId);
            assert.notInclude(request.stdin, completed.runDirectory);
          }
        })
    );

    it.effect(
      "makes every accepted reviewer setting material only to full invocation identity",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const requests: Array<Parameters<CodexCommandRunner>[0]> = [];
          const runner: CodexCommandRunner = (input) =>
            Effect.gen(function* () {
              requests.push(input);
              const index = input.request.args.indexOf("--output-last-message");
              const output = input.request.args[index + 1];
              if (index < 0 || output === undefined)
                return yield* Effect.die("missing last-message path");
              yield* fs.writeFileString(
                output,
                "Status: approved\nSummary: Reviewer semantics are bound.\n"
              );
              return { exitCode: 0, stderr: "", stdout: "" };
            });
          const configs = [
            makeCodexReviewerConfig({ command: "codex-review-a" }),
            makeCodexReviewerConfig({ command: "codex-review-b" }),
            makeCodexReviewerConfig({
              command: "codex-review-a",
              model: "model-review-a",
            }),
            makeCodexReviewerConfig({
              command: "codex-review-a",
              profile: "profile-review-a",
            }),
            makeCodexReviewerConfig({
              command: "codex-review-a",
              timeoutMs: 1_234,
            }),
          ];
          const invocations = [];
          for (const [index, config] of configs.entries()) {
            const root = yield* fs.makeTempDirectory({
              prefix: `gaia-codex-reviewer-identity-${index}-`,
            });
            const specPath = `${root}/spec.md`;
            yield* fs.writeFileString(specPath, "Review stable semantics.\n");
            const completed = yield* runSpecFile(specPath, {
              reviewer: makeCodexReviewer({ commandRunner: runner, config }),
              rootDirectory: root,
            });
            const paths = yield* makeRunPaths(completed.runId, {
              rootDirectory: root,
            });
            const resolution = resolveModelInvocationEpisodes(
              yield* readEvents(paths)
            );
            if (resolution.protocol !== "v1")
              return yield* Effect.die("missing model invocation protocol");
            const plan = resolution.episodes.find(
              ({ start }) => start.episodeKey === "planReview"
            );
            if (plan === undefined)
              return yield* Effect.die("missing plan review episode");
            invocations.push(
              (yield* loadModelInvocationPair(paths, plan.start)).invocation
            );
          }

          assert.strictEqual(
            new Set(
              invocations.map(
                ({ payload }) => payload.context.contextContentDigest
              )
            ).size,
            1
          );
          assert.strictEqual(
            new Set(
              invocations.map(
                ({ payload }) => payload.rendered.renderedInputDigest
              )
            ).size,
            1
          );
          assert.strictEqual(
            new Set(
              invocations.map(
                ({ payload }) => payload.adapterSemantics.semanticDigest
              )
            ).size,
            configs.length
          );
          assert.strictEqual(
            new Set(invocations.map(({ invocationId }) => invocationId)).size,
            configs.length
          );
          const encoded = JSON.stringify(
            invocations.map((invocation) =>
              Schema.encodeSync(Schema.Unknown)(invocation)
            )
          );
          assert.notInclude(encoded, "model-review-a");
          assert.notInclude(encoded, "profile-review-a");
          assert.notInclude(encoded, "codex-review-b");
          assert.throws(() =>
            makeCodexReviewer({
              commandRunner: runner,
              config: makeCodexHarnessConfig({ sandbox: "workspace-write" }),
            })
          );
          assert.lengthOf(requests, configs.length * 2);
        })
    );
  });
});
