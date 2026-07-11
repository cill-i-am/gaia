import {
  DeliveryRemediationActivationActionRequest,
  RunIdSchema,
  type RunId,
} from "@gaia/core";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { Effect, Schema } from "effect";

import { makeRuntimeError } from "./errors.js";
import {
  DeliveryFeedbackSmokeAuthorization,
  deliveryFeedbackSmokeAuthorizationDigest,
} from "./github-pull-request-provider.js";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const DigestSchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
);
const BoundedIdSchema = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isPattern(/^[A-Za-z0-9:_-]+$/u)),
  Schema.check(Schema.isMaxLength(200)),
);
const PromptSchema = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isMaxLength(16_384)),
);
const maximumEnvelopeBytes = 32_768;

/** Adapter-private restart material for one already-authorized attempt. */
export class DeliveryRemediationActivationEnvelope extends Schema.Class<DeliveryRemediationActivationEnvelope>(
  "DeliveryRemediationActivationEnvelope",
)({
  actionIdempotencyKey: BoundedIdSchema,
  activationReceiptDigest: DigestSchema,
  attempt: Schema.Int.pipe(
    Schema.check(Schema.isGreaterThanOrEqualTo(1)),
    Schema.check(Schema.isLessThanOrEqualTo(2)),
  ),
  authorization: DeliveryFeedbackSmokeAuthorization,
  clientInputId: BoundedIdSchema,
  expectedEventSequence: Schema.Int.pipe(
    Schema.check(Schema.isGreaterThanOrEqualTo(1)),
  ),
  expectedPredecessorDigest: DigestSchema,
  operationId: BoundedIdSchema,
  prompt: PromptSchema,
  promptDigest: DigestSchema,
  runId: RunIdSchema,
  trustPolicyDigest: DigestSchema,
  version: Schema.Literal(1),
}, strict) {}

export type DeliveryRemediationActivationStore = {
  readonly load: (
    runId: RunId,
    authorizationDigest: string,
  ) => Effect.Effect<DeliveryRemediationActivationEnvelope | undefined, ReturnType<typeof activationError>>;
  readonly removeVerified: (input: {
    readonly authorizationDigest: string;
    readonly receiptDigest: string;
    readonly runId: RunId;
  }) => Effect.Effect<boolean, ReturnType<typeof activationError>>;
  readonly save: (
    envelope: DeliveryRemediationActivationEnvelope,
  ) => Effect.Effect<void, ReturnType<typeof activationError>>;
};

/** Build the immutable private envelope and bind the operator action key. */
export function makeDeliveryRemediationActivationEnvelope(input: {
  readonly attempt: number;
  readonly authorization: DeliveryFeedbackSmokeAuthorization;
  readonly clientInputId: string;
  readonly expectedPredecessorDigest: string;
  readonly operationId: string;
  readonly prompt: string;
  readonly request: DeliveryRemediationActivationActionRequest;
  readonly runId: RunId;
  readonly trustPolicyDigest: string;
}) {
  const prompt = input.prompt.trim();
  if (prompt.length === 0 || Buffer.byteLength(prompt) > 16_384) {
    throw activationError("DeliveryActivationPromptInvalid", "Controlled remediation prompt is empty or exceeds its bound.");
  }
  if (
    input.request.authorizationDigest !== input.authorization.authorizationDigest ||
    !requestMatchesAuthorization(input.request, input.authorization)
  ) {
    throw activationError("DeliveryActivationTupleMismatch", "Controlled remediation authorization does not match the requested tuple.");
  }
  const promptDigest = stableHash(prompt);
  const activationReceiptDigest = stableHash([
    "gaia-remediation-activation-envelope-v1",
    input.runId,
    input.operationId,
    String(input.attempt),
    input.clientInputId,
    input.request.actionIdempotencyKey,
    String(input.request.expectedEventSequence),
    input.expectedPredecessorDigest,
    input.authorization.authorizationDigest,
    promptDigest,
    input.trustPolicyDigest,
    input.authorization.headSha,
  ].join("\0"));
  return DeliveryRemediationActivationEnvelope.make({
    actionIdempotencyKey: input.request.actionIdempotencyKey,
    activationReceiptDigest,
    attempt: input.attempt,
    authorization: input.authorization,
    clientInputId: input.clientInputId,
    expectedEventSequence: input.request.expectedEventSequence,
    expectedPredecessorDigest: input.expectedPredecessorDigest,
    operationId: input.operationId,
    prompt,
    promptDigest,
    runId: input.runId,
    trustPolicyDigest: input.trustPolicyDigest,
    version: 1,
  });
}

/** Durable private store with exact-file cleanup only. */
export function makeFileDeliveryRemediationActivationStore(
  rootDirectory: string,
): DeliveryRemediationActivationStore {
  const directory = activationDirectory(rootDirectory);
  return {
    load: (runId, authorizationDigest) =>
      Effect.tryPromise({
        try: () => readEnvelope(rootDirectory, directory, runId, authorizationDigest),
        catch: (cause) => activationError("DeliveryActivationEnvelopeUnreadable", "Private remediation activation state is unreadable.", cause),
      }),
    removeVerified: (input) =>
      Effect.tryPromise({
        try: async () => {
          const envelope = await readEnvelope(
            rootDirectory,
            directory,
            input.runId,
            input.authorizationDigest,
          );
          if (
            envelope === undefined ||
            envelope.activationReceiptDigest !== input.receiptDigest
          ) {
            return false;
          }
          const target = activationPath(directory, input.runId, input.authorizationDigest);
          await unlink(target);
          await syncDirectory(directory);
          return true;
        },
        catch: (cause) => activationError("DeliveryActivationEnvelopeCleanupFailed", "Verified private remediation activation cleanup failed.", cause),
      }),
    save: (envelope) =>
      Effect.tryPromise({
        try: async () => {
          await ensurePrivateDirectory(rootDirectory, directory);
          const target = activationPath(
            directory,
            envelope.runId,
            envelope.authorization.authorizationDigest,
          );
          const existing = await readEnvelope(
            rootDirectory,
            directory,
            envelope.runId,
            envelope.authorization.authorizationDigest,
          );
          if (existing !== undefined) {
            if (existing.activationReceiptDigest !== envelope.activationReceiptDigest) {
              throw new Error("Activation envelope binding changed.");
            }
            return;
          }
          const encoded = `${JSON.stringify(Schema.encodeSync(DeliveryRemediationActivationEnvelope)(envelope))}\n`;
          if (Buffer.byteLength(encoded) > maximumEnvelopeBytes) {
            throw new Error("Activation envelope exceeds its size bound.");
          }
          const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
          const handle = await open(temporary, "wx", 0o600);
          try {
            await handle.writeFile(encoded, "utf8");
            await handle.sync();
          } finally {
            await handle.close();
          }
          await chmod(temporary, 0o600);
          await rename(temporary, target);
          await syncDirectory(directory);
        },
        catch: (cause) => activationError("DeliveryActivationEnvelopeWriteFailed", "Private remediation activation state could not be persisted.", cause),
      }),
  };
}

async function readEnvelope(
  rootDirectory: string,
  directory: string,
  runId: RunId,
  authorizationDigest: string,
) {
  if (!(await hasNoSymlinkedPath(rootDirectory, directory))) return undefined;
  let directoryMetadata;
  try {
    directoryMetadata = await lstat(directory);
  } catch (cause) {
    if (isMissing(cause)) return undefined;
    throw cause;
  }
  if (
    !directoryMetadata.isDirectory() ||
    directoryMetadata.isSymbolicLink() ||
    (directoryMetadata.mode & 0o777) !== 0o700
  ) {
    throw new Error("Activation envelope directory is not private.");
  }
  const target = activationPath(directory, runId, authorizationDigest);
  let metadata;
  try {
    metadata = await lstat(target);
  } catch (cause) {
    if (isMissing(cause)) return undefined;
    throw cause;
  }
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o777) !== 0o600 ||
    metadata.size > maximumEnvelopeBytes
  ) {
    throw new Error("Activation envelope file is not private and bounded.");
  }
  const envelope = Schema.decodeUnknownSync(DeliveryRemediationActivationEnvelope)(
    JSON.parse(await readFile(target, "utf8")),
  );
  if (
    envelope.runId !== runId ||
    envelope.authorization.authorizationDigest !== authorizationDigest ||
    deliveryFeedbackSmokeAuthorizationDigest(envelope.authorization) !== authorizationDigest ||
    stableHash(envelope.prompt) !== envelope.promptDigest ||
    activationReceipt(envelope) !== envelope.activationReceiptDigest
  ) {
    throw new Error("Activation envelope binding is invalid.");
  }
  return envelope;
}

async function ensurePrivateDirectory(rootDirectory: string, directory: string) {
  const root = path.resolve(rootDirectory);
  const relative = path.relative(root, directory);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Activation envelope directory escaped its run root.");
  }
  let current = root;
  await assertDirectoryIsNotSymlink(current);
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (cause) {
      if (!isAlreadyExists(cause)) throw cause;
    }
    await assertDirectoryIsNotSymlink(current);
  }
  await chmod(directory, 0o700);
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o700) {
    throw new Error("Activation envelope directory is not private.");
  }
}

async function hasNoSymlinkedPath(rootDirectory: string, directory: string) {
  const root = path.resolve(rootDirectory);
  const relative = path.relative(root, directory);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Activation envelope directory escaped its run root.");
  }
  let current = root;
  if (!(await isDirectoryNotSymlink(current))) return false;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!(await isDirectoryNotSymlink(current))) return false;
  }
  return true;
}

async function assertDirectoryIsNotSymlink(directory: string) {
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Activation envelope path contains a symlink.");
  }
}

async function isDirectoryNotSymlink(directory: string) {
  try {
    await assertDirectoryIsNotSymlink(directory);
    return true;
  } catch (cause) {
    if (isMissing(cause)) return false;
    throw cause;
  }
}

function activationReceipt(envelope: DeliveryRemediationActivationEnvelope) {
  return stableHash([
    "gaia-remediation-activation-envelope-v1",
    envelope.runId,
    envelope.operationId,
    String(envelope.attempt),
    envelope.clientInputId,
    envelope.actionIdempotencyKey,
    String(envelope.expectedEventSequence),
    envelope.expectedPredecessorDigest,
    envelope.authorization.authorizationDigest,
    envelope.promptDigest,
    envelope.trustPolicyDigest,
    envelope.authorization.headSha,
  ].join("\0"));
}

function requestMatchesAuthorization(
  request: DeliveryRemediationActivationActionRequest,
  authorization: DeliveryFeedbackSmokeAuthorization,
) {
  return request.actorLogin === authorization.actorLogin &&
    request.actorType === authorization.actorType &&
    request.authorAssociation === authorization.authorAssociation &&
    request.commentDatabaseId === String(authorization.commentDatabaseId) &&
    request.contentDigest === authorization.contentDigest &&
    request.feedbackId === authorization.feedbackId &&
    request.headSha === authorization.headSha &&
    request.marker === authorization.marker &&
    request.prNumber === authorization.prNumber &&
    request.repository === authorization.repository;
}

export function deliveryRemediationActivationMatchesRequest(
  envelope: DeliveryRemediationActivationEnvelope,
  request: DeliveryRemediationActivationActionRequest,
) {
  return envelope.actionIdempotencyKey === request.actionIdempotencyKey &&
    envelope.expectedEventSequence === request.expectedEventSequence &&
    envelope.authorization.authorizationDigest === request.authorizationDigest &&
    requestMatchesAuthorization(request, envelope.authorization);
}

function activationDirectory(rootDirectory: string) {
  return path.join(
    rootDirectory,
    ".gaia",
    "private",
    "delivery-remediation-activations",
  );
}

function activationPath(directory: string, runId: RunId, authorizationDigest: string) {
  return path.join(
    directory,
    `${stableHash(`gaia-remediation-activation-path-v1\0${runId}\0${authorizationDigest}`)}.json`,
  );
}

async function syncDirectory(directory: string) {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function stableHash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function isMissing(cause: unknown) {
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT";
}

function isAlreadyExists(cause: unknown) {
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "EEXIST";
}

function activationError(code: string, message: string, cause?: unknown) {
  return makeRuntimeError({ cause, code, message, recoverable: false });
}

export function deliveryRemediationActivationPathForTest(
  rootDirectory: string,
  runId: RunId,
  authorizationDigest: string,
) {
  return activationPath(activationDirectory(rootDirectory), runId, authorizationDigest);
}
