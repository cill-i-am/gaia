import { assert, describe, it } from "@effect/vitest";
import { LocalGaiaServerOpenApi } from "./server-api.js";

describe("LocalGaiaServerApi contract", () => {
  it("publishes health and run read paths", () => {
    const paths = LocalGaiaServerOpenApi.paths;

    assert.containsAllKeys(paths, [
      "/health",
      "/runs",
      "/runs/{runId}",
      "/runs/{runId}/events",
      "/runs/{runId}/events/stream",
      "/runs/{runId}/artifacts/{artifactId}",
    ]);
    assert.isObject(paths["/health"]?.get);
    assert.isObject(paths["/runs"]?.get);
    assert.isObject(paths["/runs"]?.post);
    assert.isObject(paths["/runs/{runId}"]?.get);
    assert.isObject(paths["/runs/{runId}/events"]?.get);
    assert.isObject(paths["/runs/{runId}/events/stream"]?.get);
    assert.isObject(paths["/runs/{runId}/artifacts/{artifactId}"]?.get);
  });

  it("keeps success and error statuses explicit", () => {
    const paths = LocalGaiaServerOpenApi.paths;

    assert.deepEqual(responseStatuses(paths["/health"]?.get?.responses), [
      "200",
      "500",
    ]);
    assert.deepEqual(responseStatuses(paths["/runs"]?.get?.responses), [
      "200",
      "500",
    ]);
    assert.deepEqual(responseStatuses(paths["/runs"]?.post?.responses), [
      "202",
      "400",
      "405",
      "409",
      "422",
      "500",
    ]);
    assert.deepEqual(responseStatuses(paths["/runs/{runId}"]?.get?.responses), [
      "200",
      "400",
      "404",
      "422",
      "500",
    ]);
    assert.deepEqual(
      responseStatuses(paths["/runs/{runId}/events"]?.get?.responses),
      ["200", "400", "404", "422", "500"],
    );
    assert.deepEqual(
      responseStatuses(paths["/runs/{runId}/events/stream"]?.get?.responses),
      ["200", "400", "404", "405", "422", "500"],
    );
    assert.deepEqual(
      responseStatuses(
        paths["/runs/{runId}/artifacts/{artifactId}"]?.get?.responses,
      ),
      ["200", "400", "404", "422", "500"],
    );
    assertJsonSchemaRef(
      paths["/runs/{runId}"]?.get?.responses["400"],
      "#/components/schemas/LocalRunApiBadRequest",
    );
    assertJsonSchemaRef(
      paths["/runs/{runId}"]?.get?.responses["404"],
      "#/components/schemas/LocalRunApiNotFound",
    );
    assertJsonSchemaRef(
      paths["/runs"]?.post?.responses["409"],
      "#/components/schemas/LocalRunApiConflict",
    );
  });

  it("publishes a markdown-only create request schema", () => {
    const requestSchema =
      LocalGaiaServerOpenApi.paths["/runs"]?.post?.requestBody?.content?.[
        "application/json"
      ]?.schema;

    assert.deepEqual(requestSchema, {
      additionalProperties: false,
      properties: {
        specMarkdown: {
          allOf: [{ minLength: 1 }],
          type: "string",
        },
        title: {
          allOf: [{ minLength: 1 }],
          type: "string",
        },
      },
      required: ["specMarkdown"],
      type: "object",
    });
  });

  it("models path params and future SSE metadata", () => {
    const artifactParameters =
      LocalGaiaServerOpenApi.paths["/runs/{runId}/artifacts/{artifactId}"]?.get
        ?.parameters;
    const streamResponse =
      LocalGaiaServerOpenApi.paths["/runs/{runId}/events/stream"]?.get
        ?.responses["200"];
    const stream =
      streamResponse?.content?.["text/event-stream"]?.["x-effect-stream"];

    if (!Array.isArray(artifactParameters)) {
      assert.fail("Expected artifact endpoint parameters.");
    }

    assert.deepInclude(artifactParameters, {
      in: "path",
      name: "artifactId",
      required: true,
      schema: { type: "string" },
    });
    assert.deepInclude(artifactParameters, {
      in: "path",
      name: "runId",
      required: true,
      schema: { $ref: "#/components/schemas/RunId" },
    });
    assert.deepEqual(LocalGaiaServerOpenApi.components?.schemas?.RunId, {
      allOf: [{ pattern: "^run-[A-Za-z0-9_-]{10}$" }],
      type: "string",
    });
    assert.isObject(stream);
    assert.strictEqual(stream?.encoding, "sse");
  });
});

type OpenApiResponses =
  NonNullable<typeof LocalGaiaServerOpenApi.paths["/health"]["get"]>["responses"];

function responseStatuses(responses: OpenApiResponses | undefined) {
  if (responses === undefined) {
    assert.fail("Expected responses.");
  }

  return Object.keys(responses);
}

function assertJsonSchemaRef(response: unknown, ref: string) {
  const schema =
    typeof response === "object" &&
    response !== null &&
    "content" in response &&
    typeof response.content === "object" &&
    response.content !== null &&
    "application/json" in response.content &&
    typeof response.content["application/json"] === "object" &&
    response.content["application/json"] !== null &&
    "schema" in response.content["application/json"]
      ? response.content["application/json"].schema
      : undefined;
  assert.deepEqual(schema, { $ref: ref });
}
