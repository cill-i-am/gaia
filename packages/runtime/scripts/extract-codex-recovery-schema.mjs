import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const expectedVersion = "codex-cli 0.137.0";
if (
  execFileSync("codex", ["--version"], { encoding: "utf8" }).trim() !==
  expectedVersion
)
  throw new Error(`Expected ${expectedVersion}`);
const root = mkdtempSync(path.join(tmpdir(), "gaia-codex-schema-"));
try {
  execFileSync("codex", [
    "app-server",
    "generate-json-schema",
    "--experimental",
    "--out",
    root,
  ]);
  const read = (name) => readFileSync(path.join(root, "v2", name));
  const turn = read("TurnStartParams.json");
  const models = read("ModelListResponse.json");
  const sha256 = (value) => createHash("sha256").update(value).digest("hex");
  const turnJson = JSON.parse(turn);
  const modelJson = JSON.parse(models);
  const fixture = {
    generatedBy: expectedVersion,
    modelListResponse: {
      modelRequired: modelJson.definitions.Model.required,
      required: modelJson.required,
    },
    modelListResponseSha256: sha256(models),
    turnStartParams: {
      properties: {
        clientUserMessageId: turnJson.properties.clientUserMessageId.type,
        input: turnJson.properties.input.type,
        model: turnJson.properties.model.type,
        threadId: turnJson.properties.threadId.type,
      },
      required: turnJson.required,
    },
    turnStartParamsSha256: sha256(turn),
  };
  writeFileSync(
    new URL(
      "../src/fixtures/codex-app-server-0.137.0-recovery.schema.json",
      import.meta.url
    ),
    `${JSON.stringify(fixture, null, 2)}\n`
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
