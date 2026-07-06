import { assert, describe, it } from "@effect/vitest";
import { OpenApi } from "effect/unstable/httpapi";
import { LocalGaiaServerApi } from "./server-api.js";

const spec = OpenApi.fromApi(LocalGaiaServerApi);

describe("LocalGaiaServerApi contract", () => {
  it("declares health and run read endpoints", () => {
    assertMethod("/health", "get");
    assertMethod("/runs", "get");
    assertMethod("/runs", "post");
    assertMethod("/runs/{runId}", "get");
    assertMethod("/runs/{runId}/events", "get");
    assertMethod("/runs/{runId}/events/stream", "get");
    assertMethod("/runs/{runId}/artifacts/{artifactId}", "get");
  });

  it("declares success and exact typed error statuses", () => {
    assertResponses("/health", "get", [200, 500]);
    assertResponses("/runs", "get", [200, 500]);
    assertResponses("/runs", "post", [202, 400, 405, 409, 500]);
    assertResponses("/runs/{runId}", "get", [200, 400, 404, 500]);
    assertResponses("/runs/{runId}/events", "get", [200, 400, 404, 500]);
    assertResponses("/runs/{runId}/events/stream", "get", [
      200,
      400,
      404,
      405,
      500,
    ]);
    assertResponses("/runs/{runId}/artifacts/{artifactId}", "get", [
      200,
      400,
      404,
      500,
    ]);
  });

  it("declares run and artifact id params plus SSE stream metadata", () => {
    for (const path of [
      "/runs/{runId}",
      "/runs/{runId}/events",
      "/runs/{runId}/events/stream",
      "/runs/{runId}/artifacts/{artifactId}",
    ]) {
      const runIdParam = pathParameter(operation(path, "get"), "runId");
      assert.strictEqual(
        getSchemaString(runIdParam, "pattern"),
        "^run-[A-Za-z0-9_-]{10}$",
      );
    }

    const artifactGet = operation("/runs/{runId}/artifacts/{artifactId}", "get");
    pathParameter(artifactGet, "artifactId");

    const streamGet = operation("/runs/{runId}/events/stream", "get");
    const content = streamGet.responses[200]?.content ?? {};
    assert.property(content, "text/event-stream");
    const streamExtension = content["text/event-stream"]?.["x-effect-stream"];
    assert.isNotNull(streamExtension);
    if (streamExtension?.encoding !== "sse") {
      throw new Error("Expected text/event-stream to carry SSE metadata.");
    }
  });
});

type Method = "get" | "post";

function assertMethod(path: string, method: Method) {
  assert.property(spec.paths, path);
  assert.property(spec.paths[path] ?? {}, method);
}

function assertResponses(path: string, method: Method, statuses: ReadonlyArray<number>) {
  const responses = operation(path, method).responses;
  assert.deepStrictEqual(
    Object.keys(responses)
      .map((status) => Number.parseInt(status, 10))
      .sort((a, b) => a - b),
    [...statuses].sort((a, b) => a - b),
  );
}

function operation(path: string, method: Method) {
  const pathItem = spec.paths[path];
  if (pathItem === undefined) {
    throw new Error(`Expected OpenAPI path ${path}.`);
  }

  const op = pathItem[method];
  if (op === undefined) {
    throw new Error(`Expected OpenAPI operation ${method.toUpperCase()} ${path}.`);
  }

  return op;
}

function pathParameter(
  op: ReturnType<typeof operation>,
  name: string,
): { readonly schema?: object } {
  const parameter = (op.parameters ?? []).find(
    (parameter) => parameter.name === name && parameter.in === "path",
  );
  if (parameter === undefined) {
    throw new Error(`Expected path parameter ${name}.`);
  }

  return parameter;
}

function getSchemaString(
  parameter: { readonly schema?: object },
  key: string,
) {
  const schema = parameter.schema;
  if (schema === undefined) {
    throw new Error("Expected parameter schema.");
  }

  const value = Object.entries(schema).find(([entryKey]) => entryKey === key)?.[1];
  if (typeof value !== "string") {
    throw new Error(`Expected parameter schema ${key} to be a string.`);
  }

  return value;
}
