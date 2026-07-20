import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

const requirement = (
  name,
  pattern,
  { minimumMatches = 1, mutationPattern = pattern } = {}
) => ({ minimumMatches, mutationPattern, name, pattern });

const scopedRequirement = (name, marker, token, maximumDistance = 1600) =>
  requirement(
    name,
    new RegExp(
      `${marker.source}(?=[\\s\\S]{0,${maximumDistance}}${token.source})`,
      [...new Set(`${marker.flags}${token.flags}`.replace("g", ""))].join("")
    ),
    { mutationPattern: token }
  );

const newLaneMarker = /new[- ]lanes?/i;
const resumeMarker = /explicit\s+resume\s*\/\s*special-ref/i;

const contracts = {
  canonicalRecipe: [
    requirement("fetch failure guard", /git fetch --prune origin \|\| exit 1/, {
      minimumMatches: 3,
    }),
    requirement(
      "symbolic-ref failure guard",
      /remote_head=\$\(git symbolic-ref refs\/remotes\/origin\/HEAD\) \|\| exit 1/,
      { minimumMatches: 3 }
    ),
    requirement("origin namespace guard", /refs\/remotes\/origin\/\?\*\) ;;/, {
      minimumMatches: 3,
    }),
    requirement(
      "derived default ref",
      /(?:default_ref|fresh_default_ref)=\$\{remote_head#refs\/remotes\/\}/,
      { minimumMatches: 3 }
    ),
    requirement(
      "exact symbolic-ref commit",
      /git rev-parse --verify "\$\{remote_head\}\^\{commit\}"\) \|\| exit 1/,
      { minimumMatches: 3 }
    ),
    requirement(
      "honest ahead/behind command",
      /git rev-list --left-right --count HEAD\.\.\."\$default_ref"/,
      { minimumMatches: 2 }
    ),
    requirement(
      "override ref exact commit",
      /override_sha=\$\(git rev-parse --verify "\$\{override_ref\}\^\{commit\}"\) \|\| exit 1/
    ),
    requirement(
      "override equals resumed HEAD",
      /test "\$head_sha" = "\$override_sha" \|\| exit 1/
    ),
    requirement(
      "worker refresh failure guard",
      /git -C "<worker-path>" merge --ff-only "\$fresh_base_sha" \|\| exit 1/
    ),
    requirement(
      "reviewer refresh failure guard",
      /git -C "<reviewer-path>" switch --detach "\$fresh_base_sha" \|\| exit 1/
    ),
  ],
  remoteDefault: [
    requirement("fresh fetch", /git fetch --prune origin/),
    requirement("symbolic remote HEAD", /refs\/remotes\/origin\/HEAD/),
    requirement("derived remote default", /origin\/<default>/),
    requirement(
      "fail-closed provenance",
      /(?:missing|invalid)[\s\S]{0,180}fail(?:s)? closed/i,
      { mutationPattern: /fail(?:s)? closed/i }
    ),
  ],
  newLane: [
    requirement("new-lane scope", newLaneMarker),
    scopedRequirement(
      "exact base equality",
      newLaneMarker,
      /HEAD == origin\/<default> == merge-base/,
      700
    ),
    scopedRequirement("exact 0\/0 state", newLaneMarker, /0\/0/, 700),
  ],
  dispatch: [
    requirement("Codex starting state", /startingState: `?origin\/<default>`?/),
  ],
  resume: [
    requirement("explicit resume override", resumeMarker),
    scopedRequirement(
      "durable issue/handoff authority",
      resumeMarker,
      /durable\s+issue\/handoff\s+comment/i
    ),
    scopedRequirement(
      "durable dispatch evidence",
      resumeMarker,
      /durable\s+dispatch\s+comment/i
    ),
    scopedRequirement("override ref", resumeMarker, /override ref/i),
    scopedRequirement(
      "exact resumed HEAD",
      resumeMarker,
      /exact\s+resumed\s+HEAD/i
    ),
    scopedRequirement(
      "override bound to resumed HEAD",
      resumeMarker,
      /override\s+ref\s+resolves\s+to\s+the\s+exact\s+resumed\s+HEAD/i
    ),
    scopedRequirement(
      "fetched default identity",
      resumeMarker,
      /fetched\s+remote-default\s+ref\/SHA/i
    ),
    scopedRequirement("merge-base", resumeMarker, /merge-base/),
    scopedRequirement("ahead\/behind", resumeMarker, /ahead\/behind/),
    scopedRequirement("honest tree state", resumeMarker, /clean\/dirty/),
    scopedRequirement("fetch time", resumeMarker, /fetch time/),
    scopedRequirement(
      "no implicit history rewrite",
      resumeMarker,
      /reset,\s+clean,\s+merge,\s+automatic(?:ally)?\s+rebase,\s+force-move,\s+or\s+discard/i,
      2200
    ),
  ],
};

const owners = [
  [
    ".agents/skills/worktree-isolation/SKILL.md",
    ["canonicalRecipe", "remoteDefault", "newLane", "dispatch", "resume"],
  ],
  [
    ".agents/skills/orchestrator/SKILL.md",
    ["remoteDefault", "newLane", "dispatch", "resume"],
  ],
  [
    ".agents/skills/reconcile-project/SKILL.md",
    ["remoteDefault", "newLane", "resume"],
  ],
  [".agents/skills/worker/SKILL.md", ["remoteDefault", "newLane", "resume"]],
  [
    "docs/agents/execution-policy.md",
    ["remoteDefault", "newLane", "dispatch", "resume"],
  ],
  [
    "docs/agents/worker-thread-template.md",
    ["remoteDefault", "newLane", "dispatch", "resume"],
  ],
  [
    "docs/agents/reviewer-thread-template.md",
    ["remoteDefault", "newLane", "dispatch", "resume"],
  ],
  [
    ".agents/skills/linear-setup/assets/docs/agents/execution-policy.md",
    ["remoteDefault", "newLane", "dispatch", "resume"],
  ],
  [
    ".agents/skills/linear-setup/assets/docs/agents/worker-thread-template.md",
    ["remoteDefault", "newLane", "dispatch", "resume"],
  ],
  [
    ".agents/skills/linear-setup/assets/docs/agents/reviewer-thread-template.md",
    ["remoteDefault", "newLane", "dispatch", "resume"],
  ],
];

const requiredContracts = (roles) =>
  roles.flatMap((role) =>
    contracts[role].map((contract) => ({ ...contract, role }))
  );

const countMatches = (document, pattern) => {
  const everyMatch = new RegExp(
    pattern.source,
    `${pattern.flags.replace("g", "")}g`
  );
  return document.match(everyMatch)?.length ?? 0;
};

const scopedNegativeCases = [
  {
    contract: contracts.remoteDefault.find(
      ({ name }) => name === "fail-closed provenance"
    ),
    document:
      "provenance fails closed elsewhere\nmissing remote HEAD; provenance fails closed",
    mutate: (document) =>
      document.replace(
        "missing remote HEAD; provenance fails closed",
        "missing remote HEAD"
      ),
    name: "remote fail-closed clause",
  },
  {
    contract: contracts.newLane.find(
      ({ name }) => name === "exact base equality"
    ),
    document:
      "HEAD == origin/<default> == merge-base elsewhere\nnew lane\nHEAD == origin/<default> == merge-base",
    mutate: (document) =>
      document.replace(
        "new lane\nHEAD == origin/<default> == merge-base",
        "new lane"
      ),
    name: "new-lane equality clause",
  },
  {
    contract: contracts.resume.find(
      ({ name }) => name === "durable dispatch evidence"
    ),
    document:
      "durable dispatch comment elsewhere\nexplicit resume/special-ref\ndurable dispatch comment",
    mutate: (document) =>
      document.replace(
        "explicit resume/special-ref\ndurable dispatch comment",
        "explicit resume/special-ref"
      ),
    name: "resume dispatch-evidence clause",
  },
];

for (const { contract, document, mutate, name } of scopedNegativeCases) {
  assert.ok(contract, `${name} contract must exist`);
  assert.ok(countMatches(document, contract.pattern) > 0, `${name} must match`);
  const mutatedDocument = mutate(document);
  assert.ok(
    countMatches(mutatedDocument, contract.mutationPattern) > 0,
    `${name} mutation must retain duplicate vocabulary outside its scope`
  );
  assert.equal(
    countMatches(mutatedDocument, contract.pattern),
    0,
    `${name} must reject removal from its owning scope`
  );
}

const validate = (relativePath, document, roles) => {
  const violations = requiredContracts(roles)
    .filter(
      ({ minimumMatches, pattern }) =>
        countMatches(document, pattern) < minimumMatches
    )
    .map(({ name, role }) => `${relativePath} [${role}] missing ${name}`);

  if (
    /(?<!refs\/remotes\/)origin\/(?!<default>)[A-Za-z0-9._/-]+/.test(document)
  ) {
    violations.push(`${relativePath} hard-codes a remote default`);
  }

  return violations;
};

const documents = owners.map(([relativePath, roles]) => [
  relativePath,
  roles,
  readFileSync(path.join(repoRoot, relativePath), "utf-8"),
]);
const violations = documents.flatMap(([relativePath, roles, document]) =>
  validate(relativePath, document, roles)
);

if (violations.length > 0) {
  throw new Error(
    `Agent workspace provenance violations:\n${violations
      .map((violation) => `- ${violation}`)
      .join("\n")}`
  );
}

for (const [relativePath, roles, document] of documents) {
  for (const { mutationPattern, name, pattern, role } of requiredContracts(
    roles
  )) {
    const match = document.match(pattern);
    assert.ok(match, `${relativePath} must match ${role}/${name}`);

    const everyMatch = new RegExp(
      mutationPattern.source,
      `${mutationPattern.flags.replace("g", "")}g`
    );
    const mutatedDocument = document.replace(everyMatch, "");
    assert.ok(
      validate(relativePath, mutatedDocument, roles).some((violation) =>
        violation.includes(`[${role}] missing ${name}`)
      ),
      `${relativePath} must reject removal of ${role}/${name}`
    );
  }

  assert.ok(
    validate(relativePath, `${document}\norigin/main`, roles).some(
      (violation) => violation.endsWith("hard-codes a remote default")
    ),
    `${relativePath} must reject a hard-coded remote default`
  );
}

console.log(
  `Agent workspace provenance verified: ${documents.length} role-aware owners`
);
