import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ModelListResultSchema, TurnStartParamsSchema, supportedCodexCliVersion } from "./codex-app-server-protocol.js";
import { Schema } from "effect";

const pinned = JSON.parse(readFileSync(new URL("./fixtures/codex-app-server-0.137.0-recovery.schema.json", import.meta.url), "utf8"));

describe("pinned Codex App Server 0.137.0 generated-schema parity", () => {
  it("keeps model/list and explicit turn/start.model compatible with the generated protocol", () => {
    expect(supportedCodexCliVersion).toBe("0.137.0");
    expect(pinned.generatedBy).toBe("codex-cli 0.137.0");
    expect(pinned.turnStartParamsSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(pinned.modelListResponseSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(pinned.turnStartParams.required).toEqual(["input", "threadId"]);
    expect(pinned.turnStartParams.properties.model).toEqual(["string", "null"]);
    expect(() => Schema.decodeUnknownSync(TurnStartParamsSchema)({ input: [{ text: "recover", type: "text" }], model: "gpt-5.4", threadId: "thread-1" })).not.toThrow();
    expect(() => Schema.decodeUnknownSync(ModelListResultSchema)({ data: [{ defaultReasoningEffort: "high", description: "stable", displayName: "Stable", hidden: false, id: "gpt-5.4", isDefault: false, model: "gpt-5.4", supportedReasoningEfforts: [] }], nextCursor: null })).not.toThrow();
  });
});
