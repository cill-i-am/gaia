import { NodeServices } from "@effect/platform-node";
import { assert, describe, layer } from "@effect/vitest";
import { Effect, FileSystem } from "effect";

import { copyWorkspaceDirectoryContents } from "./workspace.js";

describe("workspace source preparation", () => {
  layer(NodeServices.layer)((it) => {
    it.effect("rejects a source symlink before copying its target", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectory({
          prefix: "gaia-workspace-source-",
        });
        const source = `${root}/source`;
        const destination = `${root}/destination`;
        const outside = `${root}/outside.txt`;
        yield* fs.makeDirectory(source);
        yield* fs.makeDirectory(destination);
        yield* fs.writeFileString(outside, "must-not-be-copied");
        yield* fs.symlink(outside, `${source}/linked-outside.txt`);

        const error = yield* copyWorkspaceDirectoryContents(
          source,
          destination
        ).pipe(Effect.flip);

        assert.strictEqual(
          Reflect.get(error, "code"),
          "WorkspaceSourceSymlinkRejected"
        );
        assert.strictEqual(
          yield* fs.exists(`${destination}/linked-outside.txt`),
          false
        );
      })
    );
  });
});
