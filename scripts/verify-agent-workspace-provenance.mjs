import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const read = (relativePath) =>
  readFileSync(path.join(repoRoot, relativePath), "utf-8");

const policyPath = "docs/agents/execution-policy.md";
const bundledRoot = ".agents/skills/linear-setup/assets/docs/agents";
const rolePaths = [
  ".agents/skills/orchestrator/SKILL.md",
  ".agents/skills/reconcile-project/SKILL.md",
  ".agents/skills/worker/SKILL.md",
];
const syncedDocs = [
  "execution-policy.md",
  "issue-template.md",
  "linear-workflow.md",
  "reviewer-thread-template.md",
  "triage-states.md",
  "worker-thread-template.md",
];

for (const name of syncedDocs) {
  assert.equal(
    read(`docs/agents/${name}`),
    read(`${bundledRoot}/${name}`),
    `${name} must match the linear-setup installed copy`
  );
}

const policy = read(policyPath);
assert.match(policy, /canonical owner of workflow phases, role authority/i);
assert.match(policy, /exact fetched-remote provenance/i);
assert.match(policy, /no\s+pre-edit reviewer/i);
assert.match(policy, /reviewer does not grant edit authority/i);
assert.match(policy, /Fix before merge/i);
assert.match(policy, /Accept as residual risk/i);
assert.match(policy, /Create a follow-up/i);
assert.match(policy, /Ask the human for a genuine decision/i);

for (const relativePath of rolePaths) {
  const document = read(relativePath);
  assert.match(
    document,
    /docs\/agents\/execution-policy\.md/,
    `${relativePath} must consume the canonical policy`
  );
  assert.doesNotMatch(
    document,
    /(?<!refs\/remotes\/)origin\/(?!<default>|HEAD\b)[A-Za-z0-9._/-]+/,
    `${relativePath} must not hard-code a remote default`
  );
}

const worktree = read(".agents/skills/worktree-isolation/SKILL.md");
assert.doesNotMatch(
  worktree,
  /(?<!refs\/remotes\/)origin\/(?!<default>|HEAD\b)[A-Za-z0-9._/-]+/,
  "worktree isolation must not hard-code a remote default"
);
for (const [name, pattern] of [
  ["fetch failure guard", /git fetch --prune origin \|\| exit 1/],
  [
    "symbolic remote HEAD guard",
    /remote_head=\$\(git symbolic-ref refs\/remotes\/origin\/HEAD\) \|\| exit 1/,
  ],
  ["origin namespace guard", /refs\/remotes\/origin\/\?\*\) ;;/],
  [
    "derived remote default",
    /remote_default=\$\{remote_head#refs\/remotes\/\}/,
  ],
  [
    "exact symbolic-ref commit",
    /git rev-parse --verify "\$\{remote_head\}\^\{commit\}"\) \|\| exit 1/,
  ],
  ["honest ahead and behind proof", /git rev-list --left-right --count/],
  ["clean-tree proof", /git status --porcelain/],
  ["reviewer detached", /reviewer stays detached/i],
  ["resume exception", /Explicit Resume Or Special Ref/],
  ["no implicit history rewrite", /never reset, clean, merge, auto-rebase/],
]) {
  assert.match(worktree, pattern, `worktree isolation missing ${name}`);
}

const orchestrator = read(".agents/skills/orchestrator/SKILL.md");
assert.match(
  orchestrator,
  /startingState: \{ type: "branch", branchName:\s*"origin\/<default>" \}/
);
assert.match(orchestrator, /Activate one independent read-only reviewer when/);
assert.match(orchestrator, /archive completed, obsolete, idle, or held tasks/i);

const worker = read(".agents/skills/worker/SKILL.md");
assert.match(worker, /exact dispatched\s+SHA/);
assert.match(worker, /fetch time and exact base/);
assert.match(worker, /Do not reset, clean, merge,\s+auto-rebase/);

const reconcile = read(".agents/skills/reconcile-project/SKILL.md");
assert.match(reconcile, /invalid symbolic `origin\/HEAD`/);
assert.match(reconcile, /startingState.*independently verified/);
assert.match(reconcile, /archive obsolete idle tasks/);

console.log(
  `Agent workspace provenance verified: ${syncedDocs.length} synced docs and ${rolePaths.length} policy-consuming roles`
);
