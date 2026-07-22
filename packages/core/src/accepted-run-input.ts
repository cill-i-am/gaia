import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { Schema } from "effect";

import type { RunEvent } from "./events.js";
import { canonicalV1 } from "./run-contract.js";
import { RunIdSchema } from "./run-id.js";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const LowerSha256Schema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
);
const JsonRecordSchema = Schema.Record(Schema.String, Schema.Json);

export const AcceptedRunInputCheckpointDigestSchema = LowerSha256Schema.pipe(
  Schema.brand("AcceptedRunInputCheckpointDigest")
);
export const AcceptedRunInputCheckpointBodyDigestSchema =
  LowerSha256Schema.pipe(Schema.brand("AcceptedRunInputCheckpointBodyDigest"));
export const AcceptedRunInputCheckpointIdSchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^arin1_[a-f0-9]{64}$/u)),
  Schema.brand("AcceptedRunInputCheckpointId")
);
export const AcceptedRunInputCheckpointPathSchema = Schema.Literal(
  "accepted-run-input.json"
).pipe(Schema.brand("AcceptedRunInputCheckpointPath"));

export class AcceptedRunInputSpecV1 extends Schema.Class<AcceptedRunInputSpecV1>(
  "AcceptedRunInputSpecV1"
)(
  {
    body: Schema.String.pipe(Schema.check(Schema.isMaxLength(16_384))),
    bodyDigest: LowerSha256Schema,
    byteLength: Schema.Number.pipe(
      Schema.check(
        Schema.isInt(),
        Schema.isBetween({ minimum: 0, maximum: 16_384 })
      )
    ),
    title: Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(1_024))),
  },
  strict
) {}

export class AcceptedRunInputCheckpointPayloadV1 extends Schema.Class<AcceptedRunInputCheckpointPayloadV1>(
  "AcceptedRunInputCheckpointPayloadV1"
)(
  {
    acceptanceKind: Schema.Literals(["server", "factory"] as const),
    acceptedSemantics: JsonRecordSchema,
    runId: RunIdSchema,
    spec: AcceptedRunInputSpecV1,
    version: Schema.Literal(1),
  },
  strict
) {}

export class AcceptedRunInputCheckpointV1 extends Schema.Class<AcceptedRunInputCheckpointV1>(
  "AcceptedRunInputCheckpointV1"
)(
  {
    checkpointDigest: AcceptedRunInputCheckpointDigestSchema,
    checkpointId: AcceptedRunInputCheckpointIdSchema,
    payload: AcceptedRunInputCheckpointPayloadV1,
  },
  strict
) {}

export class AcceptedRunInputCheckpointRefV1 extends Schema.Class<AcceptedRunInputCheckpointRefV1>(
  "AcceptedRunInputCheckpointRefV1"
)(
  {
    bodyDigest: AcceptedRunInputCheckpointBodyDigestSchema,
    byteLength: Schema.Number.pipe(
      Schema.check(
        Schema.isInt(),
        Schema.isBetween({ minimum: 1, maximum: 131_072 })
      )
    ),
    checkpointDigest: AcceptedRunInputCheckpointDigestSchema,
    checkpointId: AcceptedRunInputCheckpointIdSchema,
    path: AcceptedRunInputCheckpointPathSchema,
    version: Schema.Literal(1),
  },
  strict
) {}

const AcceptedRunInputCheckpointRefMakeInputV1 = Schema.Struct({
  bodyDigest: AcceptedRunInputCheckpointBodyDigestSchema,
  byteLength: AcceptedRunInputCheckpointRefV1.fields.byteLength,
  checkpoint: AcceptedRunInputCheckpointV1,
});

export const AnyAcceptedRunInputCheckpoint = AcceptedRunInputCheckpointV1;

const decodePayload = Schema.decodeUnknownSync(
  AcceptedRunInputCheckpointPayloadV1
);
const encodePayload = Schema.encodeSync(AcceptedRunInputCheckpointPayloadV1);
const decodeCheckpoint = Schema.decodeUnknownSync(AcceptedRunInputCheckpointV1);
const decodeRef = Schema.decodeUnknownSync(AcceptedRunInputCheckpointRefV1);
const decodeRefMakeInput = Schema.decodeUnknownSync(
  AcceptedRunInputCheckpointRefMakeInputV1
);
const parseDigest = Schema.decodeUnknownSync(
  AcceptedRunInputCheckpointDigestSchema
);
const parseId = Schema.decodeUnknownSync(AcceptedRunInputCheckpointIdSchema);

function checkpointDigest(payload: AcceptedRunInputCheckpointPayloadV1) {
  return parseDigest(
    bytesToHex(
      sha256(
        canonicalV1("gaia.accepted-run-input-checkpoint.v1", [
          encodePayload(payload),
        ])
      )
    )
  );
}

export function makeAcceptedRunInputCheckpointV1(
  input: typeof AcceptedRunInputCheckpointPayloadV1.Type
) {
  const payload = decodePayload(input);
  if (!payload.spec.body.isWellFormed())
    throw new Error("Accepted run input spec must be well-formed Unicode.");
  const specBytes = utf8ToBytes(payload.spec.body);
  if (
    specBytes.byteLength !== payload.spec.byteLength ||
    bytesToHex(sha256(specBytes)) !== payload.spec.bodyDigest
  )
    throw new Error("Accepted run input spec digest or length is invalid.");
  const digest = checkpointDigest(payload);
  return decodeCheckpoint({
    checkpointDigest: digest,
    checkpointId: parseId(`arin1_${digest}`),
    payload,
  });
}

export function parseAcceptedRunInputCheckpoint(input: unknown) {
  const checkpoint = decodeCheckpoint(input);
  const expected = makeAcceptedRunInputCheckpointV1(checkpoint.payload);
  if (
    checkpoint.checkpointDigest !== expected.checkpointDigest ||
    checkpoint.checkpointId !== expected.checkpointId
  )
    throw new Error(
      "Accepted run input checkpoint failed self-authentication."
    );
  return checkpoint;
}

export function makeAcceptedRunInputCheckpointRefV1(
  input: typeof AcceptedRunInputCheckpointRefMakeInputV1.Encoded
) {
  const decoded = decodeRefMakeInput(input);
  const checkpoint = parseAcceptedRunInputCheckpoint(decoded.checkpoint);
  return decodeRef({
    bodyDigest: decoded.bodyDigest,
    byteLength: decoded.byteLength,
    checkpointDigest: checkpoint.checkpointDigest,
    checkpointId: checkpoint.checkpointId,
    path: "accepted-run-input.json",
    version: 1,
  });
}

export const parseAcceptedRunInputCheckpointRef = (input: unknown) =>
  decodeRef(input);

export type AcceptedRunInputCheckpointResolution =
  | { readonly kind: "legacyAbsent" }
  | {
      readonly kind: "v1";
      readonly ref: AcceptedRunInputCheckpointRefV1;
    };

export function resolveAcceptedRunInputCheckpoint(
  events: ReadonlyArray<RunEvent>
): AcceptedRunInputCheckpointResolution {
  const first = events[0];
  if (first === undefined || first.type !== "RUN_CREATED")
    return { kind: "legacyAbsent" };
  const candidate = first.payload["acceptedInputCheckpoint"];
  if (candidate === undefined) return { kind: "legacyAbsent" };
  const ref = parseAcceptedRunInputCheckpointRef(candidate);
  if (ref.checkpointId !== `arin1_${ref.checkpointDigest}`)
    throw new Error("Accepted input checkpoint reference is inconsistent.");
  return { kind: "v1", ref };
}
