import { NodeServices } from "@effect/platform-node";
import { assert, describe, expect, layer } from "@effect/vitest";
import { Deferred, Effect, Fiber, FileSystem, Ref, Schema } from "effect";
import { it } from "vitest";

import {
  deriveRunStoreLockAnchorDigestV1,
  deriveRunStoreLockOwnerDigestV3,
  deriveRunStoreLockSuccessorEdgeDigestV1,
  deriveRunStoreLockTerminalDigestV1,
  deriveRunStoreRootDigestV1,
  parseDarwinProcessStartToken,
  RunStoreLockAnchorEnvelopeV1,
  RunStoreLockAnchorPayloadV1,
  RunStoreLockOwnerEnvelopeV3,
  RunStoreLockOwnerPayloadV3,
  RunStoreLockSuccessorEnvelopeV1,
  RunStoreLockTerminalEnvelopeV1,
  withRunStoreLock,
} from "./run-store-lock.js";

describe("run-store lock identity", () => {
  it("matches all five published canonical digest vectors", () => {
    const rootDigest = deriveRunStoreRootDigestV1({
      canonicalRoot: "/tmp/gaia/.gaia",
      version: 1,
    });
    expect(rootDigest).toBe(
      "be8d80122e21d277cd36350a172d95efcb30b410cb6866e2416f2a42cbc6e1f0"
    );
    const ownerDigest = deriveRunStoreLockOwnerDigestV3({
      nextAction: "waitThenRetry",
      nonce: "000102030405060708090a0b0c0d0e0f",
      operation: "serverRunContinuation",
      pid: 4242,
      processStartToken: "ps-start-unix-seconds-v1:1784613556",
      rootDigest,
      version: 3,
    });
    expect(ownerDigest).toBe(
      "51440c3e2641dd05e751447e15d5a4679c2c2e27392dbc957e6989ddae9c32b1"
    );
    const anchorDigest = deriveRunStoreLockAnchorDigestV1({
      initialOwnerDigest: ownerDigest,
      rootDigest,
      version: 1,
    });
    expect(anchorDigest).toBe(
      "61daae945c865b0f997165b38c51ad4c07410c0ffa6f2a7d55d3de1a3ca8f9e7"
    );
    const successorOwnerDigest = deriveRunStoreLockOwnerDigestV3({
      nextAction: "waitThenRetry",
      nonce: "101112131415161718191a1b1c1d1e1f",
      operation: "serverRunContinuation",
      pid: 4243,
      processStartToken: "ps-start-unix-seconds-v1:1784613557",
      rootDigest,
      version: 3,
    });
    expect(successorOwnerDigest).toBe(
      "dbb93431e6dae9c8f21667d9641835bd94fd187c703992e69dab390318002348"
    );
    const successorEdgeDigest = deriveRunStoreLockSuccessorEdgeDigestV1({
      anchorDigest,
      predecessorOwnerDigest: ownerDigest,
      rootDigest,
      successorOwnerDigest,
      version: 1,
    });
    expect(successorEdgeDigest).toBe(
      "ef161eb86f2d8e883f322752a295394e74d156ae0a1b3a85d8cf554c28fc7f0a"
    );
    expect(
      deriveRunStoreLockTerminalDigestV1({
        anchorDigest,
        disposition: "released",
        ownerDigest: successorOwnerDigest,
        protectedEffectStarted: true,
        rootDigest,
        successorEdgeDigest,
        version: 1,
      })
    ).toBe("27f0cb0555b3b51ed42b42cf844f80f2ae79845b652a306cba5278ad127234b5");
  });

  it("parses only the bounded padded C/UTC Darwin ps grammar", () => {
    const raw = "Tue Jul 21 05:59:16 2026\n";
    expect(parseDarwinProcessStartToken(raw)).toBe(
      "ps-start-unix-seconds-v1:1784613556"
    );
    expect(parseDarwinProcessStartToken(raw.slice(0, -1) + "        \n")).toBe(
      "ps-start-unix-seconds-v1:1784613556"
    );
    for (const invalid of [
      raw.slice(0, -1) + "         \n",
      raw.slice(0, -1) + "\t\n",
      raw.replace("Tue", "Mon"),
      raw.replace("21", "32"),
      raw.replace("\n", "\r\n"),
      `${raw}${raw}`,
    ])
      expect(() => parseDarwinProcessStartToken(invalid)).toThrow();
  });

  it("rejects mutation and unmodelled owner identity values", () => {
    expect(() =>
      deriveRunStoreLockOwnerDigestV3({
        nextAction: "waitThenRetry",
        nonce: "0".repeat(31) as never,
        operation: "serverRunContinuation",
        pid: 1,
        processStartToken: "ps-start-unix-seconds-v1:1",
        rootDigest: "a".repeat(64) as never,
        version: 3,
      })
    ).toThrow();
  });

  layer(NodeServices.layer)((it) => {
    it.effect("holds one exact-root lease across nested operations", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const rootDirectory = yield* fs.makeTempDirectory({
          prefix: "gaia-lock-nested-",
        });
        const otherRoot = yield* fs.makeTempDirectory({
          prefix: "gaia-lock-other-",
        });
        let effects = 0;
        yield* withRunStoreLock(
          { rootDirectory },
          Effect.gen(function* () {
            const wrongRoot = yield* Effect.flip(
              withRunStoreLock({ rootDirectory: otherRoot }, Effect.void, {
                operation: "Gaia worker continuation",
              })
            );
            assert.strictEqual(wrongRoot.code, "RunStoreLockOwnershipLost");
            yield* withRunStoreLock(
              { rootDirectory },
              Effect.sync(() => {
                effects += 1;
              }),
              { operation: "Gaia worker continuation" }
            );
          }),
          { operation: "Gaia server run continuation" }
        );
        assert.strictEqual(effects, 1);
        assert.isFalse(yield* fs.exists(`${rootDirectory}/.gaia/lock`));
        const stages = (yield* fs.readDirectory(
          `${rootDirectory}/.gaia`
        )).filter((entry) => entry.startsWith(".lock-stage-"));
        assert.deepEqual(stages, []);
      })
    );

    it.effect(
      "allows exactly one live owner for a canonical run-store root",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const rootDirectory = yield* fs.makeTempDirectory({
              prefix: "gaia-lock-live-",
            });
            const entered = yield* Deferred.make<void>();
            const release = yield* Deferred.make<void>();
            const owner = yield* Effect.forkScoped(
              withRunStoreLock(
                { rootDirectory },
                Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(release))
                ),
                { operation: "Gaia server run continuation" }
              )
            );
            yield* Deferred.await(entered);
            const error = yield* Effect.flip(
              withRunStoreLock({ rootDirectory }, Effect.void, {
                operation: "Gaia worker continuation",
              })
            );
            assert.strictEqual(error.code, "RunStoreLocked");
            yield* Deferred.succeed(release, undefined);
            yield* Fiber.join(owner);
            assert.isFalse(yield* fs.exists(`${rootDirectory}/.gaia/lock`));
            assert.deepEqual(
              (yield* fs.readDirectory(`${rootDirectory}/.gaia`)).filter(
                (entry) => entry.startsWith(".lock-stage-")
              ),
              []
            );
          })
        )
    );

    it.effect(
      "elects one terminal-tail reconciler without unlinking a contender's live anchor",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const rootDirectory = yield* fs.makeTempDirectory({
            prefix: "gaia-lock-reconcile-race-",
          });
          const gaiaRoot = `${rootDirectory}/.gaia`;
          const anchorPath = `${gaiaRoot}/lock`;
          yield* fs.makeDirectory(`${gaiaRoot}/lock-successors`, {
            recursive: true,
          });
          yield* fs.makeDirectory(`${gaiaRoot}/lock-terminals`, {
            recursive: true,
          });
          const canonicalRoot = yield* fs.realPath(gaiaRoot);
          const rootDigest = deriveRunStoreRootDigestV1({
            canonicalRoot,
            version: 1,
          });
          const ownerPayload = RunStoreLockOwnerPayloadV3.make({
            nextAction: "waitThenRetry",
            nonce: "0".repeat(32),
            operation: "serverRunContinuation",
            pid: 2_147_483_647,
            processStartToken: "ps-start-unix-seconds-v1:1",
            rootDigest,
            version: 3,
          });
          const deadOwner = RunStoreLockOwnerEnvelopeV3.make({
            ownerDigest: deriveRunStoreLockOwnerDigestV3(ownerPayload),
            payload: ownerPayload,
          });
          const anchorPayload = RunStoreLockAnchorPayloadV1.make({
            initialOwnerDigest: deadOwner.ownerDigest,
            rootDigest,
            version: 1,
          });
          const anchor = RunStoreLockAnchorEnvelopeV1.make({
            anchorDigest: deriveRunStoreLockAnchorDigestV1(anchorPayload),
            initialOwner: deadOwner,
            payload: anchorPayload,
          });
          const anchorBody = `${JSON.stringify(
            Schema.encodeSync(RunStoreLockAnchorEnvelopeV1)(anchor)
          )}\n`;
          yield* fs.writeFileString(anchorPath, anchorBody);
          yield* withRunStoreLock({ rootDirectory }, Effect.void, {
            operation: "Gaia server run continuation",
          });
          yield* fs.writeFileString(anchorPath, anchorBody);

          const freshAnchorLinked = yield* Deferred.make<void>();
          const anchorRemovals = yield* Ref.make(0);
          const controlledFs = FileSystem.FileSystem.of({
            ...fs,
            link: (fromPath, toPath) =>
              fs
                .link(fromPath, toPath)
                .pipe(
                  Effect.tap(() =>
                    toPath === anchorPath
                      ? Deferred.succeed(freshAnchorLinked, undefined)
                      : Effect.void
                  )
                ),
            remove: (filePath, options) =>
              filePath !== anchorPath
                ? fs.remove(filePath, options)
                : Ref.updateAndGet(anchorRemovals, (count) => count + 1).pipe(
                    Effect.flatMap((count) =>
                      count === 2
                        ? Deferred.await(freshAnchorLinked).pipe(
                            Effect.andThen(fs.remove(filePath, options))
                          )
                        : fs.remove(filePath, options)
                    )
                  ),
          });
          const active = yield* Ref.make(0);
          const maximumActive = yield* Ref.make(0);
          const contender = withRunStoreLock(
            { rootDirectory },
            Ref.updateAndGet(active, (count) => count + 1).pipe(
              Effect.tap((count) =>
                Ref.update(maximumActive, (maximum) => Math.max(maximum, count))
              ),
              Effect.andThen(Effect.yieldNow),
              Effect.ensuring(Ref.update(active, (count) => count - 1))
            ),
            { operation: "Gaia server run continuation" }
          ).pipe(
            Effect.as("success" as const),
            Effect.catch((error) => Effect.succeed(error.code))
          );
          const outcomes = yield* Effect.all([contender, contender], {
            concurrency: "unbounded",
          }).pipe(Effect.provideService(FileSystem.FileSystem, controlledFs));

          assert.deepEqual([...outcomes].sort(), ["RunStoreLocked", "success"]);
          assert.strictEqual(yield* Ref.get(maximumActive), 1);
          assert.isFalse(yield* fs.exists(anchorPath));
        })
    );

    it.effect(
      "elects one immutable successor only for a proven-dead owner",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const rootDirectory = yield* fs.makeTempDirectory({
            prefix: "gaia-lock-takeover-",
          });
          const gaiaRoot = `${rootDirectory}/.gaia`;
          yield* fs.makeDirectory(`${gaiaRoot}/lock-successors`, {
            recursive: true,
          });
          yield* fs.makeDirectory(`${gaiaRoot}/lock-terminals`, {
            recursive: true,
          });
          const canonicalRoot = yield* fs.realPath(gaiaRoot);
          const rootDigest = deriveRunStoreRootDigestV1({
            canonicalRoot,
            version: 1,
          });
          const ownerPayload = RunStoreLockOwnerPayloadV3.make({
            nextAction: "waitThenRetry",
            nonce: "0".repeat(32),
            operation: "serverRunContinuation",
            pid: 2_147_483_647,
            processStartToken: "ps-start-unix-seconds-v1:1",
            rootDigest,
            version: 3,
          });
          const deadOwner = RunStoreLockOwnerEnvelopeV3.make({
            ownerDigest: deriveRunStoreLockOwnerDigestV3(ownerPayload),
            payload: ownerPayload,
          });
          const anchorPayload = RunStoreLockAnchorPayloadV1.make({
            initialOwnerDigest: deadOwner.ownerDigest,
            rootDigest,
            version: 1,
          });
          const anchor = RunStoreLockAnchorEnvelopeV1.make({
            anchorDigest: deriveRunStoreLockAnchorDigestV1(anchorPayload),
            initialOwner: deadOwner,
            payload: anchorPayload,
          });
          const anchorBody = `${JSON.stringify(
            Schema.encodeSync(RunStoreLockAnchorEnvelopeV1)(anchor)
          )}\n`;
          yield* fs.writeFileString(`${gaiaRoot}/lock`, anchorBody);

          yield* withRunStoreLock({ rootDirectory }, Effect.void, {
            operation: "Gaia server run continuation",
          });

          const successorPath = `${gaiaRoot}/lock-successors/${deadOwner.ownerDigest}.json`;
          const successorBody = yield* fs.readFileString(successorPath);
          const successor = Schema.decodeUnknownSync(
            RunStoreLockSuccessorEnvelopeV1
          )(JSON.parse(successorBody));
          const terminalPath = `${gaiaRoot}/lock-terminals/${successor.successorOwner.ownerDigest}.json`;
          const terminalBody = yield* fs.readFileString(terminalPath);
          const terminal = Schema.decodeUnknownSync(
            RunStoreLockTerminalEnvelopeV1
          )(JSON.parse(terminalBody));
          assert.strictEqual(terminal.payload.disposition, "released");
          assert.strictEqual(terminal.payload.protectedEffectStarted, true);
          assert.isFalse(yield* fs.exists(`${gaiaRoot}/lock`));

          const successorMtime = (yield* fs.stat(successorPath)).mtime;
          const terminalMtime = (yield* fs.stat(terminalPath)).mtime;
          assert.strictEqual(
            yield* fs.readFileString(successorPath),
            successorBody
          );
          assert.strictEqual(
            yield* fs.readFileString(terminalPath),
            terminalBody
          );
          assert.deepEqual(
            (yield* fs.stat(successorPath)).mtime,
            successorMtime
          );
          assert.deepEqual((yield* fs.stat(terminalPath)).mtime, terminalMtime);
          yield* fs.writeFileString(`${gaiaRoot}/lock`, anchorBody);
          let postTerminalEffects = 0;
          yield* withRunStoreLock(
            { rootDirectory },
            Effect.sync(() => {
              postTerminalEffects += 1;
            }),
            { operation: "Gaia server run continuation" }
          );
          assert.strictEqual(postTerminalEffects, 1);
          const reconciliationSuccessorPath = `${gaiaRoot}/lock-successors/${successor.successorOwner.ownerDigest}.json`;
          const reconciliationSuccessorBody = yield* fs.readFileString(
            reconciliationSuccessorPath
          );
          const reconciliationSuccessor = Schema.decodeUnknownSync(
            RunStoreLockSuccessorEnvelopeV1
          )(JSON.parse(reconciliationSuccessorBody));
          const reconciliationTerminalPath = `${gaiaRoot}/lock-terminals/${reconciliationSuccessor.successorOwner.ownerDigest}.json`;
          const reconciliationTerminal = Schema.decodeUnknownSync(
            RunStoreLockTerminalEnvelopeV1
          )(JSON.parse(yield* fs.readFileString(reconciliationTerminalPath)));
          assert.strictEqual(
            reconciliationTerminal.payload.disposition,
            "abandoned"
          );
          assert.strictEqual(
            reconciliationTerminal.payload.protectedEffectStarted,
            false
          );
          assert.strictEqual(
            yield* fs.readFileString(successorPath),
            successorBody
          );
          assert.strictEqual(
            yield* fs.readFileString(terminalPath),
            terminalBody
          );
          assert.deepEqual(
            (yield* fs.stat(successorPath)).mtime,
            successorMtime
          );
          assert.deepEqual((yield* fs.stat(terminalPath)).mtime, terminalMtime);
          assert.isFalse(yield* fs.exists(`${gaiaRoot}/lock`));
          const initialReconciliationWitness = `${gaiaRoot}/lock-terminals/.reconciled-${terminal.terminalDigest}.anchor`;
          assert.isTrue(yield* fs.exists(initialReconciliationWitness));
          const reconciliationWitness = `${gaiaRoot}/lock-terminals/.reconciled-${reconciliationTerminal.terminalDigest}.anchor`;
          yield* fs.writeFileString(`${gaiaRoot}/lock`, anchorBody);
          yield* fs.link(`${gaiaRoot}/lock`, reconciliationWitness);
          let adoptedEffects = 0;
          yield* withRunStoreLock(
            { rootDirectory },
            Effect.sync(() => {
              adoptedEffects += 1;
            }),
            { operation: "Gaia server run continuation" }
          );
          assert.strictEqual(adoptedEffects, 1);
          assert.isFalse(yield* fs.exists(`${gaiaRoot}/lock`));
          const adoptedSuccessorPath = `${gaiaRoot}/lock-successors/${reconciliationSuccessor.successorOwner.ownerDigest}.json`;
          const adoptedSuccessor = Schema.decodeUnknownSync(
            RunStoreLockSuccessorEnvelopeV1
          )(JSON.parse(yield* fs.readFileString(adoptedSuccessorPath)));
          const adoptedTerminal = Schema.decodeUnknownSync(
            RunStoreLockTerminalEnvelopeV1
          )(
            JSON.parse(
              yield* fs.readFileString(
                `${gaiaRoot}/lock-terminals/${adoptedSuccessor.successorOwner.ownerDigest}.json`
              )
            )
          );
          const invalidWitness = `${gaiaRoot}/lock-terminals/.reconciled-${adoptedTerminal.terminalDigest}.anchor`;

          yield* fs.writeFileString(`${gaiaRoot}/lock`, anchorBody);
          yield* fs.writeFileString(invalidWitness, anchorBody);
          const differentInode = yield* withRunStoreLock(
            { rootDirectory },
            Effect.void,
            { operation: "Gaia server run continuation" }
          ).pipe(Effect.exit);
          assert.strictEqual(differentInode._tag, "Failure");
          yield* fs.remove(invalidWitness);
          yield* fs.remove(`${gaiaRoot}/lock`);

          yield* fs.writeFileString(`${gaiaRoot}/lock`, anchorBody);
          yield* fs.symlink(`${gaiaRoot}/lock`, invalidWitness);
          const symlinkWitness = yield* withRunStoreLock(
            { rootDirectory },
            Effect.void,
            { operation: "Gaia server run continuation" }
          ).pipe(Effect.exit);
          assert.strictEqual(symlinkWitness._tag, "Failure");
          yield* fs.remove(invalidWitness);
          yield* fs.remove(`${gaiaRoot}/lock`);

          yield* fs.writeFileString(`${gaiaRoot}/lock`, anchorBody);
          yield* fs.writeFileString(invalidWitness, "{}\n");
          const differentBody = yield* withRunStoreLock(
            { rootDirectory },
            Effect.void,
            { operation: "Gaia server run continuation" }
          ).pipe(Effect.exit);
          assert.strictEqual(differentBody._tag, "Failure");
          const stages = (yield* fs.readDirectory(gaiaRoot)).filter((entry) =>
            entry.startsWith(".lock-stage-")
          );
          assert.deepEqual(stages, []);
        })
    );

    it.effect(
      "rejects no-follow lock child symlink escapes before outside writes",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          for (const child of ["lock-successors", "lock-terminals"] as const) {
            const rootDirectory = yield* fs.makeTempDirectory({
              prefix: `gaia-lock-${child}-`,
            });
            const gaiaRoot = `${rootDirectory}/.gaia`;
            const outside = yield* fs.makeTempDirectory({
              prefix: "gaia-lock-outside-",
            });
            yield* fs.makeDirectory(gaiaRoot);
            yield* fs.symlink(outside, `${gaiaRoot}/${child}`);

            const exit = yield* withRunStoreLock(
              { rootDirectory },
              Effect.void,
              { operation: "Gaia server run continuation" }
            ).pipe(Effect.exit);

            assert.strictEqual(exit._tag, "Failure");
            assert.deepEqual(yield* fs.readDirectory(outside), []);
          }
        })
    );
  });
});
