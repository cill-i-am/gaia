# Codex Harness Adapter Spec

## Summary

Add a dedicated Codex harness adapter behind Gaia's existing `GaiaHarness` port.
The minimum viable adapter should use the installed Codex CLI in
non-interactive mode. The heavier ideal adapter should later support visible
worker and reviewer sessions, resumability, cancellation, and richer event
evidence.

Status: the minimum viable non-interactive Codex CLI adapter is implemented.
The visible-session adapter remains future work.

## Context / Current State

Gaia currently has:

- `HarnessName`, `HarnessRunRequest`, `HarnessRunResult`, and `GaiaHarness` in
  `packages/runtime/src/harness.ts`;
- registered `fake`, `codex`, and `process` adapters;
- isolated run workspaces under `.gaia/runs/<run-id>/workspace`;
- normalized worker evidence in `worker.log` and `worker-result.json`;
- skill intent in `skill-manifest.json`;
- placeholder browser evidence in `browser-evidence.json`;
- PR preview/publish paths that consume normalized harness artifacts.

The installed Codex CLI supports:

```sh
codex exec --json --cd <dir> --skip-git-repo-check --ephemeral --ignore-user-config --output-last-message <file> -
```

The CLI also supports sandbox, model, profile, and config flags. The MVP spec
should use only stable local process semantics and keep all Codex-specific
details inside a Codex adapter module.

## Goals

- Register a `codex` harness adapter.
- Execute Codex against the isolated run workspace.
- Pass a prompt that contains the Gaia spec, artifact contract, selected skills,
  and verification expectations.
- Capture Codex stdout/stderr or JSONL events into run evidence.
- Persist a normalized `HarnessRunResult`.
- Preserve the current run lifecycle, verifier, reports, PR preview, and PR
  publishing behavior.
- Keep expected Codex failures typed and safe to report.

## Non-Goals

- No reviewer worker sessions in the MVP.
- No merge/deploy authority in the MVP.
- No background daemon in the MVP.
- No direct dependency on private Codex desktop APIs.
- No harness-specific branches in `runSpecFile`.
- No auto-installing skills unless a separate skill-install slice has landed.

## Invariants

- `runSpecFile` selects a harness, but does not know Codex-specific behavior.
- Codex receives parsed Gaia values, not raw CLI flags or untrusted JSON.
- Codex-specific native output does not leak into core run events.
- Event payloads stay plain JSON.
- `worker-result.json` conforms to `HarnessRunResult`.
- `workspace/output.txt` remains the minimum declared output artifact until the
  verifier is generalized.
- Secrets, auth tokens, and local Codex credentials never enter logs, reports,
  events, snapshots, or errors.
- Cancellation and process lifetime are owned by Gaia, not hidden in a detached
  promise.

## Design Constraints

- Use pnpm workspace commands.
- Use Effect for runtime workflows, typed errors, and schemas.
- Parse boundary input with Effect Schema.
- Verify through public workflow seams and recording adapters, not method spies
  or module mocks.
- Keep the adapter deep enough to hide Codex CLI details from callers.
- Keep the MVP small enough to be reversible if the better Codex integration
  path changes.

## Alternatives Considered

### Option 1: Keep Using `process` Harness With Codex CLI Arguments

Shape:

```sh
pnpm gaia run spec.md \
  --harness process \
  --harness-command codex \
  --harness-arg exec \
  --harness-arg --json \
  --harness-arg --cd \
  --harness-arg <workspace>
```

Pros:

- No new adapter code.
- Useful for quick manual experiments.

Cons:

- Callers must know Codex CLI details.
- Gaia cannot own a Codex-specific prompt contract.
- Gaia cannot classify Codex-specific failures.
- Output and session evidence stay generic process evidence.

Verdict:

- Keep as an escape hatch, not the product path.

### Option 2: Dedicated Codex CLI Adapter

Shape:

```ts
export const codexHarnessName = parseHarnessName("codex");

export class CodexHarnessConfig extends Schema.Class<CodexHarnessConfig>(
  "CodexHarnessConfig",
)({
  command: CodexCommandSchema,
  extraArgs: Schema.Array(Schema.String),
  model: Schema.optionalKey(Schema.NonEmptyString),
  profile: Schema.optionalKey(Schema.NonEmptyString),
  sandbox: CodexSandboxModeSchema,
  timeoutMs: CodexCommandTimeoutMsSchema,
}) {}
```

Pros:

- Small real adapter with a meaningful interface.
- Uses installed local Codex CLI.
- Keeps Codex prompt, output parsing, and failure classification local.
- Works with existing Gaia lifecycle.

Cons:

- Non-interactive CLI sessions are less visible than desktop worker threads.
- Resumability depends on what Codex CLI exposes.
- Event parsing may need to stay conservative until JSONL shape is audited.

Verdict:

- Recommended MVP.

### Option 3: Codex App Server / Visible Thread Adapter

Shape:

```ts
type CodexVisibleSession = {
  readonly sessionId: CodexSessionId;
  readonly threadUrl?: string;
  readonly transcriptPath: string;
};
```

Pros:

- Aligns with the desired user-visible worker-thread model.
- Can support side chats, reviewer sessions, and orchestration visibility.
- Better foundation for cancellation/resume.

Cons:

- Needs a stable app-server or remote-control contract.
- Larger boundary and more operational state.
- Harder to test without dedicated local protocol fixtures.

Verdict:

- Ideal heavier case after MVP proves the Codex work loop.

### Option 4: AI SDK HarnessAgent Adapter

Pros:

- Could make Codex, Claude, OpenCode, and future harnesses swappable.
- Aligns with the software-factory direction.

Cons:

- Adds another abstraction before one concrete Codex adapter is proven.
- Risks lowering Gaia's contract to a generic harness interface too early.

Verdict:

- Revisit after the Codex adapter is working and one second real harness is
  being evaluated.

## Recommendation

Build the dedicated Codex CLI adapter first. Treat it as the minimum viable
Codex integration and keep the existing `process` adapter as a manual escape
hatch.

Design the MVP so the heavier visible-session adapter can replace the Codex
execution internals without changing `runSpecFile`, reports, verifier, or PR
publishing.

## Proposed Design

### Minimum Viable Codex Adapter

Status: **implemented**.

The MVP registers `codex` as a harness name and runs:

```sh
codex exec \
  --json \
  --cd <run-workspace> \
  --skip-git-repo-check \
  --ephemeral \
  --ignore-user-config \
  --sandbox workspace-write \
  --output-last-message <run-root>/codex-last-message.md \
  -
```

Prompt is written to stdin. Codex is instructed to:

- read the spec;
- inspect the workspace;
- make the requested change if the spec asks for code;
- write Gaia's declared `workspace/output.txt` artifact as `./output.txt` from
  inside the workspace, with a short completion note and run id;
- leave source changes in the run workspace;
- keep final response concise and evidence-oriented.

Gaia captures:

- Codex JSONL stdout and stderr into `worker.log`;
- final response into `codex-last-message.md`;
- changed workspace paths by snapshotting before and after;
- normalized `worker-result.json`.

### Ideal Heavier Codex Adapter

The heavier version adds:

- visible Codex worker sessions with session/thread IDs;
- optional visible reviewer/spec sessions;
- resumable session state in Gaia artifacts;
- cancellation and cleanup for live sessions;
- structured Codex event parsing;
- transcript artifacts separate from raw process logs;
- richer status such as `started`, `awaiting-approval`, `cancelled`,
  `completed`, and `failed`;
- per-session links or identifiers that the user can open from Gaia reports.

The heavy adapter may use Codex app-server, remote-control, future SDK support,
or AI SDK HarnessAgent, but must preserve Gaia's normalized harness port.

## Domain Model and Types

```ts
export const codexHarnessName = parseHarnessName("codex");

export const CodexCommandSchema = Schema.NonEmptyString.pipe(
  Schema.brand("CodexCommand"),
);
export type CodexCommand = typeof CodexCommandSchema.Type;

export const CodexSandboxModeSchema = Schema.Literals([
  "read-only",
  "workspace-write",
] as const);
export type CodexSandboxMode = typeof CodexSandboxModeSchema.Type;

export class CodexHarnessConfig extends Schema.Class<CodexHarnessConfig>(
  "CodexHarnessConfig",
)({
  command: CodexCommandSchema,
  extraArgs: Schema.Array(Schema.String),
  model: Schema.optionalKey(Schema.NonEmptyString),
  profile: Schema.optionalKey(Schema.NonEmptyString),
  sandbox: CodexSandboxModeSchema,
  timeoutMs: CodexCommandTimeoutMsSchema,
}) {}

export class CodexExecutionResult extends Schema.Class<CodexExecutionResult>(
  "CodexExecutionResult",
)({
  exitCode: Schema.Int,
  lastMessagePath: Schema.NonEmptyString,
  stderrPath: Schema.optionalKey(Schema.NonEmptyString),
  stdoutJsonlPath: Schema.NonEmptyString,
}) {}
```

Heavier-case additions:

```ts
export const CodexSessionIdSchema = Schema.NonEmptyString.pipe(
  Schema.brand("CodexSessionId"),
);
export type CodexSessionId = typeof CodexSessionIdSchema.Type;

export class CodexSessionEvidence extends Schema.Class<CodexSessionEvidence>(
  "CodexSessionEvidence",
)({
  lastMessagePath: Schema.NonEmptyString,
  sessionId: CodexSessionIdSchema,
  status: Schema.Literals([
    "started",
    "awaiting-approval",
    "cancelled",
    "completed",
    "failed",
  ] as const),
  transcriptPath: Schema.NonEmptyString,
}) {}
```

## Types, Interfaces, and APIs

Runtime API:

```ts
export type HarnessRunOptions = {
  readonly codexHarness?: CodexHarnessConfig;
  readonly processHarness?: ProcessHarnessConfig;
};

export function makeCodexHarnessConfig(
  input?: Partial<CodexHarnessConfigInput>,
): CodexHarnessConfig;
```

CLI surface:

```sh
pnpm gaia run spec.md --harness codex
pnpm gaia run spec.md --harness codex --codex-model gpt-5
pnpm gaia run spec.md --harness codex --codex-profile gaia
pnpm gaia run spec.md --harness codex --codex-sandbox workspace-write
pnpm gaia run spec.md --harness codex --codex-timeout-ms 600000
```

Initial defaults:

```ts
const defaultCodexHarnessConfig = CodexHarnessConfig.make({
  command: parseCodexCommand("codex"),
  extraArgs: [],
  sandbox: "workspace-write",
  timeoutMs: 600000,
});
```

Do not expose raw `codex exec` argument assembly to callers. The adapter owns
projection from `CodexHarnessConfig` to process arguments.

## Seams, Boundaries, Adapters, and Implementations

Add:

- `packages/runtime/src/codex-harness.ts`
  - owns Codex config schemas, prompt construction, command projection,
    process execution, output capture, and Codex failure classification.
- `packages/runtime/src/harness.ts`
  - registers `codex` and delegates to `codexHarness(config)`.
- `apps/cli/src/main.ts`
  - parses Codex CLI flags into `CodexHarnessConfig`.

Internal seams:

```ts
export type CodexCommandRunner = (
  input: CodexCommandInput,
) => Effect.Effect<CodexCommandResult, GaiaRuntimeError>;

export type CodexCommandInput = {
  readonly args: ReadonlyArray<string>;
  readonly command: CodexCommand;
  readonly cwd: string;
  readonly stdin: string;
};
```

Tests supply a recording `CodexCommandRunner`. Production uses a Node
`execFile` or spawn-based adapter.

## Call Stacks and Data Flow

### Current Flow

```txt
CLI flags
  -> workflowOptions
  -> runSpecFile
  -> writeWorkerPlan
  -> runHarness
  -> fake/process adapter
  -> worker.log + worker-result.json
  -> verifyHarnessOutput
  -> writeReport
```

### MVP Codex Flow

```txt
CLI flags
  -> parseCodexHarnessConfig
  -> WorkflowOptions.codexHarness
  -> runSpecFile
  -> runHarness(HarnessRunRequest)
  -> selectHarness("codex")
  -> codexHarness.run(request)
  -> buildCodexPrompt(request, skillManifest, artifact contract)
  -> CodexCommandRunner(codex exec ...)
  -> worker.log + codex-last-message.md
  -> snapshot workspace before/after
  -> HarnessRunResult
  -> worker-result.json
  -> verifyHarnessOutput
  -> report + PR evidence
```

### Failure Flow

```txt
Codex command missing / exits non-zero / invalid config / artifact missing
  -> Codex adapter classifies failure
  -> GaiaRuntimeError with safe code/message/cause
  -> runSpecFile records RUN_FAILED
  -> status/list/resume remain inspectable
```

Expected failure codes:

```ts
type CodexHarnessFailureCode =
  | "CodexHarnessConfigMissing"
  | "CodexCommandMissing"
  | "CodexCommandFailed"
  | "CodexCommandTimedOut"
  | "CodexOutputWriteFailed"
  | "CodexPromptWriteFailed"
  | "CodexLastMessageMissing"
  | "HarnessOutputArtifactMissing";
```

### Retry / Cancellation / Idempotency Flow

MVP:

- no automatic retry of Codex execution;
- failed runs are inspectable and a new run can be started;
- process lifetime is owned by the adapter call;
- no detached promise is allowed.

Ideal:

- a caller-owned cancellation signal reaches the Codex session/process;
- cancellation writes a typed cancelled run failure;
- resumable sessions persist `CodexSessionEvidence`;
- retries either resume an existing session or start a new run with a new run id.

### Observability Flow

```txt
Codex native output
  -> raw JSONL/stdout/stderr files
  -> safe summary in worker-result.json
  -> report links artifacts
```

Do not serialize:

- Codex auth tokens;
- user config files;
- raw credential paths;
- arbitrary thrown values;
- full local environment.

## Files to Add / Change / Delete

Add:

- `packages/runtime/src/codex-harness.ts`
  - Codex config schemas, command runner seam, prompt builder, adapter.
- `packages/runtime/src/codex-harness.test.ts` or extend
  `packages/runtime/src/runtime.test.ts`
  - behavior tests through `runSpecFile`.

Change:

- `packages/runtime/src/harness.ts`
  - register `codex`, add options, route to adapter.
- `packages/runtime/src/index.ts`
  - export Codex config types and constructors.
- `apps/cli/src/main.ts`
  - add `--codex-*` flags and include config in `workflowOptions`.
- `docs/harness-port.md`
  - link to this spec and update registered adapter list after implementation.
- `docs/findings.md`
  - add findings after the slice lands.

Delete:

- none for MVP.

## RGR TDD Test Plan

1. RED: `runSpecFile` with `harnessName: codex` and no config fails with
   `CodexHarnessConfigMissing`.
   GREEN: add option type and selection failure.

2. RED: a recording Codex command runner receives `codex exec --json --cd
   <workspace> --output-last-message <file> -`.
   GREEN: implement config projection and adapter command call.

3. RED: recording runner writes workspace output and a final message; run
   completes with `worker-result.json` containing `harnessName: "codex"`.
   GREEN: normalize result and write artifacts.

4. RED: command exits non-zero; run status becomes `failed` with
   `CodexCommandFailed`.
   GREEN: classify command failure in the adapter.

5. RED: command succeeds but does not produce declared `workspace/output.txt`;
   run fails with `HarnessOutputArtifactMissing`.
   GREEN: reuse declared artifact validation.

6. RED: CLI `--harness codex --codex-model gpt-5` passes parsed config to the
   runtime.
   GREEN: add CLI flags and wiring.

7. RED: `publish-workspace-pr` can publish source changes made by a Codex run
   through the existing workspace PR flow.
   GREEN: verify no new GitHub publishing path is needed.

## Minimum Viable Acceptance Criteria

- `pnpm gaia run examples/specs/smoke.md --harness codex` completes locally
  when Codex auth is available.
- `worker.log` contains Codex output.
- `codex-last-message.md` is stored in the run directory.
- `worker-result.json` validates as `HarnessRunResult`.
- `changedWorkspacePaths` records source changes and `output.txt`.
- `pnpm gaia publish-workspace-pr <run-id>` can preview/publish the resulting
  workspace changes using the existing PR path.
- `pnpm check`, `pnpm test`, and `pnpm build` pass.

## Ideal Heavier Acceptance Criteria

- Gaia creates or attaches to a visible Codex worker session.
- Gaia records session id, transcript path, and final message path.
- The user can inspect or resume a session from Gaia evidence.
- A read-only reviewer session can review the worker plan and final diff.
- Cancellation produces a typed failure and cleans up owned process/session
  resources.
- Session state is durable enough to survive process restart.
- The adapter remains behind `GaiaHarness`; no lifecycle callers learn Codex
  native protocol details.

## Risks and Open Questions

- Codex JSONL event schema should be audited before Gaia relies on structured
  event fields beyond raw log persistence.
- Codex visible thread creation may require app-server or remote-control
  semantics that should be checked when implementing the heavier adapter.
- MVP non-interactive runs may be less useful for side conversations. That is
  acceptable for the first adapter, but not the final factory experience.
- Sandbox defaults need a user decision before live mutating runs in important
  repos. The proposed MVP default is `workspace-write`, assuming Gaia runs in
  an isolated workspace.
- The verifier still requires `workspace/output.txt`. Generalizing verifier
  expectations should be a separate slice after real Codex runs prove the
  artifact needs.
