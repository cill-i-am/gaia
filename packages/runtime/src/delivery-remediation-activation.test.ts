import {
  chmod,
  lstat,
  mkdir,
  readFile,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";
import {
  DeliveryRemediationActivationActionRequest,
  parseDeliveryFeedbackId,
  parseRunId,
} from "@gaia/core";
import { Effect } from "effect";

import {
  deliveryRemediationActivationPathForTest,
  makeDeliveryRemediationActivationEnvelope,
  makeFileDeliveryRemediationActivationStore,
} from "./delivery-remediation-activation.js";
import { makeDeliveryFeedbackSmokeAuthorization } from "./github-pull-request-provider.js";

describe("delivery remediation activation envelope", () => {
  it.effect(
    "persists one immutable private envelope and removes only an exact verified receipt",
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(() =>
          import("node:fs/promises").then(({ mkdtemp }) =>
            mkdtemp("/tmp/gaia-activation-")
          )
        );
        const request = activationRequest();
        const envelope = makeEnvelope(request);
        const changedAction = makeEnvelope(
          DeliveryRemediationActivationActionRequest.make({
            ...request,
            actionIdempotencyKey: "activate-run-92-attempt-1-retry",
          })
        );
        const store = makeFileDeliveryRemediationActivationStore(root);

        yield* store.save(envelope);
        const loaded = yield* store.load(
          envelope.runId,
          envelope.authorization.authorizationDigest
        );
        const target = deliveryRemediationActivationPathForTest(
          root,
          envelope.runId,
          envelope.authorization.authorizationDigest
        );

        assert.isDefined(loaded);
        assert.strictEqual(
          loaded?.activationReceiptDigest,
          envelope.activationReceiptDigest
        );
        assert.notStrictEqual(
          changedAction.activationReceiptDigest,
          envelope.activationReceiptDigest
        );
        assert.strictEqual(
          (yield* Effect.promise(() => stat(path.dirname(target)))).mode &
            0o777,
          0o700
        );
        assert.strictEqual(
          (yield* Effect.promise(() => stat(target))).mode & 0o777,
          0o600
        );
        assert.notInclude(
          yield* Effect.promise(() => readFile(target, "utf8")),
          "/private/tmp"
        );

        assert.isFalse(
          yield* store.removeVerified({
            authorizationDigest: envelope.authorization.authorizationDigest,
            receiptDigest: "f".repeat(64),
            runId: envelope.runId,
          })
        );
        assert.isTrue(
          yield* store.removeVerified({
            authorizationDigest: envelope.authorization.authorizationDigest,
            receiptDigest: envelope.activationReceiptDigest,
            runId: envelope.runId,
          })
        );
        assert.isFalse(
          yield* Effect.promise(() =>
            lstat(target).then(
              () => true,
              () => false
            )
          )
        );
      })
  );

  it.effect("rejects symlinked and corrupt activation files", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() =>
        import("node:fs/promises").then(({ mkdtemp }) =>
          mkdtemp("/tmp/gaia-activation-")
        )
      );
      const envelope = makeEnvelope(activationRequest());
      const store = makeFileDeliveryRemediationActivationStore(root);
      const target = deliveryRemediationActivationPathForTest(
        root,
        envelope.runId,
        envelope.authorization.authorizationDigest
      );
      yield* Effect.promise(() =>
        mkdir(path.dirname(target), { mode: 0o700, recursive: true })
      );
      yield* Effect.promise(() =>
        writeFile(`${target}.source`, "{}", { mode: 0o600 })
      );
      yield* Effect.promise(() => symlink(`${target}.source`, target));
      assert.isTrue(
        (yield* Effect.exit(
          store.load(envelope.runId, envelope.authorization.authorizationDigest)
        ))._tag === "Failure"
      );

      yield* Effect.promise(() =>
        import("node:fs/promises").then(({ unlink }) => unlink(target))
      );
      yield* Effect.promise(() =>
        writeFile(target, '{"version":1}', { mode: 0o600 })
      );
      assert.isTrue(
        (yield* Effect.exit(
          store.load(envelope.runId, envelope.authorization.authorizationDigest)
        ))._tag === "Failure"
      );

      yield* Effect.promise(() => chmod(path.dirname(target), 0o755));
      assert.isTrue(
        (yield* Effect.exit(
          store.load(envelope.runId, envelope.authorization.authorizationDigest)
        ))._tag === "Failure"
      );
    })
  );

  it.effect("rejects a symlink anywhere below the accepted run root", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() =>
        import("node:fs/promises").then(({ mkdtemp }) =>
          mkdtemp("/tmp/gaia-activation-")
        )
      );
      const outside = yield* Effect.promise(() =>
        import("node:fs/promises").then(({ mkdtemp }) =>
          mkdtemp("/tmp/gaia-activation-outside-")
        )
      );
      const envelope = makeEnvelope(activationRequest());
      const store = makeFileDeliveryRemediationActivationStore(root);
      yield* Effect.promise(() => symlink(outside, path.join(root, ".gaia")));

      assert.strictEqual(
        (yield* Effect.exit(store.save(envelope)))._tag,
        "Failure"
      );
      assert.strictEqual(
        (yield* Effect.exit(
          store.load(envelope.runId, envelope.authorization.authorizationDigest)
        ))._tag,
        "Failure"
      );
    })
  );
});

function activationRequest() {
  const tuple = {
    actorLogin: "cill-i-am",
    actorType: "User" as const,
    authorAssociation: "OWNER" as const,
    commentDatabaseId: "4945491708",
    contentDigest: "b".repeat(64),
    feedbackId: parseDeliveryFeedbackId(`feedback-comment-${"c".repeat(64)}`),
    headSha: "d".repeat(40),
    prNumber: 73,
    repository: "cill-i-am/gaia",
  };
  const authorization = makeDeliveryFeedbackSmokeAuthorization(tuple);
  return DeliveryRemediationActivationActionRequest.make({
    actionIdempotencyKey: "activate-run-92-attempt-1",
    ...tuple,
    authorizationDigest: authorization.authorizationDigest,
    expectedEventSequence: 41,
    kind: "activateRemediation",
    marker: "<!-- gaia-remediation-request:v1 -->",
  });
}

function makeEnvelope(request: ReturnType<typeof activationRequest>) {
  const authorization = makeDeliveryFeedbackSmokeAuthorization({
    actorLogin: request.actorLogin,
    actorType: request.actorType,
    authorAssociation: request.authorAssociation,
    commentDatabaseId: request.commentDatabaseId,
    contentDigest: request.contentDigest,
    feedbackId: request.feedbackId,
    headSha: request.headSha,
    prNumber: request.prNumber,
    repository: request.repository,
  });
  return makeDeliveryRemediationActivationEnvelope({
    attempt: 1,
    authorization,
    clientInputId: "remediation-run-AbCd123456-1",
    expectedPredecessorDigest: "e".repeat(64),
    operationId: "remediation:run-AbCd123456:1",
    prompt: "Bounded non-empty remediation prompt.",
    request,
    runId: parseRunId("run-AbCd123456"),
    trustPolicyDigest: "f".repeat(64),
  });
}
