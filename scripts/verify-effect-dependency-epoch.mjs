import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const effectEpoch = "4.0.0-beta.93";
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const dependencySections = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

const isEffectPackage = (packageName) =>
  packageName === "effect" || packageName.startsWith("@effect/");

const workspaceManifestPaths = [
  "package.json",
  ...["apps", "packages"].flatMap((directory) =>
    readdirSync(path.join(repoRoot, directory), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(directory, entry.name, "package.json"))
  ),
];

const manifestViolations = [];
const declaredPackages = new Set();

for (const manifestPath of workspaceManifestPaths) {
  const manifest = JSON.parse(
    readFileSync(path.join(repoRoot, manifestPath), "utf-8")
  );

  for (const section of dependencySections) {
    for (const [packageName, specifier] of Object.entries(
      manifest[section] ?? {}
    )) {
      if (!isEffectPackage(packageName)) {
        continue;
      }

      declaredPackages.add(packageName);
      if (specifier !== effectEpoch) {
        manifestViolations.push(
          `${manifestPath} ${section}.${packageName} is ${JSON.stringify(specifier)}; expected ${JSON.stringify(effectEpoch)}`
        );
      }
    }
  }
}

const readDependencyProjects = (lockfileOnly) =>
  JSON.parse(
    execFileSync(
      "pnpm",
      [
        "list",
        "--recursive",
        "--depth",
        "Infinity",
        "--json",
        ...(lockfileOnly ? ["--lockfile-only"] : []),
      ],
      {
        cwd: repoRoot,
        encoding: "utf-8",
        maxBuffer: 64 * 1024 * 1024,
      }
    )
  );

const collectEffectVersions = (projects) => {
  const effectVersions = new Map();
  const visitedNodes = new Set();

  const visitDependencyTree = (dependencies = {}) => {
    for (const [packageName, dependency] of Object.entries(dependencies)) {
      if (isEffectPackage(packageName)) {
        const versions = effectVersions.get(packageName) ?? new Set();
        versions.add(dependency.version);
        effectVersions.set(packageName, versions);
      }

      if (visitedNodes.has(dependency)) {
        continue;
      }

      visitedNodes.add(dependency);
      visitDependencyTree(dependency.dependencies);
      visitDependencyTree(dependency.devDependencies);
      visitDependencyTree(dependency.optionalDependencies);
    }
  };

  for (const project of projects) {
    visitDependencyTree(project.dependencies);
    visitDependencyTree(project.devDependencies);
    visitDependencyTree(project.optionalDependencies);
  }

  return effectVersions;
};

const installedEffectVersions = collectEffectVersions(
  readDependencyProjects(false)
);
const lockfileEffectVersions = collectEffectVersions(
  readDependencyProjects(true)
);

const resolutionViolations = [];
const verifyResolution = (source, effectVersions) => {
  for (const [packageName, versions] of effectVersions) {
    for (const version of versions) {
      if (version !== effectEpoch) {
        resolutionViolations.push(
          `${source} ${packageName} resolves to ${version}; expected ${effectEpoch}`
        );
      }
    }
  }

  for (const packageName of declaredPackages) {
    if (!effectVersions.has(packageName)) {
      resolutionViolations.push(
        `${packageName} is declared but absent from ${source}`
      );
    }
  }
};

if (declaredPackages.size === 0) {
  manifestViolations.push("No Gaia-owned Effect packages are declared");
}
verifyResolution("installed graph", installedEffectVersions);
verifyResolution("lockfile graph", lockfileEffectVersions);

const violations = [...manifestViolations, ...resolutionViolations];
if (violations.length > 0) {
  throw new Error(
    `Effect dependency epoch violations:\n${violations
      .map((violation) => `- ${violation}`)
      .join("\n")}`
  );
}

console.log(
  `Effect dependency epoch verified: ${effectEpoch} (${[...installedEffectVersions.keys()].sort().join(", ")})`
);
