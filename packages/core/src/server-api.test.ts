import { assert, describe, it } from "@effect/vitest";
import { Schema } from "effect";
import {
  CreateRunRequest,
  DeliveryActionRequestSchema,
  DeliveryRecoveryActionRequestSchema,
  DeliverySnapshotDto,
  LocalGaiaServerOpenApi,
} from "./server-api.js";

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
      "/runs/{runId}/delivery",
      "/runs/{runId}/delivery/actions",
      "/runs/{runId}/delivery/stream",
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
    assert.isObject(paths["/runs/{runId}/delivery"]?.get);
    assert.isObject(paths["/runs/{runId}/delivery/actions"]?.post);
    assert.isObject(paths["/runs/{runId}/delivery/stream"]?.get);
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
      responseStatuses(paths["/runs/{runId}/delivery"]?.get?.responses),
      ["200", "400", "404", "422", "500"],
    );
    assertJsonSchemaRef(
      paths["/runs/{runId}/delivery"]?.get?.responses["200"],
      "#/components/schemas/DeliverySnapshotSuccessEnvelope",
    );
    assert.deepEqual(
      responseStatuses(paths["/runs/{runId}/delivery/actions"]?.post?.responses),
      ["200", "400", "404", "409", "422", "500"],
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
        delivery: { mode: "local" },
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
    assert.doesNotThrow(() =>
      decodeCreateRunRequest({
        delivery: { mode: "pullRequest" },
        execution: { harnessProfileId: "codexAppServer" },
        workflow: "issueDelivery",
        workItem: {
          description: "Implement the contract slice.",
          kind: "issue",
          title: "Define FactoryGraph contracts",
        },
      }),
    );
    assert.throws(() =>
      decodeCreateRunRequest({
        delivery: { mode: "workspacePr" },
        execution: { harnessProfileId: "codexAppServer" },
        workflow: "issueDelivery",
        workItem: {
          description: "Unsupported delivery mode.",
          kind: "issue",
          title: "Define FactoryGraph contracts",
        },
      }),
    );
    assert.throws(() =>
      decodeCreateRunRequest({
        delivery: { mode: "pullRequest", repositoryPath: "/tmp/gaia" },
        execution: { harnessProfileId: "codexAppServer" },
        workflow: "issueDelivery",
        workItem: {
          description: "Repository path is not public policy.",
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

  it("strictly parses optimistic delivery recovery actions", () => {
    const decode = Schema.decodeUnknownSync(
      DeliveryRecoveryActionRequestSchema,
    );

    const action = decode({ expectedEventSequence: 9, kind: "reconcile" });
    assert.strictEqual(action.expectedEventSequence, 9);
    assert.strictEqual(action.kind, "reconcile");
    assert.throws(() =>
      decode({ expectedEventSequence: 0, kind: "retry" }),
    );
    assert.throws(() =>
      decode({
        expectedEventSequence: 9,
        force: true,
        kind: "retry",
      }),
    );
  });

  it("requires the exact expected branch on merge actions", () => {
    const decode = Schema.decodeUnknownSync(DeliveryActionRequestSchema);
    const action = { actionId: "merge-1", expectedBranchName: "gaia/run-1234567890", expectedDecisionSequence: 9, expectedHeadSha: "a".repeat(40), expectedPolicyDigest: "b".repeat(64), expectedPrUrl: "https://github.com/cill-i-am/gaia/pull/74", kind: "merge", mergeMethod: "merge" };
    assert.strictEqual(decode(action).kind, "merge");
    const { expectedBranchName: _expectedBranchName, ...missing } = action;
    assert.throws(() => decode(missing));
    assert.throws(() => decode({ ...action, expectedBranchName: "" }));
  });

  it("accepts audited worker continuation actions without native checkpoint fields", () => {
    const decode = Schema.decodeUnknownSync(DeliveryActionRequestSchema);
    const request = {
      actionId: "continue-recovery-1",
      expectedContaminatedReadySequence: 6,
      expectedCurrentSequence: 17,
      expectedDeliveryProvenanceDigest: "c".repeat(64),
      expectedFailedRecoverySequence: 16,
      expectedRecoveryActionId: "recover-1",
      expectedSessionId: "session-run-1234567890",
      harnessProfileId: "codexAppServer",
      kind: "continueInterruptedWorkerRecovery",
    } as const;

    const decoded = decode(request);
    assert.strictEqual(decoded.kind, "continueInterruptedWorkerRecovery");
    assert.throws(() => decode({ ...request, nativeTurnId: "turn-private" }));
    assert.throws(() => decode({ ...request, nativeTurnIdDigest: "a".repeat(64) }));
    assert.throws(() => decode({ ...request, protocol: "codex-app-server" }));
  });

  it("accepts audited worker correlation reconciliation actions without native checkpoint fields", () => {
    const decode = Schema.decodeUnknownSync(DeliveryActionRequestSchema);
    const request = {
      actionId: "reconcile-correlation-1",
      expectedContaminatedReadySequence: 6,
      expectedContinuationActionId: "continue-recovery-1",
      expectedCurrentSequence: 35,
      expectedDeliveryProvenanceDigest: "c".repeat(64),
      expectedFailedContinuationSequence: 35,
      expectedFailedRecoverySequence: 31,
      expectedNativeTurnIdDigest: "d".repeat(64),
      expectedRecoveryActionId: "recover-1",
      expectedSessionId: "session-run-1234567890",
      harnessProfileId: "codexAppServer",
      kind: "reconcileInterruptedWorkerCorrelation",
    } as const;

    const decoded = decode(request);
    assert.strictEqual(decoded.kind, "reconcileInterruptedWorkerCorrelation");
    assert.throws(() => decode({ ...request, nativeTurnId: "turn-private" }));
    assert.throws(() => decode({ ...request, nativeThreadId: "thread-private" }));
    assert.throws(() => decode({ ...request, protocol: "codex-app-server" }));
  });

  it("accepts audited Desktop-origin correlation actions without raw native identity fields", () => {
    const decode = Schema.decodeUnknownSync(DeliveryActionRequestSchema);
    const request = {
      actionId: "reconcile-desktop-origin-1",
      expectedContaminatedReadySequence: 6,
      expectedContinuationActionId: "continue-recovery-1",
      expectedCorrelationActionId: "reconcile-correlation-1",
      expectedCurrentSequence: 38,
      expectedDeliveryProvenanceDigest: "c".repeat(64),
      expectedFailedContinuationSequence: 35,
      expectedFailedCorrelationSequence: 38,
      expectedFailedRecoverySequence: 31,
      expectedNativeTurnIdDigest: "d".repeat(64),
      expectedRecoveryActionId: "recover-1",
      expectedSessionId: "session-run-1234567890",
      harnessProfileId: "codexAppServer",
      kind: "reconcileDesktopOriginatedWorkerCorrelation",
    } as const;

    const decoded = decode(request);
    assert.strictEqual(decoded.kind, "reconcileDesktopOriginatedWorkerCorrelation");
    assert.throws(() => decode({ ...request, nativeTurnId: "turn-private" }));
    assert.throws(() => decode({ ...request, nativeThreadId: "thread-private" }));
    assert.throws(() => decode({ ...request, source: "vscode" }));
    assert.throws(() => decode({ ...request, protocol: "codex-app-server" }));
  });

  it("drops private cleanup provenance from parsed and serialized delivery snapshots", () => {
    const hostile = "/HOSTILE/absolute/common-dir::PRIVATE_TOKEN_93";
    const decode = Schema.decodeUnknownSync(DeliverySnapshotDto);
    const encode = Schema.encodeSync(Schema.toCodecJson(DeliverySnapshotDto));
    const snapshot = decode({
      actionAudit: { cleanup: [], merge: [] },
      eventSequence: 12,
      mode: "pullRequest",
      ownershipToken: hostile,
      privateProvenance: { repositoryCommonDir: hostile, worktreePath: hostile },
      recoveryActions: [],
      runId: "run-1234567890",
      stage: "cleanupRequired",
      status: "cleanupRequired",
    });
    const serialized = JSON.stringify(encode(snapshot));
    assert.notInclude(serialized, hostile);
    assert.notInclude(serialized, "ownershipToken");
    assert.notInclude(serialized, "privateProvenance");
  });

  it("strictly parses one exact controlled remediation activation", () => {
    const decode = Schema.decodeUnknownSync(DeliveryActionRequestSchema);
    const request = {
      actionIdempotencyKey: "activate-run-92-attempt-1",
      actorLogin: "cill-i-am",
      actorType: "User",
      authorAssociation: "OWNER",
      authorizationDigest: "a".repeat(64),
      commentDatabaseId: "4945491708",
      contentDigest: "b".repeat(64),
      expectedEventSequence: 41,
      feedbackId: `feedback-comment-${"c".repeat(64)}`,
      headSha: "d".repeat(40),
      kind: "activateRemediation",
      marker: "<!-- gaia-remediation-request:v1 -->",
      prNumber: 73,
      repository: "cill-i-am/gaia",
    } as const;

    const decoded = decode(request);
    assert.strictEqual(decoded.kind, "activateRemediation");
    if (decoded.kind !== "activateRemediation") {
      assert.fail("Expected a controlled remediation activation.");
    }
    assert.strictEqual(decoded.actionIdempotencyKey, request.actionIdempotencyKey);
    assert.strictEqual(decoded.authorizationDigest, request.authorizationDigest);
    assert.throws(() => decode({ ...request, prompt: "do anything" }));
    assert.throws(() => decode({ ...request, actorType: "Bot" }));
    assert.throws(() => decode({ ...request, authorAssociation: "NONE" }));
    assert.throws(() => decode({ ...request, expectedEventSequence: 0 }));
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
