import { assert, describe, it } from "@effect/vitest";
import { Schema } from "effect";

import {
  CreateRunRequest,
  DeliveryActionRequestSchema,
  DeliveryRecoveryActionRequestSchema,
  DeliverySnapshotDto,
  HealthResponse,
  LocalRunReadArtifactSchema,
  LocalRunReadDiagnosticSchema,
  LocalRunReadListSchema,
  LocalRunModelManifestArtifactSchema,
  LocalRunReadDiagnosticCodeSchema,
  LocalRunReadStatusSchema,
  LocalRunReadSummarySchema,
  LegacyLocalRunReadSummaryIngress,
  LocalGaiaServerOpenApi,
  ServerMetadata,
  VerificationActionSuccessEnvelope,
  VerificationActionRequestSchema,
  parseLocalRunArtifactId,
  parseLocalRunArtifactName,
  parseLocalRunPathSegment,
  parseLocalRunTimestamp,
} from "./server-api.js";

describe("local run legacy ingress", () => {
  it("defaults only the encoded omission and re-encodes an explicit manifest list", () => {
    const legacy = {
      artifacts: ["events"],
      createdAt: "2026-07-21T00:00:00.000Z",
      eventCount: 1,
      latestEventType: "RUN_CREATED",
      runId: "run-1234567890",
      state: "created",
      status: "running",
      updatedAt: "2026-07-21T00:00:00.000Z",
    } as const;
    const decoded = Schema.decodeUnknownSync(LegacyLocalRunReadSummaryIngress)(
      legacy
    );
    assert.deepEqual(decoded.modelInvocationArtifacts, []);
    assert.deepEqual(
      Schema.encodeSync(LegacyLocalRunReadSummaryIngress)(decoded)
        .modelInvocationArtifacts,
      []
    );
    assert.throws(() =>
      Schema.decodeUnknownSync(LocalRunReadSummarySchema)(legacy)
    );
    assert.throws(() =>
      Schema.decodeUnknownSync(LocalRunModelManifestArtifactSchema)({
        artifactId: `mmf1_${"a".repeat(64)}`,
        availability: "unavailable",
        bodyDigest: "b".repeat(64),
        byteLength: 100,
        contentType: "application/json",
        episodeId: `episode1_${"c".repeat(64)}`,
        episodeRole: "workerInitial",
        identityDigest: "d".repeat(64),
        manifestId: `mctx1_${"d".repeat(64)}`,
        manifestKind: "modelContextManifest",
        version: 1,
      })
    );
  });

  it("preserves a routed epoch while allowing older legacy wire omission", () => {
    const legacy = {
      artifacts: ["events"],
      createdAt: "2026-07-21T00:00:00.000Z",
      eventCount: 1,
      latestEventType: "RUN_CREATED",
      modelInvocationArtifacts: [],
      runId: "run-1234567890",
      state: "created",
      status: "running",
      updatedAt: "2026-07-21T00:00:00.000Z",
    } as const;
    const withoutEpoch = Schema.decodeUnknownSync(LocalRunReadSummarySchema)(
      legacy
    );
    const withEpoch = Schema.decodeUnknownSync(LocalRunReadSummarySchema)({
      ...legacy,
      workerEnvironmentEpoch: {
        limitations: ["providerNativeToolInventoryNotExposed"],
        state: "completeComparable",
        structuralDigest: "a".repeat(64),
        version: 1,
      },
    });

    assert.isUndefined(withoutEpoch.workerEnvironmentEpoch);
    assert.strictEqual(
      withEpoch.workerEnvironmentEpoch?.state,
      "completeComparable"
    );
    if (withEpoch.workerEnvironmentEpoch?.state !== "completeComparable")
      throw new Error("Expected a complete comparable worker epoch.");
    assert.strictEqual(
      withEpoch.workerEnvironmentEpoch.structuralDigest,
      "a".repeat(64)
    );
  });
});

describe("verification action success contract", () => {
  const postPublicationResult = {
    actionId: "verification-action-0001",
    actionRequestDigest:
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    aggregate: "verified",
    currentContentAuthoritySequence: 42,
    expectedContentAuthoritySequence: 42,
    generationSequence: 43,
    headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    kind: "postPublicationGenerationRecorded",
    proofResultDigest:
      "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    proofResultSequence: 48,
    publicationSequence: 41,
    replayed: false,
    runId: "run-L84-kMhLY8",
    targetDigest:
      "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  } as const;

  it("uses proofResultSequence for a zero-command generation", () => {
    const decoded = Schema.decodeUnknownSync(VerificationActionSuccessEnvelope)(
      {
        data: postPublicationResult,
        status: "success",
      }
    );

    assert.strictEqual(decoded.data.kind, "postPublicationGenerationRecorded");
    assert.strictEqual(
      decoded.data.kind === "postPublicationGenerationRecorded"
        ? decoded.data.proofResultSequence
        : undefined,
      48
    );
    assert.notProperty(decoded.data, "terminalEventSequence");
  });

  it("cannot choose an arbitrary terminal receipt for multiple command claims", () => {
    assert.throws(() =>
      Schema.decodeUnknownSync(VerificationActionSuccessEnvelope)({
        data: {
          ...postPublicationResult,
          terminalEventSequence: 47,
        },
        status: "success",
      })
    );
  });
});

describe("verification action request contract", () => {
  it("accepts exactly two top-level actions and rejects cross-variant prior fields", () => {
    const base = {
      actionId: "verification-action-0002",
      expectedContentAuthoritySequence: 42,
      expectedContractDigest: "a".repeat(64),
      expectedEventSequence: 43,
    };
    const start = Schema.decodeUnknownSync(VerificationActionRequestSchema)({
      ...base,
      expectedHeadSha: "b".repeat(40),
      expectedPublicationSequence: 41,
      expectedTargetDigest: "c".repeat(64),
      kind: "startPostPublicationGeneration",
    });
    assert.strictEqual(start.kind, "startPostPublicationGeneration");

    assert.throws(() =>
      Schema.decodeUnknownSync(VerificationActionRequestSchema)({
        ...base,
        claimId: `proof-claim:sha256:${"d".repeat(64)}`,
        expectedExecutionEvidenceIdentityDigest: "e".repeat(64),
        expectedSandboxName: "gaia-sandbox-1",
        expectedSandboxUuid: "123e4567-e89b-12d3-a456-426614174000",
        kind: "reconcileOutcomeUnknown",
        prior: {
          kind: "createdWithoutCommandStart",
          priorCommandStartSequence: 45,
          priorSandboxCreatedSequence: 44,
        },
        priorGenerationSequence: 43,
      })
    );
  });
});

describe("local run read contracts", () => {
  it("owns the exact reader diagnostic and status subsets", () => {
    assert.deepEqual(LocalRunReadDiagnosticCodeSchema.literals, [
      "ArtifactBodyMissing",
      "ArtifactBodyUnreadable",
      "ArtifactBodyCorrupt",
      "ArtifactBodyMismatch",
      "ArtifactPairConflict",
      "ArtifactNotAllowed",
      "ArtifactNotFound",
      "FactoryAgentNotFound",
      "FactoryGraphNotFound",
      "InvalidRunDirectory",
      "InvalidRunId",
      "RunHasNoEvents",
      "RunNotFound",
      "RunUnreadable",
    ]);
    assert.deepEqual(LocalRunReadStatusSchema.literals, [
      "cancelled",
      "completed",
      "failed",
      "running",
    ]);
    assert.throws(() =>
      Schema.decodeUnknownSync(LocalRunReadDiagnosticCodeSchema)(
        "InternalServerError"
      )
    );
    assert.throws(() =>
      Schema.decodeUnknownSync(LocalRunReadStatusSchema)("runningWorker")
    );
  });

  it("brands allowlisted artifact ids while preserving raw attempted names", () => {
    assert.strictEqual(parseLocalRunArtifactId("events"), "events");
    assert.throws(() => parseLocalRunArtifactId("../events.jsonl"));
    assert.throws(() => parseLocalRunArtifactId(""));
    assert.strictEqual(
      parseLocalRunArtifactName("../events.jsonl"),
      "../events.jsonl"
    );
    assert.strictEqual(parseLocalRunArtifactName(""), "");

    const traversalDiagnostic = Schema.decodeUnknownSync(
      LocalRunReadDiagnosticSchema
    )({
      artifactName: "../events.jsonl",
      code: "ArtifactNotAllowed",
      message: "Artifact is not allowlisted for local API reads.",
      recoverable: false,
      runId: "run-L84-kMhLY8",
    });
    const emptyDiagnostic = Schema.decodeUnknownSync(
      LocalRunReadDiagnosticSchema
    )({
      artifactName: "",
      code: "ArtifactNotAllowed",
      message: "Artifact is not allowlisted for local API reads.",
      recoverable: false,
      runId: "run-L84-kMhLY8",
    });

    assert.strictEqual(traversalDiagnostic.artifactName, "../events.jsonl");
    assert.strictEqual(emptyDiagnostic.artifactName, "");
  });

  it("parses exact timestamps and safe run-directory path segments", () => {
    assert.strictEqual(
      parseLocalRunTimestamp("2026-07-13T12:00:00.000Z"),
      "2026-07-13T12:00:00.000Z"
    );
    assert.throws(() => parseLocalRunTimestamp("2026-07-13T12:00:00Z"));
    assert.throws(() =>
      parseLocalRunTimestamp("2026-07-13T12:00:00.000+01:00")
    );
    assert.throws(() => parseLocalRunTimestamp("2026-02-31T12:00:00.000Z"));
    assert.strictEqual(
      parseLocalRunPathSegment("run-not-valid"),
      "run-not-valid"
    );
    for (const invalid of ["", ".", "..", "../run", "run/id", "run\\id"]) {
      assert.throws(() => parseLocalRunPathSegment(invalid));
    }
  });

  it("decodes and round-trips the authoritative reader DTOs", () => {
    const input = {
      diagnostics: [],
      runs: [
        {
          artifacts: ["events", "report"],
          createdAt: "2026-07-13T12:00:00.000Z",
          eventCount: 2,
          latestEventType: "REPORT_COMPLETED",
          modelInvocationArtifacts: [],
          runId: "run-L84-kMhLY8",
          state: "completed",
          status: "completed",
          updatedAt: "2026-07-13T12:01:00.000Z",
        },
      ],
    } as const;
    const decoded = Schema.decodeUnknownSync(LocalRunReadListSchema)(input);

    assert.deepEqual(Schema.encodeSync(LocalRunReadListSchema)(decoded), input);
    assert.deepEqual(
      Schema.decodeUnknownSync(LocalRunReadSummarySchema)(input.runs[0]),
      decoded.runs[0]
    );
    assert.deepEqual(
      Schema.decodeUnknownSync(LocalRunReadArtifactSchema)({
        artifactName: "events",
        body: "{}",
        contentType: "application/json",
        runId: "run-L84-kMhLY8",
      }).artifactName,
      "events"
    );
    assert.throws(() =>
      Schema.decodeUnknownSync(LocalRunReadSummarySchema)({
        ...input.runs[0],
        updatedAt: "not-a-timestamp",
      })
    );
  });
});

describe("LocalGaiaServerApi contract", () => {
  it("owns the exact local server URL contract in metadata and OpenAPI", () => {
    const metadata = {
      gaiaRoot: "/tmp/gaia/.gaia",
      host: "127.0.0.1",
      pid: 42,
      port: 4321,
      serverId: "server-1",
      startedAt: "2026-07-13T12:00:00.000Z",
      updatedAt: "2026-07-13T12:00:00.000Z",
      url: "http://127.0.0.1:4321",
      version: 1,
      workspaceRoot: "/tmp/gaia",
    };

    assert.strictEqual(
      Schema.decodeUnknownSync(ServerMetadata)(metadata).url,
      metadata.url
    );
    assert.strictEqual(
      Schema.decodeUnknownSync(HealthResponse)({
        ...metadata,
        status: "ok",
      }).url,
      metadata.url
    );
    assert.throws(() =>
      Schema.decodeUnknownSync(ServerMetadata)({
        ...metadata,
        url: "http://127.0.0.1:4321?debug=true",
      })
    );
    assert.deepNestedInclude(
      LocalGaiaServerOpenApi.components?.schemas?.HealthResponse,
      {
        "properties.url": {
          $ref: "#/components/schemas/LocalGaiaServerUrl",
        },
      }
    );
    assert.deepInclude(
      LocalGaiaServerOpenApi.components?.schemas?.LocalGaiaServerUrl,
      { type: "string" }
    );
  });

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
    assert.isObject(
      paths["/runs/{runId}/agents/{agentId}/session/actions"]?.post
    );
    assert.isObject(
      paths["/runs/{runId}/agents/{agentId}/session/stream"]?.get
    );
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
      "#/components/schemas/FactoryRunListSuccessEnvelope"
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
      "#/components/schemas/FactoryRunDetailSuccessEnvelope"
    );
    assert.deepEqual(
      responseStatuses(paths["/runs/{runId}/factory-graph"]?.get?.responses),
      ["200", "400", "404", "422", "500"]
    );
    assert.deepEqual(
      responseStatuses(paths["/runs/{runId}/activity"]?.get?.responses),
      ["200", "400", "404", "422", "500"]
    );
    assert.deepEqual(
      responseStatuses(paths["/runs/{runId}/delivery"]?.get?.responses),
      ["200", "400", "404", "422", "500"]
    );
    assertJsonSchemaRef(
      paths["/runs/{runId}/delivery"]?.get?.responses["200"],
      "#/components/schemas/DeliverySnapshotSuccessEnvelope"
    );
    assert.deepEqual(
      responseStatuses(
        paths["/runs/{runId}/delivery/actions"]?.post?.responses
      ),
      ["200", "400", "404", "409", "422", "500"]
    );
    assert.deepEqual(
      responseStatuses(
        paths["/runs/{runId}/agents/{agentId}/activity"]?.get?.responses
      ),
      ["200", "400", "404", "422", "500"]
    );
    assert.deepEqual(
      responseStatuses(
        paths["/runs/{runId}/agents/{agentId}/session"]?.get?.responses
      ),
      ["200", "400", "404", "422", "500"]
    );
    assertJsonSchemaRef(
      paths["/runs/{runId}/agents/{agentId}/session"]?.get?.responses["200"],
      "#/components/schemas/AgentSessionSnapshotSuccessEnvelope"
    );
    assert.deepEqual(
      responseStatuses(
        paths["/runs/{runId}/agents/{agentId}/session/stream"]?.get?.responses
      ),
      ["200", "400", "404", "409", "405", "422", "500"].sort()
    );
    assert.deepEqual(
      responseStatuses(
        paths["/runs/{runId}/agents/{agentId}/session/actions"]?.post?.responses
      ),
      ["200", "400", "404", "409", "422", "500"]
    );
    assertJsonSchemaRef(
      paths["/runs/{runId}/agents/{agentId}/session/actions"]?.post?.responses[
        "200"
      ],
      "#/components/schemas/AgentActionSuccessEnvelope"
    );
    assert.deepEqual(
      responseStatuses(paths["/runs/{runId}/artifacts"]?.get?.responses),
      ["200", "400", "404", "422", "500"]
    );
    assert.deepEqual(
      responseStatuses(
        paths["/runs/{runId}/artifacts/{artifactId}"]?.get?.responses
      ),
      ["200", "400", "404", "422", "500"]
    );
    assertJsonSchemaRef(
      paths["/runs/{runId}/artifacts/{artifactId}"]?.get?.responses["200"],
      "#/components/schemas/FactoryArtifactSuccessEnvelope"
    );
    assertJsonSchemaRef(
      paths["/runs/{runId}"]?.get?.responses["400"],
      "#/components/schemas/LocalRunApiBadRequest"
    );
    assertJsonSchemaRef(
      paths["/runs/{runId}"]?.get?.responses["404"],
      "#/components/schemas/LocalRunApiNotFound"
    );
    assertJsonSchemaRef(
      paths["/runs"]?.post?.responses["409"],
      "#/components/schemas/LocalRunApiConflict"
    );
  });

  it("models factory graph path params and schemas", () => {
    const artifactParameters =
      LocalGaiaServerOpenApi.paths["/runs/{runId}/artifacts/{artifactId}"]?.get
        ?.parameters;
    const agentActivityParameters =
      LocalGaiaServerOpenApi.paths["/runs/{runId}/agents/{agentId}/activity"]
        ?.get?.parameters;

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
      }
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
      }
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
      })
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
      })
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
      })
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
      })
    );
    assert.throws(() =>
      decodeCreateRunRequest({
        workflow: "issueDelivery",
        workItem: {
          description: "Execution selection is required.",
          kind: "issue",
          title: "Define FactoryGraph contracts",
        },
      })
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
      })
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
      })
    );
    assert.throws(() =>
      decodeCreateRunRequest({
        specMarkdown: "Legacy body is not accepted.\n",
      })
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
      })
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
      })
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
      })
    );
  });

  it("strictly parses optimistic delivery recovery actions", () => {
    const decode = Schema.decodeUnknownSync(
      DeliveryRecoveryActionRequestSchema
    );

    const action = decode({ expectedEventSequence: 9, kind: "reconcile" });
    assert.strictEqual(action.expectedEventSequence, 9);
    assert.strictEqual(action.kind, "reconcile");
    assert.throws(() => decode({ expectedEventSequence: 0, kind: "retry" }));
    assert.throws(() =>
      decode({
        expectedEventSequence: 9,
        force: true,
        kind: "retry",
      })
    );
  });

  it("requires the exact expected branch on merge actions", () => {
    const decode = Schema.decodeUnknownSync(DeliveryActionRequestSchema);
    const action = {
      actionId: "merge-1",
      expectedBranchName: "gaia/run-1234567890",
      expectedDecisionSequence: 9,
      expectedHeadSha: "a".repeat(40),
      expectedPolicyDigest: "b".repeat(64),
      expectedPrUrl: "https://github.com/cill-i-am/gaia/pull/74",
      kind: "merge",
      mergeMethod: "merge",
    };
    assert.strictEqual(decode(action).kind, "merge");
    const { expectedBranchName: _expectedBranchName, ...missing } = action;
    assert.throws(() => decode(missing));
    assert.throws(() => decode({ ...action, expectedBranchName: "" }));
  });

  it("strictly parses the public ready-for-review action tuple", () => {
    const decode = Schema.decodeUnknownSync(DeliveryActionRequestSchema);
    const action = {
      actionId: "ready-1",
      expectedBranchName: "gaia/run-1234567890",
      expectedHeadSha: "a".repeat(40),
      expectedPrNumber: 74,
      expectedPrUrl: "https://github.com/cill-i-am/gaia/pull/74",
      kind: "markReadyForReview",
    } as const;
    assert.strictEqual(decode(action).kind, "markReadyForReview");
    assert.throws(() =>
      decode({ ...action, publicationOperationId: "private-generation" })
    );
    assert.throws(() => decode({ ...action, expectedPrNumber: 0 }));
    assert.throws(() => decode({ ...action, expectedHeadSha: "not-a-sha" }));
    assert.throws(() => decode({ ...action, actionId: "bad action id" }));
    assert.throws(() => decode({ ...action, force: true }));
  });

  it("strictly parses the public local paired-review attestation tuple", () => {
    const decode = Schema.decodeUnknownSync(DeliveryActionRequestSchema);
    const action = {
      actionId: "attestation-1",
      decision: "approved",
      expectedBranchName: "gaia/run-1234567890",
      expectedHeadSha: "a".repeat(40),
      expectedPrNumber: 74,
      expectedPrUrl: "https://github.com/cill-i-am/gaia/pull/74",
      gaiaEvidenceDigest: "b".repeat(64),
      kind: "attestPairedReviewApproval",
    } as const;
    assert.strictEqual(decode(action).kind, "attestPairedReviewApproval");
    assert.throws(() => decode({ ...action, actionId: "bad action id" }));
    assert.throws(() =>
      decode({ ...action, gaiaEvidenceDigest: "not-a-digest" })
    );
    assert.throws(() =>
      decode({ ...action, evidenceUrl: "https://linear.app/example" })
    );
    assert.throws(() => decode({ ...action, reviewerIdentity: "cill-i-am" }));
    assert.throws(() => decode({ ...action, decision: "rejected" }));
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
    assert.throws(() =>
      decode({ ...request, nativeTurnIdDigest: "a".repeat(64) })
    );
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
    assert.throws(() =>
      decode({ ...request, nativeThreadId: "thread-private" })
    );
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
    assert.strictEqual(
      decoded.kind,
      "reconcileDesktopOriginatedWorkerCorrelation"
    );
    assert.throws(() => decode({ ...request, nativeTurnId: "turn-private" }));
    assert.throws(() =>
      decode({ ...request, nativeThreadId: "thread-private" })
    );
    assert.throws(() => decode({ ...request, source: "vscode" }));
    assert.throws(() => decode({ ...request, protocol: "codex-app-server" }));
  });

  it("drops private cleanup provenance from parsed and serialized delivery snapshots", () => {
    const hostile = "/HOSTILE/absolute/common-dir::PRIVATE_TOKEN_93";
    const decode = Schema.decodeUnknownSync(DeliverySnapshotDto);
    const encode = Schema.encodeSync(Schema.toCodecJson(DeliverySnapshotDto));
    const snapshot = decode({
      actionAudit: { cleanup: [], merge: [], readyForReview: [] },
      eventSequence: 12,
      mode: "pullRequest",
      ownershipToken: hostile,
      privateProvenance: {
        repositoryCommonDir: hostile,
        worktreePath: hostile,
      },
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

  it("keeps retained pre-branch pull-request observations decodable", () => {
    const snapshot = Schema.decodeUnknownSync(DeliverySnapshotDto)({
      eventSequence: 12,
      mode: "pullRequest",
      observation: {
        blockers: [],
        checks: [],
        draft: true,
        feedback: [],
        headSha: "a".repeat(40),
        mergeability: "mergeable",
        observedAt: "2026-07-12T12:00:00.000Z",
        prNumber: 91,
        prUrl: "https://github.com/cill-i-am/gaia/pull/91",
        repository: "cill-i-am/gaia",
        snapshotDigest: "b".repeat(64),
        status: "waiting",
        version: 1,
      },
      recoveryActions: [],
      runId: "run-1234567890",
      stage: "waitingForPr",
      status: "waitingForPr",
    });

    assert.isUndefined(snapshot.observation?.branchName);
  });

  it("strictly bounds the projected authoritative delivery head", () => {
    const decode = Schema.decodeUnknownSync(DeliverySnapshotDto);
    const snapshot = {
      authoritativeHeadSha: "a".repeat(40),
      eventSequence: 12,
      mode: "pullRequest",
      recoveryActions: [],
      runId: "run-1234567890",
      stage: "waitingForPr",
      status: "waitingForPr",
    } as const;

    assert.strictEqual(
      decode(snapshot).authoritativeHeadSha,
      snapshot.authoritativeHeadSha
    );
    assert.throws(() =>
      decode({ ...snapshot, authoritativeHeadSha: "not-a-git-sha" })
    );
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
    assert.strictEqual(
      decoded.actionIdempotencyKey,
      request.actionIdempotencyKey
    );
    assert.strictEqual(
      decoded.authorizationDigest,
      request.authorizationDigest
    );
    assert.throws(() => decode({ ...request, prompt: "do anything" }));
    assert.throws(() => decode({ ...request, actorType: "Bot" }));
    assert.throws(() => decode({ ...request, authorAssociation: "NONE" }));
    assert.throws(() => decode({ ...request, expectedEventSequence: 0 }));
  });
});

type OpenApiResponses = NonNullable<
  (typeof LocalGaiaServerOpenApi.paths)["/health"]["get"]
>["responses"];
const OpenApiSchemaRefSchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^#\/components\/schemas\/[A-Za-z0-9_-]+$/u))
);

function responseStatuses(responses: OpenApiResponses | undefined) {
  if (responses === undefined) {
    assert.fail("Expected responses.");
  }

  return Object.keys(responses);
}

function assertJsonSchemaRef(
  response: unknown,
  ref: typeof OpenApiSchemaRefSchema.Type
) {
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
