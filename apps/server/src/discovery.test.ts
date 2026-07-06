import { assert, describe, it, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ServerMetadata } from "@gaia/core";
import { Effect, FileSystem } from "effect";
import {
  appendServerLog,
  readServerMetadata,
  removeMatchingServerMetadata,
  serverJsonPath,
  serverLogPath,
  writeServerMetadata,
} from "./discovery.js";
import { parseArgs } from "./main.js";

describe("local Gaia server discovery", () => {
  layer(NodeServices.layer)((it) => {
    it.effect("writes, reads, logs, and removes matching workspace metadata", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-server-" });
        const metadata = ServerMetadata.make({
          gaiaRoot: `${cwd}/.gaia`,
          host: "127.0.0.1",
          pid: process.pid,
          port: 49152,
          serverId: "srv_test",
          startedAt: "2026-07-06T10:00:00.000Z",
          updatedAt: "2026-07-06T10:00:00.000Z",
          url: "http://127.0.0.1:49152",
          version: 1,
          workspaceRoot: cwd,
        });

        yield* writeServerMetadata(metadata);
        yield* appendServerLog(metadata, "started");

        const read = yield* readServerMetadata(cwd);
        const serverJsonExists = yield* fs.exists(serverJsonPath(cwd));
        const log = yield* fs.readFileString(serverLogPath(cwd));

        assert.isTrue(serverJsonExists);
        assert.strictEqual(read?.serverId, "srv_test");
        assert.strictEqual(read?.workspaceRoot, cwd);
        assert.include(log, "\"event\":\"started\"");
        assert.include(log, "\"workspaceRoot\"");

        yield* removeMatchingServerMetadata(metadata);
        const removed = yield* fs.exists(serverJsonPath(cwd));
        assert.isFalse(removed);
      }),
    );
  });

  it("parses dynamic and explicit foreground server options", () => {
    assert.deepStrictEqual(parseArgs([]), {});
    assert.deepStrictEqual(parseArgs(["--port", "0"]), { port: 0 });
    assert.deepStrictEqual(parseArgs(["--port", "49152"]), { port: 49152 });
    assert.throws(() => parseArgs(["--port", "49152abc"]));
    assert.throws(() => parseArgs(["--port", "-1"]));
    assert.throws(() => parseArgs(["--port", "99999"]));
    assert.throws(() => parseArgs(["--host", "0.0.0.0"]));
  });
});
