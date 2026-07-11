import { Schema } from "effect";
import type { RunEvent } from "./events.js";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const Digest = Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-f0-9]{64}$/u)));
const GitSha = Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-f0-9]{40}$/u)));
const BoundedId = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isPattern(/^[A-Za-z0-9:_-]+$/u)),
  Schema.check(Schema.isMaxLength(200)),
);
const Repository = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u)),
  Schema.check(Schema.isMaxLength(200)),
);
const StableCheckField = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isPattern(/^[A-Za-z0-9_.:/ -]+$/u)),
  Schema.check(Schema.isMaxLength(200)),
);

export const DeliveryMergeMethodSchema = Schema.Literals([
  "merge",
  "squash",
  "rebase",
] as const);
export type DeliveryMergeMethod = typeof DeliveryMergeMethodSchema.Type;

export const deliveryMergeMethodArguments = {
  merge: ["--merge"],
  rebase: ["--rebase"],
  squash: ["--squash"],
} as const satisfies Record<DeliveryMergeMethod, readonly [string]>;

export class DeliveryRequiredCheckIdentity extends Schema.Class<DeliveryRequiredCheckIdentity>(
  "DeliveryRequiredCheckIdentity",
)({
  appSlug: StableCheckField,
  name: StableCheckField,
  repository: Repository,
  workflow: StableCheckField,
}, strict) {}

export class DeliveryRequiredCheckPolicy extends Schema.Class<DeliveryRequiredCheckPolicy>(
  "DeliveryRequiredCheckPolicy",
)({
  checks: Schema.Array(DeliveryRequiredCheckIdentity).pipe(
    Schema.check(Schema.isMaxLength(20)),
    Schema.check(Schema.makeFilter((checks) => {
      const keys = checks.map(requiredCheckKey);
      return keys.length === new Set(keys).size && keys.every((key, index) => index === 0 || keys[index - 1]! < key);
    }, { identifier: "SortedUniqueRequiredChecks" })),
  ),
  requireApprovedReview: Schema.Boolean,
  version: Schema.Literal(1),
}, strict) {}

export class DeliveryMergeReadinessDecision extends Schema.Class<DeliveryMergeReadinessDecision>(
  "DeliveryMergeReadinessDecision",
)({
  actionId: BoundedId,
  approved: Schema.Boolean,
  blockers: Schema.Array(Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(200)))).pipe(Schema.check(Schema.isMaxLength(20))),
  branchName: Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(240))),
  headSha: GitSha,
  mergeMethod: DeliveryMergeMethodSchema,
  payloadDigest: Digest,
  policyDigest: Digest,
  policyVersion: Schema.Literal(1),
  prNumber: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1))),
  prUrl: Schema.String.pipe(Schema.check(Schema.isPattern(/^https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/[1-9]\d*$/u))),
}, strict) {}
export const parseDeliveryMergeReadinessDecision = Schema.decodeUnknownSync(DeliveryMergeReadinessDecision);
const DeliveryMergeReadinessDecisionJson = Schema.toCodecJson(DeliveryMergeReadinessDecision);
export const encodeDeliveryMergeReadinessDecisionJson = Schema.encodeSync(DeliveryMergeReadinessDecisionJson);

export function requiredCheckKey(check: typeof DeliveryRequiredCheckIdentity.Type) {
  return [check.repository, check.workflow, check.name, check.appSlug]
    .map((field) => `${field.length}:${field}`)
    .join("|");
}

export function deliveryRequiredCheckPolicyCanonicalPayload(policy: typeof DeliveryRequiredCheckPolicy.Type) {
  const entries = policy.checks.map(requiredCheckKey);
  return `v${policy.version}|review:${policy.requireApprovedReview ? "1" : "0"}|${entries.map((entry) => `${entry.length}:${entry}`).join("|")}`;
}

const mergeBinding = {
  actionId: BoundedId,
  branchName: Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(240))),
  decisionSequence: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1))),
  expectedHeadSha: GitSha,
  mergeMethod: DeliveryMergeMethodSchema,
  payloadDigest: Digest,
  policyDigest: Digest,
  policyVersion: Schema.Literal(1),
  prNumber: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1))),
  prUrl: Schema.String.pipe(Schema.check(Schema.isPattern(/^https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/[1-9]\d*$/u))),
  repository: Repository,
} as const;

export class DeliveryMergeIntent extends Schema.Class<DeliveryMergeIntent>("DeliveryMergeIntent")({
  ...mergeBinding,
  state: Schema.Literal("intentRecorded"),
}, strict) {}
export class DeliveryMergeDispatchAttempted extends Schema.Class<DeliveryMergeDispatchAttempted>("DeliveryMergeDispatchAttempted")({
  ...mergeBinding,
  state: Schema.Literal("dispatchAttempted"),
}, strict) {}
export class DeliveryMergeDispatchConfirmed extends Schema.Class<DeliveryMergeDispatchConfirmed>("DeliveryMergeDispatchConfirmed")({
  ...mergeBinding,
  mergeCommitSha: GitSha,
  mergedAt: Schema.NonEmptyString,
  state: Schema.Literal("dispatchConfirmed"),
}, strict) {}
export class DeliveryMergeTerminalFailure extends Schema.Class<DeliveryMergeTerminalFailure>("DeliveryMergeTerminalFailure")({
  ...mergeBinding,
  code: Schema.NonEmptyString,
  message: Schema.NonEmptyString,
  state: Schema.Literals(["dispatchFailed", "outcomeUnknown"] as const),
}, strict) {}

export const DeliveryMergeReceiptSchema = Schema.Union([
  DeliveryMergeIntent,
  DeliveryMergeDispatchAttempted,
  DeliveryMergeDispatchConfirmed,
  DeliveryMergeTerminalFailure,
]);
export type DeliveryMergeReceipt = typeof DeliveryMergeReceiptSchema.Type;
export const parseDeliveryMergeReceipt = Schema.decodeUnknownSync(DeliveryMergeReceiptSchema);
const DeliveryMergeReceiptJson = Schema.toCodecJson(DeliveryMergeReceiptSchema);
export const encodeDeliveryMergeReceiptJson = Schema.encodeSync(DeliveryMergeReceiptJson);

export const DeliveryCleanupResourceStateSchema = Schema.Literals(["present", "absent"] as const);
const cleanupBase = {
  actionId: BoundedId,
  branchName: Schema.NonEmptyString,
  mergeCommitSha: GitSha,
  ownershipDigest: Digest,
} as const;
export class DeliveryCleanupRequired extends Schema.Class<DeliveryCleanupRequired>("DeliveryCleanupRequired")({
  ...cleanupBase,
  branch: DeliveryCleanupResourceStateSchema,
  state: Schema.Literal("cleanupRequired"),
  worktree: DeliveryCleanupResourceStateSchema,
}, strict) {}
export class DeliveryCleanupCompleted extends Schema.Class<DeliveryCleanupCompleted>("DeliveryCleanupCompleted")({
  ...cleanupBase,
  branch: Schema.Literal("absent"),
  state: Schema.Literal("completed"),
  worktree: Schema.Literal("absent"),
}, strict) {}
export const DeliveryCleanupReceiptSchema = Schema.Union([DeliveryCleanupRequired, DeliveryCleanupCompleted]);
export const parseDeliveryCleanupReceipt = Schema.decodeUnknownSync(DeliveryCleanupReceiptSchema);
const DeliveryCleanupReceiptJson = Schema.toCodecJson(DeliveryCleanupReceiptSchema);
export const encodeDeliveryCleanupReceiptJson = Schema.encodeSync(DeliveryCleanupReceiptJson);

export type DeliveryMergeActionHistory = {
  readonly actionId: string;
  readonly latest: DeliveryMergeReceipt;
  readonly latestSequence: number;
  readonly receipts: ReadonlyArray<{ readonly receipt: DeliveryMergeReceipt; readonly sequence: number }>;
};
export type DeliveryCleanupActionReceipt = ReturnType<typeof parseDeliveryCleanupReceipt>;
export type DeliveryCleanupActionHistory = {
  readonly actionId: string;
  readonly latest: DeliveryCleanupActionReceipt;
  readonly latestSequence: number;
  readonly receipts: ReadonlyArray<{ readonly receipt: DeliveryCleanupActionReceipt; readonly sequence: number }>;
};

export function deriveDeliveryMergeActionHistories(events: ReadonlyArray<{ readonly receipt: DeliveryMergeReceipt; readonly sequence: number }>) {
  const histories = new Map<string, DeliveryMergeActionHistory>();
  for (const event of events) {
    const previous = histories.get(event.receipt.actionId);
    validateDeliveryMergeActionTransition(previous?.latest, event.receipt);
    histories.set(event.receipt.actionId, {
      actionId: event.receipt.actionId,
      latest: event.receipt,
      latestSequence: event.sequence,
      receipts: [...(previous?.receipts ?? []), event],
    });
  }
  const ordered = [...histories.values()].sort((left, right) => left.latestSequence - right.latestSequence || left.actionId.localeCompare(right.actionId));
  const active = ordered.filter(({ latest }) => latest.state === "intentRecorded" || latest.state === "dispatchAttempted" || latest.state === "outcomeUnknown");
  if (active.length > 1) throw new Error("Only one merge action may be active.");
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1]!;
    const next = ordered[index]!;
    if (previous.latest.state !== "dispatchFailed" || next.latest.decisionSequence <= previous.latest.decisionSequence) throw new Error("A newer merge action requires conclusive failure and a newer readiness decision.");
  }
  return { active: active[0], histories: ordered, latest: ordered.at(-1) };
}

export function deriveDeliveryCleanupActionHistories(events: ReadonlyArray<{ readonly receipt: DeliveryCleanupActionReceipt; readonly sequence: number }>) {
  const histories = new Map<string, DeliveryCleanupActionHistory>();
  for (const event of events) {
    const previous = histories.get(event.receipt.actionId);
    if (previous !== undefined) {
      if (previous.latest.branchName !== event.receipt.branchName || previous.latest.mergeCommitSha !== event.receipt.mergeCommitSha || previous.latest.ownershipDigest !== event.receipt.ownershipDigest) throw new Error("Cleanup action binding changed.");
      if (previous.latest.state === "completed" && event.receipt.state !== "completed") throw new Error("Completed cleanup cannot regress.");
      if (previous.latest.worktree === "absent" && event.receipt.worktree !== "absent") throw new Error("Proven worktree absence cannot regress.");
      if (previous.latest.branch === "absent" && event.receipt.branch !== "absent") throw new Error("Proven branch absence cannot regress.");
    }
    histories.set(event.receipt.actionId, { actionId: event.receipt.actionId, latest: event.receipt, latestSequence: event.sequence, receipts: [...(previous?.receipts ?? []), event] });
  }
  const ordered = [...histories.values()].sort((left, right) => left.latestSequence - right.latestSequence || left.actionId.localeCompare(right.actionId));
  const active = ordered.filter(({ latest }) => latest.state !== "completed");
  if (active.length > 1) throw new Error("Only one cleanup action may be active.");
  return { active: active[0], histories: ordered, latest: ordered.at(-1) };
}

export function deliveryActionAuditSummary(input: { readonly cleanup: ReturnType<typeof deriveDeliveryCleanupActionHistories>; readonly merge: ReturnType<typeof deriveDeliveryMergeActionHistories> }, limit = 20) {
  const safeLimit = Math.max(1, Math.min(50, Math.trunc(limit)));
  return {
    cleanup: input.cleanup.histories.slice(-safeLimit).map(({ actionId, latest, latestSequence }) => ({ actionId, latestSequence, state: latest.state })),
    merge: input.merge.histories.slice(-safeLimit).map(({ actionId, latest, latestSequence }) => ({ actionId, latestSequence, state: latest.state })),
  };
}

function validateDeliveryMergeActionTransition(previous: DeliveryMergeReceipt | undefined, next: DeliveryMergeReceipt) {
  if (previous === undefined) {
    if (next.state !== "intentRecorded") throw new Error("Merge action must begin with intent.");
    return;
  }
  const binding = ["actionId", "branchName", "decisionSequence", "expectedHeadSha", "mergeMethod", "payloadDigest", "policyDigest", "policyVersion", "prNumber", "prUrl", "repository"] as const;
  if (binding.some((key) => previous[key] !== next[key])) throw new Error("Merge action binding changed.");
  if (previous.state === next.state) return;
  if (previous.state === "intentRecorded" && next.state === "dispatchAttempted") return;
  if (previous.state === "dispatchAttempted" && (next.state === "dispatchConfirmed" || next.state === "dispatchFailed" || next.state === "outcomeUnknown")) return;
  if (previous.state === "outcomeUnknown" && next.state === "dispatchConfirmed") return;
  throw new Error(`Illegal merge action transition ${previous.state} -> ${next.state}.`);
}

export function deriveDeliveryActionHistoriesFromEvents(events: ReadonlyArray<RunEvent>) {
  return {
    cleanup: deriveDeliveryCleanupActionHistories(events.flatMap((event) => event.type === "DELIVERY_CLEANUP_RECORDED" ? [{ receipt: parseDeliveryCleanupReceipt(event.payload["cleanup"]), sequence: event.sequence }] : [])),
    merge: deriveDeliveryMergeActionHistories(events.flatMap((event) => event.type === "DELIVERY_MERGE_RECORDED" ? [{ receipt: parseDeliveryMergeReceipt(event.payload["mergeAction"]), sequence: event.sequence }] : [])),
  };
}
