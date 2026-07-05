import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { runSpecFile } from "@gaia/runtime";
import { Effect, FileSystem, Path } from "effect";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleGaiaApiRequest } from "./server.js";

describe("Gaia local API", () => {
  it("lists runs with partial diagnostics for invalid run directories", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "gaia-server-"));
    const specPath = join(cwd, "spec.md");
    await writeFile(specPath, "Serve run list.\n");
    const summary = await runRuntime(runSpecFile(specPath, { rootDirectory: cwd }));
    await mkdirp(join(cwd, ".gaia", "runs", "run-not-a-valid-id"));
    const response = await handleGaiaApiRequest("GET", "/runs", {
      rootDirectory: cwd,
    });
    const body = response.body as {
      status: string;
      data: { runs: ReadonlyArray<{ runId: string }> };
      diagnostics: ReadonlyArray<{ code: string; pathSegment: string }>;
    };

    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(body.status, "partial");
    assert.deepEqual(body.data.runs.map((run) => run.runId), [summary.runId]);
    assert.isDefined(
      body.diagnostics.find(
        (diagnostic) =>
          diagnostic.code === "InvalidRunDirectory" &&
          diagnostic.pathSegment === "run-not-a-valid-id",
      ),
    );
  });

  it("serves run detail, event logs, and allowlisted artifacts", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "gaia-server-"));
    const specPath = join(cwd, "spec.md");
    await writeFile(specPath, "Serve run detail.\n");
    const summary = await runRuntime(runSpecFile(specPath, { rootDirectory: cwd }));
    const detail = await handleGaiaApiRequest("GET", `/runs/${summary.runId}`, {
      rootDirectory: cwd,
    });
    const events = await handleGaiaApiRequest(
      "GET",
      `/runs/${summary.runId}/events`,
      { rootDirectory: cwd },
    );
    const artifact = await handleGaiaApiRequest(
      "GET",
      `/runs/${summary.runId}/artifacts/report.json`,
      { rootDirectory: cwd },
    );
    const detailBody = detail.body as {
      status: string;
      data: { eventCount: number; runId: string; state: string };
    };
    const eventsBody = events.body as {
      data: { events: ReadonlyArray<unknown> };
    };
    const artifactBody = artifact.body as {
      data: { artifactName: string; encoding: string };
    };

    assert.strictEqual(detail.statusCode, 200);
    assert.strictEqual(events.statusCode, 200);
    assert.strictEqual(artifact.statusCode, 200);
    assert.strictEqual(detailBody.status, "success");
    assert.strictEqual(detailBody.data.runId, summary.runId);
    assert.strictEqual(detailBody.data.state, "completed");
    assert.strictEqual(eventsBody.data.events.length, detailBody.data.eventCount);
    assert.strictEqual(artifactBody.data.artifactName, "report.json");
    assert.strictEqual(artifactBody.data.encoding, "json");
  });

  it("rejects malformed run ids and non-allowlisted artifacts", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "gaia-server-"));
    const specPath = join(cwd, "spec.md");
    await writeFile(specPath, "Reject unsafe reads.\n");
    const summary = await runRuntime(runSpecFile(specPath, { rootDirectory: cwd }));
    const malformed = await handleGaiaApiRequest("GET", "/runs/nope", {
      rootDirectory: cwd,
    });
    const artifact = await handleGaiaApiRequest(
      "GET",
      `/runs/${summary.runId}/artifacts/events.jsonl`,
      { rootDirectory: cwd },
    );
    const artifactBody = artifact.body as {
      error: { code: string; message: string };
    };

    assert.strictEqual(malformed.statusCode, 400);
    assert.strictEqual(artifact.statusCode, 400);
    assert.strictEqual(artifactBody.error.code, "ArtifactNotAllowlisted");
    assert.notInclude(artifactBody.error.message, "events.jsonl at line");
  });
});

async function runRuntime<A>(
  effect: Effect.Effect<A, unknown, FileSystem.FileSystem | Path.Path>,
) {
  return Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)));
}

async function mkdirp(path: string) {
  await mkdir(path, { recursive: true });
}
