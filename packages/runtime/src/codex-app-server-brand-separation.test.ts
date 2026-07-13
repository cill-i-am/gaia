import type {
  HarnessItemId,
  HarnessSessionId,
  HarnessTurnId,
  WorkerRecoveryActionId,
  WorkerRecoveryDigest,
  WorkerRecoveryModelId,
} from "@gaia/core";
import { expect, it } from "vitest";

import type {
  CodexItemId,
  CodexThreadId,
  CodexTurnId,
  CodexModelId,
} from "./codex-app-server-protocol.js";
import type {
  HarnessCheckpointToken,
  HarnessCorrelationToken,
} from "./harness-session.js";

type IsAssignable<From, To> = [From] extends [To] ? true : false;
type AssertFalse<Value extends false> = Value;

const separationProof: readonly [
  AssertFalse<IsAssignable<CodexThreadId, HarnessSessionId>>,
  AssertFalse<IsAssignable<HarnessSessionId, CodexThreadId>>,
  AssertFalse<IsAssignable<CodexTurnId, HarnessTurnId>>,
  AssertFalse<IsAssignable<HarnessTurnId, CodexTurnId>>,
  AssertFalse<IsAssignable<CodexItemId, HarnessItemId>>,
  AssertFalse<IsAssignable<HarnessItemId, CodexItemId>>,
  AssertFalse<IsAssignable<HarnessCorrelationToken, HarnessCheckpointToken>>,
  AssertFalse<IsAssignable<HarnessCheckpointToken, HarnessCorrelationToken>>,
  AssertFalse<IsAssignable<HarnessCorrelationToken, CodexThreadId>>,
  AssertFalse<IsAssignable<HarnessCheckpointToken, CodexTurnId>>,
  AssertFalse<IsAssignable<CodexModelId, WorkerRecoveryModelId>>,
  AssertFalse<IsAssignable<WorkerRecoveryModelId, CodexModelId>>,
  AssertFalse<IsAssignable<WorkerRecoveryActionId, WorkerRecoveryDigest>>,
  AssertFalse<IsAssignable<WorkerRecoveryDigest, WorkerRecoveryActionId>>,
  AssertFalse<IsAssignable<WorkerRecoveryActionId, WorkerRecoveryModelId>>,
  AssertFalse<IsAssignable<WorkerRecoveryDigest, WorkerRecoveryModelId>>,
] = [
  false,
  false,
  false,
  false,
  false,
  false,
  false,
  false,
  false,
  false,
  false,
  false,
  false,
  false,
  false,
  false,
];

it("keeps provider-native, Gaia, correlation, and checkpoint brands mutually separate", () => {
  expect(separationProof.every((value) => value === false)).toBe(true);
});
