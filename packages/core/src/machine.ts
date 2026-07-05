import * as Schema from "effect/Schema";
import { assign, createActor, createMachine } from "xstate";
import {
  FailureStageSchema,
  GaiaFailure,
  ReviewPhaseSchema,
  type RunEvent,
  RunSnapshot,
  type RunState,
  RunStateSchema,
} from "./events.js";
import type { RunId } from "./run-id.js";

export type RunMachineContext = {
  readonly browserEvidencePath: string | undefined;
  readonly browserEvidenceStatus: string | undefined;
  readonly browserEvidenceTargetUrl: string | undefined;
  readonly evidenceReviewPath: string | undefined;
  readonly failure: GaiaFailure | undefined;
  readonly githubChecksPath: string | undefined;
  readonly githubChecksStatus: string | undefined;
  readonly githubPullRequest: string | undefined;
  readonly githubWatchStatePath: string | undefined;
  readonly lastEventSequence: number;
  readonly evidenceReviewerSessionPath: string | undefined;
  readonly planReviewPath: string | undefined;
  readonly planReviewerSessionPath: string | undefined;
  readonly reportPath: string | undefined;
  readonly runId: RunId | undefined;
  readonly specPath: string | undefined;
  readonly verificationResultPath: string | undefined;
  readonly workerResultPath: string | undefined;
  readonly workspacePath: string | undefined;
};

export type RunMachineEvent =
  | { readonly type: "RUN_CREATED"; readonly runId: RunId; readonly specPath: string }
  | { readonly type: "WORKSPACE_PREPARED"; readonly workspacePath: string }
  | { readonly type: "REVIEW_STARTED" }
  | {
      readonly type: "REVIEW_COMPLETED";
      readonly phase: typeof ReviewPhaseSchema.Type;
      readonly reviewPath: string;
      readonly reviewerSessionEvidencePath?: string;
    }
  | { readonly type: "WORKER_STARTED" }
  | { readonly type: "WORKER_COMPLETED"; readonly workerResultPath: string }
  | { readonly type: "VERIFICATION_STARTED" }
  | {
      readonly type: "VERIFICATION_COMPLETED";
      readonly verificationResultPath: string;
    }
  | {
      readonly type: "BROWSER_EVIDENCE_RECORDED";
      readonly evidencePath: string;
      readonly status: string;
      readonly targetUrl: string;
    }
  | { readonly type: "REPORT_STARTED" }
  | { readonly type: "REPORT_COMPLETED"; readonly reportPath: string }
  | {
      readonly type: "GITHUB_CHECKS_RECORDED";
      readonly checksPath: string;
      readonly pullRequest: string;
      readonly status: string;
      readonly watchStatePath?: string;
    }
  | { readonly type: "RUN_FAILED"; readonly failure: GaiaFailure };

const initialContext: RunMachineContext = {
  browserEvidencePath: undefined,
  browserEvidenceStatus: undefined,
  browserEvidenceTargetUrl: undefined,
  evidenceReviewPath: undefined,
  failure: undefined,
  githubChecksPath: undefined,
  githubChecksStatus: undefined,
  githubPullRequest: undefined,
  githubWatchStatePath: undefined,
  lastEventSequence: 0,
  evidenceReviewerSessionPath: undefined,
  planReviewPath: undefined,
  planReviewerSessionPath: undefined,
  reportPath: undefined,
  runId: undefined,
  specPath: undefined,
  verificationResultPath: undefined,
  workerResultPath: undefined,
  workspacePath: undefined,
};

export const runMachine = createMachine({
  types: {} as {
    context: RunMachineContext;
    events: RunMachineEvent;
  },
  context: initialContext,
  id: "gaia-run",
  initial: "created",
  states: {
    completed: {
      on: {
        BROWSER_EVIDENCE_RECORDED: {
          actions: "recordBrowserEvidence",
        },
        GITHUB_CHECKS_RECORDED: {
          actions: "recordGitHubChecks",
        },
        RUN_FAILED: {
          actions: "recordFailure",
          target: "failed",
        },
      },
    },
    created: {
      on: {
        RUN_CREATED: {
          actions: "recordRunCreated",
          target: "preparingWorkspace",
        },
        RUN_FAILED: {
          actions: "recordFailure",
          target: "failed",
        },
      },
    },
    failed: {},
    preparingWorkspace: {
      on: {
        RUN_FAILED: {
          actions: "recordFailure",
          target: "failed",
        },
        WORKSPACE_PREPARED: {
          actions: "recordWorkspacePrepared",
          target: "runningWorker",
        },
      },
    },
    reporting: {
      on: {
        BROWSER_EVIDENCE_RECORDED: {
          actions: "recordBrowserEvidence",
        },
        REPORT_STARTED: {},
        REPORT_COMPLETED: {
          actions: "recordReportCompleted",
          target: "completed",
        },
        REVIEW_COMPLETED: {
          actions: "recordReviewCompleted",
        },
        REVIEW_STARTED: {},
        RUN_FAILED: {
          actions: "recordFailure",
          target: "failed",
        },
      },
    },
    runningWorker: {
      on: {
        RUN_FAILED: {
          actions: "recordFailure",
          target: "failed",
        },
        REVIEW_COMPLETED: {
          actions: "recordReviewCompleted",
        },
        REVIEW_STARTED: {},
        WORKER_COMPLETED: {
          actions: "recordWorkerCompleted",
          target: "verifying",
        },
        WORKER_STARTED: {},
      },
    },
    verifying: {
      on: {
        RUN_FAILED: {
          actions: "recordFailure",
          target: "failed",
        },
        VERIFICATION_COMPLETED: {
          actions: "recordVerificationCompleted",
          target: "reporting",
        },
        VERIFICATION_STARTED: {},
      },
    },
  },
}).provide({
  actions: {
    recordBrowserEvidence: assign({
      browserEvidencePath: ({ event }) =>
        event.type === "BROWSER_EVIDENCE_RECORDED"
          ? event.evidencePath
          : undefined,
      browserEvidenceStatus: ({ event }) =>
        event.type === "BROWSER_EVIDENCE_RECORDED" ? event.status : undefined,
      browserEvidenceTargetUrl: ({ event }) =>
        event.type === "BROWSER_EVIDENCE_RECORDED"
          ? event.targetUrl
          : undefined,
    }),
    recordFailure: assign({
      failure: ({ event }) =>
        event.type === "RUN_FAILED" ? event.failure : undefined,
    }),
    recordGitHubChecks: assign({
      githubChecksPath: ({ event }) =>
        event.type === "GITHUB_CHECKS_RECORDED"
          ? event.checksPath
          : undefined,
      githubChecksStatus: ({ event }) =>
        event.type === "GITHUB_CHECKS_RECORDED" ? event.status : undefined,
      githubPullRequest: ({ event }) =>
        event.type === "GITHUB_CHECKS_RECORDED"
          ? event.pullRequest
          : undefined,
      githubWatchStatePath: ({ context, event }) =>
        event.type === "GITHUB_CHECKS_RECORDED" &&
        event.watchStatePath !== undefined
          ? event.watchStatePath
          : context.githubWatchStatePath,
    }),
    recordReportCompleted: assign({
      reportPath: ({ event }) =>
        event.type === "REPORT_COMPLETED" ? event.reportPath : undefined,
    }),
    recordRunCreated: assign({
      runId: ({ event }) =>
        event.type === "RUN_CREATED" ? event.runId : undefined,
      specPath: ({ event }) =>
        event.type === "RUN_CREATED" ? event.specPath : undefined,
    }),
    recordReviewCompleted: assign({
      evidenceReviewPath: ({ context, event }) =>
        event.type === "REVIEW_COMPLETED" && event.phase === "evidence"
          ? event.reviewPath
          : context.evidenceReviewPath,
      evidenceReviewerSessionPath: ({ context, event }) =>
        event.type === "REVIEW_COMPLETED" &&
        event.phase === "evidence" &&
        event.reviewerSessionEvidencePath !== undefined
          ? event.reviewerSessionEvidencePath
          : context.evidenceReviewerSessionPath,
      planReviewPath: ({ context, event }) =>
        event.type === "REVIEW_COMPLETED" && event.phase === "plan"
          ? event.reviewPath
          : context.planReviewPath,
      planReviewerSessionPath: ({ context, event }) =>
        event.type === "REVIEW_COMPLETED" &&
        event.phase === "plan" &&
        event.reviewerSessionEvidencePath !== undefined
          ? event.reviewerSessionEvidencePath
          : context.planReviewerSessionPath,
    }),
    recordVerificationCompleted: assign({
      verificationResultPath: ({ event }) =>
        event.type === "VERIFICATION_COMPLETED"
          ? event.verificationResultPath
          : undefined,
    }),
    recordWorkerCompleted: assign({
      workerResultPath: ({ event }) =>
        event.type === "WORKER_COMPLETED" ? event.workerResultPath : undefined,
    }),
    recordWorkspacePrepared: assign({
      workspacePath: ({ event }) =>
        event.type === "WORKSPACE_PREPARED" ? event.workspacePath : undefined,
    }),
  },
});

export function replayRunEvents(events: ReadonlyArray<RunEvent>) {
  const actor = createActor(runMachine).start();
  let expectedSequence = 1;

  for (const event of events) {
    if (event.sequence !== expectedSequence) {
      throw new Error(
        `Invalid event sequence: expected ${expectedSequence}, received ${event.sequence}.`,
      );
    }

    actor.send(toMachineEvent(event));
    expectedSequence += 1;
  }

  return actor.getSnapshot();
}

export function snapshotFromReplay(events: ReadonlyArray<RunEvent>): RunSnapshot {
  const replayed = replayRunEvents(events);
  const latest = events.at(-1);

  if (latest === undefined) {
    throw new Error("Cannot create a snapshot from an empty event log.");
  }

  return RunSnapshot.make({
    context: snapshotContext(replayed.context),
    eventSequence: latest.sequence,
    runId: latest.runId,
    state: stateValueToRunState(replayed.value),
    timestamp: latest.timestamp,
    version: 1,
  });
}

function toMachineEvent(event: RunEvent): RunMachineEvent {
  switch (event.type) {
    case "BROWSER_EVIDENCE_RECORDED":
      return {
        evidencePath: getStringPayload(event, "evidencePath"),
        status: getStringPayload(event, "status"),
        targetUrl: getStringPayload(event, "targetUrl"),
        type: event.type,
      };
    case "GITHUB_CHECKS_RECORDED":
      const watchStatePath = getOptionalStringPayload(
        event,
        "watchStatePath",
      );
      return {
        checksPath: getStringPayload(event, "checksPath"),
        pullRequest: getStringPayload(event, "pullRequest"),
        status: getStringPayload(event, "status"),
        type: event.type,
        ...(watchStatePath === undefined ? {} : { watchStatePath }),
      };
    case "REPORT_COMPLETED":
      return {
        reportPath: getStringPayload(event, "reportPath"),
        type: event.type,
      };
    case "REPORT_STARTED":
    case "REVIEW_STARTED":
    case "VERIFICATION_STARTED":
    case "WORKER_STARTED":
      return { type: event.type };
    case "REVIEW_COMPLETED":
      const reviewerSessionEvidencePath = getOptionalStringPayload(
        event,
        "reviewerSessionEvidencePath",
      );
      return {
        phase: getReviewPhasePayload(event, "phase"),
        reviewPath: getStringPayload(event, "reviewPath"),
        type: event.type,
        ...(reviewerSessionEvidencePath === undefined
          ? {}
          : { reviewerSessionEvidencePath }),
      };
    case "RUN_CREATED":
      return {
        runId: event.runId,
        specPath: getStringPayload(event, "specPath"),
        type: event.type,
      };
    case "RUN_FAILED":
      return {
        failure: GaiaFailure.make({
          code: getStringPayload(event, "code"),
          message: getStringPayload(event, "message"),
          recoverable: getBooleanPayload(event, "recoverable"),
          stage: getFailureStagePayload(event, "stage"),
        }),
        type: event.type,
      };
    case "VERIFICATION_COMPLETED":
      return {
        type: event.type,
        verificationResultPath: getStringPayload(
          event,
          "verificationResultPath",
        ),
      };
    case "WORKER_COMPLETED":
      return {
        type: event.type,
        workerResultPath: getStringPayload(event, "workerResultPath"),
      };
    case "WORKSPACE_PREPARED":
      return {
        type: event.type,
        workspacePath: getStringPayload(event, "workspacePath"),
      };
  }
}

function getStringPayload(event: RunEvent, key: string): string {
  const value = event.payload[key];
  if (typeof value === "string") {
    return value;
  }

  throw new Error(`Event ${event.type} is missing string payload '${key}'.`);
}

function getBooleanPayload(event: RunEvent, key: string): boolean {
  const value = event.payload[key];
  if (typeof value === "boolean") {
    return value;
  }

  throw new Error(`Event ${event.type} is missing boolean payload '${key}'.`);
}

function getOptionalStringPayload(
  event: RunEvent,
  key: string,
): string | undefined {
  const value = event.payload[key];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === "string") {
    return value;
  }

  throw new Error(`Event ${event.type} has invalid string payload '${key}'.`);
}

function getFailureStagePayload(event: RunEvent, key: string) {
  const value = getStringPayload(event, key);
  return Schema.decodeUnknownSync(FailureStageSchema)(value);
}

function getReviewPhasePayload(event: RunEvent, key: string) {
  const value = getStringPayload(event, key);
  return Schema.decodeUnknownSync(ReviewPhaseSchema)(value);
}

function snapshotContext(
  context: RunMachineContext,
): Readonly<Record<string, string | boolean>> {
  const output: Record<string, string | boolean> = {};

  if (context.browserEvidencePath !== undefined) {
    output.browserEvidencePath = context.browserEvidencePath;
  }
  if (context.browserEvidenceStatus !== undefined) {
    output.browserEvidenceStatus = context.browserEvidenceStatus;
  }
  if (context.browserEvidenceTargetUrl !== undefined) {
    output.browserEvidenceTargetUrl = context.browserEvidenceTargetUrl;
  }
  if (context.evidenceReviewPath !== undefined) {
    output.evidenceReviewPath = context.evidenceReviewPath;
  }
  if (context.githubChecksPath !== undefined) {
    output.githubChecksPath = context.githubChecksPath;
  }
  if (context.githubChecksStatus !== undefined) {
    output.githubChecksStatus = context.githubChecksStatus;
  }
  if (context.githubPullRequest !== undefined) {
    output.githubPullRequest = context.githubPullRequest;
  }
  if (context.githubWatchStatePath !== undefined) {
    output.githubWatchStatePath = context.githubWatchStatePath;
  }
  if (context.planReviewPath !== undefined) {
    output.planReviewPath = context.planReviewPath;
  }
  if (context.evidenceReviewerSessionPath !== undefined) {
    output.evidenceReviewerSessionPath =
      context.evidenceReviewerSessionPath;
  }
  if (context.planReviewerSessionPath !== undefined) {
    output.planReviewerSessionPath =
      context.planReviewerSessionPath;
  }
  if (context.reportPath !== undefined) {
    output.reportPath = context.reportPath;
  }
  if (context.runId !== undefined) {
    output.runId = context.runId;
  }
  if (context.specPath !== undefined) {
    output.specPath = context.specPath;
  }
  if (context.verificationResultPath !== undefined) {
    output.verificationResultPath = context.verificationResultPath;
  }
  if (context.workerResultPath !== undefined) {
    output.workerResultPath = context.workerResultPath;
  }
  if (context.workspacePath !== undefined) {
    output.workspacePath = context.workspacePath;
  }

  return output;
}

function stateValueToRunState(value: unknown): RunState {
  return Schema.decodeUnknownSync(RunStateSchema)(value);
}
