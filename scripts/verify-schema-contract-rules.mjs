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
          import { setup } from "xstate";

          type ActionParams = {
            readonly recordRun: undefined;
          };
          type GuardParams = {
            readonly canRun: undefined;
          };
          setup<
            Context,
            Event,
            Record<never, never>,
            Record<never, string>,
            ActionParams,
            GuardParams
          >({});
        `,
        filename: "machine.ts",
      },
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
      {
        code: `
          type SidebarContextProps = {
            readonly state: "expanded" | "collapsed";
            readonly open: boolean;
            readonly setOpen: (open: boolean) => void;
            readonly openMobile: boolean;
            readonly setOpenMobile: (open: boolean) => void;
            readonly isMobile: boolean;
            readonly toggleSidebar: () => void;
          };
        `,
        filename: "sidebar.tsx",
      },
      {
        code: `
          type CommandApprovalRequest = Extract<
            CodexServerRequest,
            { readonly method: "item/commandExecution/requestApproval" }
          >;
        `,
        filename: "packages/runtime/src/codex-app-server-protocol.ts",
      },
      {
        code: `
          function Card({
            className,
            size = "default",
            ...props
          }: React.ComponentProps<"div"> & { size?: "default" | "sm" }) {
            return <div className={className} {...props} />;
          }
        `,
        filename: "card.tsx",
      },
      {
        code: `
          function RootDocument({
            children,
          }: Readonly<{ children: ReactNode }>) {
            return <html>{children}</html>;
          }
        `,
        filename: "__root.tsx",
      },
      {
        code: `
          declare module "@tanstack/react-router" {
            interface Register {
              router: ReturnType<typeof getRouter>;
            }
          }
        `,
        filename: "apps/dashboard/src/router.tsx",
      },
    ],
    invalid: [
      {
        code: `
          import { setup } from "xstate";
          type ExactMetadata = { readonly exact: undefined };
          type RecordMetadata = Record<string, undefined>;
          setup<Context, Event, Record<never, never>, Record<never, string>, RecordMetadata, ExactMetadata>({});
        `,
        errors: [{ messageId: "schemaFirst" }],
        filename: "xstate-record-metadata.ts",
      },
      {
        code: `
          import { setup } from "xstate";
          type ExactMetadata = { readonly exact: undefined };
          type MappedMetadata = {
            readonly [Key in "recordRun"]: undefined;
          };
          setup<Context, Event, Record<never, never>, Record<never, string>, MappedMetadata, ExactMetadata>({});
        `,
        errors: [{ messageId: "schemaFirst" }],
        filename: "xstate-mapped-metadata.ts",
      },
      {
        code: `
          import { setup } from "xstate";
          type ExactMetadata = { readonly exact: undefined };
          type GenericMetadata<Key extends string> = {
            readonly [Name in Key]: undefined;
          };
          setup<Context, Event, Record<never, never>, Record<never, string>, GenericMetadata<"recordRun">, ExactMetadata>({});
        `,
        errors: [{ messageId: "schemaFirst" }],
        filename: "xstate-generic-metadata.ts",
      },
      {
        code: `
          import { setup } from "xstate";
          type ExactMetadata = { readonly exact: undefined };
          type ArbitraryMetadata = { readonly recordRun: string };
          setup<Context, Event, Record<never, never>, Record<never, string>, ArbitraryMetadata, ExactMetadata>({});
        `,
        errors: [{ messageId: "schemaFirst" }],
        filename: "xstate-arbitrary-metadata.ts",
      },
      {
        code: `
          import { setup } from "xstate";
          type ExactMetadata = { readonly exact: undefined };
          type MixedMetadata = {
            readonly recordRun: undefined;
            readonly onRun: () => void;
          };
          setup<Context, Event, Record<never, never>, Record<never, string>, MixedMetadata, ExactMetadata>({});
        `,
        errors: [{ messageId: "schemaFirst" }],
        filename: "xstate-mixed-metadata.ts",
      },
      {
        code: `
          import { setup } from "xstate";
          type ExactMetadata = { readonly exact: undefined };
          type CallbackMetadata = {
            readonly onRun: () => void;
          };
          setup<Context, Event, Record<never, never>, Record<never, string>, CallbackMetadata, ExactMetadata>({});
        `,
        errors: [{ messageId: "schemaFirst" }],
        filename: "xstate-callback-metadata.ts",
      },
      {
        code: `
          import { setup } from "xstate";
          type ExactMetadata = { readonly exact: undefined };
          type HiddenMetadata = {
            readonly recordRun: { readonly runId: string };
          };
          setup<Context, Event, Record<never, never>, Record<never, string>, HiddenMetadata, ExactMetadata>({});
        `,
        errors: 2,
        filename: "xstate-hidden-metadata.ts",
      },
      {
        code: `
          import { setup } from "xstate";
          type MutableMetadata = { recordRun: undefined };
          type OptionalMetadata = { readonly recordRun?: undefined };
          type DataMetadata = { readonly recordRun: unknown };
          setup<Context, Event, Record<never, never>, Record<never, string>, MutableMetadata, OptionalMetadata>({});
          setup<Context, Event, Record<never, never>, Record<never, string>, DataMetadata, MutableMetadata>({});
        `,
        errors: 3,
        filename: "xstate-inexact-metadata.ts",
      },
      {
        code: `
          import { setup } from "./counterfeit-xstate";
          type CounterfeitMetadata = { readonly recordRun: undefined };
          setup<Context, Event, Record<never, never>, Record<never, string>, CounterfeitMetadata, CounterfeitMetadata>({});
        `,
        errors: [{ messageId: "schemaFirst" }],
        filename: "counterfeit-xstate.ts",
      },
      {
        code: `
          import { setup } from "xstate";
          type ShadowedMetadata = { readonly recordRun: undefined };
          function build(setup: GenericSetup) {
            setup<Context, Event, Record<never, never>, Record<never, string>, ShadowedMetadata, ShadowedMetadata>({});
          }
        `,
        errors: [{ messageId: "schemaFirst" }],
        filename: "shadowed-xstate.ts",
      },
      {
        code: `
          import { setup } from "xstate";
          type WrongPositionMetadata = { readonly recordRun: undefined };
          type ExactMetadata = { readonly exact: undefined };
          setup<Context, Event, WrongPositionMetadata, Record<never, string>, ExactMetadata, ExactMetadata>({});
        `,
        errors: [{ messageId: "schemaFirst" }],
        filename: "xstate-wrong-position.ts",
      },
      {
        code: `
          import { setup } from "xstate";
          export type ExportedMetadata = { readonly recordRun: undefined };
          setup<Context, Event, Record<never, never>, Record<never, string>, ExportedMetadata, ExportedMetadata>({});
        `,
        errors: [{ messageId: "schemaFirst" }],
        filename: "xstate-exported-metadata.ts",
      },
      {
        code: `
          import { setup } from "xstate";
          type ReusedMetadata = { readonly recordRun: undefined };
          type HiddenReuse = ReusedMetadata;
          setup<Context, Event, Record<never, never>, Record<never, string>, ReusedMetadata, ReusedMetadata>({});
        `,
        errors: [{ messageId: "schemaFirst" }],
        filename: "xstate-reused-metadata.ts",
      },
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
          type CounterfeitProviderProps = {
            readonly runId: string;
            readonly onConfirm: () => void;
          };
        `,
        errors: [{ messageId: "schemaFirst" }],
        filename: "packages/runtime/src/codex-app-server-protocol.tsx",
      },
      {
        code: `
          type WrappedReadonlyProps = {
            readonly data: Readonly<{ readonly runId: string }>;
            readonly onConfirm: () => void;
          };
        `,
        errors: 2,
        filename: "wrapped-readonly-props.tsx",
      },
      {
        code: `
          type WrappedReturnProps = {
            readonly data: ReturnType<typeof makeRunDto>;
            readonly onConfirm: () => void;
          };
        `,
        errors: [{ messageId: "schemaFirst" }],
        filename: "wrapped-return-props.tsx",
      },
      {
        code: `
          type CodexRawManualDto = {
            readonly runId: string;
          };
        `,
        errors: [{ messageId: "schemaFirst" }],
        filename: "packages/runtime/src/codex-app-server-protocol.ts",
      },
      {
        code: `
          const makeManualDto = () => ({ runId: "run-1" });
          interface Register {
            router: ReturnType<typeof makeManualDto>;
          }
        `,
        errors: [{ messageId: "schemaFirst" }],
        filename: "manual-register.tsx",
      },
      {
        code: `
          declare module "@tanstack/react-router" {
            interface Register {
              router: ReturnType<typeof getRouter>;
            }
          }
        `,
        errors: [{ messageId: "schemaFirst" }],
        filename: "router.tsx",
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
      {
        code: `
          type DeliveryMergeConfirmationData = {
            readonly sequence: DeliveryMergeDecisionSequence;
          };
        `,
        errors: [{ messageId: "schemaFirst" }],
        filename:
          "apps/dashboard/src/components/not-delivery-merge-confirmation.tsx",
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
      {
        code: `
          const CodexRawFileChangeSchema = Schema.Struct({
            kind: Schema.String,
            path: Schema.String,
          });
        `,
        filename: "packages/runtime/src/codex-app-server-protocol.ts",
      },
      {
        code: `
          class PinnedCodexSchemaSet extends Schema.Class<PinnedCodexSchemaSet>(
            "PinnedCodexSchemaSet"
          )({
            facts: Schema.Struct({
              threadTimestampFormats: Schema.Struct({
                createdAt: Schema.String,
                updatedAt: Schema.String,
              }),
              turnTimingFormats: Schema.Struct({
                completedAt: Schema.String,
                durationMs: Schema.String,
                startedAt: Schema.String,
              }),
            }),
          }) {}
        `,
        filename:
          "packages/runtime/src/codex-app-server-0.137.0-schema-parity.test.ts",
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
      {
        code: `
          const CodexRawGaiaOwnedSchema = Schema.Struct({
            runId: Schema.String,
          });
        `,
        errors: [{ messageId: "unbrandedDomainString" }],
        filename: "packages/runtime/src/codex-app-server-protocol.ts",
      },
      {
        code: `
          const CodexRawFileChangeSchema = Schema.Struct({
            runId: Schema.String,
          });
        `,
        errors: [{ messageId: "unbrandedDomainString" }],
        filename: "packages/runtime/src/codex-app-server-protocol.ts",
      },
      {
        code: `
          const CodexRawFileChangeSchema = Schema.Struct({
            kind: Schema.String,
            path: Schema.String,
          });
        `,
        errors: [{ messageId: "unbrandedDomainString" }],
        filename: "apps/dashboard/src/codex-app-server-protocol.ts",
      },
      {
        code: `
          class PinnedCodexSchemaSet extends Schema.Class<PinnedCodexSchemaSet>(
            "PinnedCodexSchemaSet"
          )({
            facts: Schema.Struct({
              threadTimestampFormats: Schema.Struct({
                createdAt: Schema.String,
              }),
            }),
          }) {}
        `,
        errors: [{ messageId: "unbrandedDomainString" }],
        filename:
          "packages/runtime/src/codex-app-server-0.137.0-schema-parity-copy.test.ts",
      },
      {
        code: `
          const CodexRawProviderLookalikeSchema = Schema.Struct({
            path: Schema.String,
          });
        `,
        errors: [{ messageId: "unbrandedDomainString" }],
        filename: "packages/runtime/src/codex-app-server-protocol.ts",
      },
    ],
  }
);
