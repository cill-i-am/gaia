import { randomUUID } from "node:crypto";

import type { RunId } from "@gaia/core";
import { Effect, Ref, Schema } from "effect";

type ActiveServerRun = {
  readonly phase: "accepting" | "running";
  readonly reservationId: string;
  readonly runId?: RunId | undefined;
};

export class ActiveServerRunConflict extends Schema.TaggedErrorClass<ActiveServerRunConflict>()(
  "ActiveServerRunConflict",
  {
    message: Schema.NonEmptyString,
    recoverable: Schema.Boolean,
  }
) {}

export type ServerRunReservation = {
  readonly clear: Effect.Effect<void>;
  readonly markAccepted: (runId: RunId) => Effect.Effect<void>;
  readonly reservationId: string;
  readonly rollback: Effect.Effect<void>;
};

export type ServerRunRegistryService = {
  readonly reserveCreate: Effect.Effect<
    ServerRunReservation,
    ActiveServerRunConflict
  >;
};

export function makeServerRunRegistry() {
  return Effect.gen(function* () {
    const active = yield* Ref.make<ActiveServerRun | undefined>(undefined);

    return {
      reserveCreate: reserveCreate(active),
    } satisfies ServerRunRegistryService;
  });
}

type ReserveResult =
  | { readonly _tag: "Conflict" }
  | {
      readonly _tag: "Reserved";
      readonly reservation: ServerRunReservation;
    };

function reserveCreate(active: Ref.Ref<ActiveServerRun | undefined>) {
  return Effect.gen(function* () {
    const reservationId = randomUUID();
    const reserved = yield* Ref.modify(active, (current) => {
      if (current !== undefined) {
        return reserveRefResult({ _tag: "Conflict" }, current);
      }

      return reserveRefResult(
        {
          _tag: "Reserved",
          reservation: makeReservation(active, reservationId),
        },
        {
          phase: "accepting",
          reservationId,
        }
      );
    });

    if (reserved._tag === "Conflict") {
      return yield* Effect.fail(
        ActiveServerRunConflict.make({
          message:
            "A server-created Gaia run is already accepting or executing.",
          recoverable: true,
        })
      );
    }

    return reserved.reservation;
  });
}

function makeReservation(
  active: Ref.Ref<ActiveServerRun | undefined>,
  reservationId: string
): ServerRunReservation {
  return {
    clear: clearReservation(active, reservationId),
    markAccepted: (runId) =>
      Ref.update(active, (current) =>
        current?.reservationId === reservationId
          ? runningState(reservationId, runId)
          : current
      ),
    reservationId,
    rollback: clearAcceptingReservation(active, reservationId),
  };
}

function reserveRefResult(
  result: ReserveResult,
  state: ActiveServerRun | undefined
): readonly [ReserveResult, ActiveServerRun | undefined] {
  return [result, state];
}

function runningState(reservationId: string, runId: RunId): ActiveServerRun {
  return {
    phase: "running",
    reservationId,
    runId,
  };
}

function clearReservation(
  active: Ref.Ref<ActiveServerRun | undefined>,
  reservationId: string
) {
  return Ref.update(active, (current) =>
    current?.reservationId === reservationId ? undefined : current
  );
}

function clearAcceptingReservation(
  active: Ref.Ref<ActiveServerRun | undefined>,
  reservationId: string
) {
  return Ref.update(active, (current) =>
    current?.reservationId === reservationId && current.phase === "accepting"
      ? undefined
      : current
  );
}
