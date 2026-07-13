import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const configPath = path.join(repoRoot, "oxfmt.config.ts");

const format = (relativePath, input) => {
  const result = spawnSync(
    "oxfmt",
    [
      "--config",
      configPath,
      "--stdin-filepath",
      path.join(repoRoot, relativePath),
    ],
    {
      cwd: repoRoot,
      encoding: "utf-8",
      input,
    }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(
    result.stderr,
    "",
    `${relativePath} emitted formatter diagnostics`
  );
  return result.stdout;
};

const cases = [
  {
    expected: `import { readFile } from "node:fs/promises";

import type { RunId } from "@gaia/core";
import { Effect } from "effect";

import { alpha } from "./alpha.js";
import { zed } from "./zed.js";

export const value: RunId = Effect.succeed(readFile).pipe(() => alpha + zed);
`,
    input: `import { zed } from "./zed.js";
import type { RunId } from "@gaia/core";
import { readFile } from "node:fs/promises";
import { Effect } from "effect";
import { alpha } from "./alpha.js";

export const value: RunId = Effect.succeed(readFile).pipe(() => alpha + zed);
`,
    path: "scripts/tooling-sorting.ts",
  },
  {
    expected: `import { cva } from "class-variance-authority";
import { clsx } from "clsx";
import { useMemo } from "react";
import type { ReactNode } from "react";

import { cn } from "../apps/dashboard/src/lib/utils";

const badge = cva(clsx("flex bg-red-500 px-4", "text-white"), {
  variants: {
    tone: {
      info: cn("rounded-md p-2 text-sm", false && "mt-2 block"),
    },
  },
  compoundVariants: [
    {
      tone: "info",
      class: clsx("flex gap-2 font-bold", cn("bg-blue-500 px-2")),
    },
  ],
});

export function Example({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}) {
  const value = useMemo(() => active, [active]);
  return (
    <div className="flex bg-red-500 px-4">
      {children}
      {value && (
        <span
          className={cn("mt-2 block text-white", active && "rounded-md p-2")}
        >
          ok
        </span>
      )}
      <em className={clsx("flex gap-2 font-bold")}>fine</em>
      <strong className={badge({ tone: "info" })}>badge</strong>
    </div>
  );
}
`,
    input: `import { cn } from "../apps/dashboard/src/lib/utils";
import { cva } from "class-variance-authority";
import { clsx } from "clsx";
import { useMemo } from "react";
import type { ReactNode } from "react";

const badge = cva(
  clsx("px-4 bg-red-500 flex", "text-white"),
  {
    variants: {
      tone: {
        info: cn("text-sm rounded-md p-2", false && "mt-2 block"),
      },
    },
    compoundVariants: [
      {
        tone: "info",
        class: clsx("font-bold flex gap-2", cn("px-2 bg-blue-500")),
      },
    ],
  },
);

export function Example({ active, children }: { active: boolean; children: ReactNode }) {
  const value = useMemo(() => active, [active]);
  return <div className="px-4 bg-red-500 flex">{children}{value && <span className={cn("text-white mt-2 block", active && "p-2 rounded-md")}>ok</span>}<em className={clsx("font-bold flex gap-2")}>fine</em><strong className={badge({ tone: "info" })}>badge</strong></div>;
}
`,
    path: "scripts/tooling-sorting.tsx",
  },
];

for (const testCase of cases) {
  const firstPass = format(testCase.path, testCase.input);
  assert.notEqual(
    firstPass,
    testCase.input,
    `${testCase.path} must begin non-canonical`
  );
  assert.equal(
    firstPass,
    testCase.expected,
    `${testCase.path} must match the shipped sorting policy`
  );
  assert.equal(
    format(testCase.path, firstPass),
    firstPass,
    `${testCase.path} must be byte-identical on the second pass`
  );
}
