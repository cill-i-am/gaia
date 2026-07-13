import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runSchemaContractAudit } from "./audit-schema-contracts.mjs";
import { analyzeSchemaContracts } from "./check-schema-contract-ownership.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const projectRoot = await mkdtemp(
  path.join(repoRoot, "packages/runtime/.gaia-schema-contract-ownership-")
);

try {
  await writeFile(
    path.join(projectRoot, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        exactOptionalPropertyTypes: true,
        jsx: "react-jsx",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        noEmit: true,
        skipLibCheck: true,
        strict: true,
        target: "ES2024",
      },
      include: ["*.ts", "*.tsx"],
    })
  );
  await writeFile(
    path.join(projectRoot, "schema.ts"),
    `
      import { Schema } from "effect";

      export const RunIdSchema = Schema.String.pipe(Schema.brand("RunId"));
      export type RunId = typeof RunIdSchema.Type;
      export const HarnessNameSchema = Schema.String.pipe(
        Schema.brand("HarnessName")
      );
      export type HarnessName = typeof HarnessNameSchema.Type;
      export const RunSchema = Schema.Struct({ runId: RunIdSchema });
      export type Run = typeof RunSchema.Type;
      export const RunMapSchema = Schema.Record(Schema.String, RunIdSchema);
      export type RunMap = typeof RunMapSchema.Type;
      export const HarnessSchema = Schema.Struct({
        harnessName: HarnessNameSchema,
      });
      export type Harness = typeof HarnessSchema.Type;
      export type RunWithHarness = Run & Harness;
      export class RunDto extends Schema.Class<RunDto>("RunDto")({
        runId: RunIdSchema,
      }) {}
    `
  );
  await writeFile(
    path.join(projectRoot, "derived.ts"),
    `
      import { RunSchema } from "./reexport.js";
      import type { Run, RunDto } from "./reexport.js";
      export type RunSummary = Pick<Run, "runId">;
      export type RunDtoSummary = Pick<RunDto, "runId">;
      export type RunIndexed = typeof RunSchema["Type"];
    `
  );
  await writeFile(
    path.join(projectRoot, "reexport.ts"),
    `export { RunSchema } from "./schema.js";
    export type {
      HarnessName,
      Run,
      RunDto,
      RunId,
      RunMap,
      RunWithHarness,
    } from "./schema.js";`
  );
  await writeFile(
    path.join(projectRoot, "counterfeit-types.d.ts"),
    `
      export type Pick<T, K extends keyof T> = {
        readonly manuallyAuthored: string;
      };
      export type Wrapper<T> = { readonly manuallyWrapped: string };
    `
  );
  await writeFile(
    path.join(projectRoot, "counterfeit.ts"),
    `
      import { RunSchema } from "./reexport.js";
      import type { Run } from "./reexport.js";
      import type { Pick, Wrapper } from "./counterfeit-types.js";

      export type CounterfeitPick = Pick<Run, "runId">;
      export type SchemaWrapper = Wrapper<typeof RunSchema>;
      export type SchemaMetadata = typeof RunSchema["fields"];
    `
  );
  await writeFile(
    path.join(projectRoot, "manual.ts"),
    `export type ManualRun = { readonly runId: string };`
  );
  await writeFile(
    path.join(projectRoot, "derived-manual.ts"),
    `
      import type { ManualRun } from "./manual.js";
      export type ManualRunSummary = Pick<ManualRun, "runId">;
    `
  );
  await writeFile(
    path.join(projectRoot, "fake-type.ts"),
    `
      const FakeSchema = { Type: { runId: "run-1" } };
      export type FakeRun = typeof FakeSchema.Type;
      export type FakeRunIndexed = typeof FakeSchema["Type"];
    `
  );
  await writeFile(
    path.join(projectRoot, "capability.ts"),
    `
      import type { Run } from "./schema.js";
      export type RunStore = {
        readonly load: (
          input: { readonly runId: string },
          authorizationDigest: string
        ) => Promise<Run>;
      };
    `
  );
  await writeFile(
    path.join(projectRoot, "valid-capability.ts"),
    `
      import type { Run, RunId } from "./schema.js";
      export type RunStore = {
        readonly load: (runId: RunId) => Promise<Run>;
        readonly save: (run: Run) => Promise<void>;
      };
    `
  );
  await writeFile(
    path.join(projectRoot, "framework.tsx"),
    `
      import type { ReactNode } from "react";
      import type { RunId } from "./schema.js";
      export type ConfirmationProps = {
        readonly children: ReactNode;
        readonly displayName?: string;
        readonly runId: RunId;
        readonly onSelect: (runId: RunId) => void;
      };
    `
  );
  await writeFile(
    path.join(projectRoot, "framework-interface.tsx"),
    `
      import type { ReactNode } from "react";
      import type { RunId } from "./schema.js";
      export interface ConfirmationProps {
        readonly children: ReactNode;
        readonly title: string;
        readonly runId: RunId;
        readonly onSelect: (runId: RunId) => void;
      }
    `
  );
  await writeFile(
    path.join(projectRoot, "mixed-framework.tsx"),
    `
      export type DeliveryMergeConfirmationProps = {
        readonly runId: string;
        readonly pullRequestUrl: string;
        readonly headSha: string;
        readonly onConfirm: () => void;
      };
    `
  );
  await writeFile(
    path.join(projectRoot, "brand-casts.ts"),
    `
      import type {
        HarnessName,
        Run,
        RunId as ImportedRunId,
        RunMap,
        RunWithHarness,
      } from "./reexport.js";
      import type { Option } from "effect";

      declare const raw: string;
      export const imported = raw as ImportedRunId;
      export const angle = <ImportedRunId>raw;
      export const chained = raw as unknown as ImportedRunId;
      export const nonId = raw as HarnessName;
      export const property = raw as Run;
      export const tuple = raw as readonly [ImportedRunId];
      export const array = raw as ReadonlyArray<ImportedRunId>;
      export const container = raw as Option<ImportedRunId>;
      export const union = raw as ImportedRunId | undefined;
      export const intersection = raw as RunWithHarness;
      export const record = raw as unknown as RunMap;
      export const literal = { raw } as const;
    `
  );
  await writeFile(
    path.join(projectRoot, "structural-spoof.ts"),
    `
      type StructuralSpoof = string & {
        readonly ["~effect/Brand"]: { readonly Spoof: "Spoof" };
      };
      export const spoof = "spoof" as StructuralSpoof;
    `
  );

  const diagnostics = analyzeSchemaContracts({
    cwd: projectRoot,
    projectPath: path.join(projectRoot, "tsconfig.json"),
  });

  assert.deepEqual(
    diagnostics.map(({ filePath, rule }) => ({ filePath, rule })),
    [
      {
        filePath: "brand-casts.ts",
        rule: "gaia/no-brand-cast",
      },
      {
        filePath: "brand-casts.ts",
        rule: "gaia/no-brand-cast",
      },
      {
        filePath: "brand-casts.ts",
        rule: "gaia/no-brand-cast",
      },
      {
        filePath: "brand-casts.ts",
        rule: "gaia/no-brand-cast",
      },
      {
        filePath: "brand-casts.ts",
        rule: "gaia/no-brand-cast",
      },
      {
        filePath: "brand-casts.ts",
        rule: "gaia/no-brand-cast",
      },
      {
        filePath: "brand-casts.ts",
        rule: "gaia/no-brand-cast",
      },
      {
        filePath: "brand-casts.ts",
        rule: "gaia/no-brand-cast",
      },
      {
        filePath: "brand-casts.ts",
        rule: "gaia/no-brand-cast",
      },
      {
        filePath: "brand-casts.ts",
        rule: "gaia/no-brand-cast",
      },
      {
        filePath: "brand-casts.ts",
        rule: "gaia/no-brand-cast",
      },
      {
        filePath: "capability.ts",
        rule: "gaia/schema-first-data-contract",
      },
      {
        filePath: "counterfeit.ts",
        rule: "gaia/schema-first-data-contract",
      },
      {
        filePath: "counterfeit.ts",
        rule: "gaia/schema-first-data-contract",
      },
      {
        filePath: "counterfeit.ts",
        rule: "gaia/schema-first-data-contract",
      },
      {
        filePath: "derived-manual.ts",
        rule: "gaia/schema-first-data-contract",
      },
      {
        filePath: "fake-type.ts",
        rule: "gaia/schema-first-data-contract",
      },
      {
        filePath: "fake-type.ts",
        rule: "gaia/schema-first-data-contract",
      },
      {
        filePath: "manual.ts",
        rule: "gaia/schema-first-data-contract",
      },
      {
        filePath: "mixed-framework.tsx",
        rule: "gaia/schema-first-data-contract",
      },
      {
        filePath: "structural-spoof.ts",
        rule: "gaia/schema-first-data-contract",
      },
    ]
  );
  assert.equal(
    diagnostics.some(
      (diagnostic) =>
        diagnostic.filePath === "structural-spoof.ts" &&
        diagnostic.rule === "gaia/no-brand-cast"
    ),
    false,
    "a local structural marker must not acquire Effect Brand provenance"
  );
  assert.match(diagnostics.at(-1).remedy, /owning Effect Schema/u);

  const syntaxFailurePath = path.join(projectRoot, "syntax-failure.mjs");
  const ownershipFailurePath = path.join(projectRoot, "ownership-failure.mjs");
  await writeFile(
    syntaxFailurePath,
    `
      process.stdout.write(
        ${JSON.stringify(
          `${path.join(projectRoot, "syntax.ts")}:1:2 gaia/schema-first-data-contract syntax finding Remedy: define a Schema\n`
        )}
      );
      process.exitCode = 1;
    `
  );
  await writeFile(
    ownershipFailurePath,
    `
      process.stdout.write(
        ${JSON.stringify(
          `${path.join(projectRoot, "ownership.ts")}:3:4 gaia/no-brand-cast ownership finding Remedy: decode with the owning Schema\n`
        )}
      );
      process.exitCode = 1;
    `
  );
  await writeFile(
    path.join(projectRoot, "audit-syntax.ts"),
    `export type AuditManualRun = { readonly runId: string };`
  );

  const audit = runSchemaContractAudit({
    cwd: projectRoot,
    ownership: {
      args: [ownershipFailurePath],
      command: process.execPath,
      format: "normalized",
    },
    syntax: {
      args: [syntaxFailurePath],
      command: process.execPath,
      format: "normalized",
    },
  });
  assert.equal(audit.status, 1);
  assert.deepEqual(audit.diagnostics, [
    "syntax.ts:1:2 gaia/schema-first-data-contract syntax finding Remedy: define a Schema",
    "ownership.ts:3:4 gaia/no-brand-cast ownership finding Remedy: decode with the owning Schema",
  ]);

  const temporaryAuditDirectoriesBefore = new Set(
    (await readdir(projectRoot)).filter((entry) =>
      entry.startsWith("gaia-schema-contract-audit-")
    )
  );
  const isolatedAudit = runSchemaContractAudit({
    cwd: projectRoot,
    ownership: {
      args: [ownershipFailurePath],
      command: process.execPath,
      format: "normalized",
    },
    syntaxTargets: ["audit-syntax.ts"],
    temporaryRoot: projectRoot,
  });
  const temporaryAuditDirectoriesAfter = new Set(
    (await readdir(projectRoot)).filter((entry) =>
      entry.startsWith("gaia-schema-contract-audit-")
    )
  );
  assert.equal(isolatedAudit.status, 1);
  assert.match(isolatedAudit.raw.syntax.stdout, /gaia\(/u);
  assert.match(isolatedAudit.raw.ownership.stdout, /gaia\//u);
  assert.deepEqual(
    isolatedAudit.diagnostics.map((diagnostic) =>
      diagnostic.replace(/^audit-syntax\.ts:\d+:\d+/u, "audit-syntax.ts")
    ),
    [
      "audit-syntax.ts gaia/schema-first-data-contract Serializable data contracts must originate in Effect Schema. Remedy: define the owning Schema and derive its Type.",
      "audit-syntax.ts gaia/no-unbranded-domain-string Semantic field 'runId' must use a branded schema-derived value. Remedy: parse with the owning Schema and carry the branded value inward.",
      "ownership.ts:3:4 gaia/no-brand-cast ownership finding Remedy: decode with the owning Schema",
    ]
  );
  assert.deepEqual(
    temporaryAuditDirectoriesAfter,
    temporaryAuditDirectoriesBefore,
    "the audit-only Oxlint config must be removed after the run"
  );
} finally {
  await rm(projectRoot, { force: true, recursive: true });
}
