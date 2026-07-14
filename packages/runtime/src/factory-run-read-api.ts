import {
  LocalRunPathSegmentSchema,
  parseLocalRunReadDiagnostic,
  type FactoryAgentId,
  type FactoryArtifactId,
  type LocalRunReadDiagnostic,
  type RunId,
} from "@gaia/core";
import { Effect, Option, Schema } from "effect";

import {
  readFactoryArtifactBodyFromIndex,
  readFactoryRunIndexes,
  type FactoryActivityIndex,
} from "./factory-run-store.js";
import type { RunStorageOptions } from "./paths.js";

const decodeLocalRunPathSegment = Schema.decodeUnknownOption(
  LocalRunPathSegmentSchema
);

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
  agentIdInput: FactoryAgentId,
  options: RunStorageOptions = {}
) {
  return Effect.gen(function* () {
    const indexes = yield* readFactoryRunIndexes(runId, options);
    const agent = indexes.graph.agents.find(
      (candidate) => candidate.id === agentIdInput
    );
    if (agent === undefined) {
      const pathSegment = decodeLocalRunPathSegment(agentIdInput);
      return yield* Effect.fail(
        parseLocalRunReadDiagnostic({
          code: "FactoryAgentNotFound",
          message: "Factory agent does not exist for this run.",
          ...(Option.isNone(pathSegment)
            ? {}
            : { pathSegment: pathSegment.value }),
          recoverable: false,
          runId: indexes.graph.runId,
        })
      );
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
  artifactIdInput: FactoryArtifactId,
  options: RunStorageOptions = {}
) {
  return readFactoryArtifactBodyFromIndex(runId, artifactIdInput, options);
}
