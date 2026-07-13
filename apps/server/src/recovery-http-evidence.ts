import {
  LocalRunApiErrorEnvelope,
  WorkerRecoveryFailureEvidence,
} from "@gaia/core";
import { Effect, FileSystem, Path, Schema } from "effect";

const maxEvidenceBytes = 16_384;

/** Persist one bounded typed non-2xx body outside a scoped server root before cleanup. */
export function writeRecoveryHttpEvidence(input: {
  readonly body: unknown;
  readonly diagnostic: unknown;
  readonly evidenceDirectory: string;
}) {
  return Effect.gen(function* () {
    const body = yield* Schema.decodeUnknownEffect(LocalRunApiErrorEnvelope)(
      input.body
    );
    const diagnostic = yield* Schema.decodeUnknownEffect(
      WorkerRecoveryFailureEvidence
    )(input.diagnostic);
    const encoded = `${JSON.stringify({ diagnostic, response: body })}\n`;
    if (Buffer.byteLength(encoded) > maxEvidenceBytes) {
      return yield* Effect.fail(
        new Error("Recovery HTTP evidence exceeds its size limit.")
      );
    }
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(input.evidenceDirectory, { recursive: true });
    const target = path.join(
      input.evidenceDirectory,
      "recovery-http-error.json"
    );
    yield* fs.writeFileString(target, encoded);
    return target;
  });
}
