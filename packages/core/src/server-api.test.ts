import { assert, describe, it } from "@effect/vitest";
import { Schema } from "effect";
import { CreateRunRequest, LocalGaiaServerOpenApi } from "./server-api.js";

describe("LocalGaiaServerApi contract", () => {
  it("publishes fresh factory run paths", () => {
    const paths = LocalGaiaServerOpenApi.paths;

    assert.containsAllKeys(paths, [
      "/health",
      "/runs",
      "/runs/{runId}",
      "/runs/{runId}/activity",
      "/runs/{runId}/agents/{agentId}/activity",
      "/runs/{runId}/agents/{agentId}/session",
      "/runs/{runId}/agents/{agentId}/session/actions",
      "/runs/{runId}/agents/{agentId}/session/stream",
      "/runs/{runId}/artifacts/{artifactId}",
      "/runs/{runId}/artifacts",
      "/runs/{runId}/factory-graph",
    ]);
    assert.isObject(paths["/health"]?.get);
    assert.isObject(paths["/runs"]?.get);
    assert.isObject(paths["/runs"]?.post);
    assert.isObject(paths["/runs/{runId}"]?.get);
    assert.isUndefined(paths["/runs/{runId}/events"]);
    assert.isUndefined(paths["/runs/{runId}/events/stream"]);
    assert.isObject(paths["/runs/{runId}/activity"]?.get);
    assert.isObject(paths["/runs/{runId}/agents/{agentId}/activity"]?.get);
    assert.isObject(paths["/runs/{runId}/agents/{agentId}/session"]?.get);
    assert.isObject(paths["/runs/{runId}/agents/{agentId}/session/actions"]?.post);
    assert.isObject(paths["/runs/{runId}/agents/{agentId}/session/stream"]?.get);
    assert.isObject(paths["/runs/{runId}/artifacts"]?.get);
    assert.isObject(paths["/runs/{runId}/artifacts/{artifactId}"]?.get);
    assert.isObject(paths["/runs/{runId}/factory-graph"]?.get);
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
    assertJsonSchemaRef(
      paths["/runs"]?.get?.responses["200"],
      "#/components/schemas/FactoryRunListSuccessEnvelope",
    );
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
    assertJsonSchemaRef(
      paths["/runs/{runId}"]?.get?.responses["200"],
      "#/components/schemas/FactoryRunDetailSuccessEnvelope",
    );
    assert.deepEqual(
      responseStatuses(paths["/runs/{runId}/factory-graph"]?.get?.responses),
      ["200", "400", "404", "422", "500"],
    );
    assert.deepEqual(
      responseStatuses(paths["/runs/{runId}/activity"]?.get?.responses),
      ["200", "400", "404", "422", "500"],
    );
    assert.deepEqual(
      responseStatuses(paths["/runs/{runId}/agents/{agentId}/activity"]?.get?.responses),
      ["200", "400", "404", "422", "500"],
    );
    assert.deepEqual(
      responseStatuses(paths["/runs/{runId}/agents/{agentId}/session"]?.get?.responses),
      ["200", "400", "404", "422", "500"],
    );
    assertJsonSchemaRef(
      paths["/runs/{runId}/agents/{agentId}/session"]?.get?.responses["200"],
      "#/components/schemas/AgentSessionSnapshotSuccessEnvelope",
    );
    assert.deepEqual(
      responseStatuses(paths["/runs/{runId}/agents/{agentId}/session/stream"]?.get?.responses),
      ["200", "400", "404", "409", "405", "422", "500"].sort(),
    );
    assert.deepEqual(
      responseStatuses(paths["/runs/{runId}/agents/{agentId}/session/actions"]?.post?.responses),
      ["200", "400", "404", "409", "422", "500"],
    );
    assertJsonSchemaRef(
      paths["/runs/{runId}/agents/{agentId}/session/actions"]?.post?.responses["200"],
      "#/components/schemas/AgentActionSuccessEnvelope",
    );
    assert.deepEqual(
      responseStatuses(paths["/runs/{runId}/artifacts"]?.get?.responses),
      ["200", "400", "404", "422", "500"],
    );
    assert.deepEqual(
      responseStatuses(
        paths["/runs/{runId}/artifacts/{artifactId}"]?.get?.responses,
      ),
      ["200", "400", "404", "422", "500"],
    );
    assertJsonSchemaRef(
      paths["/runs/{runId}/artifacts/{artifactId}"]?.get?.responses["200"],
      "#/components/schemas/FactoryArtifactSuccessEnvelope",
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

  it("models factory graph path params and schemas", () => {
    const artifactParameters =
      LocalGaiaServerOpenApi.paths["/runs/{runId}/artifacts/{artifactId}"]?.get
        ?.parameters;
    const agentActivityParameters =
      LocalGaiaServerOpenApi.paths["/runs/{runId}/agents/{agentId}/activity"]?.get
        ?.parameters;

    if (!Array.isArray(artifactParameters)) {
      assert.fail("Expected artifact endpoint parameters.");
    }
    if (!Array.isArray(agentActivityParameters)) {
      assert.fail("Expected agent activity endpoint parameters.");
    }

    assert.deepInclude(artifactParameters, {
      in: "path",
      name: "artifactId",
      required: true,
      schema: { $ref: "#/components/schemas/FactoryArtifactId" },
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
    assert.deepInclude(agentActivityParameters, {
      in: "path",
      name: "agentId",
      required: true,
      schema: { $ref: "#/components/schemas/FactoryAgentId" },
    });
    assert.deepEqual(
      LocalGaiaServerOpenApi.components?.schemas?.FactoryAgentRole,
      {
        enum: [
          "orchestrator",
          "worker",
          "reviewer",
          "tester",
          "ciWatcher",
          "researcher",
          "unknown",
        ],
        type: "string",
      },
    );
    assert.deepEqual(
      LocalGaiaServerOpenApi.components?.schemas?.LocalRunApiNotFound,
      {
        additionalProperties: false,
        properties: {
          artifactName: { type: "string" },
          code: {
            enum: [
              "ArtifactNotAllowed",
              "ArtifactNotFound",
              "EndpointNotFound",
              "FactoryAgentNotFound",
              "FactoryGraphNotFound",
              "RunNotFound",
            ],
            type: "string",
          },
          message: { allOf: [{ minLength: 1 }], type: "string" },
          pathSegment: { type: "string" },
          recoverable: { type: "boolean" },
          runId: { $ref: "#/components/schemas/RunId" },
          status: { enum: [404], type: "number" },
        },
        required: ["message", "recoverable", "code", "status"],
        type: "object",
      },
    );
  });

  it("accepts only fresh issue delivery create requests", () => {
    const decodeCreateRunRequest = Schema.decodeUnknownSync(CreateRunRequest);

    assert.doesNotThrow(() =>
      decodeCreateRunRequest({
        execution: { harnessProfileId: "codexAppServer" },
        workflow: "issueDelivery",
        workItem: {
          description: "Implement the contract slice.",
          externalRefs: [{ id: "GAIA-65", provider: "linear" }],
          kind: "issue",
          title: "Define FactoryGraph contracts",
        },
      }),
    );
    assert.throws(() =>
      decodeCreateRunRequest({
        workflow: "issueDelivery",
        workItem: {
          description: "Execution selection is required.",
          kind: "issue",
          title: "Define FactoryGraph contracts",
        },
      }),
    );
    assert.throws(() =>
      decodeCreateRunRequest({
        execution: { harnessProfileId: "fake" },
        workflow: "issueDelivery",
        workItem: {
          description: "Fake is not a production issue-delivery profile.",
          kind: "issue",
          title: "Define FactoryGraph contracts",
        },
      }),
    );
    assert.throws(() =>
      decodeCreateRunRequest({
        execution: {
          command: "/usr/local/bin/codex",
          harnessProfileId: "codexAppServer",
        },
        workflow: "issueDelivery",
        workItem: {
          description: "Execution internals are not public request fields.",
          kind: "issue",
          title: "Define FactoryGraph contracts",
        },
      }),
    );
    assert.throws(() =>
      decodeCreateRunRequest({
        specMarkdown: "Legacy body is not accepted.\n",
      }),
    );
    assert.throws(() =>
      decodeCreateRunRequest({
        execution: { harnessProfileId: "codexAppServer" },
        workflow: "issueDelivery",
        workItem: {
          description: "Projects are a later slice.",
          kind: "project",
          title: "Project delivery",
        },
      }),
    );
    assert.throws(() =>
      decodeCreateRunRequest({
        execution: { harnessProfileId: "codexAppServer" },
        profile: "default",
        workflow: "issueDelivery",
        workItem: {
          description: "Unknown top-level fields fail loudly.",
          kind: "issue",
          title: "Define FactoryGraph contracts",
        },
      }),
    );
    assert.throws(() =>
      decodeCreateRunRequest({
        execution: { harnessProfileId: "codexAppServer" },
        workflow: "issueDelivery",
        workItem: {
          description: "Unknown nested fields fail loudly.",
          kind: "issue",
          title: "Define FactoryGraph contracts",
          workspaceSource: ".",
        },
      }),
    );
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
