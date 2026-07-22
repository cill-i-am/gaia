import { assert, describe, it } from "@effect/vitest";
import { Schema } from "effect";

import {
  HarnessEnvironmentReceiptV1,
  WorkerEnvironmentEpochComparisonDto,
  compareWorkerEnvironmentEpochs,
  digestHarnessEnvironmentContract,
  makeHarnessEnvironmentReceiptV1,
  parseHarnessEnvironmentReceiptV1,
} from "./harness-execution.js";

const digest = (value: string) => value.repeat(64).slice(0, 64);

const receiptInput = {
  modelInvocation: {
    adapterSemanticDigest: digest("a"),
    contextContentDigest: digest("b"),
    contextDigest: digest("c"),
    contextRef: {
      artifactId: `mmf1_${digest("1")}`,
      bodyDigest: digest("2"),
      byteLength: 512,
      episodeKey: "workerInitial",
      identityDigest: digest("c"),
      kind: "modelContextManifest",
      path: `model-invocations/episode1_${digest("4")}/context-manifest.json`,
      runId: "run-1234567890",
      version: 1,
    },
    invocationDigest: digest("d"),
    invocationSemanticDigest: digest("7"),
    invocationRef: {
      artifactId: `mmf1_${digest("5")}`,
      bodyDigest: digest("6"),
      byteLength: 768,
      episodeKey: "workerInitial",
      identityDigest: digest("d"),
      kind: "modelInvocationManifest",
      path: `model-invocations/episode1_${digest("4")}/invocation-manifest.json`,
      runId: "run-1234567890",
      version: 1,
    },
    outputContractId: "gaia.cwd-run-marker.v1",
    outputContractVersion: 1,
    renderedInputDigest: digest("c"),
    workspaceBinding: {
      canonicalRunStoreRootDigest: digest("8"),
      canonicalWorkspacePathDigest: digest("9"),
      runId: "run-1234567890",
      shape: ".gaia/runs/<runId>/workspace",
      version: 1,
      workspaceRole: "workerWorkspace",
    },
  },
  observation: {
    approvalPolicy: "on-request",
    cwdMatchesWorkspaceBinding: true,
    model: "gpt-5.6-codex",
    modelProvider: "openai",
    reasoningEffort: "high",
    sandbox: "workspace-write",
    source: "threadRuntimeResult",
  },
  recordedAt: "2026-07-22T11:20:00.000Z",
  resolvedExecution: {
    capabilities: {
      approvals: [
        "command",
        "fileChange",
        "permission",
        "userInput",
        "mcpElicitation",
      ],
      fileChangeEvents: true,
      interruption: true,
      resumableSessions: true,
      review: true,
      steering: true,
      streamingMessages: true,
      structuredOutput: false,
      subagents: false,
      toolEvents: true,
      usageReporting: true,
      userQuestions: true,
    },
    environmentAssignment: {
      adapter: {
        contractDigest: digest("a"),
        contractId: "gaia.codex-app-server",
        contractVersion: "1",
        providerNativeToolInventoryObservation: "notExposed",
        toolContractDigest: digest("b"),
      },
      authority: {
        approvalPolicy: "on-request",
        ephemeral: false,
        sandbox: "workspace-write",
        workspaceBindingDigest: digestHarnessEnvironmentContract(
          "gaia.worker-workspace-authority.v1",
          ["cill-i-am/gaia", ".gaia/runs/<runId>/workspace"]
        ),
      },
      effectDependencyEpoch: "4.0.0-beta.93",
      hostClass: "localGaiaServer",
      interfaceClass: "codexAppServerStdio",
      model: {
        id: "gpt-5.6-codex",
        provider: "openai",
        reasoningEffort: "high",
      },
      runtimeSource: {
        repositoryIdentity: "cill-i-am/gaia",
        revision: "6cc2350063cec02229fde3669af0f67a8cc3497a",
        sourceState: "clean",
      },
      version: 1,
    },
    executionMode: "local",
    harnessProfileId: "codexAppServer",
    provider: {
      displayName: "Codex App Server",
      executionModes: ["local"],
      providerId: "codex-app-server",
    },
    version: "0.137.0",
  },
  runContract: {
    baseDigest: digest("e"),
    contractDigest: digest("f"),
    semanticDigest: digest("9"),
    targetDigest: digest("0"),
  },
  runId: "run-1234567890",
  runProfileDigest: digest("1"),
  skillManifestDigest: digest("2"),
  workerPlanDigest: digest("3"),
  version: 1,
} as const;

describe("worker environment epoch contracts", () => {
  it("keeps structural identity stable across episode metadata and changes for material evidence", () => {
    const first = makeHarnessEnvironmentReceiptV1(receiptInput);
    const repeated = makeHarnessEnvironmentReceiptV1(receiptInput);
    const anotherRun = makeHarnessEnvironmentReceiptV1({
      ...receiptInput,
      modelInvocation: {
        ...receiptInput.modelInvocation,
        contextRef: {
          ...receiptInput.modelInvocation.contextRef,
          runId: "run-abcdefghij",
        },
        invocationRef: {
          ...receiptInput.modelInvocation.invocationRef,
          runId: "run-abcdefghij",
        },
        workspaceBinding: {
          ...receiptInput.modelInvocation.workspaceBinding,
          canonicalWorkspacePathDigest: digest("4"),
          runId: "run-abcdefghij",
        },
      },
      recordedAt: "2026-07-22T11:21:00.000Z",
      runId: "run-abcdefghij",
    });
    const changedRevision = makeHarnessEnvironmentReceiptV1({
      ...receiptInput,
      resolvedExecution: {
        ...receiptInput.resolvedExecution,
        environmentAssignment: {
          ...receiptInput.resolvedExecution.environmentAssignment,
          runtimeSource: {
            ...receiptInput.resolvedExecution.environmentAssignment
              .runtimeSource,
            revision: "7cc2350063cec02229fde3669af0f67a8cc3497a",
          },
        },
      },
    });

    assert.strictEqual(first.receiptDigest, repeated.receiptDigest);
    assert.strictEqual(first.structuralDigest, repeated.structuralDigest);
    assert.notStrictEqual(first.receiptDigest, anotherRun.receiptDigest);
    assert.strictEqual(first.structuralDigest, anotherRun.structuralDigest);
    assert.notStrictEqual(
      first.structuralDigest,
      changedRevision.structuralDigest
    );
    assert.doesNotThrow(() => HarnessEnvironmentReceiptV1.make(first));
  });

  it("rejects forged digests and cross-run receipt bindings", () => {
    const receipt = makeHarnessEnvironmentReceiptV1(receiptInput);

    assert.throws(() =>
      makeHarnessEnvironmentReceiptV1({
        ...receiptInput,
        modelInvocation: {
          ...receiptInput.modelInvocation,
          contextRef: {
            ...receiptInput.modelInvocation.contextRef,
            runId: "run-abcdefghij",
          },
        },
      })
    );
    assert.throws(() =>
      parseHarnessEnvironmentReceiptV1({
        ...receipt,
        receiptDigest: digest("0"),
      })
    );
  });

  it("refuses equivalence unless both public projections are complete and identical", () => {
    const receipt = makeHarnessEnvironmentReceiptV1(receiptInput);
    const complete = Schema.decodeUnknownSync(
      WorkerEnvironmentEpochComparisonDto
    )({
      limitations: ["providerNativeToolInventoryNotExposed"],
      state: "completeComparable",
      structuralDigest: receipt.structuralDigest,
      version: 1,
    });
    const incomplete = Schema.decodeUnknownSync(
      WorkerEnvironmentEpochComparisonDto
    )({
      limitations: [],
      state: "incomplete",
      version: 1,
    });

    assert.deepEqual(compareWorkerEnvironmentEpochs(complete, complete), {
      equivalent: true,
      reason: "matchingCompleteStructuralDigest",
    });
    assert.deepEqual(compareWorkerEnvironmentEpochs(complete, incomplete), {
      equivalent: false,
      reason: "incompleteEvidence",
    });
    assert.throws(() =>
      Schema.decodeUnknownSync(WorkerEnvironmentEpochComparisonDto)({
        limitations: [],
        state: "incomplete",
        structuralDigest: receipt.structuralDigest,
        version: 1,
      })
    );
  });
});
