import { RuleTester } from "oxlint/plugins-dev";

import gaiaSchemaContractPlugin from "./oxlint/gaia-schema-contract-plugin.mjs";

const tester = new RuleTester({
  eslintCompat: true,
  languageOptions: {
    parserOptions: { lang: "ts" },
    sourceType: "module",
  },
});

tester.run(
  "gaia/schema-first-data-contract",
  gaiaSchemaContractPlugin.rules["schema-first-data-contract"],
  {
    valid: [
      {
        code: `
          const RunSchema = Schema.Struct({ runId: Schema.String });
          type Run = typeof RunSchema.Type;
        `,
        filename: "schema-derived.ts",
      },
      {
        code: `
          type RunStore = {
            readonly load: (runId: RunId) => Promise<Run>;
            readonly save: (run: Run) => Promise<void>;
          };
        `,
        filename: "capability.ts",
      },
      {
        code: `
          type ConfirmationProps = {
            readonly children: ReactNode;
            readonly displayName?: string;
            readonly onSelect: (selection: Selection) => void;
          };
        `,
        filename: "confirmation.tsx",
      },
    ],
    invalid: [
      {
        code: `type ManualRun = { readonly runId: string };`,
        errors: [
          {
            column: 6,
            line: 1,
            messageId: "schemaFirst",
          },
        ],
        filename: "manual-contract.ts",
      },
      {
        code: `
          type MixedProps = {
            readonly runId: string;
            readonly onConfirm: () => void;
          };
        `,
        errors: [{ messageId: "schemaFirst" }],
        filename: "mixed-props.tsx",
      },
      {
        code: `
          type RunStore = {
            readonly load: (input: { readonly runId: string }) => Promise<Run>;
          };
        `,
        errors: [{ messageId: "schemaFirst" }],
        filename: "nested-operation-input.ts",
      },
    ],
  }
);

tester.run(
  "gaia/no-brand-cast",
  gaiaSchemaContractPlugin.rules["no-brand-cast"],
  {
    valid: [
      {
        code: `const value = { runId: "run-1" } as const;`,
        filename: "const-assertion.ts",
      },
      {
        code: `
          type StructuralSpoof = string & {
            readonly ["~effect/Brand"]: { readonly Spoof: "Spoof" };
          };
          const value = "spoof" as StructuralSpoof;
        `,
        filename: "structural-spoof.ts",
      },
      {
        code: `const runId = value as RunId;`,
        filename: "imported-brand-candidate.ts",
      },
    ],
    invalid: [
      {
        code: `const runId = value as typeof RunIdSchema.Type;`,
        errors: [{ messageId: "brandCastCandidate" }],
        filename: "schema-type-assertion.ts",
      },
      {
        code: `const runId = <typeof RunIdSchema.Type>value;`,
        errors: [{ messageId: "brandCastCandidate" }],
        filename: "angle-brand-assertion.ts",
      },
      {
        code: `const runId = value as unknown as typeof RunIdSchema.Type;`,
        errors: [{ messageId: "brandCastCandidate" }],
        filename: "chained-brand-assertion.ts",
      },
    ],
  }
);

tester.run(
  "gaia/no-unbranded-domain-string",
  gaiaSchemaContractPlugin.rules["no-unbranded-domain-string"],
  {
    valid: [
      {
        code: `
          type DisplayCopy = {
            readonly displayName: string;
            readonly label: string;
            readonly title: string;
            readonly summary: string;
            readonly message: string;
            readonly description: string;
            readonly text: string;
            readonly content: string;
            readonly reason: string;
            readonly remediation: string;
          };
        `,
        filename: "display-copy.ts",
      },
      {
        code: `function parseRunId(input: string): RunId { return decode(input); }`,
        filename: "parse-run-id.ts",
      },
      {
        code: `const decodeWorkspacePath = (raw: unknown): WorkspacePath => decode(raw);`,
        filename: "decode-workspace-path.ts",
      },
      {
        code: `const input: string = "display copy";`,
        filename: "non-callable-raw-name.ts",
      },
      {
        code: `const parseRunId = function (input: string): RunId { return decode(input); };`,
        filename: "assigned-parser.ts",
      },
      {
        code: `const parsers = { decodeRunId(raw: string): RunId { return decode(raw); } };`,
        filename: "object-parser-method.ts",
      },
      {
        code: `class Parsers { parseRunId = (value: string): RunId => decode(value); }`,
        filename: "class-parser-property.ts",
      },
      {
        code: `const parseRunId = ((input: string): RunId => decode(input)) as Parser;`,
        filename: "wrapped-parser.ts",
      },
      {
        code: `
          function render() {
            const input: string = "display input";
            const value: string = "display value";
            const runId: string = "display run";
            const workspacePath: string = "display workspace";
            return input + value + runId + workspacePath;
          }
          function parseRunId(raw: unknown): RunId {
            const input: string = String(raw);
            return decode(input);
          }
        `,
        filename: "raw-named-locals.ts",
      },
      {
        code: `
          type Parser = {
            readonly parseRunId: (input: string) => RunId;
          };
          interface Decoder {
            readonly decodeRunId: (raw: string) => RunId;
          }
          type ParenthesizedParser = {
            readonly parseRunId: ((value: string) => RunId);
          };
        `,
        filename: "capability-parser-properties.ts",
      },
    ],
    invalid: [
      {
        code: `type ParserInput = { readonly runId: string };`,
        errors: [
          {
            column: 31,
            line: 1,
            messageId: "unbrandedDomainString",
          },
        ],
        filename: "trusted-parser-input.ts",
      },
      {
        code: `
          type SemanticStrings = {
            readonly runId: string;
            readonly workspacePath: string;
            readonly pullRequestUrl: string;
            readonly createdAt: string;
            readonly headSha: string;
            readonly gitOid: string;
            readonly evidenceDigest: string;
            readonly providerHandle: string;
            readonly sessionHandle: string;
            readonly branch: string;
            readonly command: string;
            readonly model: string;
            readonly version: string;
            readonly harnessName: string;
          };
        `,
        errors: 14,
        filename: "semantic-strings.ts",
      },
      {
        code: `type Store = { load(authorizationDigest: string): Promise<void> };`,
        errors: [{ messageId: "unbrandedDomainString" }],
        filename: "callable-parameter.ts",
      },
      {
        code: `function loadRun(runId: string, workspacePath: string): void {}`,
        errors: [
          { messageId: "unbrandedDomainString" },
          { messageId: "unbrandedDomainString" },
        ],
        filename: "semantic-direct-parameters.ts",
      },
      {
        code: `function makeRunId(input: string): RunId { return input; }`,
        errors: [{ messageId: "unbrandedDomainString" }],
        filename: "make-run-id.ts",
      },
      {
        code: `interface RunFactory { (input: string): RunId }`,
        errors: [{ messageId: "unbrandedDomainString" }],
        filename: "call-signature-input.ts",
      },
      {
        code: `interface RunFactory { new (raw: string): RunId }`,
        errors: [{ messageId: "unbrandedDomainString" }],
        filename: "construct-signature-input.ts",
      },
      {
        code: `const makeRunId = function (input: string): RunId { return input; };`,
        errors: [{ messageId: "unbrandedDomainString" }],
        filename: "assigned-factory.ts",
      },
      {
        code: `const factories = { createRunId(raw: string): RunId { return raw; } };`,
        errors: [{ messageId: "unbrandedDomainString" }],
        filename: "object-factory-method.ts",
      },
      {
        code: `class Factory { makeRunId(value: string): RunId { return value; } }`,
        errors: [{ messageId: "unbrandedDomainString" }],
        filename: "class-factory-method.ts",
      },
      {
        code: `class Factory { createRunId = (input: string): RunId => input; }`,
        errors: [{ messageId: "unbrandedDomainString" }],
        filename: "class-factory-property.ts",
      },
      {
        code: `const makeRunId = ((input: string): RunId => input) as Factory;`,
        errors: [{ messageId: "unbrandedDomainString" }],
        filename: "wrapped-factory.ts",
      },
      {
        code: `const Run = Schema.Struct({ runId: Schema.String });`,
        errors: [{ messageId: "unbrandedDomainString" }],
        filename: "schema-string.ts",
      },
    ],
  }
);
