import { assert, describe, it } from "@effect/vitest";
import { parseRunId } from "@gaia/core";
import { Effect } from "effect";

import {
  ActiveServerRunConflict,
  makeServerRunRegistry,
} from "./server-state.js";

describe("server run registry", () => {
  it.effect(
    "clears an accepting reservation with rollback so a later create can reserve",
    () =>
      Effect.gen(function* () {
        const registry = yield* makeServerRunRegistry();
        const first = yield* registry.reserveCreate;

        yield* first.rollback;

        const second = yield* registry.reserveCreate;
        assert.notStrictEqual(second.reservationId, first.reservationId);
      })
  );

  it.effect(
    "keeps stale rollback and clear operations from clearing a different reservation",
    () =>
      Effect.gen(function* () {
        const registry = yield* makeServerRunRegistry();
        const stale = yield* registry.reserveCreate;
        yield* stale.rollback;
        const current = yield* registry.reserveCreate;

        yield* stale.rollback;
        yield* stale.clear;

        yield* assertActiveConflict(registry.reserveCreate);

        yield* current.rollback;
        const next = yield* registry.reserveCreate;
        assert.notStrictEqual(next.reservationId, current.reservationId);
      })
  );

  it.effect(
    "keeps accepting-only rollback from clearing the same reservation after markAccepted",
    () =>
      Effect.gen(function* () {
        const registry = yield* makeServerRunRegistry();
        const reservation = yield* registry.reserveCreate;

        yield* reservation.markAccepted(parseRunId("run-1234567890"));
        yield* reservation.rollback;

        yield* assertActiveConflict(registry.reserveCreate);
      })
  );

  it.effect(
    "keeps continuation clear able to release the running reservation",
    () =>
      Effect.gen(function* () {
        const registry = yield* makeServerRunRegistry();
        const reservation = yield* registry.reserveCreate;

        yield* reservation.markAccepted(parseRunId("run-1234567890"));
        yield* reservation.clear;

        const next = yield* registry.reserveCreate;
        assert.notStrictEqual(next.reservationId, reservation.reservationId);
      })
  );
});

function assertActiveConflict<A>(
  effect: Effect.Effect<A, ActiveServerRunConflict>
) {
  return Effect.gen(function* () {
    const error = yield* effect.pipe(Effect.flip);
    assert.instanceOf(error, ActiveServerRunConflict);
  });
}
