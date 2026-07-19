import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const capabilityPath = path.join(repoRoot, "docs/current-capabilities.md");
const baselinePath = path.join(repoRoot, "docs/self-hosting-baseline.md");
const capabilityDocument = readFileSync(capabilityPath, "utf-8");
const baselineDocument = readFileSync(baselinePath, "utf-8");
const lockfileDocument = readFileSync(path.join(repoRoot, "pnpm-lock.yaml"));
const routingDocuments = [
  ["README.md", "docs/current-capabilities.md"],
  ["AGENTS.md", "docs/current-capabilities.md"],
  ["docs/README.md", "current-capabilities.md"],
  ["docs/prototype-1.md", "current-capabilities.md"],
  ["docs/post-harness-roadmap.md", "current-capabilities.md"],
];

const expectedStates = new Set([
  "implemented",
  "partial",
  "missing",
  "superseded",
  "historical-prototype",
]);
const observedStates = new Set();
const ledgerSection = capabilityDocument
  .split("## Ledger\n", 2)[1]
  ?.split("\n## Preservation Rules", 1)[0];

assert.ok(ledgerSection, "Capability document must contain the live ledger");

for (const line of ledgerSection.split("\n")) {
  if (!line.startsWith("|") || line.includes("| ---")) {
    continue;
  }

  const cells = line
    .split("|")
    .slice(1, -1)
    .map((cell) => cell.trim());
  if (cells[0] === "Capability claim") {
    continue;
  }

  assert.equal(
    cells.length,
    4,
    `Capability ledger row ${JSON.stringify(cells[0])} must have four cells`
  );
  const state = cells[1];
  assert.ok(
    expectedStates.has(state),
    `Capability row ${JSON.stringify(cells[0])} uses unapproved state ${JSON.stringify(state)}`
  );

  observedStates.add(state);
  assert.match(
    cells[2],
    /\[[^\]]+\]\([^)]+\)/,
    `Capability row ${JSON.stringify(cells[0])} must link current evidence`
  );

  if (
    state === "implemented" ||
    state === "partial" ||
    state === "superseded"
  ) {
    assert.match(
      cells[2],
      /\.test\.(?:ts|tsx)/,
      `Capability row ${JSON.stringify(cells[0])} must cite focused tests`
    );
    assert.ok(
      [...cells[2].matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].some(
        ([, target]) => !/\.test\.(?:ts|tsx)(?:#.*)?$/.test(target)
      ),
      `Capability row ${JSON.stringify(cells[0])} must cite current non-test source`
    );
  }
}

assert.deepEqual(
  observedStates,
  expectedStates,
  "Capability ledger must use every approved classification exactly as a live state"
);

const requiredBaselineSections = [
  "## Baseline Identity",
  "## Representative Job",
  "## Accepted Outcome",
  "## Proof Bar",
  "## Authority Envelope",
  "## Stop Conditions",
  "## Baseline Trajectory",
  "## Expected Evidence Packet",
  "## Preservation and Deletion Rules",
  "## Unobservable or Unproven Facts",
];

for (const heading of requiredBaselineSections) {
  assert.ok(
    baselineDocument.includes(heading),
    `Baseline document is missing ${heading}`
  );
}

assert.match(
  baselineDocument,
  /Model identity \| unobservable/,
  "Baseline must label unavailable model identity as unobservable"
);
assert.match(
  baselineDocument,
  /does not prove factory outcomes/,
  "Baseline must keep dependency evidence separate from factory-outcome proof"
);

const lockfileDigest = createHash("sha256")
  .update(lockfileDocument)
  .digest("hex");
assert.ok(
  baselineDocument.includes(
    `| Lockfile SHA-256 after alignment | \`${lockfileDigest}\` |`
  ),
  "Baseline lockfile digest must match pnpm-lock.yaml"
);

const expectedRegistryInputs = new Map([
  [
    "effect@4.0.0-beta.93",
    {
      integrity:
        "sha512-wNS5MKFa3C42uBfIDik2oJ78lhpoYz2hN4oBR0229BeeDCIrkg/FiOvoiPGdCVlWa7MEKxEL5I0f8AILVHSD9A==",
      lockfileKey: "effect@4.0.0-beta.93",
    },
  ],
  [
    "@effect/platform-node@4.0.0-beta.93",
    {
      integrity:
        "sha512-QagsCGR0ZOXaCQqS5qGR2mcDng4LiP2bYhiiX1D6UC8cT9vsusVVOHiJWn8CupeDx+yVnPcu81QmA/SDt6GM1w==",
      lockfileKey: "'@effect/platform-node@4.0.0-beta.93'",
    },
  ],
  [
    "@effect/vitest@4.0.0-beta.93",
    {
      integrity:
        "sha512-gMAnZ9PiMeJMDED9s0jWgCOhc2JccrTCxowhur/KriImsHnHIRj4VG/vK0xLw0Axe4AkTWzXNdRsFrYOjBTl3A==",
      lockfileKey: "'@effect/vitest@4.0.0-beta.93'",
    },
  ],
]);

for (const [
  packageName,
  { integrity, lockfileKey },
] of expectedRegistryInputs) {
  assert.ok(
    baselineDocument.includes(`| \`${packageName}\` | \`${integrity}\` |`),
    `Baseline must retain the reviewed registry input for ${packageName}`
  );
  assert.ok(
    lockfileDocument.includes(
      `  ${lockfileKey}:\n    resolution: {integrity: ${integrity}}`
    ),
    `Baseline package integrity ${integrity} must match ${lockfileKey} in pnpm-lock.yaml`
  );
}

for (const [relativePath, ledgerReference] of routingDocuments) {
  assert.ok(
    readFileSync(path.join(repoRoot, relativePath), "utf-8").includes(
      ledgerReference
    ),
    `${relativePath} must route current capability claims to the ledger`
  );
}

const markdownLinkPattern = /\[[^\]]+\]\(([^)]+)\)/g;
const linkedDocuments = [
  [capabilityPath, capabilityDocument],
  [baselinePath, baselineDocument],
  ...routingDocuments.map(([relativePath]) => {
    const documentPath = path.join(repoRoot, relativePath);
    return [documentPath, readFileSync(documentPath, "utf-8")];
  }),
];

for (const [documentPath, document] of linkedDocuments) {
  for (const match of document.matchAll(markdownLinkPattern)) {
    const target = match[1];
    if (
      target.startsWith("http://") ||
      target.startsWith("https://") ||
      target.startsWith("#") ||
      target.startsWith("mailto:")
    ) {
      continue;
    }

    const [relativePath] = target.split("#", 1);
    assert.ok(
      existsSync(path.resolve(path.dirname(documentPath), relativePath)),
      `${path.relative(repoRoot, documentPath)} links to missing ${target}`
    );
  }
}

console.log(
  `Baseline documentation verified: ${[...observedStates].sort().join(", ")}`
);
