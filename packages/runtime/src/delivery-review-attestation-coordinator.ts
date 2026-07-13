import {
  DeliveryLocalReviewAttestationConfirmed,
  DeliveryLocalReviewAttestationFailed,
  DeliveryLocalReviewAttestationIntent,
  deliveryLocalReviewAttestationPayloadDigest,
  deriveDeliveryActionHistoriesFromEvents,
  deriveDeliveryAuthority,
  encodeDeliveryLocalReviewAttestationReceiptJson,
  parseDeliveryPublication,
  parseDeliveryPullRequestReadyReceipt,
  snapshotFromReplay,
  type DeliveryAttestPairedReviewActionRequest,
  type DeliveryLocalReviewAttestationReceipt,
  type RunId,
} from "@gaia/core";
import { createHash } from "node:crypto";
import { Effect, Schema } from "effect";
import { appendEvent, readEvents } from "./event-store.js";
import { makeRuntimeError } from "./errors.js";
import { makeRunPaths, type RunPaths, type RunStorageOptions } from "./paths.js";
import {
  makeGitHubFreshReadyForReviewStateReader,
  requireExactReadyForReviewConfirmation,
  type DeliveryReadyForReviewCoordinatorOptions,
  type FreshReadyForReviewState,
} from "./delivery-ready-for-review-coordinator.js";
import { withRunStoreLock } from "./run-store-lock.js";

export type DeliveryLocalReviewAttestationCoordinatorOptions = RunStorageOptions & Pick<
  DeliveryReadyForReviewCoordinatorOptions,
  "commandRunner" | "freshStateReader"
>;

export function coordinateDeliveryLocalReviewAttestation(
  runId: RunId,
  action: DeliveryAttestPairedReviewActionRequest,
  options: DeliveryLocalReviewAttestationCoordinatorOptions,
) {
  return withRunStoreLock(options, Effect.gen(function* () {
    const paths = yield* makeRunPaths(runId, options);
    const events = yield* readEvents(paths).pipe(
      Effect.catchCause(() => conflict("Local review attestation history is invalid for the current run authority.")),
    );
    const replay = snapshotFromReplay(events);
    if (replay.state !== "delivering") return yield* conflict("Local review attestation requires a delivering pull-request run.");
    const delivery = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(replay.context["delivery"]);
    const publication = parseDeliveryPublication(delivery["publication"]);
    if (publication.state !== "confirmed") return yield* conflict("Local review attestation requires a confirmed owned pull request.");
    const repository = repositoryFromPrUrl(publication.prUrl);
    const authority = deriveDeliveryAuthority(publication, events);
    if (
      action.expectedBranchName !== publication.branchName ||
      action.expectedHeadSha !== authority.headSha ||
      action.expectedPrNumber !== publication.prNumber ||
      action.expectedPrUrl !== publication.prUrl
    ) return yield* conflict("Local review attestation does not match the authoritative current pull-request head.");

    const ready = requireExactReadyForReviewConfirmation(events, {
      branchName: publication.branchName,
      expectedHeadSha: authority.headSha,
      prNumber: publication.prNumber,
      prUrl: publication.prUrl,
      publicationOperationId: publication.operationId,
      publicationPayloadDigest: publication.payloadDigest,
      repository,
      runId,
    });
    const readyConfirmation = events.findLast((event) => {
      if (event.type !== "DELIVERY_PR_READY_RECORDED") return false;
      const candidate = parseDeliveryPullRequestReadyReceipt(event.payload["readyForReviewAction"]);
      return candidate.actionId === ready.actionId && candidate.payloadDigest === ready.payloadDigest &&
        (candidate.state === "confirmedWithoutDispatch" || candidate.state === "dispatchConfirmed");
    });
    if (readyConfirmation === undefined) return yield* conflict("Exact ready-for-review confirmation evidence is unavailable.");

    const gaiaEvidenceId = deterministicEvidenceId({ actionId: action.actionId, authoritySequence: authority.authoritySequence, headSha: authority.headSha, publicationPayloadDigest: publication.payloadDigest, readyPayloadDigest: ready.payloadDigest, runId });
    const bindingBase = {
      actionId: action.actionId,
      authority: "localOperator" as const,
      authoritySequence: authority.authoritySequence,
      branchName: publication.branchName,
      decision: action.decision,
      ...(action.gaiaEvidenceDigest === undefined ? {} : { gaiaEvidenceDigest: action.gaiaEvidenceDigest }),
      gaiaEvidenceId,
      headSha: authority.headSha,
      prNumber: publication.prNumber,
      prUrl: publication.prUrl,
      publicationConfirmationSequence: authority.publicationConfirmationSequence,
      publicationOperationId: publication.operationId,
      publicationPayloadDigest: publication.payloadDigest,
      readyConfirmationActionId: ready.actionId,
      readyConfirmationPayloadDigest: ready.payloadDigest,
      readyConfirmationSequence: readyConfirmation.sequence,
      repository,
      runId,
      version: 1 as const,
    };
    const binding = { ...bindingBase, attestationPayloadDigest: deliveryLocalReviewAttestationPayloadDigest(bindingBase) };
    const histories = deriveDeliveryActionHistoriesFromEvents(events).localReviewAttestation;
    const previous = histories.histories.find(({ actionId }) => actionId === action.actionId)?.latest;
    if (previous !== undefined && previous.attestationPayloadDigest !== binding.attestationPayloadDigest) {
      return yield* conflict("Local review attestation action ID conflicts with a changed immutable tuple.");
    }
    if (histories.active !== undefined && histories.active.actionId !== action.actionId) {
      return yield* conflict("An unresolved local review attestation cannot be superseded.");
    }
    const currentConfirmed = histories.histories.find(({ latest }) =>
      latest.state === "confirmed" &&
      latest.authoritySequence === authority.authoritySequence &&
      latest.headSha === authority.headSha
    );
    if (currentConfirmed !== undefined && currentConfirmed.actionId !== action.actionId) {
      return yield* conflict("The current delivery head already has a confirmed local review attestation.");
    }
    if (previous?.state === "confirmed" || previous?.state === "failed") return previous;

    if (previous === undefined) {
      yield* appendAttestation(runId, paths, DeliveryLocalReviewAttestationIntent.make({ ...binding, state: "intentRecorded" }));
    }
    const reader = options.freshStateReader ?? makeGitHubFreshReadyForReviewStateReader({
      ...(options.commandRunner === undefined ? {} : { commandRunner: options.commandRunner }),
      rootDirectory: options.rootDirectory ?? ".",
    });
    const fresh = yield* reader({ prNumber: publication.prNumber, repository }).pipe(
      Effect.mapError(() => makeRuntimeError({ code: "DeliveryReviewAttestationReadFailed", message: "Fresh pull-request lifecycle state is unavailable; the attestation intent remains active.", recoverable: true })),
    );
    if (!isExactOpenPullRequest(fresh, binding)) {
      const failed = DeliveryLocalReviewAttestationFailed.make({ ...binding, code: "DeliveryReviewAttestationPullRequestUnavailable", message: "Fresh state does not prove the exact pull request is open, unmerged, and non-draft.", state: "failed" });
      yield* appendAttestation(runId, paths, failed);
      return failed;
    }
    const latestEvents = yield* readEvents(paths);
    const latestReplay = snapshotFromReplay(latestEvents);
    const latestDelivery = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(latestReplay.context["delivery"]);
    const latestPublication = parseDeliveryPublication(latestDelivery["publication"]);
    if (latestPublication.state !== "confirmed") return yield* conflict("Confirmed publication changed before local review attestation confirmation.");
    const latestAuthority = deriveDeliveryAuthority(latestPublication, latestEvents);
    if (latestPublication.operationId !== publication.operationId || latestPublication.payloadDigest !== publication.payloadDigest || latestAuthority.authoritySequence !== authority.authoritySequence || latestAuthority.headSha !== authority.headSha) {
      return yield* conflict("Delivery authority changed before local review attestation confirmation.");
    }
    const confirmed = DeliveryLocalReviewAttestationConfirmed.make({ ...binding, state: "confirmed" });
    yield* appendAttestation(runId, paths, confirmed);
    return confirmed;
  }), {
    operation: "Gaia local operator paired-review attestation",
    nextSafeAction: "Refresh delivery state and resume only the same exact attestation action ID.",
  });
}

function appendAttestation(runId: RunId, paths: RunPaths, receipt: DeliveryLocalReviewAttestationReceipt) {
  return appendEvent(runId, paths, {
    payload: { attestation: encodeDeliveryLocalReviewAttestationReceiptJson(receipt) },
    type: "DELIVERY_LOCAL_REVIEW_ATTESTATION_RECORDED",
  });
}

function deterministicEvidenceId(input: { readonly actionId: string; readonly authoritySequence: number; readonly headSha: string; readonly publicationPayloadDigest: string; readonly readyPayloadDigest: string; readonly runId: string }) {
  const digest = createHash("sha256").update(["gaia.delivery.local-paired-review-evidence-id.v1", input.actionId, input.runId, input.publicationPayloadDigest, String(input.authoritySequence), input.headSha, input.readyPayloadDigest].join("\0")).digest("hex");
  return `evidence-${digest.slice(0, 32)}`;
}

function isExactOpenPullRequest(fresh: FreshReadyForReviewState, binding: { readonly branchName: string; readonly headSha: string; readonly prNumber: number; readonly prUrl: string; readonly repository: string }) {
  return fresh.repository === binding.repository &&
    fresh.prNumber === binding.prNumber &&
    fresh.prUrl === binding.prUrl &&
    fresh.branchName === binding.branchName &&
    fresh.headSha === binding.headSha &&
    fresh.draft === false &&
    fresh.state === "open" &&
    fresh.mergedAt === undefined &&
    fresh.mergeCommitSha === undefined;
}

function repositoryFromPrUrl(url: string) {
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\//u.exec(url);
  if (match?.[1] === undefined) throw new Error("Invalid owned PR URL.");
  return match[1];
}

function conflict(message: string) {
  return Effect.fail(makeRuntimeError({ code: "DeliveryActionConflict", message, recoverable: true }));
}
