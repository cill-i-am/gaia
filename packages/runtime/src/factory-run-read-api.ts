import type { RunId } from "@gaia/core";
import { Effect } from "effect";

import {
  readFactoryArtifactBodyFromIndex,
  readFactoryRunIndexes,
  type FactoryActivityIndex,
} from "./factory-run-store.js";
import type { RunStorageOptions } from "./paths.js";
import type { LocalRunReadDiagnostic } from "./run-read-api.js";

export function readFactoryGraph(
  runId: RunId,
  options: RunStorageOptions = {}
) {
  return readFactoryRunIndexes(runId, options).pipe(
    Effect.map((indexes) => indexes.graph)
  );
}

export function readFactoryRunActivity(
  runId: RunId,
  options: RunStorageOptions = {}
) {
  return readFactoryRunIndexes(runId, options).pipe(
    Effect.map((indexes) => indexes.activity)
  );
}

export function readFactoryAgentActivity(
  runId: RunId,
  agentIdInput: string,
  options: RunStorageOptions = {}
) {
  return Effect.gen(function* () {
    const indexes = yield* readFactoryRunIndexes(runId, options);
    const agent = indexes.graph.agents.find(
      (candidate) => candidate.id === agentIdInput
    );
    if (agent === undefined) {
      return yield* Effect.fail({
        code: "FactoryAgentNotFound",
        message: "Factory agent does not exist for this run.",
        pathSegment: agentIdInput,
        recoverable: false,
        runId: indexes.graph.runId,
      } satisfies LocalRunReadDiagnostic);
    }

    return {
      activities: indexes.activity.activities.filter(
        (activity) => activity.agentId === agent.id
      ),
      runId: indexes.activity.runId,
    } satisfies FactoryActivityIndex;
  });
}

export function listFactoryRunArtifacts(
  runId: RunId,
  options: RunStorageOptions = {}
) {
  return readFactoryRunIndexes(runId, options).pipe(
    Effect.map((indexes) => indexes.artifacts)
  );
}

export function readFactoryRunArtifact(
  runId: RunId,
  artifactIdInput: string,
  options: RunStorageOptions = {}
) {
  return readFactoryArtifactBodyFromIndex(runId, artifactIdInput, options);
}
