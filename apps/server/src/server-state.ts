import { Context, Effect, Layer, Ref, Schema } from "effect";
import { randomUUID } from "node:crypto";

export class ActiveServerRunConflict extends Schema.TaggedErrorClass<ActiveServerRunConflict>()(
  "ActiveServerRunConflict",
  {
    message: Schema.NonEmptyString,
  },
) {}

type ActiveServerRun = {
  readonly reservationId: string;
  readonly runId?: string;
};

export type ServerRunReservation = {
  readonly clear: Effect.Effect<void>;
  readonly markAccepted: (runId: string) => Effect.Effect<void>;
  readonly reservationId: string;
  readonly rollback: Effect.Effect<void>;
};

export class ServerRunRegistry extends Context.Service<ServerRunRegistry, {
  readonly reserve: Effect.Effect<ServerRunReservation, ActiveServerRunConflict>;
}>()("@gaia/server/ServerRunRegistry") {}

type ReservationResult =
  | { readonly _tag: "Conflict" }
  | { readonly _tag: "Reserved"; readonly reservation: ServerRunReservation };

export const ServerRunRegistryLive = Layer.effect(
  ServerRunRegistry,
  Effect.gen(function* () {
    const active = yield* Ref.make<ActiveServerRun | undefined>(undefined);

    return {
      reserve: Effect.gen(function* () {
        const reservationId = randomUUID();
        const result = yield* Ref.modify(active, (current): readonly [
          ReservationResult,
          ActiveServerRun | undefined,
        ] => {
          if (current !== undefined) {
            return [
              {
                _tag: "Conflict",
              } satisfies ReservationResult,
              current,
            ];
          }

          return [
            {
              _tag: "Reserved",
              reservation: reservation(active, reservationId),
            } satisfies ReservationResult,
            { reservationId },
          ];
        });

        if (result._tag === "Conflict") {
          return yield* Effect.fail(
            ActiveServerRunConflict.make({
              message: "A server-created Gaia run is already active.",
            }),
          );
        }

        return result.reservation;
      }),
    };
  }),
);

function reservation(
  active: Ref.Ref<ActiveServerRun | undefined>,
  reservationId: string,
): ServerRunReservation {
  return {
    clear: clearReservation(active, reservationId),
    markAccepted: (runId) =>
      Ref.update(active, (current) =>
        current?.reservationId === reservationId
          ? { reservationId, runId }
          : current,
      ),
    reservationId,
    rollback: clearReservation(active, reservationId),
  };
}

function clearReservation(
  active: Ref.Ref<ActiveServerRun | undefined>,
  reservationId: string,
) {
  return Ref.update(active, (current) =>
    current?.reservationId === reservationId ? undefined : current,
  );
}
