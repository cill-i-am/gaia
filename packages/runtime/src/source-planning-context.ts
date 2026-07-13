import path from "node:path";

import type { RunSpec } from "@gaia/core";
import { Effect, FileSystem, Schema } from "effect";

export class WorkerPlanAgentInstruction extends Schema.Class<WorkerPlanAgentInstruction>(
  "WorkerPlanAgentInstruction"
)({
  path: Schema.NonEmptyString,
  scope: Schema.NonEmptyString,
  summary: Schema.NonEmptyString,
}) {}

export class WorkerPlanLikelyFile extends Schema.Class<WorkerPlanLikelyFile>(
  "WorkerPlanLikelyFile"
)({
  owner: Schema.NonEmptyString,
  path: Schema.NonEmptyString,
  reason: Schema.NonEmptyString,
}) {}

export class WorkerPlanWorkspacePackage extends Schema.Class<WorkerPlanWorkspacePackage>(
  "WorkerPlanWorkspacePackage"
)({
  name: Schema.NonEmptyString,
  path: Schema.NonEmptyString,
  reason: Schema.NonEmptyString,
  scripts: Schema.Array(Schema.NonEmptyString),
}) {}

export class WorkerPlanSourceDoc extends Schema.Class<WorkerPlanSourceDoc>(
  "WorkerPlanSourceDoc"
)({
  path: Schema.NonEmptyString,
  reason: Schema.NonEmptyString,
}) {}

export class WorkerPlanSimilarTest extends Schema.Class<WorkerPlanSimilarTest>(
  "WorkerPlanSimilarTest"
)({
  path: Schema.NonEmptyString,
  reason: Schema.NonEmptyString,
}) {}

export class WorkerPlanPlanningContext extends Schema.Class<WorkerPlanPlanningContext>(
  "WorkerPlanPlanningContext"
)({
  agentInstructions: Schema.Array(WorkerPlanAgentInstruction),
  likelyFiles: Schema.Array(WorkerPlanLikelyFile),
  outOfScopeTraps: Schema.Array(Schema.NonEmptyString),
  packages: Schema.Array(WorkerPlanWorkspacePackage),
  similarTests: Schema.Array(WorkerPlanSimilarTest),
  sourceDocs: Schema.Array(WorkerPlanSourceDoc),
  verificationSeams: Schema.Array(Schema.NonEmptyString),
}) {}

type PlanningDomainReference = {
  readonly kind: string;
  readonly value: string;
};

type PlanningVerificationCheck = {
  readonly command?: string | undefined;
  readonly expectation: string;
};

type SourcePlanningContextInput = {
  readonly domainReferences: ReadonlyArray<PlanningDomainReference>;
  readonly nonGoals: ReadonlyArray<string>;
  readonly spec: RunSpec;
  readonly verificationChecks: ReadonlyArray<PlanningVerificationCheck>;
  readonly workspaceRoot: string;
};

type RankedPath = {
  readonly matchedTokens: ReadonlyArray<string>;
  readonly path: string;
  readonly score: number;
};

type PackageManifest = {
  readonly directory: string;
  readonly name: string;
  readonly path: string;
  readonly scripts: ReadonlyArray<string>;
};

const PackageJson = Schema.Struct({
  name: Schema.optionalKey(Schema.NonEmptyString),
  scripts: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});
const decodePackageJson = Schema.decodeUnknownSync(PackageJson);
const sourceRoots = ["apps", "packages", "docs"] as const;
const ignoredPathSegments = new Set([
  ".git",
  ".gaia",
  ".turbo",
  "dist",
  "node_modules",
]);
const importantTokens = new Set([
  "agent",
  "api",
  "artifact",
  "auth",
  "check",
  "cleanup",
  "cli",
  "command",
  "context",
  "core",
  "dashboard",
  "doc",
  "effect",
  "evidence",
  "factory",
  "github",
  "http",
  "httpapi",
  "linear",
  "merge",
  "package",
  "plan",
  "planning",
  "promotion",
  "read",
  "report",
  "route",
  "run",
  "runtime",
  "schema",
  "server",
  "sqlite",
  "test",
  "verification",
  "workspace",
]);
const weakTokens = new Set([
  "add",
  "and",
  "before",
  "continue",
  "does",
  "for",
  "from",
  "gaia",
  "into",
  "keep",
  "local",
  "make",
  "not",
  "raw",
  "should",
  "source",
  "stay",
  "the",
  "this",
  "with",
]);

export function buildSourcePlanningContext(
  input: SourcePlanningContextInput
): Effect.Effect<WorkerPlanPlanningContext, never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const files = yield* listWorkspaceFiles(fs, input.workspaceRoot);
    const profile = sourceProfile(input);
    const packageManifests = yield* readPackageManifests(
      fs,
      input.workspaceRoot,
      files,
      profile
    );
    const likelyFiles = rankImplementationFiles(files, profile)
      .slice(0, 12)
      .map((ranked) =>
        WorkerPlanLikelyFile.make({
          owner: ownerForPath(ranked.path, packageManifests),
          path: ranked.path,
          reason: reasonFromRankedPath(ranked),
        })
      );
    const similarTests = (yield* rankTextFiles(
      fs,
      input.workspaceRoot,
      files.filter(isTestFile),
      profile
    ))
      .slice(0, 12)
      .map((ranked) =>
        WorkerPlanSimilarTest.make({
          path: ranked.path,
          reason: reasonFromRankedPath(ranked),
        })
      );
    const sourceDocs = (yield* rankTextFiles(
      fs,
      input.workspaceRoot,
      files.filter(isSourceDoc),
      profile
    ))
      .slice(0, 8)
      .map((ranked) =>
        WorkerPlanSourceDoc.make({
          path: ranked.path,
          reason: reasonFromRankedPath(ranked),
        })
      );
    const likelyFilePaths = likelyFiles.map((file) => file.path);
    const instructionSourcePaths = [
      ...likelyFilePaths,
      ...sourceDocs.map((doc) => doc.path),
    ];
    const agentInstructions = yield* readRelevantAgentInstructions(
      fs,
      input.workspaceRoot,
      files,
      instructionSourcePaths,
      profile
    );
    const packages = packageManifests
      .filter((manifest) =>
        packageIsRelevant(manifest, likelyFilePaths, profile)
      )
      .map((manifest) =>
        WorkerPlanWorkspacePackage.make({
          name: manifest.name,
          path: manifest.path,
          reason: packageReason(manifest, likelyFilePaths, profile),
          scripts: [...manifest.scripts],
        })
      );

    return WorkerPlanPlanningContext.make({
      agentInstructions,
      likelyFiles,
      outOfScopeTraps: outOfScopeTraps(input.nonGoals, agentInstructions),
      packages,
      similarTests,
      sourceDocs,
      verificationSeams: verificationSeams(
        similarTests,
        input.verificationChecks
      ),
    });
  });
}

function sourceProfile(input: SourcePlanningContextInput) {
  const explicitPaths = new Set<string>();
  for (const reference of input.domainReferences) {
    if (reference.kind === "file-path") {
      explicitPaths.add(normalizeRelativePath(reference.value));
    }
  }

  return {
    explicitPaths,
    tokens: tokenSet(
      [
        input.spec.title,
        input.spec.body,
        ...input.domainReferences.map((reference) => reference.value),
        ...input.verificationChecks.map((check) => check.expectation),
      ].join("\n")
    ),
  };
}

function rankImplementationFiles(
  files: ReadonlyArray<string>,
  profile: ReturnType<typeof sourceProfile>
): ReadonlyArray<RankedPath> {
  return files
    .filter(isImplementationFile)
    .map((candidate) =>
      rankedPath(
        candidate,
        profile,
        tokenSet(candidate),
        pathBaseScore(candidate)
      )
    )
    .filter((ranked) => ranked.score > 0)
    .sort(compareRankedPaths);
}

function rankTextFiles(
  fs: FileSystem.FileSystem,
  workspaceRoot: string,
  candidates: ReadonlyArray<string>,
  profile: ReturnType<typeof sourceProfile>
): Effect.Effect<ReadonlyArray<RankedPath>, never> {
  return Effect.gen(function* () {
    const ranked: Array<RankedPath> = [];
    for (const candidate of candidates) {
      const body = yield* readOptionalFileString(fs, workspaceRoot, candidate);
      const contentTokens = tokenSet([candidate, body ?? ""].join("\n"));
      const score = pathBaseScore(candidate);
      const pathRank = rankedPath(candidate, profile, contentTokens, score);
      if (pathRank.score > 0) {
        ranked.push(pathRank);
      }
    }

    return ranked.sort(compareRankedPaths);
  });
}

function rankedPath(
  candidate: string,
  profile: ReturnType<typeof sourceProfile>,
  candidateTokens: ReadonlySet<string>,
  baseScore: number
): RankedPath {
  const matchedTokens = [...profile.tokens]
    .filter((token) => candidateTokens.has(token))
    .sort();
  const explicitScore = profile.explicitPaths.has(candidate) ? 50 : 0;
  const ownerScore =
    (profile.tokens.has("server") && candidate.startsWith("apps/server/")) ||
    (profile.tokens.has("cli") && candidate.startsWith("apps/cli/")) ||
    (profile.tokens.has("runtime") &&
      candidate.startsWith("packages/runtime/")) ||
    (profile.tokens.has("core") && candidate.startsWith("packages/core/"))
      ? 8
      : 0;
  const relevanceScore = explicitScore + ownerScore + matchedTokens.length;
  const score = relevanceScore === 0 ? 0 : relevanceScore * 10 + baseScore;

  return {
    matchedTokens,
    path: candidate,
    score,
  };
}

function compareRankedPaths(left: RankedPath, right: RankedPath) {
  if (left.score !== right.score) {
    return right.score - left.score;
  }

  return left.path.localeCompare(right.path);
}

function pathBaseScore(candidate: string) {
  const tokens = tokenSet(candidate);
  let score = 0;

  for (const token of tokens) {
    if (importantTokens.has(token)) {
      score += 2;
    }
  }

  if (candidate.includes("/src/")) {
    score += 1;
  }
  if (candidate.endsWith(".test.ts")) {
    score += 1;
  }

  return score;
}

function reasonFromRankedPath(ranked: RankedPath) {
  if (ranked.matchedTokens.length === 0) {
    return "Selected from explicit source references.";
  }

  return `Matches planning terms: ${ranked.matchedTokens.slice(0, 6).join(", ")}.`;
}

function packageReason(
  manifest: PackageManifest,
  selectedPaths: ReadonlyArray<string>,
  profile: ReturnType<typeof sourceProfile>
) {
  if (packageOwnsSelectedPath(manifest, selectedPaths)) {
    return "Owns one or more likely files.";
  }

  const matchedTokens = [
    ...tokenSet([manifest.name, manifest.directory].join(" ")),
  ]
    .filter((token) => profile.tokens.has(token))
    .sort();

  return matchedTokens.length === 0
    ? "Package manifest is available for dependency and script context."
    : `Package manifest matches planning terms: ${matchedTokens.join(", ")}.`;
}

function packageIsRelevant(
  manifest: PackageManifest,
  selectedPaths: ReadonlyArray<string>,
  profile: ReturnType<typeof sourceProfile>
) {
  if (packageOwnsSelectedPath(manifest, selectedPaths)) {
    return true;
  }

  const manifestTokens = tokenSet(
    [manifest.name, manifest.directory].join(" ")
  );
  for (const token of profile.tokens) {
    if (manifestTokens.has(token)) {
      return true;
    }
  }

  return false;
}

function packageOwnsSelectedPath(
  manifest: PackageManifest,
  selectedPaths: ReadonlyArray<string>
) {
  return selectedPaths.some((selectedPath) =>
    pathIsUnderDirectory(selectedPath, manifest.directory)
  );
}

function pathIsUnderDirectory(relativePath: string, directory: string) {
  return directory !== "." && relativePath.startsWith(`${directory}/`);
}

function ownerForPath(
  relativePath: string,
  manifests: ReadonlyArray<PackageManifest>
) {
  const owner = manifests.find((manifest) =>
    pathIsUnderDirectory(relativePath, manifest.directory)
  );
  if (owner !== undefined) {
    return owner.name;
  }

  if (relativePath.startsWith("docs/")) {
    return "docs/AGENTS.md";
  }

  return nearestInstructionPath(relativePath) ?? "AGENTS.md";
}

function verificationSeams(
  similarTests: ReadonlyArray<WorkerPlanSimilarTest>,
  verificationChecks: ReadonlyArray<PlanningVerificationCheck>
) {
  return uniqueStrings([
    ...similarTests.map((test) => verificationSeamForTest(test.path)),
    ...verificationChecks.map((check) =>
      check.command === undefined
        ? check.expectation
        : `${check.command} verifies: ${check.expectation}`
    ),
  ]);
}

function verificationSeamForTest(testPath: string) {
  if (testPath === "apps/server/src/api.test.ts") {
    return "apps/server/src/api.test.ts exercises server API behavior.";
  }
  if (testPath === "apps/cli/src/main.test.ts") {
    return "apps/cli/src/main.test.ts exercises CLI behavior.";
  }
  if (testPath === "packages/core/src/server-api.test.ts") {
    return "packages/core/src/server-api.test.ts exercises core server API contracts.";
  }
  if (testPath === "packages/runtime/src/runtime.test.ts") {
    return "packages/runtime/src/runtime.test.ts exercises runtime workflow behavior.";
  }

  return `${testPath} exercises nearby behavior.`;
}

function outOfScopeTraps(
  nonGoals: ReadonlyArray<string>,
  agentInstructions: ReadonlyArray<WorkerPlanAgentInstruction>
) {
  const instructionTraps = agentInstructions.flatMap((instruction) =>
    instruction.summary
      .split(/(?<=\.)\s+/u)
      .filter((sentence) =>
        /\bdo not\b|\bavoid\b|\bout of scope\b/iu.test(sentence)
      )
  );

  return uniqueStrings([...nonGoals, ...instructionTraps]).slice(0, 12);
}

function readRelevantAgentInstructions(
  fs: FileSystem.FileSystem,
  workspaceRoot: string,
  files: ReadonlyArray<string>,
  selectedPaths: ReadonlyArray<string>,
  profile: ReturnType<typeof sourceProfile>
): Effect.Effect<ReadonlyArray<WorkerPlanAgentInstruction>, never> {
  return Effect.gen(function* () {
    const available = new Set(
      files.filter((file) => file.endsWith("AGENTS.md"))
    );
    const selected = new Set<string>();
    if (available.has("AGENTS.md")) {
      selected.add("AGENTS.md");
    }

    for (const selectedPath of selectedPaths) {
      for (const instructionPath of instructionPathsFor(
        selectedPath,
        available
      )) {
        selected.add(instructionPath);
      }
    }

    const instructions: Array<WorkerPlanAgentInstruction> = [];
    for (const instructionPath of [...selected].sort(compareInstructionPaths)) {
      const body = yield* readOptionalFileString(
        fs,
        workspaceRoot,
        instructionPath
      );
      if (body === undefined) {
        continue;
      }

      instructions.push(
        WorkerPlanAgentInstruction.make({
          path: instructionPath,
          scope: instructionScope(instructionPath),
          summary: summarizeInstruction(body, profile),
        })
      );
    }

    return instructions;
  });
}

function instructionPathsFor(
  relativePath: string,
  available: ReadonlySet<string>
) {
  const paths: Array<string> = [];
  const segments = relativePath
    .split("/")
    .filter((segment) => segment.length > 0);

  for (let index = 1; index < segments.length; index += 1) {
    const instructionPath = `${segments.slice(0, index).join("/")}/AGENTS.md`;
    if (available.has(instructionPath)) {
      paths.push(instructionPath);
    }
  }

  return paths;
}

function compareInstructionPaths(left: string, right: string) {
  if (left === "AGENTS.md") {
    return -1;
  }
  if (right === "AGENTS.md") {
    return 1;
  }

  return left.localeCompare(right);
}

function instructionScope(instructionPath: string) {
  if (instructionPath === "AGENTS.md") {
    return "repo root";
  }

  return instructionPath.replace(/\/AGENTS\.md$/u, "");
}

function summarizeInstruction(
  body: string,
  profile: ReturnType<typeof sourceProfile>
) {
  const heading =
    body
      .split(/\r?\n/u)
      .map(
        (line) => /^#{1,6}\s+(?<heading>.+)$/u.exec(line)?.groups?.["heading"]
      )
      .find((line) => line !== undefined && line.trim().length > 0) ??
    "Agent instructions";
  const bullets = body
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => /^[-*+]\s+/u.test(line))
    .map((line) => line.replace(/^[-*+]\s+/u, "").trim());
  const relevant = bullets.filter((bullet) => {
    const bulletTokens = tokenSet(bullet);
    for (const token of profile.tokens) {
      if (bulletTokens.has(token)) {
        return true;
      }
    }

    return /\bdo not\b|\bparse\b|\bserializable\b|\bpnpm\b/iu.test(bullet);
  });
  const selected = [...relevant, ...bullets].slice(0, 4);

  return uniqueStrings([heading, ...selected]).join(" ");
}

function readPackageManifests(
  fs: FileSystem.FileSystem,
  workspaceRoot: string,
  files: ReadonlyArray<string>,
  profile: ReturnType<typeof sourceProfile>
): Effect.Effect<ReadonlyArray<PackageManifest>, never> {
  return Effect.gen(function* () {
    const manifests: Array<PackageManifest> = [];
    for (const manifestPath of files.filter(isPackageManifest).sort()) {
      const body = yield* readOptionalFileString(
        fs,
        workspaceRoot,
        manifestPath
      );
      if (body === undefined) {
        continue;
      }
      const parsed = parsePackageJson(body);
      const directory = parentDirectory(manifestPath);
      const name = parsed?.name ?? directory;
      const scripts =
        parsed?.scripts === undefined ? [] : Object.keys(parsed.scripts).sort();
      const manifest = {
        directory,
        name,
        path: manifestPath,
        scripts,
      };
      if (directory !== "." || packageIsRelevant(manifest, [], profile)) {
        manifests.push(manifest);
      }
    }

    return manifests;
  });
}

function parsePackageJson(body: string) {
  try {
    const parsed: unknown = JSON.parse(body);
    return decodePackageJson(parsed);
  } catch {
    return undefined;
  }
}

function listWorkspaceFiles(
  fs: FileSystem.FileSystem,
  workspaceRoot: string
): Effect.Effect<ReadonlyArray<string>, never> {
  return Effect.gen(function* () {
    const files: Array<string> = [];
    const rootAgents = yield* pathExists(
      fs,
      path.join(workspaceRoot, "AGENTS.md")
    );
    if (rootAgents) {
      files.push("AGENTS.md");
    }

    for (const sourceRoot of sourceRoots) {
      files.push(...(yield* listFilesBelow(fs, workspaceRoot, sourceRoot)));
    }

    return uniqueStrings(files).sort();
  });
}

function listFilesBelow(
  fs: FileSystem.FileSystem,
  workspaceRoot: string,
  relativeDirectory: string
): Effect.Effect<ReadonlyArray<string>, never> {
  return Effect.gen(function* () {
    const absoluteDirectory = path.join(workspaceRoot, relativeDirectory);
    const info = yield* optionalStat(fs, absoluteDirectory);
    if (info?.type !== "Directory") {
      return [];
    }

    const entries = yield* fs
      .readDirectory(absoluteDirectory)
      .pipe(Effect.catchTag("PlatformError", () => Effect.succeed([])));
    const files: Array<string> = [];
    for (const entry of entries.toSorted()) {
      if (ignoredPathSegments.has(entry)) {
        continue;
      }

      const relativePath = `${relativeDirectory}/${entry}`;
      const absolutePath = path.join(workspaceRoot, relativePath);
      const entryInfo = yield* optionalStat(fs, absolutePath);
      if (entryInfo?.type === "Directory") {
        files.push(...(yield* listFilesBelow(fs, workspaceRoot, relativePath)));
        continue;
      }
      if (entryInfo?.type === "File") {
        files.push(relativePath);
      }
    }

    return files;
  });
}

function optionalStat(fs: FileSystem.FileSystem, absolutePath: string) {
  return fs.stat(absolutePath).pipe(
    Effect.map((stat) => stat),
    Effect.catchTag("PlatformError", () => Effect.succeed(undefined))
  );
}

function pathExists(fs: FileSystem.FileSystem, absolutePath: string) {
  return fs
    .exists(absolutePath)
    .pipe(Effect.catchTag("PlatformError", () => Effect.succeed(false)));
}

function readOptionalFileString(
  fs: FileSystem.FileSystem,
  workspaceRoot: string,
  relativePath: string
) {
  return fs
    .readFileString(path.join(workspaceRoot, relativePath))
    .pipe(Effect.catchTag("PlatformError", () => Effect.succeed(undefined)));
}

function isPackageManifest(relativePath: string) {
  return (
    relativePath === "package.json" || relativePath.endsWith("/package.json")
  );
}

function isImplementationFile(relativePath: string) {
  return (
    /\.(?:ts|tsx|mjs|js)$/u.test(relativePath) &&
    !relativePath.endsWith(".test.ts") &&
    !relativePath.endsWith(".test.tsx") &&
    relativePath.includes("/src/")
  );
}

function isTestFile(relativePath: string) {
  return /\.(?:test|spec)\.(?:ts|tsx|js)$/u.test(relativePath);
}

function isSourceDoc(relativePath: string) {
  return (
    relativePath.startsWith("docs/") &&
    relativePath.endsWith(".md") &&
    !relativePath.endsWith("/AGENTS.md")
  );
}

function parentDirectory(relativePath: string) {
  const directory = path.posix.dirname(relativePath);
  return directory === "." ? "." : directory;
}

function nearestInstructionPath(relativePath: string) {
  const segments = relativePath.split("/");
  for (let index = segments.length - 1; index > 0; index -= 1) {
    const instructionPath = `${segments.slice(0, index).join("/")}/AGENTS.md`;
    if (instructionPath.length > "AGENTS.md".length) {
      return instructionPath;
    }
  }

  return undefined;
}

function normalizeRelativePath(input: string) {
  return input.replace(/\\/gu, "/").replace(/^\.\//u, "");
}

function tokenSet(input: string) {
  return new Set(tokensFrom(input));
}

function tokensFrom(input: string) {
  const rawTokens = input
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((token) => token.length > 1 && !weakTokens.has(token));
  const expanded: Array<string> = [];
  for (const token of rawTokens) {
    expanded.push(token);
    if (token.length > 3 && token.endsWith("s")) {
      expanded.push(token.slice(0, -1));
    }
  }

  return uniqueStrings(expanded);
}

function uniqueStrings(items: ReadonlyArray<string>) {
  const seen = new Set<string>();
  const unique: Array<string> = [];
  for (const item of items) {
    const normalized = item.trim();
    if (normalized.length === 0 || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    unique.push(normalized);
  }

  return unique;
}
