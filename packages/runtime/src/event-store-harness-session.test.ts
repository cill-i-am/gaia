import { NodeServices } from "@effect/platform-node";
import {
  HarnessCapabilities,
  HarnessProviderDescriptor,
  makeHarnessRunEvent,
  makeRunEvent,
  parseHarnessItemId,
  parseHarnessProviderId,
  parseHarnessSessionId,
  parseHarnessTurnId,
  parseRunId,
  RunEvent,
} from "@gaia/core";
import { describe, expect, it } from "vitest";
import { Effect, FileSystem, Schema } from "effect";
import {
  appendEvent,
  appendHarnessSessionEvent,
  readEvents,
  type AppendEventInput,
} from "./event-store.js";
import { makeRunPaths } from "./paths.js";

const runId = parseRunId("run-Gaia84ev01");
const sessionId = parseHarnessSessionId("session-event-store");
const orphanItemId = parseHarnessItemId("orphan-item");
const orphanTurnId = parseHarnessTurnId("orphan-turn");
const provider = HarnessProviderDescriptor.make({
  displayName: "Synthetic",
  executionModes: ["local"],
  providerId: parseHarnessProviderId("synthetic"),
});
const capabilities = HarnessCapabilities.make({
  approvals: [],
  fileChangeEvents: false,
  interruption: false,
  resumableSessions: false,
  review: false,
  steering: false,
  streamingMessages: false,
  structuredOutput: false,
  subagents: false,
  toolEvents: false,
  usageReporting: false,
  userQuestions: false,
});

describe("harness session event persistence", () => {
  it("excludes harness payloads from generic append and persists them through the finite path", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-event-store-" });
          const paths = yield* makeRunPaths(runId, { rootDirectory: cwd });
          yield* fs.makeDirectory(paths.root, { recursive: true });
          yield* appendEvent(runId, paths, {
            payload: { specPath: "spec.md" },
            type: "RUN_CREATED",
          });

          // SAFETY: Deliberately bypass the compile-time exclusion to prove the
          // public generic append path also rejects this payload at runtime.
          const unsafeHarnessAppend = {
            payload: {
              event: { kind: "rawVendorPacket", secret: "provider-secret" },
            },
            type: "HARNESS_SESSION_EVENT_RECORDED",
          } as unknown as AppendEventInput;
          const raw = yield* appendEvent(
            runId,
            paths,
            unsafeHarnessAppend,
          ).pipe(Effect.exit);
          expect(raw._tag).toBe("Failure");

          yield* appendHarnessSessionEvent(runId, paths, {
            capabilities,
            kind: "sessionStarted",
            provider,
            sessionId,
            state: "connecting",
          });

          const events = yield* readEvents(paths);
          expect(events.at(-1)?.payload.event).toMatchObject({
            kind: "sessionStarted",
            sessionId,
          });
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  });

  it("rejects an invalid persisted harness payload while reading events.jsonl", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-event-store-" });
          const paths = yield* makeRunPaths(runId, { rootDirectory: cwd });
          yield* fs.makeDirectory(paths.root, { recursive: true });
          const events = [
            makeRunEvent({
              payload: { specPath: "spec.md" },
              runId,
              sequence: 1,
              timestamp: "2026-07-10T10:00:00.000Z",
              type: "RUN_CREATED",
            }),
            makeRunEvent({
              payload: {
                event: { kind: "rawVendorPacket", secret: "provider-secret" },
              },
              runId,
              sequence: 2,
              timestamp: "2026-07-10T10:00:01.000Z",
              type: "HARNESS_SESSION_EVENT_RECORDED",
            }),
          ];
          yield* fs.writeFileString(
            paths.events,
            `${events
              .map((event) => JSON.stringify(Schema.encodeSync(RunEvent)(event)))
              .join("\n")}\n`,
          );

          const result = yield* readEvents(paths).pipe(Effect.exit);
          expect(result._tag).toBe("Failure");
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  });

  it("rejects semantically unreplayable harness history before append", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-event-store-" });
          const paths = yield* makeRunPaths(runId, { rootDirectory: cwd });
          yield* fs.makeDirectory(paths.root, { recursive: true });
          yield* appendEvent(runId, paths, {
            payload: { specPath: "spec.md" },
            type: "RUN_CREATED",
          });

          const result = yield* appendHarnessSessionEvent(runId, paths, {
            chunk: "orphan",
            deltaKind: "message",
            itemId: orphanItemId,
            kind: "itemDeltaRecorded",
            sessionId,
            turnId: orphanTurnId,
          }).pipe(Effect.exit);

          expect(result._tag).toBe("Failure");
          expect((yield* readEvents(paths))).toHaveLength(1);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  });

  it("rejects semantically unreplayable harness history during readback", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-event-store-" });
          const paths = yield* makeRunPaths(runId, { rootDirectory: cwd });
          yield* fs.makeDirectory(paths.root, { recursive: true });
          const events = [
            makeRunEvent({
              payload: { specPath: "spec.md" },
              runId,
              sequence: 1,
              timestamp: "2026-07-10T10:00:00.000Z",
              type: "RUN_CREATED",
            }),
            makeHarnessRunEvent({
              event: {
                capabilities,
                kind: "sessionStarted",
                provider,
                sessionId,
                state: "running",
              },
              runId,
              sequence: 2,
              timestamp: "2026-07-10T10:00:01.000Z",
            }),
            makeHarnessRunEvent({
              event: {
                chunk: "orphan",
                deltaKind: "message",
                itemId: orphanItemId,
                kind: "itemDeltaRecorded",
                sessionId,
                turnId: orphanTurnId,
              },
              runId,
              sequence: 3,
              timestamp: "2026-07-10T10:00:02.000Z",
            }),
          ];
          yield* fs.writeFileString(
            paths.events,
            `${events
              .map((event) => JSON.stringify(Schema.encodeSync(RunEvent)(event)))
              .join("\n")}\n`,
          );

          const result = yield* readEvents(paths).pipe(Effect.exit);
          expect(result._tag).toBe("Failure");
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  });

  it("validates many independent harness histories without rescanning unrelated sessions", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-event-store-" });
          const paths = yield* makeRunPaths(runId, { rootDirectory: cwd });
          yield* fs.makeDirectory(paths.root, { recursive: true });
          const events = [
            makeRunEvent({
              payload: { specPath: "spec.md" },
              runId,
              sequence: 1,
              timestamp: "2026-07-10T10:00:00.000Z",
              type: "RUN_CREATED",
            }),
            ...Array.from({ length: 250 }, (_, index) =>
              makeHarnessRunEvent({
                event: {
                  capabilities,
                  kind: "sessionStarted",
                  provider,
                  sessionId: parseHarnessSessionId(`bulk-session-${index}`),
                  state: "running",
                },
                runId,
                sequence: index + 2,
                timestamp: "2026-07-10T10:00:01.000Z",
              }),
            ),
          ];
          yield* fs.writeFileString(
            paths.events,
            `${events
              .map((event) => JSON.stringify(Schema.encodeSync(RunEvent)(event)))
              .join("\n")}\n`,
          );

          expect(yield* readEvents(paths)).toHaveLength(251);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  });
});
