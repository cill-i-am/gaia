import { readFileSync } from "node:fs";

import { assert, describe, it } from "@effect/vitest";

import { parseMarkdownSpec } from "./spec.js";

describe("structured claim verification source", () => {
  it("parses the exact dedicated V2 fixture with body-owned provenance", () => {
    const input = fixture();
    const spec = parseMarkdownSpec(input, "fallback");

    assert.strictEqual(spec.verification?.version, 2);
    assert.deepEqual(
      spec.verification?.claims.map((claim) => claim.key),
      ["smoke-command", "smoke-ci", "smoke-review"]
    );
    assert.deepEqual(
      spec.verification?.outcomes[0]?.prePublicationRequiredClaims,
      ["smoke-command"]
    );
  });

  it("rejects a frontmatter claim when its body item is missing", () => {
    assert.throws(() =>
      parseMarkdownSpec(
        fixture().replace(
          "- Paired local reviewer approved the published exact head.\n",
          ""
        ),
        "fallback"
      )
    );
  });

  it("rejects duplicate raw body items before deduplication", () => {
    const item =
      "- Run the pinned POSIX printf command with no network or credentials.";
    assert.throws(() =>
      parseMarkdownSpec(fixture().replace(item, `${item}\n${item}`), "fallback")
    );
  });

  it("rejects a body item rebound to another claim key", () => {
    const claim = fixture().match(
      / {4}- key: smoke-ci[\s\S]*?(?= {4}- key: smoke-review)/u
    )?.[0];
    assert.ok(claim);
    assert.throws(() =>
      parseMarkdownSpec(
        fixture().replace(
          "    - key: smoke-review",
          `${claim.replace("key: smoke-ci", "key: smoke-ci-copy")}    - key: smoke-review`
        ),
        "fallback"
      )
    );
  });

  it("rejects changed body text and a stale source digest", () => {
    assert.throws(() =>
      parseMarkdownSpec(
        fixture().replace(
          "- The smoke command exits 0 and emits exactly gaia-claim-ok.",
          "- The smoke command exits 0 and emits something else."
        ),
        "fallback"
      )
    );
    assert.throws(() =>
      parseMarkdownSpec(
        fixture().replace(
          "3dfad97fa384fc8d25327a9bd7d7a4d94ea2ce584721f9265f57047f73b01ee4",
          "0".repeat(64)
        ),
        "fallback"
      )
    );
  });

  it("rejects dangling, unmapped, conflicting, and excess source inputs", () => {
    assert.throws(() =>
      parseMarkdownSpec(
        fixture().replace(
          "prePublicationRequiredClaims: [smoke-command]",
          "prePublicationRequiredClaims: [missing-command]"
        ),
        "fallback"
      )
    );
    assert.throws(() =>
      parseMarkdownSpec(
        fixture().replace(
          "postPublicationRequiredClaims: [smoke-ci, smoke-review]",
          "postPublicationRequiredClaims: [smoke-ci]"
        ),
        "fallback"
      )
    );
    assert.throws(() =>
      parseMarkdownSpec(
        fixture().replace(
          "conditionalClaims: []",
          "conditionalClaims: [smoke-command]"
        ),
        "fallback"
      )
    );
    assert.throws(() =>
      parseMarkdownSpec(
        fixture().replace(
          "      phase: prePublication",
          "      phase: prePublication\n      unexpected: true"
        ),
        "fallback"
      )
    );
  });
});

function fixture() {
  return readFileSync(
    new URL(
      "../../../examples/specs/claim-verification-v2.md",
      import.meta.url
    ),
    "utf8"
  );
}
