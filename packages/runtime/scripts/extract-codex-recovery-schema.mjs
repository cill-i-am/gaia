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
  const schemaPaths = [
    "ClientRequest.json",
    "CommandExecutionRequestApprovalParams.json",
    "CommandExecutionRequestApprovalResponse.json",
    "FileChangeRequestApprovalParams.json",
    "FileChangeRequestApprovalResponse.json",
    "McpServerElicitationRequestParams.json",
    "McpServerElicitationRequestResponse.json",
    "PermissionsRequestApprovalParams.json",
    "PermissionsRequestApprovalResponse.json",
    "RequestId.json",
    "ServerNotification.json",
    "ServerRequest.json",
    "ToolRequestUserInputParams.json",
    "ToolRequestUserInputResponse.json",
    "v1/InitializeParams.json",
    "v1/InitializeResponse.json",
    "v2/AgentMessageDeltaNotification.json",
    "v2/CommandExecutionOutputDeltaNotification.json",
    "v2/ErrorNotification.json",
    "v2/FileChangeOutputDeltaNotification.json",
    "v2/FileChangePatchUpdatedNotification.json",
    "v2/ItemCompletedNotification.json",
    "v2/ItemStartedNotification.json",
    "v2/ModelListParams.json",
    "v2/ModelListResponse.json",
    "v2/ServerRequestResolvedNotification.json",
    "v2/ThreadListParams.json",
    "v2/ThreadListResponse.json",
    "v2/ThreadReadParams.json",
    "v2/ThreadReadResponse.json",
    "v2/ThreadResumeParams.json",
    "v2/ThreadResumeResponse.json",
    "v2/ThreadStartParams.json",
    "v2/ThreadStartResponse.json",
    "v2/ThreadStartedNotification.json",
    "v2/ThreadStatusChangedNotification.json",
    "v2/ThreadTokenUsageUpdatedNotification.json",
    "v2/TurnCompletedNotification.json",
    "v2/TurnDiffUpdatedNotification.json",
    "v2/TurnInterruptParams.json",
    "v2/TurnInterruptResponse.json",
    "v2/TurnPlanUpdatedNotification.json",
    "v2/TurnStartParams.json",
    "v2/TurnStartResponse.json",
    "v2/TurnStartedNotification.json",
    "v2/TurnSteerParams.json",
    "v2/TurnSteerResponse.json",
    "v2/WarningNotification.json",
  ];
  const sha256 = (value) => createHash("sha256").update(value).digest("hex");
  const readSchema = (schemaPath) =>
    JSON.parse(readFileSync(path.join(root, schemaPath), "utf8"));
  const permissions = readSchema("PermissionsRequestApprovalParams.json");
  const permissionResponse = readSchema(
    "PermissionsRequestApprovalResponse.json"
  );
  const elicitationRequest = readSchema(
    "McpServerElicitationRequestParams.json"
  );
  const elicitationResponse = readSchema(
    "McpServerElicitationRequestResponse.json"
  );
  const itemStarted = readSchema("v2/ItemStartedNotification.json");
  const itemCompleted = readSchema("v2/ItemCompletedNotification.json");
  const serverNotification = readSchema("ServerNotification.json");
  const fixture = {
    facts: {
      additionalFileSystemPermissionsRequired:
        permissions.definitions.AdditionalFileSystemPermissions.required ?? [],
      additionalNetworkPermissionsRequired:
        permissions.definitions.AdditionalNetworkPermissions.required ?? [],
      elicitationRequestRequired: elicitationRequest.required,
      elicitationResponseRequired: elicitationResponse.required,
      itemCompletedRequired: itemCompleted.required,
      itemStartedRequired: itemStarted.required,
      modelListRequired: readSchema("v2/ModelListResponse.json").required,
      notificationMethods: serverNotification.oneOf.map(
        (entry) => entry.properties.method.enum[0]
      ),
      permissionApprovalResponseRequired: permissionResponse.required,
      permissionApprovalScopeDefault:
        permissionResponse.properties.scope.default,
      permissionRequestRequired: permissions.required,
      requestIdTypes: readSchema("RequestId.json").anyOf.map(
        (entry) => entry.type
      ),
      requestPermissionProfileRequired:
        permissions.definitions.RequestPermissionProfile.required ?? [],
      threadItemTypes: itemStarted.definitions.ThreadItem.oneOf.map(
        (entry) => entry.properties.type.enum[0]
      ),
      threadListRequired: readSchema("v2/ThreadListResponse.json").required,
    },
    generatedBy: expectedVersion,
    schemas: Object.fromEntries(
      schemaPaths.map((schemaPath) => [
        schemaPath,
        sha256(readFileSync(path.join(root, schemaPath))),
      ])
    ),
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
