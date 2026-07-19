import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

const normalizePath = (cwd, filePath) =>
  (path.isAbsolute(filePath) ? path.relative(cwd, filePath) : filePath)
    .split(path.sep)
    .join("/");

const normalizeRuleId = (ruleId) => {
  const pluginStyle = /^gaia\((.+)\)$/u.exec(ruleId);
  return pluginStyle === null ? ruleId : `gaia/${pluginStyle[1]}`;
};

const normalizeDiagnosticLine = (cwd, line, format) => {
  if (format === "normalized") {
    const match = /^(.*):(\d+):(\d+) (gaia\/\S+) (.+Remedy: .+)$/u.exec(line);
    if (match === null) return undefined;
    return `${normalizePath(cwd, match[1])}:${match[2]}:${match[3]} ${match[4]} ${match[5]}`;
  }

  const match =
    /^(.*):(\d+):(\d+):\s+(.+)\s+\[(?:Error|Warning)\/([^\]]+)\]$/u.exec(line);
  if (match === null) return undefined;
  const rule = normalizeRuleId(match[5]);
  if (!rule.startsWith("gaia/")) return undefined;
  return `${normalizePath(cwd, match[1])}:${match[2]}:${match[3]} ${rule} ${match[4]}`;
};

const runProcess = (cwd, specification) => {
  const result = spawnSync(specification.command, specification.args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
  if (result.error !== undefined) throw result.error;
  return result;
};

const createDefaultSyntaxSpecification = (temporaryRoot, syntaxTargets) => {
  const directory = mkdtempSync(
    path.join(temporaryRoot, "gaia-schema-contract-audit-")
  );
  const configPath = path.join(directory, "oxlint.schema-contracts.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      categories: {
        correctness: "off",
      },
      ignorePatterns: [
        "**/.gaia/**",
        "**/.turbo/**",
        "**/dist/**",
        "**/node_modules/**",
        "**/*.gen.*",
      ],
      jsPlugins: [
        path.join(repoRoot, "scripts/oxlint/gaia-schema-contract-plugin.mjs"),
      ],
      rules: {
        "gaia/no-brand-cast": "error",
        "gaia/no-unbranded-domain-string": "error",
        "gaia/schema-first-data-contract": "error",
      },
    })
  );

  return {
    cleanup() {
      rmSync(directory, { force: true, recursive: true });
    },
    specification: {
      args: [
        "exec",
        "oxlint",
        "--config",
        configPath,
        "--format",
        "unix",
        ...syntaxTargets,
      ],
      command: "pnpm",
      format: "oxlint-unix",
    },
  };
};

const collectDiagnostics = (cwd, result, format) =>
  `${result.stdout}\n${result.stderr}`.split(/\r?\n/u).flatMap((line) => {
    const diagnostic = normalizeDiagnosticLine(cwd, line, format);
    return diagnostic === undefined ? [] : [diagnostic];
  });

const compareDiagnostics = (left, right) => {
  const parse = (diagnostic) => {
    const match = /^(.*):(\d+):(\d+) (gaia\/\S+) /u.exec(diagnostic);
    return match === null
      ? [diagnostic, 0, 0, ""]
      : [match[1], Number(match[2]), Number(match[3]), match[4]];
  };
  const [leftPath, leftLine, leftColumn, leftRule] = parse(left);
  const [rightPath, rightLine, rightColumn, rightRule] = parse(right);
  if (leftPath !== rightPath) return leftPath < rightPath ? -1 : 1;
  if (leftLine !== rightLine) return leftLine - rightLine;
  if (leftColumn !== rightColumn) return leftColumn - rightColumn;
  if (leftRule !== rightRule) return leftRule < rightRule ? -1 : 1;
  return left === right ? 0 : left < right ? -1 : 1;
};

/**
 * Run both schema-contract diagnostic engines and retain both result streams.
 *
 * @param {{ cwd?: string; ownership?: { args: string[]; command: string; format: "normalized" | "oxlint-unix" }; syntax?: { args: string[]; command: string; format: "normalized" | "oxlint-unix" }; syntaxTargets?: string[]; temporaryRoot?: string }} options Process, target, and temporary-directory overrides used by the fixture verifier.
 * @returns {{ diagnostics: string[]; raw: { ownership: { stderr: string; stdout: string }; syntax: { stderr: string; stdout: string } }; status: number }} Both normalized diagnostics and unmodified process streams.
 */
export function runSchemaContractAudit({
  cwd = repoRoot,
  ownership = {
    args: [path.join(repoRoot, "scripts/check-schema-contract-ownership.mjs")],
    command: process.execPath,
    format: "normalized",
  },
  syntax,
  syntaxTargets = ["apps", "packages", "examples", "scripts"],
  temporaryRoot = tmpdir(),
} = {}) {
  const temporarySyntax =
    syntax === undefined
      ? createDefaultSyntaxSpecification(temporaryRoot, syntaxTargets)
      : undefined;
  const syntaxSpecification = syntax ?? temporarySyntax.specification;

  try {
    const syntaxResult = runProcess(cwd, syntaxSpecification);
    const ownershipResult = runProcess(cwd, ownership);
    const diagnostics = [
      ...collectDiagnostics(cwd, syntaxResult, syntaxSpecification.format),
      ...collectDiagnostics(cwd, ownershipResult, ownership.format),
    ].sort(compareDiagnostics);

    return {
      diagnostics,
      raw: {
        ownership: {
          stderr: ownershipResult.stderr,
          stdout: ownershipResult.stdout,
        },
        syntax: {
          stderr: syntaxResult.stderr,
          stdout: syntaxResult.stdout,
        },
      },
      status:
        syntaxResult.status === 0 &&
        ownershipResult.status === 0 &&
        diagnostics.length === 0
          ? 0
          : 1,
    };
  } finally {
    temporarySyntax?.cleanup();
  }
}

const isMain =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  const audit = runSchemaContractAudit();
  for (const diagnostic of audit.diagnostics) {
    process.stdout.write(`${diagnostic}\n`);
  }
  if (audit.raw.syntax.stderr.length > 0) {
    process.stderr.write(audit.raw.syntax.stderr);
  }
  if (audit.raw.ownership.stderr.length > 0) {
    process.stderr.write(audit.raw.ownership.stderr);
  }
  process.exitCode = audit.status;
}
