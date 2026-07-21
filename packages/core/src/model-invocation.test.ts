import { createHash } from "node:crypto";

import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { makeRunEvent } from "./events.js";
import {
  MODEL_OUTPUT_CONTRACT_CWD_RUN_MARKER_V1,
  MODEL_REVIEW_OUTPUT_CONTRACT_V1,
  ModelInvocationObservationV1,
  makeModelContextContentV1,
  makeModelContextManifestV1,
  makeModelInvocationManifestV1,
  parseModelContextManifest,
  parseModelInvocationManifest,
  renderModelInputV1,
  resolveModelInvocationEpisodes,
} from "./model-invocation.js";
import { parseRunId } from "./run-id.js";

const runA = parseRunId("run-1234567890");
const runB = parseRunId("run-abcdefghij");

const contentInput = {
  acceptedOutcomes: ["Return an inspectable implementation."],
  authority: ["Edit this issue only."],
  budget: { maxOutputBytes: 16_384, maxTurns: 1 },
  contentRefs: [
    { digest: "a".repeat(64), kind: "runContract", relevance: "authoritative" },
  ],
  episodeRole: "workerInitial" as const,
  instructions: ["Use the accepted verification commands."],
  nonGoals: ["Do not deploy."],
  outputContract: MODEL_OUTPUT_CONTRACT_CWD_RUN_MARKER_V1,
  planningFacts: ["events.jsonl is authoritative."],
  safeExclusions: ["credentials"],
  skills: ["effect-ts"],
  stops: ["Stop on scope drift."],
  taskInput: "Implement the accepted slice. \u{1f680}",
  verificationCommands: ["pnpm test"],
};

const workspaceBinding = {
  canonicalRunStoreRootDigest: "b".repeat(64),
  canonicalWorkspacePathDigest: "c".repeat(64),
  runId: runA,
  shape: ".gaia/runs/<runId>/workspace" as const,
  version: 1 as const,
  workspaceRole: "workerWorkspace" as const,
};

describe("model invocation manifests", () => {
  it("enforces the closed adapter, input, and capability-observation matrix", () => {
    const content = makeModelContextContentV1(contentInput);
    const rendered = renderModelInputV1(content);
    const context = makeModelContextManifestV1({
      authoritativeRefs: [],
      binding: { episodeKey: "workerInitial", runId: runA },
      content,
      workspaceBinding,
    });
    const kinds = [
      "codexBatch",
      "codexAppServer",
      "deterministicReviewer",
      "deterministicFake",
      "legacyProcess",
    ] as const;
    const inputs = [
      "codexBatchStdin",
      "codexAppTurn",
      "codexReviewerStdin",
      "deterministicInput",
      "legacySpecEnvironment",
    ] as const;
    const observations = [
      "offered",
      "retrieved",
      "opened",
      "invoked",
      "reportedRelevant",
      "unobservable",
      "notApplicable",
    ] as const;
    const allowed = {
      codexAppServer: {
        input: "codexAppTurn",
        observations: ["offered", "unobservable"],
      },
      codexBatch: {
        input: "codexBatchStdin",
        observations: ["offered", "unobservable"],
      },
      deterministicFake: {
        input: "deterministicInput",
        observations: ["notApplicable"],
      },
      deterministicReviewer: {
        input: "codexReviewerStdin",
        observations: ["notApplicable", "unobservable"],
      },
      legacyProcess: {
        input: "legacySpecEnvironment",
        observations: ["unobservable"],
      },
    } as const;
    const make = (
      kind: (typeof kinds)[number],
      adapterInputClass: (typeof inputs)[number],
      acceptedProviderCapabilityObservation: (typeof observations)[number]
    ) =>
      makeModelInvocationManifestV1({
        acceptedProviderCapabilityObservation,
        adapterInputClass,
        adapterSemantics: { kind, semanticDigest: "e".repeat(64) },
        authorityRef: { digest: "f".repeat(64), kind: "authority" },
        binding: context.payload.binding,
        budget: content.payload.budget,
        context,
        outputContract: content.payload.outputContract,
        rendered,
        runContractRef: { digest: "1".repeat(64), kind: "runContract" },
        template: { id: "gaia.worker-input.v1", version: 1 },
        workspaceBinding,
      });

    for (const kind of kinds) {
      const rule = allowed[kind];
      for (const observation of rule.observations)
        expect(() => make(kind, rule.input, observation)).not.toThrow();
      for (const input of inputs)
        if (input !== rule.input)
          expect(() => make(kind, input, rule.observations[0])).toThrow(
            /adapter|input/u
          );
      for (const observation of observations)
        if (!rule.observations.includes(observation as never))
          expect(() => make(kind, rule.input, observation)).toThrow(
            /adapter|observation/u
          );
    }
  });

  it("derives stable content and rendered identities independently of run and adapter", () => {
    const content = makeModelContextContentV1(contentInput);
    const rendered = renderModelInputV1(content);

    expect(content.contextContentDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(rendered.renderedInputDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(rendered.text).not.toContain("run-1234567890");
    expect(rendered.text).not.toContain("/tmp/");
    expect(rendered.text).toContain("<run-store>/.gaia/runs/<runId>/workspace");
    const reviewRoleOnly = makeModelContextContentV1({
      ...contentInput,
      episodeRole: "planReview",
    });
    expect(renderModelInputV1(reviewRoleOnly).text).toBe(rendered.text);
  });

  it("binds full context and invocation identities without changing stable bytes", () => {
    const content = makeModelContextContentV1(contentInput);
    const rendered = renderModelInputV1(content);
    const context = makeModelContextManifestV1({
      authoritativeRefs: [{ digest: "d".repeat(64), kind: "workerPlan" }],
      binding: { episodeKey: "workerInitial", runId: runA },
      content,
      workspaceBinding,
    });
    const invocation = makeModelInvocationManifestV1({
      acceptedProviderCapabilityObservation: "unobservable",
      adapterInputClass: "codexBatchStdin",
      adapterSemantics: { kind: "codexBatch", semanticDigest: "e".repeat(64) },
      authorityRef: { digest: "f".repeat(64), kind: "authority" },
      binding: context.payload.binding,
      budget: content.payload.budget,
      context,
      outputContract: MODEL_OUTPUT_CONTRACT_CWD_RUN_MARKER_V1,
      rendered,
      runContractRef: { digest: "1".repeat(64), kind: "runContract" },
      template: { id: "gaia.worker-input.v1", version: 1 },
      workspaceBinding,
    });

    expect(context.contextId).toBe(`mctx1_${context.contextDigest}`);
    expect(invocation.invocationId).toBe(
      `minv1_${invocation.invocationDigest}`
    );
    expect(invocation.payload.rendered.renderedInputDigest).toBe(
      rendered.renderedInputDigest
    );
  });

  it("rejects mutation, excess fields, cross-binding, and self-authentication mismatches", () => {
    const content = makeModelContextContentV1(contentInput);
    const context = makeModelContextManifestV1({
      authoritativeRefs: [],
      binding: { episodeKey: "workerInitial", runId: runA },
      content,
      workspaceBinding,
    });
    expect(() =>
      parseModelContextManifest({ ...context, contextDigest: "0".repeat(64) })
    ).toThrow();
    expect(() =>
      parseModelContextManifest({ ...context, extra: true })
    ).toThrow();

    const rendered = renderModelInputV1(content);
    const invocation = makeModelInvocationManifestV1({
      acceptedProviderCapabilityObservation: "unobservable",
      adapterInputClass: "codexAppTurn",
      adapterSemantics: {
        kind: "codexAppServer",
        semanticDigest: "e".repeat(64),
      },
      authorityRef: { digest: "f".repeat(64), kind: "authority" },
      binding: context.payload.binding,
      budget: content.payload.budget,
      context,
      outputContract: MODEL_OUTPUT_CONTRACT_CWD_RUN_MARKER_V1,
      rendered,
      runContractRef: { digest: "1".repeat(64), kind: "runContract" },
      template: { id: "gaia.worker-input.v1", version: 1 },
      workspaceBinding,
    });
    expect(() =>
      parseModelInvocationManifest(
        {
          ...invocation,
          payload: {
            ...invocation.payload,
            binding: { ...invocation.payload.binding, runId: runB },
          },
        },
        context
      )
    ).toThrow();

    const otherContent = makeModelContextContentV1({
      ...contentInput,
      taskInput: "A different accepted input.",
    });
    expect(() =>
      makeModelInvocationManifestV1({
        ...invocation.payload,
        context,
        rendered: renderModelInputV1(otherContent),
      })
    ).toThrow(/rendered|context/u);
    expect(() =>
      makeModelInvocationManifestV1({
        ...invocation.payload,
        budget: { ...invocation.payload.budget, maxTurns: 2 },
        context,
      })
    ).toThrow(/budget|context/u);
    expect(() =>
      makeModelInvocationManifestV1({
        ...invocation.payload,
        context,
        outputContract: MODEL_REVIEW_OUTPUT_CONTRACT_V1,
      })
    ).toThrow(/output contract|context/u);
    expect(() =>
      makeModelInvocationManifestV1({
        ...invocation.payload,
        context,
        workspaceBinding: {
          ...workspaceBinding,
          canonicalRunStoreRootDigest: "3".repeat(64),
        },
      })
    ).toThrow(/workspace|context/u);
    expect(() =>
      parseModelInvocationManifest(
        {
          ...invocation,
          payload: {
            ...invocation.payload,
            template: { id: "gaia.plan-review.v1", version: 1 },
          },
        },
        context
      )
    ).toThrow(/template|Literal/u);
  });

  it("changes only full identities for run-only or adapter-only material changes", () => {
    const content = makeModelContextContentV1(contentInput);
    const rendered = renderModelInputV1(content);
    const contextA = makeModelContextManifestV1({
      authoritativeRefs: [],
      binding: { episodeKey: "workerInitial", runId: runA },
      content,
      workspaceBinding,
    });
    const contextB = makeModelContextManifestV1({
      authoritativeRefs: [],
      binding: { episodeKey: "workerInitial", runId: runB },
      content,
      workspaceBinding: {
        ...workspaceBinding,
        canonicalWorkspacePathDigest: "2".repeat(64),
        runId: runB,
      },
    });
    expect(contextA.payload.contextContentDigest).toBe(
      contextB.payload.contextContentDigest
    );
    expect(contextA.contextDigest).not.toBe(contextB.contextDigest);
    expect(renderModelInputV1(content).text).toBe(rendered.text);

    const batch = makeModelInvocationManifestV1({
      acceptedProviderCapabilityObservation: "offered",
      adapterInputClass: "codexBatchStdin",
      adapterSemantics: {
        kind: "codexBatch",
        semanticDigest: "4".repeat(64),
      },
      authorityRef: { digest: "5".repeat(64), kind: "authority" },
      binding: contextA.payload.binding,
      budget: content.payload.budget,
      context: contextA,
      outputContract: content.payload.outputContract,
      rendered,
      runContractRef: { digest: "6".repeat(64), kind: "runContract" },
      template: { id: "gaia.worker-input.v1", version: 1 },
      workspaceBinding,
    });
    const app = makeModelInvocationManifestV1({
      acceptedProviderCapabilityObservation: "offered",
      adapterInputClass: "codexAppTurn",
      adapterSemantics: {
        kind: "codexAppServer",
        semanticDigest: "7".repeat(64),
      },
      authorityRef: batch.payload.authorityRef,
      binding: contextA.payload.binding,
      budget: content.payload.budget,
      context: contextA,
      outputContract: content.payload.outputContract,
      rendered,
      runContractRef: batch.payload.runContractRef,
      template: { id: "gaia.worker-input.v1", version: 1 },
      workspaceBinding,
    });
    expect(batch.payload.context.contextContentDigest).toBe(
      app.payload.context.contextContentDigest
    );
    expect(batch.payload.rendered).toEqual(app.payload.rendered);
    expect(batch.invocationId).not.toBe(app.invocationId);
  });

  it("keeps marked lifecycle prefixes conditional and requires each reached input owner", () => {
    const created = event(1, "RUN_CREATED", {
      modelInvocationProtocol: "v1",
      source: "server",
    });
    expect(resolveModelInvocationEpisodes([created])).toEqual({
      episodes: [],
      protocol: "v1",
    });
    const plan = episode("planReview");
    const planOwner = event(2, "REVIEW_STARTED", {
      modelInvocationEpisode: plan,
      phase: "plan",
    });
    const worker = episode("workerInitial");
    const workerOwner = event(3, "WORKER_STARTED", {
      modelInvocationEpisode: worker,
    });
    expect(
      resolveModelInvocationEpisodes([created, planOwner, workerOwner])
    ).toMatchObject({ protocol: "v1" });
    expect(() =>
      resolveModelInvocationEpisodes([created, event(2, "WORKER_STARTED", {})])
    ).toThrow(/workerInitial/u);
  });

  it("requires fresh remediation, recovery, and correlation pairs only at intent", () => {
    const created = event(1, "RUN_CREATED", {
      modelInvocationProtocol: "v1",
    });
    const owners = [
      event(2, "DELIVERY_REMEDIATION_RECORDED", {
        modelInvocationEpisode: episode(
          "deliveryRemediation:remediation:run-1234567890:1"
        ),
        remediation: {
          operationId: "remediation:run-1234567890:1",
          state: "intentRecorded",
        },
      }),
      event(3, "WORKER_RECOVERY_RECORDED", {
        modelInvocationEpisode: episode("workerRecovery:recover-1"),
        recovery: { actionId: "recover-1", state: "intentRecorded" },
      }),
      event(4, "WORKER_CORRELATION_RECONCILIATION_RECORDED", {
        modelInvocationEpisode: episode("workerCorrelation:correlate-1"),
        reconciliation: {
          actionId: "correlate-1",
          state: "intentRecorded",
        },
      }),
      event(5, "WORKER_DESKTOP_ORIGIN_CORRELATION_RECORDED", {
        desktopOriginCorrelation: {
          actionId: "desktop-1",
          state: "intentRecorded",
        },
        modelInvocationEpisode: episode(
          "workerDesktopOriginCorrelation:desktop-1"
        ),
      }),
    ];
    expect(resolveModelInvocationEpisodes([created, ...owners])).toMatchObject({
      protocol: "v1",
    });
    expect(() =>
      resolveModelInvocationEpisodes([
        created,
        event(2, "WORKER_RECOVERY_RECORDED", {
          recovery: { actionId: "recover-1", state: "intentRecorded" },
        }),
      ])
    ).toThrow(/workerRecovery/u);
    const crossBound = episode("workerInitial");
    expect(() =>
      resolveModelInvocationEpisodes([
        created,
        event(2, "WORKER_STARTED", {
          modelInvocationEpisode: {
            ...crossBound,
            contextRef: { ...crossBound.contextRef, runId: runB },
          },
        }),
      ])
    ).toThrow(/bind|authenticate/u);
  });

  it("forbids pairs on non-input actions and enforces the closed observation matrix", () => {
    const created = event(1, "RUN_CREATED", {
      modelInvocationProtocol: "v1",
    });
    expect(() =>
      resolveModelInvocationEpisodes([
        created,
        event(2, "HARNESS_SESSION_EVENT_RECORDED", {
          event: {
            actionId: "interrupt-1",
            actionKind: "interrupt",
            kind: "operatorActionIntentRecorded",
          },
          modelInvocationEpisode: episode("operatorSteer:interrupt-1"),
        }),
      ])
    ).toThrow(/forbids/u);
    const worker = episode("workerInitial");
    const invalidObservations = [
      {
        episodeKey: "workerInitial",
        kind: "reportedRelevant",
        source: "providerSelfReport",
        trust: "high",
        version: 1,
      },
      {
        episodeKey: "workerInitial",
        kind: "offered",
        source: "providerSelfReport",
        trust: "high",
        version: 1,
      },
      {
        episodeKey: "workerInitial",
        kind: "retrieved",
        source: "codexBatchTransport",
        trust: "high",
        version: 1,
      },
      {
        episodeKey: "workerInitial",
        kind: "unobservable",
        source: "providerTelemetry",
        trust: "none",
        version: 1,
      },
    ] as const;
    for (const observation of invalidObservations)
      expect(() =>
        resolveModelInvocationEpisodes([
          created,
          event(2, "WORKER_STARTED", { modelInvocationEpisode: worker }),
          event(3, "WORKER_COMPLETED", {
            modelInvocationObservation: Schema.encodeSync(
              ModelInvocationObservationV1
            )(ModelInvocationObservationV1.make(observation)),
          }),
        ])
      ).toThrow(/observation|self-report|trust/u);

    expect(
      resolveModelInvocationEpisodes([
        created,
        event(2, "WORKER_STARTED", { modelInvocationEpisode: worker }),
        event(3, "WORKER_COMPLETED", {
          modelInvocationObservation: Schema.encodeSync(
            ModelInvocationObservationV1
          )(
            ModelInvocationObservationV1.make({
              episodeKey: "workerInitial",
              kind: "offered",
              source: "codexBatchTransport",
              trust: "high",
              version: 1,
            })
          ),
        }),
      ])
    ).toMatchObject({ protocol: "v1" });
  });
});

function event(
  sequence: number,
  type: Parameters<typeof makeRunEvent>[0]["type"],
  payload: Readonly<Record<string, typeof Schema.Json.Type>>
) {
  return makeRunEvent({
    payload,
    runId: runA,
    sequence,
    timestamp: `2026-07-21T00:00:0${sequence}.000Z`,
    type,
  });
}

function episode(episodeKey: string) {
  const episodeId = createHash("sha256").update(episodeKey).digest("hex");
  const ref = (
    kind: "modelContextManifest" | "modelInvocationManifest",
    identityDigest: string,
    filename: "context-manifest.json" | "invocation-manifest.json"
  ) => ({
    artifactId: `mmf1_${createHash("sha256")
      .update(`${kind}\0${identityDigest}`)
      .digest("hex")}`,
    bodyDigest: "f".repeat(64),
    byteLength: 123,
    episodeKey,
    identityDigest,
    kind,
    path: `model-invocations/episode1_${episodeId}/${filename}`,
    runId: runA,
    version: 1 as const,
  });
  return {
    contextRef: ref(
      "modelContextManifest",
      createHash("sha256").update(`${episodeKey}:context`).digest("hex"),
      "context-manifest.json"
    ),
    episodeKey,
    invocationRef: ref(
      "modelInvocationManifest",
      createHash("sha256").update(`${episodeKey}:invocation`).digest("hex"),
      "invocation-manifest.json"
    ),
    version: 1 as const,
  };
}
