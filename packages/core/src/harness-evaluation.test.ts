import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { createActor } from "xstate";

import {
  HarnessLessonObservationSchema,
  HarnessRunPreparationBindingV1,
  makeHarnessBaselineManifestV1,
  makeHarnessBaselineManifestRefV1,
  makeHarnessEvaluationV1,
  makeHarnessPreparedRunReceiptV1,
  parseHarnessBaselineManifestV1,
  parseHarnessEvaluationV1,
  parseHarnessPreparedRunReceiptV1,
} from "./harness-evaluation.js";
import { runMachine } from "./machine.js";

const sha = (value: string) => value.repeat(64).slice(0, 64);

const manifestInput = {
  acceptedOutcome: {
    outcomeId: `accepted-outcome:sha256:${sha("a")}`,
    proofContractDigest: sha("b"),
    version: 2 as const,
  },
  authorityDigest: sha("c"),
  baseDigest: sha("d"),
  contextDigest: sha("e"),
  evaluationId: "evaluation-fixed-worker",
  externalCondition: {
    descriptor: "local-host-pinned",
    digest: sha("f"),
  },
  freshSessionPolicy: "globallyDistinct" as const,
  grader: { id: "grader.fixed", version: "1" },
  interventionWithheld: "runtimeRevision" as const,
  limitations: ["singleLocalHost"] as const,
  manifestId: "baseline-fixed-worker",
  model: {
    id: "gpt-fixed",
    provider: "openai",
    reasoningEffort: "high",
  },
  ownerRunId: "run-owner00001",
  plannedBaselineRunIds: ["run-base000001"],
  plannedRepetitions: 1,
  profileDigest: sha("1"),
  providerInterfaceDigest: sha("2"),
  recordedAt: "2026-07-26T00:00:00.000Z",
  runtimeRevision: "dc559bd3236edf595ba36f8bf625d3dd97c24f91",
  scenario: { id: "implementation-completes", version: 1 },
  skillManifestDigest: sha("3"),
  stopConditions: ["unknownExternalOutcome"] as const,
  targetDigest: sha("4"),
  worker: { capabilityEpoch: "gaia-capability-v1", id: "worker.fixed" },
  workerPlanDigest: sha("5"),
};

describe("HarnessEvaluation contracts", () => {
  it("commits a strict, content-addressed baseline manifest", () => {
    const manifest = makeHarnessBaselineManifestV1(manifestInput);
    expect(parseHarnessBaselineManifestV1(manifest)).toEqual(manifest);
    expect(manifest.manifestDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(() =>
      parseHarnessBaselineManifestV1({ ...manifest, unexpected: true })
    ).toThrow();
    expect(() =>
      parseHarnessBaselineManifestV1({
        ...manifest,
        plannedBaselineRunIds: ["run-base000001", "run-base000001"],
      })
    ).toThrow();
  });

  it("commits a strict prepared-run receipt from exact owned artifact bytes", () => {
    const manifest = makeHarnessBaselineManifestV1(manifestInput);
    const receipt = makeHarnessPreparedRunReceiptV1({
      artifacts: [
        "model-context-manifest",
        "model-invocation-manifest",
        "run-contract",
        "run-profile",
        "skill-manifest",
        "worker-plan",
      ].map((artifactId, index) => ({
        artifactId,
        byteLength: index + 1,
        contentDigest: sha(String(index + 1)),
        path: `${artifactId}.json`,
      })) as never,
      capabilitiesDigest: sha("a"),
      preparationBinding: {
        manifestRef: makeHarnessBaselineManifestRefV1({
          eventSequence: 2,
          manifest,
        }),
        repetition: 1,
        role: "baseline",
        runId: "run-base000001",
      },
      manifestRef: makeHarnessBaselineManifestRefV1({
        eventSequence: 2,
        manifest,
      }),
      preparedInputs: {
        authorityDigest: manifest.authorityDigest,
        baseDigest: manifest.baseDigest,
        capabilityEpoch: manifest.worker.capabilityEpoch,
        contextDigest: manifest.contextDigest,
        modelId: manifest.model.id,
        modelProvider: manifest.model.provider,
        modelReasoningEffort: manifest.model.reasoningEffort,
        profileDigest: manifest.profileDigest,
        providerInterfaceDigest: manifest.providerInterfaceDigest,
        runtimeRevision: manifest.runtimeRevision,
        skillManifestDigest: manifest.skillManifestDigest,
        targetDigest: manifest.targetDigest,
        workerId: manifest.worker.id,
        workerPlanDigest: manifest.workerPlanDigest,
      },
      providerId: "codex-app-server",
      providerVersion: "0.137.0",
      recordedAt: "2026-07-26T00:00:01.000Z",
      runId: "run-base000001",
      version: 1,
    });
    expect(parseHarnessPreparedRunReceiptV1(receipt)).toEqual(receipt);
    expect(() =>
      parseHarnessPreparedRunReceiptV1({
        ...receipt,
        receiptDigest: sha("f"),
      })
    ).toThrow();
    expect(() =>
      makeHarnessPreparedRunReceiptV1({
        ...receipt,
        artifacts: receipt.artifacts.map((artifact) => ({
          ...artifact,
          path: "same.json",
        })),
      })
    ).toThrow();
  });

  it("makes preparation role and treatment intervention strict durable authority", () => {
    const manifest = makeHarnessBaselineManifestV1(manifestInput);
    const manifestRef = makeHarnessBaselineManifestRefV1({
      eventSequence: 2,
      manifest,
    });
    const decode = Schema.decodeUnknownSync(HarnessRunPreparationBindingV1, {
      onExcessProperty: "error",
    });
    expect(
      decode({
        manifestRef,
        repetition: 1,
        role: "baseline",
        runId: "run-base000001",
      }).role
    ).toBe("baseline");
    expect(
      decode({
        intervention: {
          baselineRuntimeRevision: manifest.runtimeRevision,
          baselineSemanticContractDigest: manifest.providerInterfaceDigest,
          kind: "runtimeRevision",
          treatmentRuntimeRevision: "ac559bd3236edf595ba36f8bf625d3dd97c24f91",
          treatmentSemanticContractDigest: sha("6"),
          version: 1,
        },
        manifestRef,
        repetition: 1,
        role: "treatment",
        runId: "run-treat00001",
      }).role
    ).toBe("treatment");
    expect(() =>
      decode({
        manifestRef,
        repetition: 1,
        role: "baseline",
      })
    ).toThrow();
    expect(() =>
      decode({
        manifestRef,
        repetition: 1,
        role: "treatment",
        runId: "run-treat00001",
      })
    ).toThrow();
    expect(() =>
      decode({
        intervention: {
          kind: "promotedControl",
          lessonId: `lesson1_${sha("7")}`,
          projectionDigest: sha("7"),
          version: 1,
        },
        manifestRef,
        repetition: 1,
        role: "baseline",
        runId: "run-base000001",
      })
    ).toThrow();
    expect(() =>
      decode({
        intervention: {
          kind: "promotedControl",
          lessonId: `lesson1_${sha("7")}`,
          projectionDigest: sha("8"),
          version: 1,
        },
        manifestRef,
        repetition: 1,
        role: "treatment",
      })
    ).toThrow();
  });

  it("keeps session freshness separate from stable equivalence and fails closed", () => {
    const manifest = makeHarnessBaselineManifestV1(manifestInput);
    const baselineManifestRef = makeHarnessBaselineManifestRefV1({
      eventSequence: 2,
      manifest,
    });
    const stableConditions = {
      acceptedOutcomeDigest: sha("6"),
      authorityDigest: sha("c"),
      baseDigest: sha("d"),
      capabilityEpoch: "gaia-capability-v1",
      externalConditionDigest: sha("f"),
      graderDigest: sha("7"),
      modelDigest: sha("8"),
      profileDigest: sha("1"),
      providerInterfaceDigest: sha("2"),
      skillManifestDigest: sha("3"),
      targetDigest: sha("4"),
      workerDigest: sha("9"),
      workerPlanDigest: sha("5"),
    };
    const evidence = {
      acceptedOutcome: {
        outcomeId: manifest.acceptedOutcome.outcomeId,
        resultDigest: sha("a"),
        statementDigest: sha("b"),
      },
      contentAuthoritySequence: 3,
      contractDigest: manifest.acceptedOutcome.proofContractDigest,
      contractVersion: 2 as const,
      environmentReceiptDigest: sha("c"),
      externalConditionReceiptDigest: sha("d"),
      modelManifestDigest: sha("e"),
      proofContractDigest: manifest.acceptedOutcome.proofContractDigest,
      proofResultDigest: sha("f"),
      providerReceiptDigest: sha("1"),
      runProfileDigest: sha("2"),
      runtimeRevision: "dc559bd3236edf595ba36f8bf625d3dd97c24f91",
      workerReceiptDigest: sha("3"),
    };
    const evaluationInput = {
      anchorRunId: "run-treat00001",
      baselineManifest: manifest,
      baselineManifestRef,
      evaluationId: "evaluation-fixed-worker",
      grader: { id: "grader.fixed", version: "1" },
      intervention: {
        baselineRuntimeRevision: "dc559bd3236edf595ba36f8bf625d3dd97c24f91",
        baselineSemanticContractDigest: sha("2"),
        kind: "runtimeRevision",
        treatmentRuntimeRevision: "ac559bd3236edf595ba36f8bf625d3dd97c24f91",
        treatmentSemanticContractDigest: sha("6"),
        version: 1,
      },
      limitations: [],
      metrics: [
        {
          family: "acceptedOutcomeCorrectness",
          provenance: {
            eventDigest: sha("a"),
            eventType: "RUN_PROOF_RESULT_RECORDED",
            kind: "event",
            runId: "run-treat00001",
            sequence: 8,
          },
          repetition: 1,
          value: "accepted",
        },
      ],
      repetitions: [
        {
          baseline: {
            baselineManifestRef,
            conditions: stableConditions,
            evidence,
            prefix: {
              prefixDigest: sha("b"),
              runId: "run-base000001",
              throughSequence: 8,
            },
            runId: "run-base000001",
            sessionId: "session-run-base000001",
          },
          treatment: {
            conditions: {
              ...stableConditions,
              providerInterfaceDigest: sha("6"),
            },
            evidence: {
              ...evidence,
              runtimeRevision: "ac559bd3236edf595ba36f8bf625d3dd97c24f91",
            },
            prefix: {
              prefixDigest: sha("c"),
              runId: "run-treat00001",
              throughSequence: 8,
            },
            runId: "run-treat00001",
            sessionId: "session-run-treat00001",
          },
        },
      ],
      scenario: {
        id: "implementation-completes",
        minimumRepetitions: 1,
        version: 1,
      },
    } as const;
    const evaluation = makeHarnessEvaluationV1(evaluationInput);

    expect(evaluation.validity.state).toBe("validComparable");
    expect(evaluation.evaluationMode).toBe("fixedWorker");
    expect(parseHarnessEvaluationV1(evaluation)).toEqual(evaluation);
    expect(evaluation).not.toHaveProperty("total");
    expect(evaluation).not.toHaveProperty("winner");
    expect(() =>
      parseHarnessEvaluationV1({ ...evaluation, total: 1 })
    ).toThrow();
    const unexpectedInput: unknown = { ...evaluationInput, unexpected: true };
    expect(() => makeHarnessEvaluationV1(unexpectedInput as never)).toThrow();

    const duplicate = makeHarnessEvaluationV1({
      anchorRunId: evaluation.anchorRunId,
      baselineManifest: manifest,
      baselineManifestRef,
      evaluationId: evaluation.evaluationId,
      grader: evaluation.grader,
      intervention: evaluation.intervention,
      limitations: evaluation.limitations,
      metrics: evaluation.metrics,
      repetitions: [
        {
          baseline: evaluation.repetitions[0]!.baseline,
          treatment: {
            ...evaluation.repetitions[0]!.treatment,
            sessionId: evaluation.repetitions[0]!.baseline.sessionId,
          },
        },
      ],
      scenario: evaluation.scenario,
    });
    expect(duplicate.validity).toEqual({
      reasons: ["duplicateSessionId"],
      state: "invalid",
    });
  });

  it("does not admit generic opened as lesson evidence", () => {
    const decode = Schema.decodeUnknownSync(HarnessLessonObservationSchema);
    expect(
      ["offered", "retrieved", "invoked", "relevant", "unobservable"].map(
        (value) => decode(value)
      )
    ).toEqual(["offered", "retrieved", "invoked", "relevant", "unobservable"]);
    expect(() => decode("opened")).toThrow();
  });

  it("keeps both authority events lifecycle-neutral in every run state", () => {
    const initialActor = createActor(runMachine);
    initialActor.start();
    const initial = initialActor.getSnapshot();
    initialActor.stop();
    const states = [
      "created",
      "preparingWorkspace",
      "delivering",
      "runningWorker",
      "waitingForHuman",
      "paused",
      "verifying",
      "reporting",
      "completed",
      "cancelled",
      "failed",
    ] as const;
    for (const state of states) {
      for (const type of [
        "HARNESS_BASELINE_MANIFEST_RECORDED",
        "HARNESS_PREPARED_RUN_RECORDED",
        "HARNESS_EVALUATION_RECORDED",
      ] as const) {
        const actor = createActor(runMachine, {
          snapshot: runMachine.resolveState({
            context: initial.context,
            value: state,
          }),
        });
        actor.start();
        actor.send({ type });
        expect(actor.getSnapshot().value).toBe(state);
        actor.stop();
      }
    }
  });
});
