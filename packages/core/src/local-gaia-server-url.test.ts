import { assert, describe, it } from "@effect/vitest";
import { Schema } from "effect";

import {
  LocalGaiaServerUrlSchema,
  parseLocalGaiaServerUrl,
} from "./local-gaia-server-url.js";
import { RunIdSchema, parseRunId } from "./run-id.js";

describe("LocalGaiaServerUrl", () => {
  it("preserves supported local server base URLs and rejects unsafe forms", () => {
    const accepted = [
      "/gaia-api",
      "/gaia-api/",
      "http://127.0.0.1:4321",
      "http://127.0.0.1:4321/",
      "https://gaia.example.test/api",
    ];

    for (const input of accepted) {
      assert.strictEqual(parseLocalGaiaServerUrl(input), input);
    }

    const rejected = [
      "ftp://127.0.0.1:4321",
      "http:foo",
      "http:/foo",
      "http:///foo",
      "https:foo",
      "//127.0.0.1:4321",
      " http://127.0.0.1:4321",
      "http://127.0.0.1:4321 ",
      "http://127.0.0.1:4321/a b",
      "http:\\127.0.0.1:4321",
      "http://127.0.0.1:4321?debug=true",
      "http://127.0.0.1:4321#status",
      "/gaia-api?debug=true",
      "/gaia-api#status",
      "gaia-api",
      "",
    ];

    for (const input of rejected) {
      assert.throws(() => parseLocalGaiaServerUrl(input));
    }

    const value = parseLocalGaiaServerUrl("http://127.0.0.1:4321/");
    const jsonCodec = Schema.fromJsonString(LocalGaiaServerUrlSchema);
    assert.strictEqual(
      Schema.encodeSync(jsonCodec)(value),
      '"http://127.0.0.1:4321/"'
    );
    assert.strictEqual(
      Schema.decodeUnknownSync(jsonCodec)('"http://127.0.0.1:4321/"'),
      value
    );
  });

  it("keeps branded run IDs as exact JSON strings", () => {
    const value = parseRunId("run-1234567890");
    const jsonCodec = Schema.fromJsonString(RunIdSchema);

    assert.strictEqual(Schema.encodeSync(jsonCodec)(value), '"run-1234567890"');
    assert.strictEqual(
      Schema.decodeUnknownSync(jsonCodec)('"run-1234567890"'),
      value
    );
    assert.throws(() => Schema.decodeUnknownSync(jsonCodec)('"not-a-run"'));
  });
});
