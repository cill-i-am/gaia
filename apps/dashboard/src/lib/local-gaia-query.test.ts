import { expect, it, describe } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { Effect, Layer } from "effect";
import { createEffectQuery } from "effect-query";
import { FetchHttpClient } from "effect/unstable/http";

import {
  defaultLocalGaiaServerUrl,
  getRunArtifactFromDashboardGaiaClient,
  getRunFromDashboardGaiaClient,
  listRunsFromDashboardGaiaClient,
} from "@/lib/local-gaia-client";
import {
  localGaiaCreateRunMutationOptions,
  localGaiaHealthQueryOptions,
  localGaiaQueryKeys,
  localGaiaRunArtifactQueryOptions,
  localGaiaRunQueryOptions,
  localGaiaRunsQueryOptions,
} from "@/lib/local-gaia-query";

describe("local Gaia query options", () => {
  it("keeps browser dashboard requests on the same-origin proxy path", () => {
    expect(defaultLocalGaiaServerUrl).toBe("/gaia-api");
  });

  it("constructs stable TanStack Query options through effect-query", () => {
    const health = localGaiaHealthQueryOptions({
      serverUrl: "http://127.0.0.1:4321",
    });
    const runs = localGaiaRunsQueryOptions({
      serverUrl: "http://127.0.0.1:4321",
    });
    const artifact = localGaiaRunArtifactQueryOptions({
      artifactId: "report",
      runId: "run-1234567890",
      serverUrl: "http://127.0.0.1:4321",
    });

    expect(health.queryKey).toEqual(localGaiaQueryKeys.health());
    expect(runs.queryKey).toEqual(localGaiaQueryKeys.runs());
    expect(artifact.queryKey).toEqual([
      "local-gaia",
      "runs",
      "detail",
      "run-1234567890",
      "artifact",
      "report",
    ]);
    expect(artifact.enabled).toBe(true);
    expect(typeof health.queryFn).toBe("function");
    expect(typeof runs.queryFn).toBe("function");
  });

  it("decodes run lists through the shared HttpApi contract", async () => {
    const requests: Array<string> = [];
    const result = await Effect.runPromise(
      listRunsFromDashboardGaiaClient({
        serverUrl: "http://127.0.0.1:4321",
      }).pipe(
        Effect.provide(
          recordingFetchLayer(requests, () =>
            jsonResponse({
              data: { diagnostics: [], runs: [] },
              status: "success",
            }),
          ),
        ),
      ),
    );

    expect(result.data.runs).toEqual([]);
    expect(requests).toEqual(["GET http://127.0.0.1:4321/runs"]);
  });

  it("maps declared API failures into a tagged dashboard query error", async () => {
    const error = await Effect.runPromise(
      getRunFromDashboardGaiaClient({
        runId: "run-1234567890",
        serverUrl: "http://127.0.0.1:4321",
      }).pipe(
        Effect.provide(
          recordingFetchLayer([], () =>
            jsonResponse(
              {
                code: "RunNotFound",
                message: "Run was not found.",
                recoverable: false,
                runId: "run-1234567890",
                status: 404,
              },
              { status: 404 },
            ),
          ),
        ),
        Effect.flip,
      ),
    );

    expect(error._tag).toBe("DashboardGaiaApiError");
    if (error._tag === "DashboardGaiaApiError") {
      expect(error.error.status).toBe(404);
      expect(error.error.code).toBe("RunNotFound");
      expect(error.error.message).toBe("Run was not found.");
    }
  });

  it("reads allowlisted artifacts through the shared HttpApi contract", async () => {
    const requests: Array<string> = [];
    const result = await Effect.runPromise(
      getRunArtifactFromDashboardGaiaClient({
        artifactId: "report",
        runId: "run-1234567890",
        serverUrl: "http://127.0.0.1:4321",
      }).pipe(
        Effect.provide(
          recordingFetchLayer(requests, () =>
            jsonResponse({
              data: {
                artifactName: "report",
                body: "# Report\n\nAll checks passed.\n",
                contentType: "text/markdown",
                runId: "run-1234567890",
              },
              status: "success",
            }),
          ),
        ),
      ),
    );

    expect(requests).toEqual([
      "GET http://127.0.0.1:4321/runs/run-1234567890/artifacts/report",
    ]);
    expect(result.data.artifactName).toBe("report");
    expect(result.data.body).toContain("All checks passed.");
  });

  it("rejects empty artifact identifiers before issuing a request", async () => {
    const requests: Array<string> = [];
    const error = await Effect.runPromise(
      getRunArtifactFromDashboardGaiaClient({
        artifactId: "",
        runId: "run-1234567890",
        serverUrl: "http://127.0.0.1:4321",
      }).pipe(
        Effect.provide(
          recordingFetchLayer(requests, () =>
            jsonResponse({
              data: {
                artifactName: "report",
                body: "",
                contentType: "text/plain",
                runId: "run-1234567890",
              },
              status: "success",
            }),
          ),
        ),
        Effect.flip,
      ),
    );

    expect(requests).toEqual([]);
    expect(error._tag).toBe("DashboardGaiaParameterError");
    if (error._tag === "DashboardGaiaParameterError") {
      expect(error.parameter).toBe("artifactId");
    }
  });

  it("surfaces typed client failures through effect-query and TanStack Query", async () => {
    const effectQuery = createEffectQuery(
      recordingFetchLayer([], () =>
        jsonResponse(
          {
            code: "RunNotFound",
            message: "Run was not found.",
            recoverable: false,
            runId: "run-1234567890",
            status: 404,
          },
          { status: 404 },
        ),
      ),
    );

    const queryClient = new QueryClient();
    await queryClient
      .fetchQuery(
        effectQuery.queryOptions({
          queryKey: localGaiaQueryKeys.run("run-1234567890"),
          queryFn: () =>
            getRunFromDashboardGaiaClient({
              runId: "run-1234567890",
              serverUrl: "http://127.0.0.1:4321",
            }),
          retry: false,
        }),
      )
      .then(
        () => {
          throw new Error("Expected fetchQuery to fail.");
        },
        (error: unknown) => {
          expect(effectQueryFailure(error)?._tag).toBe("DashboardGaiaApiError");
        },
      );
  });

  it("creates Markdown runs through the exported effect-query mutation options", async () => {
    const requests: Array<string> = [];
    const bodies: Array<unknown> = [];
    const createRunInput = {
      specMarkdown: "# Mutation proof\n\nRun the focused test.\n",
      title: "Mutation proof",
    };
    const createRunResponse = {
      acceptedAt: "2026-07-07T00:00:00.000Z",
      runId: "run-1234567890",
      status: "accepted",
      urls: {
        activity: "/runs/run-1234567890/activity",
        artifacts: "/runs/run-1234567890/artifacts",
        factoryGraph: "/runs/run-1234567890/factory-graph",
        run: "/runs/run-1234567890",
      },
    };
    const effectQuery = createEffectQuery(
      recordingFetchLayer(requests, async (request) => {
        const body: unknown = await request.json();
        bodies.push(body);
        return jsonResponse(createRunResponse, { status: 202 });
      }),
    );
    const mutation = localGaiaCreateRunMutationOptions(
      {
        serverUrl: "http://127.0.0.1:4321",
      },
      effectQuery,
    );

    expect(typeof mutation.mutationFn).toBe("function");
    if (mutation.mutationFn === undefined) {
      throw new Error("Expected create-run mutationFn to be defined.");
    }

    const result = await mutation.mutationFn(createRunInput, {
      client: new QueryClient(),
      meta: undefined,
    });

    expect(requests).toEqual(["POST http://127.0.0.1:4321/runs"]);
    expect(bodies).toEqual([
      {
        workflow: "issueDelivery",
        workItem: {
          description: createRunInput.specMarkdown,
          kind: "issue",
          title: createRunInput.title,
        },
      },
    ]);
    expect(result).toEqual(createRunResponse);
  });
});

function recordingFetchLayer(
  requests: Array<string>,
  respond: (request: Request) => Response | Promise<Response>,
) {
  const recordingFetch: typeof globalThis.fetch = (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    requests.push(`${request.method} ${request.url}`);
    return Promise.resolve(respond(request));
  };

  return Layer.provide(
    FetchHttpClient.layer,
    Layer.succeed(FetchHttpClient.Fetch, recordingFetch),
  );
}

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(body), {
    ...init,
    headers,
  });
}

function effectQueryFailure(error: unknown) {
  if (typeof error !== "object" || error === null || !("failure" in error)) {
    return undefined;
  }

  const failure = error.failure;
  if (typeof failure === "object" && failure !== null && "_tag" in failure) {
    return failure;
  }

  return undefined;
}
