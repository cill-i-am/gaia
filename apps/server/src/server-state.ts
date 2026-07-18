import { randomUUID } from "node:crypto";

import { RunIdSchema, type RunId } from "@gaia/core";
import { Effect, Ref, Schema } from "effect";

const ServerRunReservationIdSchema = Schema.NonEmptyString.pipe(
  Schema.brand("ServerRunReservationId")
);
const parseServerRunReservationId = Schema.decodeUnknownSync(
  ServerRunReservationIdSchema
);

const ActiveServerRunSchema = Schema.Struct({
  phase: Schema.Literals(["accepting", "running"]),
  reservationId: ServerRunReservationIdSchema,
  runId: Schema.optionalKey(Schema.UndefinedOr(RunIdSchema)),
});

type ActiveServerRun = typeof ActiveServerRunSchema.Type;

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
  readonly reservationId: typeof ServerRunReservationIdSchema.Type;
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

const ReserveConflictSchema = Schema.Struct({
  _tag: Schema.Literal("Conflict"),
});
const parseReserveConflict = Schema.decodeUnknownSync(ReserveConflictSchema);

type ReserveResult =
  | typeof ReserveConflictSchema.Type
  | {
      readonly _tag: "Reserved";
      readonly reservation: ServerRunReservation;
    };

function reserveCreate(active: Ref.Ref<ActiveServerRun | undefined>) {
  return Effect.gen(function* () {
    const reservationId = parseServerRunReservationId(randomUUID());
    const reserved = yield* Ref.modify(active, (current) => {
      if (current !== undefined) {
        return reserveRefResult(
          parseReserveConflict({ _tag: "Conflict" }),
          current
        );
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
  reservationId: typeof ServerRunReservationIdSchema.Type
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

function runningState(
  reservationId: typeof ServerRunReservationIdSchema.Type,
  runId: RunId
): ActiveServerRun {
  return {
    phase: "running",
    reservationId,
    runId,
  };
}

function clearReservation(
  active: Ref.Ref<ActiveServerRun | undefined>,
  reservationId: typeof ServerRunReservationIdSchema.Type
) {
  return Ref.update(active, (current) =>
    current?.reservationId === reservationId ? undefined : current
  );
}

function clearAcceptingReservation(
  active: Ref.Ref<ActiveServerRun | undefined>,
  reservationId: typeof ServerRunReservationIdSchema.Type
) {
  return Ref.update(active, (current) =>
    current?.reservationId === reservationId && current.phase === "accepting"
      ? undefined
      : current
  );
}
