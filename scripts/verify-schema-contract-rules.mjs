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
          type ShadowedMetadata = { readonly recordRun: undefined };
          const build = function setup<A, B, C, D, E, F>(input: unknown) {
            void input;
            return setup<
              unknown,
              unknown,
              unknown,
              unknown,
              ShadowedMetadata,
              ShadowedMetadata
            >({});
          };
          void build;
        `,
        errors: [{ messageId: "schemaFirst" }],
        filename: "named-function-expression-shadowed-xstate.ts",
      },
      {
        code: `
          import { setup } from "xstate";
          type ShadowedMetadata = { readonly recordRun: undefined };
          const Machine = class setup<A, B, C, D, E, F> {
            static build(input: unknown) {
              void input;
              return setup<
                unknown,
                unknown,
                unknown,
                unknown,
                ShadowedMetadata,
                ShadowedMetadata
              >({});
            }
          };
          void Machine;
        `,
        errors: [{ messageId: "schemaFirst" }],
        filename: "named-class-expression-shadowed-xstate.ts",
      },
      {
        code: `
          import { setup } from "xstate";
          type GenericSetup = <A, B, C, D, E, F>(input: unknown) => unknown;
          type ShadowedMetadata = { readonly recordRun: undefined };
          class Machine {
            constructor(private readonly setup: GenericSetup) {
              setup<
                unknown,
                unknown,
                unknown,
                unknown,
                ShadowedMetadata,
                ShadowedMetadata
              >({});
            }
          }
          void Machine;
        `,
        errors: [{ messageId: "schemaFirst" }],
        filename: "parameter-property-shadowed-xstate.ts",
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
          type ReviewerName = typeof ReviewerNameSchema.Type;
          type MixedReviewerCapability = {
            readonly name: ReviewerName;
            readonly run: () => Promise<void>;
          };
          type ReviewerInjectionOptions = {
            readonly reviewer?: MixedReviewerCapability;
          };
        `,
        errors: [
          {
            line: 3,
            messageId: "schemaFirst",
          },
        ],
        filename: "capability-wrapper.ts",
      },
      {
        code: `
          type NoCallCapability = {
            readonly name: ReviewerName;
          };
          type NoCallOptions = {
            readonly reviewer?: NoCallCapability;
          };
        `,
        errors: 2,
        filename: "no-call-capability-wrapper.ts",
      },
      {
        code: `
          type MixedReviewerCapability = {
            readonly name: ReviewerName;
            readonly run: () => Promise<void>;
          };
          type RequiredCapabilityOptions = {
            readonly reviewer: MixedReviewerCapability;
          };
          type MutableCapabilityOptions = {
            reviewer?: MixedReviewerCapability;
          };
          type DataCapabilityOptions = {
            readonly reviewer?: MixedReviewerCapability;
            readonly runId?: RunId;
          };
        `,
        errors: 4,
        filename: "inexact-capability-wrappers.ts",
      },
      {
        code: `
          import type { OpaqueCapability } from "./opaque-capability.js";
          type OpaqueCapabilityOptions = {
            readonly capability?: OpaqueCapability;
          };
        `,
        errors: [{ messageId: "schemaFirst" }],
        filename: "opaque-capability-wrapper.ts",
      },
      {
        code: `
          type CircularCapability = {
            readonly next?: CircularCapability;
          };
          type CircularCapabilityOptions = {
            readonly capability?: CircularCapability;
          };
        `,
        errors: 2,
        filename: "circular-capability-wrapper.ts",
      },
      {
        code: `
          type MixedReviewerCapability = {
            readonly name: ReviewerName;
            readonly run: () => Promise<void>;
          };
          type CapabilityAlias = MixedReviewerCapability;
          type AliasedCapabilityOptions = {
            readonly capability?: CapabilityAlias;
          };
        `,
        errors: 2,
        filename: "aliased-capability-wrapper.ts",
      },
      {
        code: `
          type CallableCapability = {
            readonly run: () => void;
          };
          type GenericCapabilityOptions<Capability> = {
            readonly capability?: Capability;
          };
          type RecordCapabilityOptions = {
            readonly capability?: Record<string, CallableCapability>;
          };
          type MappedCapabilityOptions = {
            readonly capability?: {
              readonly [Name in "primary"]: CallableCapability;
            };
          };
        `,
        errors: 3,
        filename: "generic-capability-wrappers.ts",
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
          import { Schema } from "effect";

          const NeutralTargetUrlSchema = Schema.NonEmptyString.pipe(
            Schema.refine(isNetworkUrl, {
              identifier: "NeutralTargetUrl",
            }),
            Schema.brand("NeutralTargetUrl")
          );

          function isNetworkUrl(input: string): input is string {
            return input.startsWith("https://");
          }

          void NeutralTargetUrlSchema;
        `,
        filename: "canonical-refinement.ts",
      },
      {
        code: `
          import { Schema } from "effect";

          class ProseProjection extends Schema.Class<ProseProjection>(
            "ProseProjection"
          )({
            summary: Schema.NonEmptyString,
            surfaces: Schema.Array(Schema.NonEmptyString),
            title: Schema.NonEmptyString,
            verificationPrompts: Schema.Array(Schema.NonEmptyString),
          }) {}
          declare const suppliedCopy: string;

          function normalizeCopy(input: string) {
            return input.trim().toLowerCase();
          }

          function collectParagraphs(input: string) {
            return input
              .split(/\\r?\\n/u)
              .map((line) => line.trim())
              .filter((line) => line.length > 0);
          }

          function collectSurfaceHints(input: string) {
            return input.match(/packages\\/[a-z0-9./-]+/gu) ?? [];
          }

          function collectVerificationPrompts(input: string) {
            return collectParagraphs(input).filter((line) =>
              normalizeCopy(line).includes("verify")
            );
          }

          function firstDisplayLine(input: string) {
            return collectParagraphs(input)[0] ?? "Supplied prose.";
          }

          function fallbackDisplayText(input: string, fallback: string) {
            const normalized = input.trim();
            return normalized.length === 0 ? fallback : normalized;
          }

          const normalizeAlias = normalizeCopy;
          ProseProjection.make({
            summary: fallbackDisplayText(suppliedCopy, "Fallback summary."),
            surfaces: collectSurfaceHints(suppliedCopy).map(normalizeAlias),
            title: firstDisplayLine(suppliedCopy),
            verificationPrompts: collectVerificationPrompts(suppliedCopy),
          });
        `,
        filename: "closed-prose-graph.ts",
      },
      {
        code: `
          declare const suppliedSource: string;
          const forbiddenCastPattern = /\\bas\\b/u;

          function scanSourceText(input: string, startIndex: number) {
            let output = "";
            let index = startIndex;
            while (index < input.length) {
              if (input.charCodeAt(index) === 96) {
                const nested = scanTemplateText(input, index);
                output += nested.output;
                index = nested.index;
                continue;
              }
              output += input[index] ?? "";
              index += 1;
            }
            return { index, output };
          }

          function scanTemplateText(input: string, startIndex: number) {
            const expression = scanSourceText(input, startIndex + 1);
            return {
              index: expression.index,
              output: expression.output.replace(/[^\\n]/gu, " "),
            };
          }

          function containsForbiddenCast(input: string) {
            return forbiddenCastPattern.test(scanSourceText(input, 0).output);
          }

          if (containsForbiddenCast(suppliedSource)) {
            void suppliedSource;
          }
        `,
        filename: "closed-source-scanner.ts",
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
        code: `
          import { Schema } from "./fake-effect.js";
          const TargetUrlSchema = Schema.NonEmptyString.pipe(
            Schema.refine(isNetworkUrl),
            Schema.brand("TargetUrl")
          );
          function isNetworkUrl(input: string): input is string {
            return input.startsWith("https://");
          }
          void TargetUrlSchema;
        `,
        errors: [{ messageId: "unbrandedDomainString" }],
        filename: "counterfeit-refinement.ts",
      },
      {
        code: `
          import { Schema } from "effect";
          import { URL } from "./browser-address.js";

          const BrowserAddressSchema = Schema.NonEmptyString.pipe(
            Schema.refine(isBrowserAddress, {
              identifier: "BrowserAddress",
            }),
            Schema.brand("BrowserAddress")
          );

          function isBrowserAddress(input: string): input is string {
            const parsed = new URL(input);
            return parsed.protocol === "https:";
          }

          void BrowserAddressSchema;
        `,
        errors: [{ messageId: "unbrandedDomainString" }],
        filename: "import-shadowed-refinement.ts",
      },
      {
        code: `
          import { Schema as EffectSchema } from "effect";
          const TargetUrlSchema = EffectSchema.NonEmptyString.pipe(
            EffectSchema.refine(isNetworkUrl),
            EffectSchema.brand("TargetUrl")
          );
          function isNetworkUrl(input: string): input is string {
            return input.startsWith("https://");
          }
          void TargetUrlSchema;
        `,
        errors: [{ messageId: "unbrandedDomainString" }],
        filename: "aliased-refinement.ts",
      },
      {
        code: `
          import { Schema } from "effect";
          const TargetUrlSchema = Schema.NonEmptyString.pipe(
            Schema.refine(isNetworkUrl),
            Schema.brand("TargetUrl")
          );
          function isNetworkUrl(input: string): input is string {
            return input.startsWith("https://");
          }
          void isNetworkUrl;
          void TargetUrlSchema;
        `,
        errors: [{ messageId: "unbrandedDomainString" }],
        filename: "escaped-refinement-predicate.ts",
      },
      {
        code: `
          import { Schema } from "effect";
          const TargetUrlSchema = Schema.NonEmptyString.pipe(
            Schema.refine(isNetworkUrl)
          );
          function isNetworkUrl(input: string): input is string {
            return input.startsWith("https://");
          }
          void TargetUrlSchema;
        `,
        errors: [{ messageId: "unbrandedDomainString" }],
        filename: "unbranded-refinement.ts",
      },
      {
        code: `
          import { Schema } from "effect";
          function isNetworkUrl(input: string): boolean {
            return input.startsWith("https://");
          }
          const TargetUrlSchema = Schema.NonEmptyString.pipe(
            Schema.refine(isNetworkUrl),
            Schema.brand("TargetUrl")
          );
          void TargetUrlSchema;
        `,
        errors: [{ messageId: "unbrandedDomainString" }],
        filename: "boolean-refinement.ts",
      },
      {
        code: `
          import { Schema } from "effect";
          function isNetworkUrl(input: string): input is string {
            return input.startsWith("https://");
          }
          const build = function Schema() {
            return Schema.NonEmptyString.pipe(
              Schema.refine(isNetworkUrl),
              Schema.brand("TargetUrl")
            );
          };
          void build;
        `,
        errors: [{ messageId: "unbrandedDomainString" }],
        filename: "named-function-shadowed-refinement.ts",
      },
      {
        code: `
          import { Schema } from "effect";
          function isNetworkUrl(input: string): input is string {
            return input.startsWith("https://");
          }
          const Builder = class Schema {
            static build() {
              return Schema.NonEmptyString.pipe(
                Schema.refine(isNetworkUrl),
                Schema.brand("TargetUrl")
              );
            }
          };
          void Builder;
        `,
        errors: [{ messageId: "unbrandedDomainString" }],
        filename: "named-class-shadowed-refinement.ts",
      },
      {
        code: `
          import { Schema } from "effect";
          function isNetworkUrl(input: string): input is string {
            return input.startsWith("https://");
          }
          class Builder {
            constructor(private readonly Schema: typeof Schema) {
              Schema.NonEmptyString.pipe(
                Schema.refine(isNetworkUrl),
                Schema.brand("TargetUrl")
              );
            }
          }
          void Builder;
        `,
        errors: [{ messageId: "unbrandedDomainString" }],
        filename: "parameter-property-shadowed-refinement.ts",
      },
      {
        code: `
          import { Schema } from "effect";
          const candidates = ["https://example.test"].filter(isNetworkUrl);
          function isNetworkUrl(input: string): input is string {
            return input.startsWith("https://");
          }
          void Schema;
          void candidates;
        `,
        errors: [{ messageId: "unbrandedDomainString" }],
        filename: "array-filter-refinement.ts",
      },
      {
        code: `
          import { Schema } from "effect";
          declare const consumePredicate: (
            predicate: (text: string) => boolean
          ) => void;
          function isNetworkUrl(input: string): input is string {
            return input.startsWith("https://");
          }
          consumePredicate(isNetworkUrl);
          void Schema;
        `,
        errors: [{ messageId: "unbrandedDomainString" }],
        filename: "arbitrary-refinement-use.ts",
      },
      {
        code: `
          import { Schema } from "effect";
          function isNetworkUrl(input: string): input is string {
            return input.startsWith("https://");
          }
          function build(refine: typeof Schema.refine) {
            return Schema.NonEmptyString.pipe(
              refine(isNetworkUrl),
              Schema.brand("TargetUrl")
            );
          }
          void build;
        `,
        errors: [{ messageId: "unbrandedDomainString" }],
        filename: "shadowed-refine-binding.ts",
      },
      {
        code: `
          import { Schema } from "effect";
          declare const persist: (text: string) => void;
          const TargetUrlSchema = Schema.NonEmptyString.pipe(
            Schema.refine(isNetworkUrl),
            Schema.brand("TargetUrl")
          );
          function isNetworkUrl(input: string): input is string {
            persist(input);
            return input.startsWith("https://");
          }
          void TargetUrlSchema;
        `,
        errors: [{ messageId: "unbrandedDomainString" }],
        filename: "escaping-refinement-input.ts",
      },
      {
        code: `
          import { Schema } from "effect";
          declare const escape: { value: string };
          const NeutralTargetUrlSchema = Schema.NonEmptyString.pipe(
            Schema.refine(isNetworkUrl),
            Schema.brand("NeutralTargetUrl")
          );
          function isNetworkUrl(input: string): input is string {
            escape.value = input;
            return input.startsWith("https://");
          }
          void NeutralTargetUrlSchema;
        `,
        errors: [{ messageId: "unbrandedDomainString" }],
        filename: "refinement-non-call-write.ts",
      },
      {
        code: `
          declare const persist: (text: string) => void;
          declare const rawValue: string;
          function normalizeDisplayText(input: string) {
            return input.trim();
          }
          persist(normalizeDisplayText(rawValue));
        `,
        errors: [{ messageId: "unbrandedDomainString" }],
        filename: "operational-text-sink.ts",
      },
      {
        code: `
          declare const DisplayProjection: {
            make(input: { readonly summary: string }): unknown;
          };
          declare const rawValue: string;
          function forwardDisplayText(input: string) {
            return input;
          }
          DisplayProjection.make({ summary: forwardDisplayText(rawValue) });
        `,
        errors: [{ messageId: "unbrandedDomainString" }],
        filename: "identity-text-wrapper.ts",
      },
      {
        code: `
          declare const writeArtifact: (text: string) => void;
          declare const rawValue: string;
          function collectSurfaceHints(input: string) {
            return input.match(/packages\\/[a-z0-9./-]+/gu) ?? [];
          }
          writeArtifact(collectSurfaceHints(rawValue).join("\\n"));
        `,
        errors: [{ messageId: "unbrandedDomainString" }],
        filename: "path-looking-operational-sink.ts",
      },
      {
        code: `
          import { Schema } from "effect";
          declare const rawValue: string;
          declare const externalNormalize: (text: string) => string;
          class DisplayProjection extends Schema.Class<DisplayProjection>(
            "DisplayProjection"
          )({ summary: Schema.NonEmptyString }) {}
          function normalizeDisplayText(input: string) {
            return externalNormalize(input);
          }
          DisplayProjection.make({
            summary: normalizeDisplayText(rawValue),
          });
        `,
        errors: [{ messageId: "unbrandedDomainString" }],
        filename: "unresolved-prose-edge.ts",
      },
      {
        code: `
          declare const persist: (text: string) => void;
          declare const rawValue: string;
          function normalizeDisplayText(input: string) {
            return input.trim();
          }
          const normalized = normalizeDisplayText(rawValue);
          persist(normalized);
        `,
        errors: [{ messageId: "unbrandedDomainString" }],
        filename: "aliased-operational-text-sink.ts",
      },
      {
        code: `
          declare const register: (
            callback: (text: string) => string
          ) => void;
          function normalizeDisplayText(input: string) {
            return input.trim();
          }
          register(normalizeDisplayText);
        `,
        errors: [{ messageId: "unbrandedDomainString" }],
        filename: "open-callback-edge.ts",
      },
      {
        code: `
          import { Schema } from "effect";
          declare const provider: {
            map(callback: (text: string) => string): string;
          };
          class DisplayProjection extends Schema.Class<DisplayProjection>(
            "DisplayProjection"
          )({ summary: Schema.NonEmptyString }) {}
          function normalizeDisplayText(input: string) {
            return input.trim();
          }
          DisplayProjection.make({
            summary: provider.map(normalizeDisplayText),
          });
        `,
        errors: [{ messageId: "unbrandedDomainString" }],
        filename: "counterfeit-text-method.ts",
      },
      {
        code: `
          import { Schema } from "effect";
          declare const suppliedCopy: string;
          declare class ProjectionReceiver {
            map(callback: () => string): string;
          }
          declare const receiver: ProjectionReceiver;
          class DisplayProjection extends Schema.Class<DisplayProjection>(
            "DisplayProjection"
          )({ summary: Schema.NonEmptyString }) {}
          function renderCopy(
            candidate: ProjectionReceiver,
            input: string
          ) {
            return candidate.map(() => input.trim());
          }
          DisplayProjection.make({
            summary: renderCopy(receiver, suppliedCopy),
          });
        `,
        errors: [{ messageId: "unbrandedDomainString" }],
        filename: "parameter-receiver-map.ts",
      },
      {
        code: `
          import { Schema } from "effect";
          declare const suppliedCopy: string;
          declare class ProjectionReceiver {
            map(callback: () => string): string;
          }
          declare const receivers: ReadonlyArray<ProjectionReceiver>;
          class DisplayProjection extends Schema.Class<DisplayProjection>(
            "DisplayProjection"
          )({ summary: Schema.NonEmptyString }) {}
          function renderCopy(
            candidates: ReadonlyArray<ProjectionReceiver>,
            input: string
          ) {
            return candidates
              .map((candidate) => candidate.map(() => input.trim()))
              .join("");
          }
          DisplayProjection.make({
            summary: renderCopy(receivers, suppliedCopy),
          });
        `,
        errors: [{ messageId: "unbrandedDomainString" }],
        filename: "callback-counterfeit-receiver.ts",
      },
      {
        code: `
          import { Schema } from "effect";
          declare const suppliedCopy: string;
          declare class ProjectionReceiver {
            map(callback: () => string): string;
          }
          declare const request: {
            readonly receivers: ReadonlyArray<ProjectionReceiver>;
          };
          class DisplayProjection extends Schema.Class<DisplayProjection>(
            "DisplayProjection"
          )({ summary: Schema.NonEmptyString }) {}
          function renderCopy(
            payload: {
              readonly receivers: ReadonlyArray<ProjectionReceiver>;
            },
            input: string
          ) {
            return payload.receivers
              .map((candidate) => candidate.map(() => input.trim()))
              .join("");
          }
          DisplayProjection.make({
            summary: renderCopy(request, suppliedCopy),
          });
        `,
        errors: [{ messageId: "unbrandedDomainString" }],
        filename: "readonly-field-callback-counterfeit-receiver.ts",
      },
      {
        code: `
          import { Schema } from "effect";
          declare const suppliedCopy: string;
          declare class ProjectionReceiver {
            map(callback: () => string): string;
          }
          declare const receiver: ProjectionReceiver;
          class DisplayProjection extends Schema.Class<DisplayProjection>(
            "DisplayProjection"
          )({ summary: Schema.NonEmptyString }) {}
          function renderCopy(candidate: ProjectionReceiver, input: string) {
            const candidates = [candidate];
            return candidates
              .map((item) => item.map(() => input.trim()))
              .join("");
          }
          DisplayProjection.make({
            summary: renderCopy(receiver, suppliedCopy),
          });
        `,
        errors: [{ messageId: "unbrandedDomainString" }],
        filename: "local-array-callback-counterfeit-receiver.ts",
      },
      {
        code: `
          import { Schema } from "effect";
          declare const suppliedCopy: string;
          declare class ProjectionReceiver {
            map(callback: () => string): string;
          }
          declare const receiver: ProjectionReceiver;
          class DisplayProjection extends Schema.Class<DisplayProjection>(
            "DisplayProjection"
          )({ summary: Schema.NonEmptyString }) {}
          function renderCopy(candidate: ProjectionReceiver, input: string) {
            const candidates = [...new Set([candidate])];
            return candidates
              .map((item) => item.map(() => input.trim()))
              .join("");
          }
          DisplayProjection.make({
            summary: renderCopy(receiver, suppliedCopy),
          });
        `,
        errors: [{ messageId: "unbrandedDomainString" }],
        filename: "constructed-set-callback-counterfeit-receiver.ts",
      },
      {
        code: `
          import { Schema } from "effect";
          declare const suppliedCopy: string;
          declare class ProjectionReceiver {
            map(callback: () => string): string;
          }
          declare const receivers: ReadonlyArray<ProjectionReceiver>;
          class DisplayProjection extends Schema.Class<DisplayProjection>(
            "DisplayProjection"
          )({ summary: Schema.NonEmptyString }) {}
          function renderCopy(
            candidates: ReadonlyArray<ProjectionReceiver>,
            input: string
          ) {
            const wrapped = [...new Set(candidates)];
            return wrapped
              .map((item) => item.map(() => input.trim()))
              .join("");
          }
          DisplayProjection.make({
            summary: renderCopy(receivers, suppliedCopy),
          });
        `,
        errors: [{ messageId: "unbrandedDomainString" }],
        filename: "constructed-set-parameter-counterfeit-receiver.ts",
      },
      {
        code: `
          import { Schema } from "effect";
          declare const suppliedCopy: string;
          declare class ProjectionReceiver {
            map(callback: () => string): string;
          }
          declare const receiver: ProjectionReceiver;
          class DisplayProjection extends Schema.Class<DisplayProjection>(
            "DisplayProjection"
          )({ summary: Schema.NonEmptyString }) {}
          function hold<T>(value: T) {
            "decoy".trim();
            return value;
          }
          function renderCopy(candidate: ProjectionReceiver, input: string) {
            const candidates = [hold(candidate)];
            return candidates
              .map((item) => item.map(() => input.trim()))
              .join("");
          }
          DisplayProjection.make({
            summary: renderCopy(receiver, suppliedCopy),
          });
        `,
        errors: [{ messageId: "unbrandedDomainString" }],
        filename: "helper-call-callback-counterfeit-receiver.ts",
      },
      {
        code: `
          import { Schema } from "effect";
          declare const suppliedCopy: string;
          declare class ProjectionReceiver {
            map(callback: () => string): string;
          }
          declare const receivers: ReadonlyArray<ProjectionReceiver>;
          class DisplayProjection extends Schema.Class<DisplayProjection>(
            "DisplayProjection"
          )({ summary: Schema.NonEmptyString }) {}
          function hold(candidates: ReadonlyArray<ProjectionReceiver>) {
            "decoy".trim();
            return candidates;
          }
          function renderCopy(
            candidates: ReadonlyArray<ProjectionReceiver>,
            input: string
          ) {
            const wrapped = [...hold(candidates)];
            return wrapped
              .map((item) => item.map(() => input.trim()))
              .join("");
          }
          DisplayProjection.make({
            summary: renderCopy(receivers, suppliedCopy),
          });
        `,
        errors: [{ messageId: "unbrandedDomainString" }],
        filename: "helper-collection-counterfeit-receiver.ts",
      },
      {
        code: `
          import { Schema } from "effect";
          declare const suppliedCopy: string;
          type ProjectionReceiver = {
            readonly map: (callback: () => string) => string;
          } & (() => void);
          const ProjectionReceiverSchema = Schema.declare<ProjectionReceiver>(
            (input): input is ProjectionReceiver =>
              typeof input === "function"
          );
          class ReceiverBatch extends Schema.Class<ReceiverBatch>(
            "ReceiverBatch"
          )({ receivers: Schema.Array(ProjectionReceiverSchema) }) {}
          declare const batch: ReceiverBatch;
          class DisplayProjection extends Schema.Class<DisplayProjection>(
            "DisplayProjection"
          )({ summary: Schema.NonEmptyString }) {}
          function selectReceivers(payload: ReceiverBatch) {
            "decoy".trim();
            return payload.receivers;
          }
          function renderCopy(payload: ReceiverBatch, input: string) {
            return selectReceivers(payload)
              .map((candidate) => candidate.map(() => input.trim()))
              .join("");
          }
          DisplayProjection.make({
            summary: renderCopy(batch, suppliedCopy),
          });
        `,
        errors: [{ messageId: "unbrandedDomainString" }],
        filename: "helper-schema-field-counterfeit-receiver.ts",
      },
      {
        code: `
          import { Schema } from "effect";
          declare const suppliedCopy: string;
          declare const preferPrimary: boolean;
          declare class ProjectionReceiver {
            map(callback: () => string): string;
          }
          type ReceiverBatch = {
            readonly primary: ReadonlyArray<ProjectionReceiver>;
            readonly fallback: ReadonlyArray<ProjectionReceiver>;
          };
          declare const batch: ReceiverBatch;
          class DisplayProjection extends Schema.Class<DisplayProjection>(
            "DisplayProjection"
          )({ summary: Schema.NonEmptyString }) {}
          function selectReceivers(
            payload: ReceiverBatch,
            usePrimary: boolean
          ) {
            "decoy".trim();
            return usePrimary ? payload.primary : payload.fallback;
          }
          const selectAlias = selectReceivers;
          function renderCopy(
            payload: ReceiverBatch,
            input: string,
            usePrimary: boolean
          ) {
            return selectAlias(payload, usePrimary)
              .map((candidate) => candidate.map(() => input.trim()))
              .join("");
          }
          DisplayProjection.make({
            summary: renderCopy(batch, suppliedCopy, preferPrimary),
          });
        `,
        errors: [{ messageId: "unbrandedDomainString" }],
        filename: "helper-alias-conditional-field-counterfeit-receiver.ts",
      },
      {
        code: `
          import { Schema } from "effect";
          declare const rawValue: string;
          const RunIdSchema = Schema.String.pipe(Schema.brand("RunId"));
          class SemanticProjection extends Schema.Class<SemanticProjection>(
            "SemanticProjection"
          )({ runId: RunIdSchema }) {}
          function normalizeDisplayText(input: string) {
            return input.trim();
          }
          SemanticProjection.make({
            runId: normalizeDisplayText(rawValue),
          });
        `,
        errors: [{ messageId: "unbrandedDomainString" }],
        filename: "schema-owned-semantic-laundering.ts",
      },
      {
        code: `
          import { Schema } from "effect";
          declare const rawValue: string;
          const RunIdSchema = Schema.String.pipe(Schema.brand("RunId"));
          class SemanticProjection extends Schema.Class<SemanticProjection>(
            "SemanticProjection"
          )({ value: RunIdSchema }) {}
          function normalizeDisplayText(input: string) {
            return input.trim();
          }
          SemanticProjection.make({
            value: normalizeDisplayText(rawValue),
          });
        `,
        errors: [{ messageId: "unbrandedDomainString" }],
        filename: "declaration-linked-semantic-field.ts",
      },
      {
        code: `
          import { Schema } from "effect";
          declare const rawValue: string;
          class DisplayProjection extends Schema.Class<DisplayProjection>(
            "DisplayProjection"
          )({ summary: Schema.NonEmptyString }) {}
          function normalizeDisplayText(input: string) {
            return input.trim();
          }
          const semanticRecord = {
            runId: normalizeDisplayText(rawValue),
          };
          DisplayProjection.make({
            summary: normalizeDisplayText(rawValue),
          });
          void semanticRecord;
        `,
        errors: [{ messageId: "unbrandedDomainString" }],
        filename: "prose-result-object-escape.ts",
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
