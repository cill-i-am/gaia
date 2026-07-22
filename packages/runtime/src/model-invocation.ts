import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";

import {
  ModelContextManifestV1,
  ModelInvocationEpisodeStartV1,
  ModelInvocationEpisodeRoleSchema,
  ModelInvocationManifestV1,
  ModelManifestArtifactRefV1,
  LocalRunModelManifestArtifactDto,
  LocalRunModelManifestArtifactSchema,
  ModelManifestArtifactDiagnosticDto,
  ModelWorkspaceBindingV1,
  RunSpec,
  SpecDigestSchema,
  makeModelContextContentV1,
  makeModelContextManifestV1,
  makeModelInvocationManifestV1,
  parseModelContextManifest,
  parseModelInvocationEpisodeStart,
  parseModelInvocationManifest,
  parseMarkdownSpec,
  parseRunId,
  parseSpecDigest,
  renderModelInputV1,
  resolveModelInvocationEpisodes,
  type RunEvent,
} from "@gaia/core";
import { Cause, Effect, FileSystem, Option, Path, Schema } from "effect";

import {
  BrowserEvidenceTargetUrlSchema,
  parseBrowserEvidenceTargetUrl,
} from "./browser-evidence.js";
import {
  CodexHarnessConfig,
  type CodexCommandRunner,
  type CodexHarnessOptions,
} from "./codex-harness.js";
import { GaiaRuntimeError, makeRuntimeError } from "./errors.js";
import type { ProcessHarnessConfig } from "./harness.js";
import {
  parseRuntimePath,
  RunPathsSchema,
  RuntimePathSchema,
  type RunPaths,
} from "./paths.js";
import {
  BrowserEvidenceRequirementSchema,
  RunProfile,
  RunProfileSourceSchema,
  resolveRunProfile,
  type BrowserEvidenceRequirement,
  type RunProfileSource,
} from "./run-profile.js";
import {
  isCredentialFreeSkillSourceRepository,
  type SkillInstallCommandRunner,
  type SkillInstallerOptions,
} from "./skill-bundle.js";
import {
  SkillManifest,
  SkillManifestSourceSchema,
  resolveSkillManifest,
  type SkillManifestSource,
} from "./skill-manifest.js";
import {
  WorkspaceSourceSchema,
  emptyWorkspaceSource,
  type WorkspaceSource,
} from "./workspace.js";

const encodeContextManifest = Schema.encodeSync(ModelContextManifestV1);
const encodeInvocationManifest = Schema.encodeSync(ModelInvocationManifestV1);
const decodeModelManifestArtifact = Schema.decodeUnknownSync(
  LocalRunModelManifestArtifactSchema
);
const decodeEpisodeRole = Schema.decodeUnknownSync(
  ModelInvocationEpisodeRoleSchema
);
const decodeString = Schema.decodeUnknownSync(Schema.String);

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const SafeDigestSchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
);
const SafeExecutableSchema = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isMaxLength(1_024))
);
const PreparedInputTextSchema = Schema.String.pipe(
  Schema.check(Schema.isMaxLength(16_384))
);
const ModelInvocationEpisodeIdSchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^episode1_[a-f0-9]{64}$/u)),
  Schema.brand("ModelInvocationEpisodeId")
);
const ModelManifestBodySchema = Schema.String.pipe(
  Schema.check(Schema.isMaxLength(131_072)),
  Schema.brand("ModelManifestBody")
);

export class PreparedSkillInstallerV1 extends Schema.Class<PreparedSkillInstallerV1>(
  "PreparedSkillInstallerV1"
)(
  {
    command: SafeExecutableSchema,
    externalInstallationReachable: Schema.Boolean,
    semanticDigest: SafeDigestSchema,
    version: Schema.Literal(1),
  },
  strict
) {}

export class CodexBatchSemanticConfigV1 extends Schema.Class<CodexBatchSemanticConfigV1>(
  "CodexBatchSemanticConfigV1"
)(
  {
    command: SafeExecutableSchema,
    extraArgs: Schema.Array(Schema.String).pipe(
      Schema.check(Schema.isMaxLength(32))
    ),
    model: Schema.optionalKey(Schema.NonEmptyString),
    profile: Schema.optionalKey(Schema.NonEmptyString),
    sandbox: Schema.Literals(["read-only", "workspace-write"] as const),
    semanticDigest: SafeDigestSchema,
    timeoutMs: Schema.Number,
    version: Schema.Literal(1),
  },
  strict
) {}

export class ProcessHarnessSemanticConfigV1 extends Schema.Class<ProcessHarnessSemanticConfigV1>(
  "ProcessHarnessSemanticConfigV1"
)(
  {
    args: Schema.Array(Schema.String).pipe(
      Schema.check(Schema.isMaxLength(64))
    ),
    command: SafeExecutableSchema,
    semanticDigest: SafeDigestSchema,
    version: Schema.Literal(1),
  },
  strict
) {}

class ProcessHarnessSemanticInput extends Schema.Class<ProcessHarnessSemanticInput>(
  "ProcessHarnessSemanticInput"
)({
  args: Schema.Array(Schema.String).pipe(Schema.check(Schema.isMaxLength(64))),
  command: SafeExecutableSchema,
}) {}

export class PreparedRunSemanticsV1 extends Schema.Class<PreparedRunSemanticsV1>(
  "PreparedRunSemanticsV1"
)({
  browserEvidenceRequirement: BrowserEvidenceRequirementSchema,
  explicitBrowserEvidenceTargetUrl: Schema.optionalKey(
    BrowserEvidenceTargetUrlSchema
  ),
  installer: PreparedSkillInstallerV1,
  processHarness: Schema.optionalKey(ProcessHarnessSemanticConfigV1),
  codexHarness: Schema.optionalKey(CodexBatchSemanticConfigV1),
  runProfile: RunProfile,
  skillManifest: SkillManifest,
  workspaceSource: WorkspaceSourceSchema,
}) {}

export class PreparedSpecRunAcceptanceV1 extends Schema.Class<PreparedSpecRunAcceptanceV1>(
  "PreparedSpecRunAcceptanceV1"
)({
  ...PreparedRunSemanticsV1.fields,
  input: PreparedInputTextSchema,
  spec: RunSpec,
  specDigest: SpecDigestSchema,
  specPath: RuntimePathSchema,
}) {}

const CodexCommandRunnerSchema = Schema.declare<CodexCommandRunner>(
  (input): input is CodexCommandRunner => typeof input === "function"
);
const SkillInstallCommandRunnerSchema =
  Schema.declare<SkillInstallCommandRunner>(
    (input): input is SkillInstallCommandRunner => typeof input === "function"
  );
const PrepareSpecRunOptionsSchema = Schema.Struct({
  browserEvidenceRequirement: Schema.optionalKey(
    BrowserEvidenceRequirementSchema
  ),
  browserEvidenceTargetUrl: Schema.optionalKey(Schema.String),
  codexHarness: Schema.optionalKey(
    Schema.Struct({
      commandRunner: Schema.optionalKey(CodexCommandRunnerSchema),
      config: CodexHarnessConfig,
    })
  ),
  processHarness: Schema.optionalKey(ProcessHarnessSemanticInput),
  runProfileSource: Schema.optionalKey(RunProfileSourceSchema),
  skillInstaller: Schema.optionalKey(
    Schema.Struct({
      command: Schema.optionalKey(Schema.String),
      commandRunner: Schema.optionalKey(SkillInstallCommandRunnerSchema),
    })
  ),
  skillManifestSource: Schema.optionalKey(SkillManifestSourceSchema),
  workspaceSource: Schema.optionalKey(WorkspaceSourceSchema),
});

export type PrepareSpecRunOptions = typeof PrepareSpecRunOptionsSchema.Type;

const PreparedServerRunInputSchemaV1 = Schema.Struct({
  specMarkdown: PreparedInputTextSchema,
  title: Schema.optionalKey(Schema.UndefinedOr(PreparedInputTextSchema)),
});

export class PreparedServerRunAcceptanceV1 extends Schema.Class<PreparedServerRunAcceptanceV1>(
  "PreparedServerRunAcceptanceV1"
)({
  ...PreparedRunSemanticsV1.fields,
  input: PreparedServerRunInputSchemaV1,
  spec: RunSpec,
}) {}

export function prepareServerRunAcceptance(
  input: typeof PreparedServerRunInputSchemaV1.Type,
  options: PrepareSpecRunOptions = {}
) {
  return Effect.gen(function* () {
    const parsed = yield* preflight(() => {
      assertSecretSafe(input.specMarkdown, "server.spec.body");
      if (input.title !== undefined)
        assertSecretSafe(input.title, "server.spec.title");
      return parseMarkdownSpec(
        input.specMarkdown,
        input.title?.trim() || "Untitled Gaia run"
      );
    });
    const semantics = yield* prepareRunSemantics(options);
    return {
      ...semantics,
      input,
      spec: parsed,
    } satisfies PreparedServerRunAcceptanceV1;
  });
}

export function assertFactoryRunAcceptanceSecretSafe(input: unknown) {
  return preflight(() => {
    const visit = (value: unknown, field: string, depth: number): void => {
      if (depth > 8) throw preflightFailure(field, "bounded-structure");
      if (typeof value === "string") {
        assertSecretSafe(value, field);
        if (/^https?:\/\//iu.test(value)) parseBrowserEvidenceTargetUrl(value);
        return;
      }
      if (Array.isArray(value)) {
        if (value.length > 64)
          throw preflightFailure(field, "bounded-structure");
        for (const [index, entry] of value.entries())
          visit(entry, `${field}.${index}`, depth + 1);
        return;
      }
      if (typeof value === "object" && value !== null) {
        const entries = Object.entries(value);
        if (entries.length > 64)
          throw preflightFailure(field, "bounded-structure");
        for (const [key, entry] of entries)
          visit(entry, `${field}.${key}`, depth + 1);
      }
    };
    visit(input, "factory", 0);
  });
}

const secretAssignmentPattern =
  /(?:api[_-]?key|access[_-]?token|auth[_-]?token|auth(?:orization)?|bearer|client[_-]?secret|password|passwd|private[_-]?key)\s*(?::|=)\s*[^\s,;]+/iu;
const credentialFlagPattern =
  /^--?(?:api[_-]?key|access[_-]?token|auth[_-]?token|auth(?:orization)?|bearer|client[_-]?secret|credential|password|passwd|private[_-]?key|secret|token)$/iu;
const privateKeyPattern = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/u;
const sensitivePathPattern =
  /(?:^|[/\\])(?:\.ssh|\.aws|\.gnupg|\.env)(?:[/\\]|$)|(?:credentials|id_rsa|id_ed25519)$/iu;
const safeCodexFeaturePattern = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/u;

function preflightFailure(field: string, category: string) {
  return makeRuntimeError({
    code: "AcceptedInputRejected",
    message: `Accepted input ${field} failed the ${category} safety policy.`,
    recoverable: false,
  });
}

function preflight<A>(evaluate: () => A) {
  return Effect.try({
    try: evaluate,
    catch: (cause) =>
      cause instanceof GaiaRuntimeError
        ? cause
        : preflightFailure("accepted-input", "schema"),
  });
}

function assertWellFormedBounded(
  value: unknown,
  maximum: number,
  field: string
) {
  const decoded = decodeString(value);
  if (!decoded.isWellFormed() || Buffer.byteLength(decoded, "utf8") > maximum)
    throw preflightFailure(field, "bounded-text");
  return decoded;
}

function assertSecretSafe(value: unknown, field: string) {
  const decoded = assertWellFormedBounded(value, 16_384, field);
  if (
    secretAssignmentPattern.test(decoded) ||
    privateKeyPattern.test(decoded) ||
    sensitivePathPattern.test(decoded)
  )
    throw preflightFailure(field, "credential-free");
}

function assertCredentialFreeUrlLike(value: unknown, field: string) {
  const candidate = assertWellFormedBounded(value, 16_384, field);
  if (!/^https?:\/\//iu.test(candidate)) return;
  parseBrowserEvidenceTargetUrl(candidate);
}

function isSafeExecutable(value: string) {
  if (!/^[\u0021-\u007e]{1,1024}$/u.test(value) || value.includes("="))
    return false;
  if (/^[A-Za-z0-9._+-]+$/u.test(value)) return true;
  if (/^\.\/(?:[A-Za-z0-9._+-]+\/)*[A-Za-z0-9._+-]+$/u.test(value)) return true;
  return [
    "/bin/",
    "/usr/bin/",
    "/usr/local/bin/",
    "/opt/homebrew/bin/",
    "/opt/local/bin/",
  ].some(
    (root) => value.startsWith(root) && !value.slice(root.length).includes("/")
  );
}

function isSafeProcessExecutable(value: string) {
  return (
    /^[A-Za-z0-9._+-]{1,1024}$/u.test(value) ||
    (/^\/(?:[A-Za-z0-9._+-]+\/)*[A-Za-z0-9._+-]+$/u.test(value) &&
      !value.includes("..")) ||
    /^\.\/(?:[A-Za-z0-9._+-]+\/)*[A-Za-z0-9._+-]+$/u.test(value)
  );
}

function digestSemantic(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

const CodexBatchSemanticInputSchema = Schema.Struct({
  config: Schema.Struct({
    command: SafeExecutableSchema,
    extraArgs: CodexBatchSemanticConfigV1.fields.extraArgs,
    model: Schema.optionalKey(Schema.NonEmptyString),
    profile: Schema.optionalKey(Schema.NonEmptyString),
    sandbox: CodexBatchSemanticConfigV1.fields.sandbox,
    timeoutMs: CodexBatchSemanticConfigV1.fields.timeoutMs,
  }),
});
export function decodeCodexBatchSemanticConfig(
  options?: CodexHarnessOptions | typeof CodexBatchSemanticInputSchema.Type
): CodexBatchSemanticConfigV1 | undefined {
  if (options === undefined) return undefined;
  const config = options.config;
  if (!isSafeExecutable(config.command))
    throw preflightFailure("codex.command", "executable");
  const args = [...config.extraArgs];
  const singletonFlags = new Set<string>();
  const featureModes = new Map<string, "enable" | "disable">();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--strict-config") {
      if (singletonFlags.has(flag))
        throw preflightFailure("codex.args", "conflicting-extension");
      singletonFlags.add(flag);
      continue;
    }
    if (flag === "--color") {
      if (singletonFlags.has(flag))
        throw preflightFailure("codex.args", "conflicting-extension");
      singletonFlags.add(flag);
      const value = args[++index];
      if (value === "auto" || value === "always" || value === "never") continue;
      throw preflightFailure("codex.args", "documented-extension");
    }
    if (flag === "--enable" || flag === "--disable") {
      const value = args[++index];
      if (value !== undefined && safeCodexFeaturePattern.test(value)) {
        const mode = flag === "--enable" ? "enable" : "disable";
        if (featureModes.has(value))
          throw preflightFailure("codex.args", "conflicting-extension");
        featureModes.set(value, mode);
        continue;
      }
      throw preflightFailure("codex.args", "documented-extension");
    }
    throw preflightFailure("codex.args", "documented-extension");
  }
  for (const [field, value] of [
    ["codex.model", config.model],
    ["codex.profile", config.profile],
  ] as const)
    if (value !== undefined) assertSecretSafe(value, field);
  const payload = {
    command: config.command,
    extraArgs: args,
    ...(config.model === undefined ? {} : { model: config.model }),
    ...(config.profile === undefined ? {} : { profile: config.profile }),
    sandbox: config.sandbox,
    timeoutMs: config.timeoutMs,
    version: 1 as const,
  };
  return CodexBatchSemanticConfigV1.make({
    ...payload,
    semanticDigest: digestSemantic(payload),
  });
}

export function decodeProcessHarnessSemanticConfig(
  config?: ProcessHarnessConfig | ProcessHarnessSemanticInput
): ProcessHarnessSemanticConfigV1 | undefined {
  if (config === undefined) return undefined;
  if (!isSafeProcessExecutable(config.command))
    throw preflightFailure("process.command", "executable");
  assertSecretSafe(config.command, "process.command");
  for (let index = 0; index < config.args.length; index += 1) {
    const argument = config.args[index]!;
    assertSecretSafe(argument, `process.arg.${index}`);
    if (credentialFlagPattern.test(argument))
      throw preflightFailure(`process.arg.${index}`, "credential-free");
    assertCredentialFreeUrlLike(argument, `process.arg.${index}`);
  }
  const payload = {
    args: [...config.args],
    command: config.command,
    version: 1 as const,
  };
  return ProcessHarnessSemanticConfigV1.make({
    ...payload,
    semanticDigest: digestSemantic(payload),
  });
}

export function prepareSkillInstaller(
  installer: SkillInstallerOptions | undefined,
  manifest: SkillManifest
) {
  const command = installer?.command ?? "git";
  if (!isSafeExecutable(command))
    throw preflightFailure("skillInstaller.command", "executable");
  const externalInstallationReachable = manifest.skills.some(
    (skill) => skill.sourceRepository !== "local"
  );
  const payload = {
    command,
    externalInstallationReachable,
    version: 1 as const,
  };
  return PreparedSkillInstallerV1.make({
    ...payload,
    semanticDigest: digestSemantic(payload),
  });
}

export function assertPreparedRunSemanticsV1(input: PreparedRunSemanticsV1) {
  if (input.skillManifest.skills.length > 64)
    throw preflightFailure("skills", "bounded-structure");
  assertSecretSafe(input.runProfile.name, "profile.name");
  if (input.runProfile.browser?.targetUrl !== undefined)
    assertCredentialFreeUrlLike(
      input.runProfile.browser.targetUrl,
      "profile.browser.targetUrl"
    );
  for (const [index, skill] of input.skillManifest.skills.entries()) {
    assertSecretSafe(skill.name, `skill.${index}.name`);
    assertSecretSafe(skill.sourcePath, `skill.${index}.sourcePath`);
    assertSecretSafe(skill.sourceRepository, `skill.${index}.sourceRepository`);
    if (!isCredentialFreeSkillSourceRepository(skill.sourceRepository))
      throw preflightFailure(
        `skill.${index}.sourceRepository`,
        "credential-free-repository"
      );
    if (skill.version !== undefined)
      assertSecretSafe(skill.version, `skill.${index}.version`);
    if (skill.commit !== undefined)
      assertSecretSafe(skill.commit, `skill.${index}.commit`);
  }
  if (input.workspaceSource._tag === "LocalDirectory")
    assertSecretSafe(input.workspaceSource.path, "workspace.source.path");
  if (input.explicitBrowserEvidenceTargetUrl !== undefined) {
    parseBrowserEvidenceTargetUrl(input.explicitBrowserEvidenceTargetUrl);
  }
  const expectedInstaller = prepareSkillInstaller(
    { command: input.installer.command },
    input.skillManifest
  );
  if (JSON.stringify(expectedInstaller) !== JSON.stringify(input.installer))
    throw preflightFailure("skillInstaller", "semantic-identity");
  if (input.processHarness !== undefined) {
    const expected = decodeProcessHarnessSemanticConfig({
      args: input.processHarness.args,
      command: input.processHarness.command,
    });
    if (JSON.stringify(expected) !== JSON.stringify(input.processHarness))
      throw preflightFailure("process", "semantic-identity");
  }
  if (input.codexHarness !== undefined) {
    const expected = decodeCodexBatchSemanticConfig({
      config: {
        command: input.codexHarness.command,
        extraArgs: input.codexHarness.extraArgs,
        ...(input.codexHarness.model === undefined
          ? {}
          : { model: input.codexHarness.model }),
        ...(input.codexHarness.profile === undefined
          ? {}
          : { profile: input.codexHarness.profile }),
        sandbox: input.codexHarness.sandbox,
        timeoutMs: input.codexHarness.timeoutMs,
      },
    });
    if (JSON.stringify(expected) !== JSON.stringify(input.codexHarness))
      throw preflightFailure("codex", "semantic-identity");
  }
  return input;
}

export function prepareSpecRunAcceptance(
  specPathInput: typeof RuntimePathSchema.Encoded,
  options: PrepareSpecRunOptions
): Effect.Effect<
  PreparedSpecRunAcceptanceV1,
  GaiaRuntimeError,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const specPath = yield* preflight(() => {
      const decoded =
        Schema.decodeUnknownSync(RuntimePathSchema)(specPathInput);
      assertSecretSafe(decoded, "spec.path");
      return decoded;
    });
    const input = yield* fs
      .readFileString(specPath)
      .pipe(Effect.mapError(() => preflightFailure("spec", "readable-source")));
    yield* preflight(() => assertSecretSafe(input, "spec.body"));
    const fallbackTitle = path.basename(specPath, path.extname(specPath));
    const spec = yield* Effect.try({
      try: () => parseMarkdownSpec(input, fallbackTitle),
      catch: () => preflightFailure("spec", "markdown-schema"),
    });
    yield* preflight(() => {
      assertSecretSafe(spec.title, "spec.title");
      assertSecretSafe(spec.body, "spec.body");
    });
    const semantics = yield* prepareRunSemantics(options);
    return {
      ...semantics,
      input,
      spec,
      specDigest: parseSpecDigest(
        createHash("sha256").update(input).digest("hex")
      ),
      specPath,
    };
  });
}

function prepareRunSemantics(options: PrepareSpecRunOptions) {
  return Effect.gen(function* () {
    const runProfile = yield* resolveRunProfile(options.runProfileSource);
    yield* preflight(() => {
      assertSecretSafe(runProfile.name, "profile.name");
      if (runProfile.browser?.targetUrl !== undefined)
        assertCredentialFreeUrlLike(
          runProfile.browser.targetUrl,
          "profile.browser.targetUrl"
        );
    });
    const skillManifest = yield* resolveSkillManifest(
      options.skillManifestSource
    );
    yield* preflight(() => {
      if (skillManifest.skills.length > 64)
        throw preflightFailure("skills", "bounded-structure");
      for (const [index, skill] of skillManifest.skills.entries()) {
        assertSecretSafe(skill.name, `skill.${index}.name`);
        assertSecretSafe(skill.sourcePath, `skill.${index}.sourcePath`);
        assertSecretSafe(
          skill.sourceRepository,
          `skill.${index}.sourceRepository`
        );
        if (!isCredentialFreeSkillSourceRepository(skill.sourceRepository))
          throw preflightFailure(
            `skill.${index}.sourceRepository`,
            "credential-free-repository"
          );
        if (skill.version !== undefined)
          assertSecretSafe(skill.version, `skill.${index}.version`);
        if (skill.commit !== undefined)
          assertSecretSafe(skill.commit, `skill.${index}.commit`);
      }
    });
    const browserEvidenceTargetUrl = options.browserEvidenceTargetUrl;
    const explicitBrowserEvidenceTargetUrl =
      browserEvidenceTargetUrl === undefined
        ? undefined
        : yield* Effect.try({
            try: () => {
              const parsedTarget = parseBrowserEvidenceTargetUrl(
                browserEvidenceTargetUrl
              );
              return parsedTarget;
            },
            catch: () =>
              preflightFailure("browser.target", "credential-free-url"),
          });
    const workspaceSource = yield* preflight(() => {
      const source = options.workspaceSource ?? emptyWorkspaceSource();
      if (source._tag === "LocalDirectory")
        assertSecretSafe(source.path, "workspace.source.path");
      return source;
    });
    const { codexHarness, installer, processHarness } = yield* preflight(
      () => ({
        codexHarness: decodeCodexBatchSemanticConfig(options.codexHarness),
        installer: prepareSkillInstaller(options.skillInstaller, skillManifest),
        processHarness: decodeProcessHarnessSemanticConfig(
          options.processHarness
        ),
      })
    );
    return {
      browserEvidenceRequirement:
        options.browserEvidenceRequirement ?? runProfile.checks.browserEvidence,
      ...(explicitBrowserEvidenceTargetUrl === undefined
        ? {}
        : { explicitBrowserEvidenceTargetUrl }),
      ...(processHarness === undefined ? {} : { processHarness }),
      ...(codexHarness === undefined ? {} : { codexHarness }),
      installer,
      runProfile,
      skillManifest,
      workspaceSource,
    } satisfies PreparedRunSemanticsV1;
  });
}

export function deriveModelWorkspaceBinding(
  paths: RunPaths
): Effect.Effect<
  ModelWorkspaceBindingV1,
  GaiaRuntimeError,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const canonicalRunStoreRoot = yield* canonicalDirectory(fs, paths.gaiaRoot);
    const canonicalWorkspace = yield* canonicalDirectory(fs, paths.workspace);
    const expected = path.join(
      canonicalRunStoreRoot,
      "runs",
      paths.runId,
      "workspace"
    );
    const derivedRunId = yield* Effect.try({
      try: () => parseRunId(path.basename(path.dirname(canonicalWorkspace))),
      catch: (cause) =>
        makeRuntimeError({
          cause,
          code: "ModelWorkspaceBindingInvalid",
          message: "The canonical worker workspace has an invalid run shape.",
          recoverable: false,
        }),
    });
    if (canonicalWorkspace !== expected || derivedRunId !== paths.runId)
      return yield* Effect.fail(
        makeRuntimeError({
          code: "ModelWorkspaceBindingInvalid",
          message: "The canonical worker workspace has an invalid run shape.",
          recoverable: false,
        })
      );
    return ModelWorkspaceBindingV1.make({
      canonicalRunStoreRootDigest: hashText(canonicalRunStoreRoot),
      canonicalWorkspacePathDigest: hashText(canonicalWorkspace),
      runId: paths.runId,
      shape: ".gaia/runs/<runId>/workspace",
      version: 1,
      workspaceRole: "workerWorkspace",
    });
  });
}

export function verifyModelAdapterCwd(
  rawCwd: string,
  binding: ModelWorkspaceBindingV1
): Effect.Effect<void, GaiaRuntimeError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const canonical = yield* canonicalDirectory(fs, rawCwd).pipe(
      Effect.mapError((cause) =>
        makeRuntimeError({
          cause,
          code: "ModelAdapterCwdMismatch",
          message:
            "The adapter cwd does not match the accepted workspace binding.",
          recoverable: false,
        })
      )
    );
    const derivedRunId = yield* Effect.try({
      try: () => parseRunId(path.basename(path.dirname(canonical))),
      catch: () =>
        makeRuntimeError({
          code: "ModelAdapterCwdMismatch",
          message:
            "The adapter cwd does not match the accepted workspace binding.",
          recoverable: false,
        }),
    });
    if (
      derivedRunId !== binding.runId ||
      hashText(canonical) !== binding.canonicalWorkspacePathDigest
    )
      return yield* Effect.fail(
        makeRuntimeError({
          code: "ModelAdapterCwdMismatch",
          message:
            "The adapter cwd does not match the accepted workspace binding.",
          recoverable: false,
        })
      );
  });
}

function canonicalDirectory(fs: FileSystem.FileSystem, value: string) {
  return Effect.gen(function* () {
    const real = yield* fs.realPath(value).pipe(
      Effect.mapError((cause) =>
        makeRuntimeError({
          cause,
          code: "ModelWorkspaceBindingInvalid",
          message: "The accepted worker workspace could not be canonicalized.",
          recoverable: false,
        })
      )
    );
    const info = yield* fs.stat(value).pipe(
      Effect.mapError((cause) =>
        makeRuntimeError({
          cause,
          code: "ModelWorkspaceBindingInvalid",
          message: "The accepted worker workspace is unavailable.",
          recoverable: false,
        })
      )
    );
    if (info.type !== "Directory")
      return yield* Effect.fail(
        makeRuntimeError({
          code: "ModelWorkspaceBindingInvalid",
          message: "The accepted worker workspace is not a directory.",
          recoverable: false,
        })
      );
    return real;
  });
}

function hashText(value: unknown) {
  return createHash("sha256").update(decodeString(value), "utf8").digest("hex");
}

/**
 * Derive one bounded App-server input episode from the event-owned initial
 * worker context. This is intentionally limited to the four named continuation
 * roles; it does not create a general prompt/session abstraction.
 */
export function commitDerivedAppModelInvocationEpisode(input: {
  readonly episodeKey: string;
  readonly episodeRole:
    | "operatorFollowUp"
    | "operatorSteer"
    | "deliveryRemediation"
    | "workerRecovery"
    | "workerCorrelation"
    | "workerDesktopOriginCorrelation";
  readonly events: ReadonlyArray<RunEvent>;
  readonly paths: RunPaths;
  readonly runId: ReturnType<typeof parseRunId>;
  readonly taskInput: string;
}) {
  return Effect.gen(function* () {
    yield* preflight(() =>
      assertSecretSafe(input.taskInput, "model.taskInput")
    );
    const resolution = yield* Effect.try({
      try: () => resolveModelInvocationEpisodes(input.events),
      catch: (cause) =>
        makeRuntimeError({
          cause,
          code: "ModelInvocationPairConflict",
          message: "Authoritative history cannot accept this model input.",
          recoverable: false,
        }),
    });
    if (resolution.protocol === "legacyAbsent") return undefined;
    const baseEpisode = resolution.episodes.find(
      ({ start }) => start.episodeKey === "workerInitial"
    );
    if (baseEpisode === undefined)
      return yield* Effect.fail(
        makeRuntimeError({
          code: "ModelInvocationEpisodeMissing",
          message:
            "The marked run has no event-owned initial worker context for this input.",
          recoverable: false,
        })
      );
    const base = yield* loadModelInvocationPair(input.paths, baseEpisode.start);
    const baseContent = base.context.payload.content;
    const content = makeModelContextContentV1({
      acceptedOutcomes: baseContent.acceptedOutcomes,
      authority: baseContent.authority,
      budget: baseContent.budget,
      contentRefs: baseContent.contentRefs,
      episodeRole: input.episodeRole,
      instructions: baseContent.instructions,
      nonGoals: baseContent.nonGoals,
      outputContract: baseContent.outputContract,
      planningFacts: baseContent.planningFacts,
      safeExclusions: baseContent.safeExclusions,
      skills: baseContent.skills,
      stops: baseContent.stops,
      taskInput: input.taskInput,
      verificationCommands: baseContent.verificationCommands,
    });
    const rendered = renderModelInputV1(content);
    const context = makeModelContextManifestV1({
      authoritativeRefs: [
        ...base.context.payload.authoritativeRefs.slice(0, 63),
        { digest: base.context.contextDigest, kind: "baseContext" },
      ],
      binding: { episodeKey: input.episodeKey, runId: input.runId },
      content,
      workspaceBinding: base.workspaceBinding,
    });
    const invocation = makeModelInvocationManifestV1({
      acceptedProviderCapabilityObservation: "unobservable",
      adapterInputClass: "codexAppTurn",
      adapterSemantics: {
        kind: "codexAppServer",
        semanticDigest: hashText(
          "gaia.codex-app-server.on-request.ephemeral-false.workspace-write.v1"
        ),
      },
      authorityRef: base.invocation.payload.authorityRef,
      binding: context.payload.binding,
      budget: content.payload.budget,
      context,
      outputContract: content.payload.outputContract,
      rendered,
      runContractRef: base.invocation.payload.runContractRef,
      template: { id: "gaia.worker-input.v1", version: 1 },
      workspaceBinding: base.workspaceBinding,
    });
    return yield* commitModelInvocationPair({
      context,
      episodeKey: input.episodeKey,
      invocation,
      paths: input.paths,
    });
  });
}

const decodeEpisodeStart = Schema.decodeUnknownSync(
  ModelInvocationEpisodeStartV1
);
const decodeManifestRef = Schema.decodeUnknownSync(ModelManifestArtifactRefV1);
const decodeEpisodeId = Schema.decodeUnknownSync(
  ModelInvocationEpisodeIdSchema
);
const decodeModelManifestBody = Schema.decodeUnknownSync(
  ModelManifestBodySchema
);
const ModelInvocationPairCommitInputSchema = Schema.Struct({
  context: ModelContextManifestV1,
  episodeKey: ModelInvocationEpisodeStartV1.fields.episodeKey,
  invocation: ModelInvocationManifestV1,
  paths: RunPathsSchema,
});
const MakeEpisodeStartInputSchema = Schema.Struct({
  contextBody: ModelManifestBodySchema,
  contextPath: RuntimePathSchema,
  episodeId: ModelInvocationEpisodeIdSchema,
  input: ModelInvocationPairCommitInputSchema,
  invocationBody: ModelManifestBodySchema,
  invocationPath: RuntimePathSchema,
});

export function loadModelInvocationPair(
  paths: RunPaths,
  startInput: ModelInvocationEpisodeStartV1
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const start = parseModelInvocationEpisodeStart(startInput);
    const read = <A>(
      ref: ModelManifestArtifactRefV1,
      parse: (input: unknown) => A,
      encode: (value: A) => unknown
    ) =>
      Effect.gen(function* () {
        const target = parseRuntimePath(path.join(paths.root, ref.path));
        const canonicalRunRoot = yield* fs.realPath(paths.root);
        const canonicalRoot = yield* fs.realPath(paths.modelInvocations);
        const expectedRoot = path.join(canonicalRunRoot, "model-invocations");
        const episodeDirectory = path.dirname(target);
        const canonicalEpisode = yield* fs.realPath(episodeDirectory);
        const expectedEpisode = path.join(
          expectedRoot,
          path.basename(episodeDirectory)
        );
        const [runRootInfo, rootInfo, episodeInfo] = yield* Effect.all([
          fs.stat(paths.root),
          fs.stat(paths.modelInvocations),
          fs.stat(episodeDirectory),
        ]);
        if (
          runRootInfo.type !== "Directory" ||
          rootInfo.type !== "Directory" ||
          episodeInfo.type !== "Directory" ||
          canonicalRoot !== expectedRoot ||
          canonicalEpisode !== expectedEpisode
        )
          return yield* Effect.fail(
            makeRuntimeError({
              code: "ModelInvocationArtifactMismatch",
              message:
                "An event-referenced model invocation artifact has an invalid parent binding.",
              recoverable: false,
            })
          );
        const expectedReal = path.join(
          canonicalRoot,
          ref.path.slice("model-invocations/".length)
        );
        const real = yield* fs.realPath(target).pipe(
          Effect.mapError((cause) =>
            makeRuntimeError({
              cause,
              code: "ModelInvocationArtifactUnavailable",
              message:
                "An event-referenced model invocation artifact is unavailable.",
              recoverable: false,
            })
          )
        );
        const targetInfo = yield* fs.stat(target);
        if (
          !real.startsWith(`${canonicalRoot}${path.sep}`) ||
          real !== expectedReal ||
          targetInfo.type !== "File"
        )
          return yield* Effect.fail(
            makeRuntimeError({
              code: "ModelInvocationArtifactMismatch",
              message:
                "An event-referenced model invocation artifact has an invalid path binding.",
              recoverable: false,
            })
          );
        const body = yield* fs.readFileString(target);
        if (
          Buffer.byteLength(body, "utf8") !== ref.byteLength ||
          hashText(body) !== ref.bodyDigest
        )
          return yield* Effect.fail(
            makeRuntimeError({
              code: "ModelInvocationArtifactMismatch",
              message:
                "An event-referenced model invocation artifact failed its body witness.",
              recoverable: false,
            })
          );
        const value = yield* Effect.try({
          try: () => parse(JSON.parse(body)),
          catch: (cause) =>
            makeRuntimeError({
              cause,
              code: "ModelInvocationArtifactCorrupt",
              message:
                "An event-referenced model invocation artifact is not a valid manifest.",
              recoverable: false,
            }),
        });
        if (body !== `${JSON.stringify(encode(value))}\n`)
          return yield* Effect.fail(
            makeRuntimeError({
              code: "ModelInvocationArtifactEncodingMismatch",
              message:
                "An event-referenced model invocation artifact is not canonically encoded.",
              recoverable: false,
            })
          );
        return value;
      });
    const context = yield* read(
      start.contextRef,
      parseModelContextManifest,
      encodeContextManifest
    );
    const invocation = yield* read(
      start.invocationRef,
      (value) => parseModelInvocationManifest(value, context),
      encodeInvocationManifest
    );
    if (
      context.contextDigest !== start.contextRef.identityDigest ||
      invocation.invocationDigest !== start.invocationRef.identityDigest ||
      context.payload.binding.episodeKey !== start.episodeKey ||
      invocation.payload.binding.episodeKey !== start.episodeKey ||
      context.payload.binding.runId !== paths.runId ||
      invocation.payload.binding.runId !== paths.runId ||
      invocation.payload.context.contextId !== context.contextId ||
      invocation.payload.context.contextDigest !== context.contextDigest ||
      invocation.payload.context.contextContentDigest !==
        context.payload.contextContentDigest
    )
      return yield* Effect.fail(
        makeRuntimeError({
          code: "ModelInvocationArtifactMismatch",
          message:
            "The event-referenced model invocation pair failed cross-binding.",
          recoverable: false,
        })
      );
    return {
      context,
      invocation,
      rendered: invocation.payload.rendered,
      workspaceBinding: invocation.payload.workspaceBinding,
    } as const;
  }).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(
        makeRuntimeError({
          cause,
          code: "ModelInvocationArtifactUnavailable",
          message:
            "An event-referenced model invocation artifact could not be read.",
          recoverable: false,
        })
      )
    )
  );
}

function episodeRoleFromKey(episodeKey: string) {
  const role = episodeKey.split(":", 1)[0];
  return decodeEpisodeRole(role);
}

function manifestDiagnosticFromCause(cause: Cause.Cause<unknown>) {
  let code: typeof ModelManifestArtifactDiagnosticDto.Type.code =
    "ArtifactBodyUnreadable";
  for (const reason of cause.reasons) {
    if (!Cause.isFailReason(reason)) continue;
    const error = reason.error;
    if (!(error instanceof GaiaRuntimeError)) continue;
    if (error.code === "ModelInvocationPairConflict")
      code = "ArtifactPairConflict";
    else if (error.code === "ModelInvocationArtifactCorrupt")
      code = "ArtifactBodyCorrupt";
    else if (
      error.code === "ModelInvocationArtifactMismatch" ||
      error.code === "ModelInvocationArtifactEncodingMismatch"
    )
      code = "ArtifactBodyMismatch";
    else if (error.code === "ModelInvocationArtifactUnavailable")
      code = "ArtifactBodyMissing";
  }
  const messages = {
    ArtifactBodyCorrupt:
      "The event-referenced manifest body is not a valid versioned manifest.",
    ArtifactBodyMismatch:
      "The event-referenced manifest body does not match its recorded identity.",
    ArtifactBodyMissing: "The event-referenced manifest body is unavailable.",
    ArtifactBodyUnreadable:
      "The event-referenced manifest body could not be read.",
    ArtifactPairConflict:
      "The event-referenced manifest pair conflicts with authoritative history.",
  } as const;
  return ModelManifestArtifactDiagnosticDto.make({
    code,
    message: messages[code],
    recoverable: false,
  });
}

/** Build a bounded read projection exclusively from event-owned manifest references. */
export function inspectModelInvocationArtifacts(
  paths: RunPaths,
  events: ReadonlyArray<RunEvent>
) {
  return Effect.gen(function* () {
    const resolution = yield* Effect.try({
      try: () => resolveModelInvocationEpisodes(events),
      catch: (cause) =>
        makeRuntimeError({
          cause,
          code: "ModelInvocationPairConflict",
          message:
            "Authoritative events contain conflicting model invocation references.",
          recoverable: false,
        }),
    });
    if (resolution.protocol === "legacyAbsent") return [];
    const items: Array<typeof LocalRunModelManifestArtifactDto.Type> = [];
    for (const episode of resolution.episodes) {
      const loaded = yield* Effect.exit(
        loadModelInvocationPair(paths, episode.start)
      );
      const diagnostic =
        loaded._tag === "Failure"
          ? manifestDiagnosticFromCause(loaded.cause)
          : undefined;
      const episodeId = episode.start.contextRef.path.split("/")[1];
      if (episodeId === undefined)
        return yield* Effect.fail(modelPairConflict());
      for (const ref of [
        episode.start.contextRef,
        episode.start.invocationRef,
      ]) {
        const manifestId =
          ref.kind === "modelContextManifest"
            ? `mctx1_${ref.identityDigest}`
            : `minv1_${ref.identityDigest}`;
        items.push(
          decodeModelManifestArtifact({
            artifactId: ref.artifactId,
            availability:
              diagnostic === undefined ? "available" : "unavailable",
            bodyDigest: ref.bodyDigest,
            byteLength: ref.byteLength,
            contentType: "application/json",
            ...(diagnostic === undefined ? {} : { diagnostic }),
            episodeId,
            episodeRole: episodeRoleFromKey(episode.start.episodeKey),
            identityDigest: ref.identityDigest,
            manifestId,
            manifestKind: ref.kind,
            version: 1,
          })
        );
      }
    }
    return items;
  });
}

export function readModelInvocationArtifactBody(
  paths: RunPaths,
  events: ReadonlyArray<RunEvent>,
  artifactId: string
) {
  return Effect.gen(function* () {
    const resolution = yield* Effect.try({
      try: () => resolveModelInvocationEpisodes(events),
      catch: () => modelPairConflict(),
    });
    if (resolution.protocol === "legacyAbsent") return Option.none();
    for (const episode of resolution.episodes) {
      const ref = [episode.start.contextRef, episode.start.invocationRef].find(
        (candidate) => candidate.artifactId === artifactId
      );
      if (ref === undefined) continue;
      yield* loadModelInvocationPair(paths, episode.start);
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const body = yield* fs.readFileString(path.join(paths.root, ref.path));
      return Option.some({ body, ref });
    }
    return Option.none();
  }).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(
        makeRuntimeError({
          cause,
          code: "ModelInvocationArtifactUnavailable",
          message:
            "An event-referenced model invocation artifact could not be read.",
          recoverable: false,
        })
      )
    )
  );
}

export function commitModelInvocationPair(
  input: typeof ModelInvocationPairCommitInputSchema.Type
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const episodeId = decodeEpisodeId(
        `episode1_${hashText(`${input.paths.runId}\0${input.episodeKey}`)}`
      );
      const directory = parseRuntimePath(
        path.join(input.paths.modelInvocations, episodeId)
      );
      const contextPath = parseRuntimePath(
        path.join(directory, "context-manifest.json")
      );
      const invocationPath = parseRuntimePath(
        path.join(directory, "invocation-manifest.json")
      );
      const reservationPath = parseRuntimePath(
        path.join(
          input.paths.modelInvocations,
          `.${episodeId}.reservation.json`
        )
      );
      const contextBody = decodeModelManifestBody(
        `${JSON.stringify(encodeContextManifest(input.context))}\n`
      );
      const invocationBody = decodeModelManifestBody(
        `${JSON.stringify(encodeInvocationManifest(input.invocation))}\n`
      );
      const reservationBody = `${JSON.stringify({
        episodeId,
        episodeKey: input.episodeKey,
        runId: input.paths.runId,
        version: 1,
      })}\n`;
      const canonicalRunRoot = yield* fs.realPath(input.paths.root);
      if ((yield* fs.stat(input.paths.root)).type !== "Directory")
        return yield* Effect.fail(modelPairConflict());
      const expectedManifestRoot = path.join(
        canonicalRunRoot,
        "model-invocations"
      );
      if (!(yield* fs.exists(input.paths.modelInvocations)))
        yield* fs.makeDirectory(input.paths.modelInvocations);
      if (
        (yield* fs.realPath(input.paths.modelInvocations)) !==
          expectedManifestRoot ||
        (yield* fs.stat(input.paths.modelInvocations)).type !== "Directory"
      )
        return yield* Effect.fail(modelPairConflict());
      const expectedDirectory = path.join(expectedManifestRoot, episodeId);
      if (!(yield* fs.exists(directory))) yield* fs.makeDirectory(directory);
      if (
        (yield* fs.realPath(directory)) !== expectedDirectory ||
        (yield* fs.stat(directory)).type !== "Directory"
      )
        return yield* Effect.fail(modelPairConflict());
      const existingContext = yield* fs.exists(contextPath);
      const existingInvocation = yield* fs.exists(invocationPath);
      if (existingContext || existingInvocation) {
        if (!(existingContext && existingInvocation))
          return yield* Effect.fail(modelPairConflict());
        const [recordedContext, recordedInvocation] = yield* Effect.all([
          fs.readFileString(contextPath),
          fs.readFileString(invocationPath),
        ]);
        if (
          recordedContext !== contextBody ||
          recordedInvocation !== invocationBody
        )
          return yield* Effect.fail(modelPairConflict());
        yield* verifyCanonicalModelFile(
          fs,
          reservationPath,
          path.join(expectedManifestRoot, path.basename(reservationPath)),
          reservationBody
        );
        const start = makeEpisodeStart({
          contextBody,
          contextPath,
          episodeId,
          input,
          invocationBody,
          invocationPath,
        });
        yield* loadModelInvocationPair(input.paths, start);
        return start;
      }
      const staging = yield* fs.makeTempDirectoryScoped({
        directory: input.paths.root,
        prefix: ".model-invocation-staging-",
      });
      const stagedReservation = path.join(staging, "reservation.json");
      const stagedContext = path.join(staging, "context.json");
      const stagedInvocation = path.join(staging, "invocation.json");
      yield* writeSyncedExclusive(fs, stagedReservation, reservationBody);
      yield* writeSyncedExclusive(fs, stagedContext, contextBody);
      yield* writeSyncedExclusive(fs, stagedInvocation, invocationBody);
      yield* fs
        .link(stagedReservation, reservationPath)
        .pipe(Effect.catchTag("PlatformError", () => Effect.void));
      yield* verifyCanonicalModelFile(
        fs,
        reservationPath,
        path.join(expectedManifestRoot, path.basename(reservationPath)),
        reservationBody
      );
      yield* fs
        .link(stagedContext, contextPath)
        .pipe(Effect.mapError(() => modelPairConflict()));
      yield* fs
        .link(stagedInvocation, invocationPath)
        .pipe(Effect.mapError(() => modelPairConflict()));
      yield* verifyCanonicalModelFile(
        fs,
        reservationPath,
        path.join(expectedManifestRoot, path.basename(reservationPath)),
        reservationBody
      );
      const start = makeEpisodeStart({
        contextBody,
        contextPath,
        episodeId,
        input,
        invocationBody,
        invocationPath,
      });
      yield* loadModelInvocationPair(input.paths, start);
      return start;
    })
  ).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(
        makeRuntimeError({
          cause,
          code: "ModelInvocationPairPersistenceFailed",
          message: "The model invocation manifest pair could not be committed.",
          recoverable: false,
        })
      )
    )
  );
}

function verifyCanonicalModelFile(
  fs: FileSystem.FileSystem,
  target: string,
  expectedRealPath: string,
  expectedBody: string
) {
  return Effect.gen(function* () {
    const info = yield* Effect.tryPromise({
      try: () => lstat(target),
      catch: () => modelPairConflict(),
    });
    const real = yield* fs
      .realPath(target)
      .pipe(Effect.mapError(() => modelPairConflict()));
    const body = yield* fs
      .readFileString(target)
      .pipe(Effect.mapError(() => modelPairConflict()));
    if (
      info.isSymbolicLink() ||
      !info.isFile() ||
      real !== expectedRealPath ||
      body !== expectedBody
    )
      return yield* Effect.fail(modelPairConflict());
  });
}

function writeSyncedExclusive(
  fs: FileSystem.FileSystem,
  target: string,
  body: string
) {
  return Effect.gen(function* () {
    const file = yield* fs.open(target, { flag: "wx", mode: 0o600 });
    yield* file.writeAll(new TextEncoder().encode(body));
    yield* file.sync;
  });
}

function makeEpisodeStart(input: typeof MakeEpisodeStartInputSchema.Type) {
  const ref = (
    kind: "modelContextManifest" | "modelInvocationManifest",
    identityDigest: typeof SafeDigestSchema.Type,
    body: typeof ModelManifestBodySchema.Type,
    target: typeof RuntimePathSchema.Type
  ) =>
    decodeManifestRef({
      artifactId: `mmf1_${hashText(`${kind}\0${identityDigest}`)}`,
      bodyDigest: hashText(body),
      byteLength: Buffer.byteLength(body, "utf8"),
      episodeKey: input.input.episodeKey,
      identityDigest,
      kind,
      path: `model-invocations/${input.episodeId}/${target.split("/").at(-1)}`,
      runId: input.input.paths.runId,
      version: 1,
    });
  return decodeEpisodeStart({
    contextRef: ref(
      "modelContextManifest",
      input.input.context.contextDigest,
      input.contextBody,
      input.contextPath
    ),
    episodeKey: input.input.episodeKey,
    invocationRef: ref(
      "modelInvocationManifest",
      input.input.invocation.invocationDigest,
      input.invocationBody,
      input.invocationPath
    ),
    version: 1,
  });
}

function modelPairConflict() {
  return makeRuntimeError({
    code: "ModelInvocationPairConflict",
    message:
      "The model invocation episode is already bound to different state.",
    recoverable: false,
  });
}
