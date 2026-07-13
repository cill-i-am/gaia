import { execFile } from "node:child_process";

import { Effect, FileSystem, Path, Schema } from "effect";

import { makeRuntimeError, type GaiaRuntimeError } from "./errors.js";
import type { RunPaths } from "./paths.js";
import {
  SkillManifest,
  SkillNameSchema,
  type SkillManifestEntry,
  type SkillManifestSource,
} from "./skill-manifest.js";

export const SkillBundleResolutionSchema = Schema.Literals([
  "external",
  "installed",
  "local",
] as const);

export type SkillBundleResolution = typeof SkillBundleResolutionSchema.Type;

export const SkillBundleStatusSchema = Schema.Literals([
  "empty",
  "ready",
  "requires-install",
] as const);

export type SkillBundleStatus = typeof SkillBundleStatusSchema.Type;

export class SkillBundleEntry extends Schema.Class<SkillBundleEntry>(
  "SkillBundleEntry"
)({
  commit: Schema.optionalKey(Schema.NonEmptyString),
  name: SkillNameSchema,
  resolution: SkillBundleResolutionSchema,
  resolvedPath: Schema.optionalKey(Schema.NonEmptyString),
  sourcePath: Schema.NonEmptyString,
  sourceRepository: Schema.NonEmptyString,
  version: Schema.optionalKey(Schema.NonEmptyString),
}) {}

export class SkillBundle extends Schema.Class<SkillBundle>("SkillBundle")({
  skills: Schema.Array(SkillBundleEntry),
  status: SkillBundleStatusSchema,
  version: Schema.Literal(1),
}) {}

const SkillBundleJson = Schema.toCodecJson(SkillBundle);
const encodeSkillBundleJson = Schema.encodeSync(SkillBundleJson);
export const parseSkillBundleJson = Schema.decodeUnknownSync(SkillBundleJson);

const defaultSkillInstallCommand = "git";
const skillInstallCommandMaxBufferBytes = 10 * 1024 * 1024;

export type SkillInstallCommandInput = {
  readonly args: ReadonlyArray<string>;
  readonly command: string;
  readonly cwd: string;
};

export type SkillInstallCommandResult = {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
};

export type SkillInstallCommandRunner = (
  input: SkillInstallCommandInput
) => Effect.Effect<SkillInstallCommandResult, GaiaRuntimeError>;

export type SkillInstallerOptions = {
  readonly command?: string;
  readonly commandRunner?: SkillInstallCommandRunner;
};

export const nodeSkillInstallCommandRunner: SkillInstallCommandRunner = (
  input
) =>
  Effect.tryPromise({
    try: () =>
      new Promise<SkillInstallCommandResult>((resolve, reject) => {
        execFile(
          input.command,
          [...input.args],
          {
            cwd: input.cwd,
            maxBuffer: skillInstallCommandMaxBufferBytes,
          },
          (error, stdout, stderr) => {
            if (error !== null && error.code === undefined) {
              reject(error);
              return;
            }

            resolve({
              exitCode: normalizeExitCode(error?.code),
              stderr: String(stderr),
              stdout: String(stdout),
            });
          }
        );
      }),
    catch: (cause) =>
      makeRuntimeError({
        cause,
        code: "SkillBundleInstallCommandFailed",
        message: `${input.command} ${input.args.join(" ")} failed.`,
        recoverable: true,
      }),
  });

export function writeSkillBundle(input: {
  readonly installer?: SkillInstallerOptions;
  readonly manifest: SkillManifest;
  readonly paths: RunPaths;
  readonly source?: SkillManifestSource;
}): Effect.Effect<
  SkillBundle,
  GaiaRuntimeError,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const entries: Array<SkillBundleEntry> = [];

    for (const [index, skill] of input.manifest.skills.entries()) {
      entries.push(
        yield* resolveSkillBundleEntry({
          index,
          installer: input.installer,
          paths: input.paths,
          skill,
          source: input.source,
        })
      );
    }

    const bundle = SkillBundle.make({
      skills: entries,
      status: skillBundleStatus(entries),
      version: 1,
    });

    yield* fs.writeFileString(
      input.paths.skillBundle,
      `${JSON.stringify(encodeSkillBundleJson(bundle), null, 2)}\n`
    );

    return bundle;
  }).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(
        makeRuntimeError({
          cause,
          code: "SkillBundleWriteFailed",
          message: "Gaia could not write the skill bundle artifact.",
          recoverable: false,
        })
      )
    )
  );
}

export function resolvedSkillPaths(bundle: SkillBundle): ReadonlyArray<string> {
  return bundle.skills.flatMap((skill) =>
    skill.resolvedPath === undefined ? [] : [skill.resolvedPath]
  );
}

function resolveSkillBundleEntry(input: {
  readonly index: number;
  readonly installer: SkillInstallerOptions | undefined;
  readonly paths: RunPaths;
  readonly skill: SkillManifestEntry;
  readonly source: SkillManifestSource | undefined;
}) {
  const { skill } = input;

  return isLocalSkillSource(skill.sourceRepository)
    ? resolveLocalSkillBundleEntry(skill, input.source)
    : resolveExternalSkillBundleEntry(input);
}

function resolveExternalSkillBundleEntry(input: {
  readonly index: number;
  readonly installer: SkillInstallerOptions | undefined;
  readonly paths: RunPaths;
  readonly skill: SkillManifestEntry;
}) {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const runner =
      input.installer?.commandRunner ?? nodeSkillInstallCommandRunner;
    const command = input.installer?.command ?? defaultSkillInstallCommand;
    const repositoryUrl = yield* resolveRepositoryCloneUrl(input.skill);
    const installDirectory = path.join(
      input.paths.skillInstallRoot,
      `${input.index}-${safeSkillDirectoryName(input.skill.name)}`
    );
    const repositoryDirectory = path.join(installDirectory, "repository");
    const checkoutRef = input.skill.commit ?? input.skill.version;

    if (checkoutRef === undefined) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "SkillBundleEntryUnpinned",
          message: `Skill '${input.skill.name}' must pin either commit or version before installation.`,
          recoverable: false,
        })
      );
    }

    if (path.isAbsolute(input.skill.sourcePath)) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "SkillBundleExternalSourcePathAbsolute",
          message: `Skill '${input.skill.name}' external sourcePath must be relative to the checked out repository.`,
          recoverable: false,
        })
      );
    }

    yield* fs.makeDirectory(installDirectory, { recursive: true }).pipe(
      Effect.catchTag("PlatformError", (cause) =>
        Effect.fail(
          makeRuntimeError({
            cause,
            code: "SkillBundleInstallDirectoryFailed",
            message: `Gaia could not create the install directory for skill '${input.skill.name}'.`,
            recoverable: false,
          })
        )
      )
    );
    yield* runSkillInstallCommand(
      {
        args: ["clone", repositoryUrl, repositoryDirectory],
        command,
        cwd: input.paths.root,
      },
      input.skill,
      runner
    );
    yield* runSkillInstallCommand(
      {
        args: ["-C", repositoryDirectory, "checkout", checkoutRef],
        command,
        cwd: input.paths.root,
      },
      input.skill,
      runner
    );

    const resolvedPath = path.join(repositoryDirectory, input.skill.sourcePath);
    yield* validateSkillDirectory(input.skill, resolvedPath);

    return SkillBundleEntry.make({
      ...(input.skill.commit === undefined
        ? {}
        : { commit: input.skill.commit }),
      name: input.skill.name,
      resolution: "installed",
      resolvedPath,
      sourcePath: input.skill.sourcePath,
      sourceRepository: input.skill.sourceRepository,
      ...(input.skill.version === undefined
        ? {}
        : { version: input.skill.version }),
    });
  });
}

function resolveRepositoryCloneUrl(skill: SkillManifestEntry) {
  if (skill.sourceRepository.startsWith("github.com/")) {
    const suffix = skill.sourceRepository.endsWith(".git") ? "" : ".git";
    return Effect.succeed(`https://${skill.sourceRepository}${suffix}`);
  }

  if (
    skill.sourceRepository.startsWith("https://") ||
    skill.sourceRepository.startsWith("http://") ||
    skill.sourceRepository.startsWith("git@")
  ) {
    return Effect.succeed(skill.sourceRepository);
  }

  return Effect.fail(
    makeRuntimeError({
      code: "SkillBundleRepositoryUnsupported",
      message: `Skill '${skill.name}' source repository '${skill.sourceRepository}' is not a supported git repository reference.`,
      recoverable: false,
    })
  );
}

function runSkillInstallCommand(
  input: SkillInstallCommandInput,
  skill: SkillManifestEntry,
  runner: SkillInstallCommandRunner
) {
  return Effect.gen(function* () {
    const result = yield* runner(input);

    if (result.exitCode !== 0) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "SkillBundleInstallCommandFailed",
          message: `Skill '${skill.name}' install command '${input.command} ${input.args.join(" ")}' exited with code ${result.exitCode}.`,
          recoverable: true,
        })
      );
    }

    return result;
  });
}

function resolveLocalSkillBundleEntry(
  skill: SkillManifestEntry,
  source: SkillManifestSource | undefined
) {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const manifestDirectory =
      source === undefined ? "." : path.dirname(source.path);
    const resolvedPath = path.isAbsolute(skill.sourcePath)
      ? skill.sourcePath
      : path.resolve(manifestDirectory, skill.sourcePath);
    yield* validateSkillDirectory(skill, resolvedPath);

    return SkillBundleEntry.make({
      ...(skill.commit === undefined ? {} : { commit: skill.commit }),
      name: skill.name,
      resolution: "local",
      resolvedPath,
      sourcePath: skill.sourcePath,
      sourceRepository: skill.sourceRepository,
      ...(skill.version === undefined ? {} : { version: skill.version }),
    });
  });
}

function validateSkillDirectory(
  skill: SkillManifestEntry,
  resolvedPath: string
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const skillInfo = yield* fs.stat(resolvedPath).pipe(
      Effect.catchTag("PlatformError", (cause) =>
        Effect.fail(
          makeRuntimeError({
            cause,
            code: "SkillBundleSourceUnavailable",
            message: `Skill '${skill.name}' source '${resolvedPath}' is not available.`,
            recoverable: false,
          })
        )
      )
    );

    if (skillInfo.type !== "Directory") {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "SkillBundleSourceNotDirectory",
          message: `Skill '${skill.name}' source '${resolvedPath}' must be a directory.`,
          recoverable: false,
        })
      );
    }

    const skillMarkdownPath = path.join(resolvedPath, "SKILL.md");
    const hasSkillMarkdown = yield* fs.exists(skillMarkdownPath);
    if (!hasSkillMarkdown) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "SkillBundleSkillMarkdownMissing",
          message: `Skill '${skill.name}' source '${resolvedPath}' must contain SKILL.md.`,
          recoverable: false,
        })
      );
    }
  });
}

function skillBundleStatus(
  entries: ReadonlyArray<SkillBundleEntry>
): SkillBundleStatus {
  if (entries.length === 0) {
    return "empty";
  }

  return entries.some((entry) => entry.resolution === "external")
    ? "requires-install"
    : "ready";
}

function isLocalSkillSource(sourceRepository: string) {
  return sourceRepository === "local" || sourceRepository === "file";
}

function safeSkillDirectoryName(name: string) {
  return name.replace(/[^A-Za-z0-9._-]+/gu, "_");
}

function normalizeExitCode(code: number | string | null | undefined) {
  return typeof code === "number" ? code : code === undefined ? 0 : 1;
}
