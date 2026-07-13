import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import { runSchemaContractAudit } from "./audit-schema-contracts.mjs";
import { analyzeSchemaContracts } from "./check-schema-contract-ownership.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const brandDiagnostic = (filePath, line, column) => ({
  column,
  filePath,
  line,
  message:
    "Type assertion manufactures a compiler-proven Effect branded value.",
  remedy:
    "Decode with the owning Effect Schema or parser and carry its branded result inward.",
  rule: "gaia/no-brand-cast",
});
const schemaDiagnostic = (
  filePath,
  line,
  column,
  message = "Serializable data contract has no compiler-proven Schema origin."
) => ({
  column,
  filePath,
  line,
  message,
  remedy:
    "Define the owning Effect Schema and derive this contract from its decoded Type.",
  rule: "gaia/schema-first-data-contract",
});
const projectRoot = await mkdtemp(
  path.join(
    repoRoot,
    "packages/runtime/node_modules/.gaia-schema-contract-ownership-"
  )
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
      import { Schema } from "effect";
      import { HttpApiEndpoint, HttpApiSchema } from "effect/unstable/httpapi";
      import { RunDto as RunDtoSchemaClass } from "./schema.js";
      import { RunIdSchema, RunSchema } from "./reexport.js";
      import type { Run, RunDto } from "./reexport.js";
      export type RunSummary = Pick<Run, "runId">;
      export type RunDtoSummary = Pick<RunDto, "runId">;
      export type RunIndexed = typeof RunSchema["Type"];
      export type RunIdViaCanonicalUtility =
        Schema.Schema.Type<typeof RunIdSchema>;
      const AnnotatedRunSchema = RunSchema.annotate({ title: "Run" });
      export type AnnotatedRun = typeof AnnotatedRunSchema.Type;
      const CurriedAnnotatedRunSchema = Schema.annotate({ title: "Run" })(
        RunSchema
      );
      export type CurriedAnnotatedRun = typeof CurriedAnnotatedRunSchema.Type;
      const LocalBaseSchema = Schema.String.pipe(
        Schema.annotate({ title: "LocalBase" })
      );
      const LocalDerivedSchema = LocalBaseSchema.pipe(
        Schema.brand("LocalDerived")
      );
      export type LocalDerived = typeof LocalDerivedSchema.Type;
      const LocalStructSchema = Schema.Struct({ value: LocalBaseSchema });
      export type LocalStruct = typeof LocalStructSchema.Type;
      const RealArraySchema = Schema.Array(RunIdSchema);
      export type RealArray = typeof RealArraySchema.Type;
      const RealStructSchema = Schema.Struct({ value: RunIdSchema });
      export type RealStruct = typeof RealStructSchema.Type;
      const RealUnionSchema = Schema.Union([RunIdSchema, Schema.String]);
      export type RealUnion = typeof RealUnionSchema.Type;
      const RealRecordSchema = Schema.Record(Schema.String, RunIdSchema);
      export type RealRecord = typeof RealRecordSchema.Type;
      const RealFieldRecord = { value: RunIdSchema };
      const RealRecordStructSchema = Schema.Struct(RealFieldRecord);
      export type RealRecordStruct = typeof RealRecordStructSchema.Type;
      const RealNestedStructSchema = Schema.Struct({
        nested: Schema.Struct({ value: RunIdSchema }),
      });
      export type RealNestedStruct = typeof RealNestedStructSchema.Type;
      const RealUnionMembers: [typeof RunIdSchema, typeof Schema.String] = [
        RunIdSchema,
        Schema.String,
      ];
      const RealSpreadUnionSchema = Schema.Union(RealUnionMembers);
      export type RealSpreadUnion = typeof RealSpreadUnionSchema.Type;
      const RealConstFields = { value: RunIdSchema } as const;
      const RealConstStructSchema = Schema.Struct(RealConstFields);
      export type RealConstStruct = typeof RealConstStructSchema.Type;
      const RealSatisfiesFields = { value: RunIdSchema } satisfies Record<
        string,
        Schema.Top
      >;
      const RealSatisfiesStructSchema = Schema.Struct(RealSatisfiesFields);
      export type RealSatisfiesStruct = typeof RealSatisfiesStructSchema.Type;
      const RealConstUnionMembers = [RunIdSchema, Schema.String] as const;
      const RealConstSpreadUnionSchema = Schema.Union(RealConstUnionMembers);
      export type RealConstSpreadUnion =
        typeof RealConstSpreadUnionSchema.Type;
      const RealRecursiveSchema: Schema.Schema<Run> = Schema.suspend(
        () => RealRecursiveSchema
      );
      export type RealRecursive = typeof RealRecursiveSchema.Type;
      const CanonicalFieldsSchema = Schema.Struct({ ...RunSchema.fields });
      export type CanonicalFields = typeof CanonicalFieldsSchema.Type;
      const CanonicalMembersSchema = Schema.Union(RealUnionSchema.members);
      export type CanonicalMembers = typeof CanonicalMembersSchema.Type;
      const RealAliasedFields = { ...RealConstFields };
      const RealAliasedStructSchema = Schema.Struct(RealAliasedFields);
      export type RealAliasedStruct = typeof RealAliasedStructSchema.Type;
      const RepeatedFieldsSchemaA = Schema.Struct(RealConstFields);
      const RepeatedFieldsSchemaB = Schema.Struct(RealConstFields);
      export type RepeatedFieldsA = typeof RepeatedFieldsSchemaA.Type;
      export type RepeatedFieldsB = typeof RepeatedFieldsSchemaB.Type;
      const exactSuspend = Schema.suspend;
      const ExactSuspendAliasSchema: Schema.Schema<string> = exactSuspend(
        () => Schema.String
      );
      export type ExactSuspendAlias = typeof ExactSuspendAliasSchema.Type;
      const StructuralSelfSchema: Schema.Schema<string> = Schema.suspend(
        () => StructuralSelfSchema
      );
      export type StructuralSelf = typeof StructuralSelfSchema.Type;
      const OneLazyA: Schema.Schema<string> = Schema.suspend(() => OneLazyB);
      const OneLazyB: Schema.Schema<string> = OneLazyA.annotate({
        title: "OneLazyB",
      });
      export type OneLazy = typeof OneLazyA.Type;
      const AllLazyA: Schema.Schema<string> = Schema.suspend(() => AllLazyB);
      const AllLazyB: Schema.Schema<string> = Schema.suspend(() => AllLazyA);
      export type AllLazy = typeof AllLazyA.Type;
      const RecursiveAnnotatedSchema: Schema.Schema<string> = Schema.suspend(
        () => RecursiveAnnotatedSchema.annotate({ title: "Recursive" })
      );
      export type RecursiveAnnotated = typeof RecursiveAnnotatedSchema.Type;
      const LiteralVocabularySchema = Schema.Literals(["one", "two"] as const);
      export type LiteralVocabulary = typeof LiteralVocabularySchema.Type;
      export const literalVocabulary = LiteralVocabularySchema.literals.map(
        (literal) => literal
      );
      const NestedImmutableFields = { value: RunIdSchema };
      const NestedImmutableGraph = { ...NestedImmutableFields } as const;
      const NestedImmutableSchema = Schema.Struct(NestedImmutableGraph);
      export type NestedImmutable = typeof NestedImmutableSchema.Type;
      export const RealEndpoint = HttpApiEndpoint.get(
        "real",
        "/real/:runId",
        {
          error: RunSchema,
          params: { runId: RunIdSchema },
          success: RunSchema,
        }
      );
      export const RealStream = HttpApiSchema.StreamSse({
        data: RunSchema,
        error: RunSchema,
      });
      const decodeWith = <S extends typeof RunSchema>(schema: S, input: unknown) =>
        Schema.decodeUnknownSync(schema)(input);
      export const locallyDecoded = decodeWith(RunSchema, { runId: "run" });
      export const madeRunDto = RunDtoSchemaClass.make({
        runId: Schema.decodeUnknownSync(RunIdSchema)("run"),
      });
      export const isRunDto = madeRunDto instanceof RunDtoSchemaClass;
      const MergedOwner = Schema.Struct({ value: Schema.String });
      type MergedOwner = typeof MergedOwner.Type;
      export type MergedProjection = Pick<MergedOwner, "value">;
      const canonicalAnnotate = RunSchema.annotate;
      const MethodAliasAnnotatedSchema = canonicalAnnotate({
        title: "MethodAliasRun",
      });
      export type MethodAliasAnnotated =
        typeof MethodAliasAnnotatedSchema.Type;
      const canonicalCurriedAnnotate = Schema.annotate;
      const CurriedAliasAnnotatedSchema = canonicalCurriedAnnotate({
        title: "CurriedAliasRun",
      })(RunSchema);
      export type CurriedAliasAnnotated =
        typeof CurriedAliasAnnotatedSchema.Type;
      const classAnnotate = RunDtoSchemaClass.annotate;
      const ClassMethodAliasAnnotatedSchema = classAnnotate({
        title: "ClassMethodAliasRun",
      });
      export type ClassMethodAliasAnnotated =
        typeof ClassMethodAliasAnnotatedSchema.Type;
    `
  );
  await writeFile(
    path.join(projectRoot, "reexport.ts"),
    `export { RunIdSchema, RunSchema } from "./schema.js";
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
    path.join(projectRoot, "external-schema-containers.d.ts"),
    `
      import { Schema } from "effect";
      export type Fields = Record<
        string,
        Schema.Schema<Record<string, string>>
      >;
      export type Members = readonly [
        Schema.Schema<Record<string, string>>,
        typeof Schema.String,
      ];
      export declare const fields: Fields;
      export declare const members: Members;
      export declare function fakeFields(): Fields;
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
    path.join(projectRoot, "counterfeit-schema-owner.ts"),
    `
      import { Schema } from "effect"; import { fakeFields, fields, members, type Fields } from "./external-schema-containers.js";

      const FakeSchema = {} as Schema.Schema<Record<string, string>>;
      export type FakeDto = typeof FakeSchema.Type;
      export type FakeViaCanonicalUtility =
        Schema.Schema.Type<typeof FakeSchema>;
      declare const AnnotatedSchema: Schema.Schema<Record<string, string>>;
      export type AnnotatedDto = typeof AnnotatedSchema.Type;
      const LaunderedSchema = AnnotatedSchema.annotate({ title: "Fake" });
      export type LaunderedDto = typeof LaunderedSchema.Type;
      const CurriedLaunderedSchema = Schema.annotate({ title: "Fake" })(
        AnnotatedSchema
      );
      export type CurriedLaunderedDto = typeof CurriedLaunderedSchema.Type;
      const ArrayLaundered = Schema.Array(FakeSchema);
      export type ArrayDto = typeof ArrayLaundered.Type;
      const StructLaundered = Schema.Struct({ value: AnnotatedSchema });
      export type StructDto = typeof StructLaundered.Type;
      const TypedSchema: Schema.Schema<Record<string, string>> = {} as never;
      const UnionLaundered = Schema.Union([TypedSchema, Schema.String]);
      export type UnionDto = typeof UnionLaundered.Type;
      const FakeFieldRecord = { value: FakeSchema };
      const RecordLaundered = Schema.Struct(FakeFieldRecord);
      export type RecordDto = typeof RecordLaundered.Type;
      const NestedStructLaundered = Schema.Struct({
        nested: Schema.Struct({ value: FakeSchema }),
      });
      export type NestedStructDto = typeof NestedStructLaundered.Type;
      const FakeUnionMembers: [
        Schema.Schema<Record<string, string>>,
        typeof Schema.String,
      ] = [FakeSchema, Schema.String];
      const SpreadUnionLaundered = Schema.Union(FakeUnionMembers);
      export type SpreadUnionDto = typeof SpreadUnionLaundered.Type;
      const DeclaredFieldsLaundered = Schema.Struct(fields);
      export type DeclaredFieldsDto = typeof DeclaredFieldsLaundered.Type;
      const AssertedFieldsLaundered = Schema.Struct({} as Fields);
      export type AssertedFieldsDto = typeof AssertedFieldsLaundered.Type;
      const HelperFieldsLaundered = Schema.Struct(fakeFields());
      export type HelperFieldsDto = typeof HelperFieldsLaundered.Type;
      const DeclaredMembersLaundered = Schema.Union(members);
      export type DeclaredMembersDto = typeof DeclaredMembersLaundered.Type;
      const MutableFields: Fields = {};
      MutableFields.value = FakeSchema;
      const MutableFieldsLaundered = Schema.Struct(MutableFields);
      export type MutableFieldsDto = typeof MutableFieldsLaundered.Type;
      const SuspendedLaundered = Schema.suspend(() => FakeSchema);
      export type SuspendedDto = typeof SuspendedLaundered.Type;
      const counterfeitAnnotate = FakeSchema.annotate;
      const MethodAliasLaundered = counterfeitAnnotate({
        title: "MethodAliasFake",
      });
      export type MethodAliasLaunderedDto =
        typeof MethodAliasLaundered.Type;
    `
  );
  await writeFile(
    path.join(projectRoot, "manual.ts"),
    `export type ManualRun = { readonly runId: string };`
  );
  await writeFile(
    path.join(projectRoot, "provenance-adversarial.ts"),
    `
      import { Schema } from "effect";

      const FakeSchema = {} as typeof Schema.String;
      let MutableSchema = Schema.String;
      const MutableOwner = Schema.Array(MutableSchema);
      export type MutableDto = typeof MutableOwner.Type;
      var VariableSchema = Schema.String;
      const VariableOwner = Schema.Array(VariableSchema);
      export type VariableDto = typeof VariableOwner.Type;

      const BeforeFields = { value: Schema.String };
      BeforeFields.value = FakeSchema;
      const BeforeOwner = Schema.Struct(BeforeFields);
      export type BeforeDto = typeof BeforeOwner.Type;

      const AfterFields = { value: Schema.String };
      const AfterOwner = Schema.Struct(AfterFields);
      AfterFields.value = FakeSchema;
      export type AfterDto = typeof AfterOwner.Type;

      const ElementMembers: [typeof Schema.String] = [Schema.String];
      ElementMembers[0] = FakeSchema;
      const ElementOwner = Schema.Union(ElementMembers);
      export type ElementDto = typeof ElementOwner.Type;

      const DeleteFields = { value: Schema.String };
      delete (DeleteFields as Partial<typeof DeleteFields>).value;
      const DeleteOwner = Schema.Struct(DeleteFields);
      export type DeleteDto = typeof DeleteOwner.Type;

      const UpdateMembers: [
        typeof Schema.String,
        ...Array<typeof Schema.String>,
      ] = [Schema.String];
      UpdateMembers.length++;
      const UpdateOwner = Schema.Union(UpdateMembers);
      export type UpdateDto = typeof UpdateOwner.Type;

      const DestructuredFields = { value: Schema.String };
      ({ value: DestructuredFields.value } = { value: FakeSchema });
      const DestructuredOwner = Schema.Struct(DestructuredFields);
      export type DestructuredDto = typeof DestructuredOwner.Type;

      declare const escape: (value: unknown) => void;
      const EscapedFields = { value: Schema.String };
      escape(EscapedFields);
      const EscapedOwner = Schema.Struct(EscapedFields);
      export type EscapedDto = typeof EscapedOwner.Type;

      const ReturnedFields = { value: Schema.String };
      const returnFields = () => ReturnedFields;
      const ReturnedOwner = Schema.Struct(ReturnedFields);
      export type ReturnedDto = typeof ReturnedOwner.Type;
      void returnFields;

      export const ExportedFields = { value: Schema.String };
      const ExportedOwner = Schema.Struct(ExportedFields);
      export type ExportedDto = typeof ExportedOwner.Type;

      declare const dynamicKey: "value";
      const DynamicFields = { value: Schema.String };
      const DynamicOwner = Schema.Struct({ value: DynamicFields[dynamicKey] });
      export type DynamicDto = typeof DynamicOwner.Type;

      declare const fakeSuspend: typeof Schema.suspend;
      const FakeSuspendedOwner = fakeSuspend(() => Schema.String);
      export type FakeSuspendedDto = typeof FakeSuspendedOwner.Type;

      const CounterfeitCycleA: Schema.Schema<string> = Schema.suspend(
        () => CounterfeitCycleB
      );
      const CounterfeitCycleB: Schema.Schema<string> = Schema.suspend(
        () => FakeSchema
      );
      export type CounterfeitCycleDto = typeof CounterfeitCycleA.Type;

      const FixedFieldsShape = Schema.Struct({ value: Schema.String });
      declare const AmbientFixedFields: typeof FixedFieldsShape.fields;
      const AmbientFixedOwner = Schema.Struct(AmbientFixedFields);
      export type AmbientFixedDto = typeof AmbientFixedOwner.Type;

      const failSchema = (): never => {
        throw new Error("no schema");
      };
      const NeverLeaf: Schema.Schema<string> = failSchema();
      export type NeverLeafDto = typeof NeverLeaf.Type;

      declare const AnySchemaValue: any;
      const AnyLeaf: Schema.Schema<string> = AnySchemaValue;
      export type AnyLeafDto = typeof AnyLeaf.Type;

      const NullLeaf: Schema.Schema<string> = null!;
      export type NullLeafDto = typeof NullLeaf.Type;

      const SuspendedNeverLeaf: Schema.Schema<string> = Schema.suspend(
        () => NeverLeaf
      );
      export type SuspendedNeverLeafDto = typeof SuspendedNeverLeaf.Type;

      declare const choose: boolean;
      declare const arbitrary: any;
      const ConditionalNull: Schema.Schema<string> = choose
        ? Schema.String
        : null!;
      export type ConditionalNullDto = typeof ConditionalNull.Type;
      const ConditionalAny: Schema.Schema<string> = choose
        ? Schema.String
        : arbitrary;
      export type ConditionalAnyDto = typeof ConditionalAny.Type;

      const MixedFields = { good: Schema.String, bad: arbitrary };
      const MixedOwner = Schema.Struct(MixedFields);
      export type MixedDto = typeof MixedOwner.Type;
      const ArbitraryStructFieldOwner = Schema.Struct({ value: arbitrary });
      export type ArbitraryStructFieldDto =
        typeof ArbitraryStructFieldOwner.Type;
      const ArbitraryStructOwner = Schema.Struct(arbitrary);
      export type ArbitraryStructDto = typeof ArbitraryStructOwner.Type;
      const ArbitraryArrayOwner = Schema.Array(arbitrary);
      export type ArbitraryArrayDto = typeof ArbitraryArrayOwner.Type;
      const ArbitraryUnionOwner = Schema.Union(arbitrary);
      export type ArbitraryUnionDto = typeof ArbitraryUnionOwner.Type;
      const NeverArrayOwner = Schema.Array(undefined as never);
      export type NeverArrayDto = typeof NeverArrayOwner.Type;
      const AliasMutationOriginal = Schema.Struct({ value: Schema.String });
      const AliasMutation = AliasMutationOriginal;
      (AliasMutation.fields as Record<"value", typeof Schema.String>).value = FakeSchema;
      export type AliasMutationDto = typeof AliasMutationOriginal.Type;
      const ObjectAssignOriginal = Schema.Struct({ value: Schema.String });
      const ObjectAssignAlias = ObjectAssignOriginal;
      Object.assign(ObjectAssignAlias.fields, { value: FakeSchema });
      export type ObjectAssignDto = typeof ObjectAssignOriginal.Type;
      const MembersMutationOriginal = Schema.Union([Schema.String]);
      const MembersMutationAlias = MembersMutationOriginal.members;
      Object.assign(MembersMutationAlias, { 0: FakeSchema });
      export type MembersMutationDto = typeof MembersMutationOriginal.Type;
      class MutableSchemaClass extends Schema.Class<MutableSchemaClass>("MutableSchemaClass")({ value: Schema.String }) {}
      Object.assign(MutableSchemaClass.fields, { value: FakeSchema });
      export type MutableSchemaClassDto = typeof MutableSchemaClass.Type;

      declare const fakeEffectConsumer: (options: {
        readonly success: Schema.Top;
      }) => void;
      const FakeConsumerOwner = Schema.Struct({ value: Schema.String });
      fakeEffectConsumer({ success: FakeConsumerOwner });
      export type FakeConsumerDto = typeof FakeConsumerOwner.Type;

      let storedSchema: Schema.Top | undefined;
      const storingConsumer = <S extends Schema.Top>(schema: S) => {
        storedSchema = schema;
      };
      const StoredConsumerOwner = Schema.Struct({ value: Schema.String });
      storingConsumer(StoredConsumerOwner);
      export type StoredConsumerDto = typeof StoredConsumerOwner.Type;
      void storedSchema;

      declare const opaqueSchemaConsumer: (schema: unknown) => void;
      declare const unsafeBranch: boolean;
      const mixedConsumer = <S extends Schema.Top>(schema: S) => {
        if (unsafeBranch) Schema.Array(schema);
        else opaqueSchemaConsumer(schema);
      };
      const MixedConsumerOwner = Schema.Struct({ value: Schema.String });
      mixedConsumer(MixedConsumerOwner);
      export type MixedConsumerDto = typeof MixedConsumerOwner.Type;

      const CapturedCallOwner = Schema.Struct({ value: Schema.String });
      const capturedCall = opaqueSchemaConsumer(CapturedCallOwner);
      export type CapturedCallDto = typeof CapturedCallOwner.Type;
      void capturedCall;

      declare function unresolvedConsumer(schema: Schema.Top): void;
      const UnresolvedConsumerOwner = Schema.Struct({ value: Schema.String });
      unresolvedConsumer(UnresolvedConsumerOwner);
      export type UnresolvedConsumerDto = typeof UnresolvedConsumerOwner.Type;
    `
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
    path.join(projectRoot, "callable-casts.ts"),
    `
      import type { RunId } from "./reexport.js";

      type Handler<T> = (input: T) => void;
      type Factory<T> = () => T;
      type CallableWithData<T> = ((input: string) => void) & {
        readonly stored: T;
      };
      class ConcreteWrapper {
        declare readonly handler: CallableWithData<RunId>;
      }
      class PureCallableWrapper {
        declare readonly handler: Handler<RunId>;
      }

      declare const raw: unknown;
      export const genericHandler = raw as Handler<RunId>;
      export const genericFactory = raw as Factory<RunId>;
      export const directHandler = raw as (input: RunId) => void;
      export const directFactory = raw as () => RunId;
      export const stored = raw as CallableWithData<RunId>;
      export const nestedStored = raw as ConcreteWrapper;
      export const nestedPureCallable = raw as PureCallableWrapper;
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

  const configPath = path.join(projectRoot, "tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  assert.equal(config.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    projectRoot
  );
  const semanticProgram = ts.createProgram({
    options: parsed.options,
    rootNames: parsed.fileNames,
  });
  const semanticCleanFiles = new Set([
    "counterfeit-schema-owner.ts",
    "derived.ts",
    "external-schema-containers.d.ts",
    "provenance-adversarial.ts",
    "reexport.ts",
    "schema.ts",
  ]);
  assert.deepEqual(
    [
      ...semanticProgram.getSyntacticDiagnostics(),
      ...semanticProgram.getSemanticDiagnostics(),
    ]
      .filter(
        (diagnostic) =>
          diagnostic.file !== undefined &&
          semanticCleanFiles.has(path.basename(diagnostic.file.fileName))
      )
      .map(
        (diagnostic) =>
          `${path.basename(diagnostic.file.fileName)}: ${ts.flattenDiagnosticMessageText(
            diagnostic.messageText,
            "\n"
          )}`
      ),
    [],
    "ownership fixtures must be semantically valid for Effect beta.93"
  );

  const diagnostics = analyzeSchemaContracts({
    cwd: projectRoot,
    includeIgnoredPathsForTesting: true,
    projectPath: configPath,
  });

  assert.deepEqual(diagnostics, [
    brandDiagnostic("brand-casts.ts", 12, 31),
    brandDiagnostic("brand-casts.ts", 13, 28),
    brandDiagnostic("brand-casts.ts", 14, 30),
    brandDiagnostic("brand-casts.ts", 15, 28),
    brandDiagnostic("brand-casts.ts", 16, 31),
    brandDiagnostic("brand-casts.ts", 17, 28),
    brandDiagnostic("brand-casts.ts", 18, 28),
    brandDiagnostic("brand-casts.ts", 19, 32),
    brandDiagnostic("brand-casts.ts", 20, 28),
    brandDiagnostic("brand-casts.ts", 21, 35),
    brandDiagnostic("brand-casts.ts", 22, 29),
    brandDiagnostic("callable-casts.ts", 21, 29),
    brandDiagnostic("callable-casts.ts", 22, 35),
    schemaDiagnostic(
      "capability.ts",
      5,
      18,
      "Nested operation data contract has no compiler-proven Schema origin."
    ),
    schemaDiagnostic("counterfeit-schema-owner.ts", 5, 19),
    schemaDiagnostic("counterfeit-schema-owner.ts", 6, 19),
    schemaDiagnostic("counterfeit-schema-owner.ts", 9, 19),
    schemaDiagnostic("counterfeit-schema-owner.ts", 11, 19),
    schemaDiagnostic("counterfeit-schema-owner.ts", 15, 19),
    schemaDiagnostic("counterfeit-schema-owner.ts", 17, 19),
    schemaDiagnostic("counterfeit-schema-owner.ts", 19, 19),
    schemaDiagnostic("counterfeit-schema-owner.ts", 22, 19),
    schemaDiagnostic("counterfeit-schema-owner.ts", 25, 19),
    schemaDiagnostic("counterfeit-schema-owner.ts", 29, 19),
    schemaDiagnostic("counterfeit-schema-owner.ts", 35, 19),
    schemaDiagnostic("counterfeit-schema-owner.ts", 37, 19),
    schemaDiagnostic("counterfeit-schema-owner.ts", 39, 19),
    schemaDiagnostic("counterfeit-schema-owner.ts", 41, 19),
    schemaDiagnostic("counterfeit-schema-owner.ts", 43, 19),
    schemaDiagnostic("counterfeit-schema-owner.ts", 47, 19),
    schemaDiagnostic("counterfeit-schema-owner.ts", 49, 19),
    schemaDiagnostic("counterfeit-schema-owner.ts", 54, 19),
    schemaDiagnostic("counterfeit.ts", 6, 19),
    schemaDiagnostic("counterfeit.ts", 7, 19),
    schemaDiagnostic("counterfeit.ts", 8, 19),
    schemaDiagnostic("derived-manual.ts", 3, 19),
    schemaDiagnostic("fake-type.ts", 3, 19),
    schemaDiagnostic("fake-type.ts", 4, 19),
    schemaDiagnostic("manual.ts", 1, 13),
    schemaDiagnostic("mixed-framework.tsx", 2, 19),
    schemaDiagnostic("provenance-adversarial.ts", 7, 19),
    schemaDiagnostic("provenance-adversarial.ts", 10, 19),
    schemaDiagnostic("provenance-adversarial.ts", 15, 19),
    schemaDiagnostic("provenance-adversarial.ts", 20, 19),
    schemaDiagnostic("provenance-adversarial.ts", 25, 19),
    schemaDiagnostic("provenance-adversarial.ts", 30, 19),
    schemaDiagnostic("provenance-adversarial.ts", 38, 19),
    schemaDiagnostic("provenance-adversarial.ts", 43, 19),
    schemaDiagnostic("provenance-adversarial.ts", 49, 19),
    schemaDiagnostic("provenance-adversarial.ts", 54, 19),
    schemaDiagnostic("provenance-adversarial.ts", 59, 19),
    schemaDiagnostic("provenance-adversarial.ts", 64, 19),
    schemaDiagnostic("provenance-adversarial.ts", 68, 19),
    schemaDiagnostic("provenance-adversarial.ts", 76, 19),
    schemaDiagnostic("provenance-adversarial.ts", 81, 19),
    schemaDiagnostic("provenance-adversarial.ts", 87, 19),
    schemaDiagnostic("provenance-adversarial.ts", 91, 19),
    schemaDiagnostic("provenance-adversarial.ts", 94, 19),
    schemaDiagnostic("provenance-adversarial.ts", 99, 19),
    schemaDiagnostic("provenance-adversarial.ts", 106, 19),
    schemaDiagnostic("provenance-adversarial.ts", 110, 19),
    schemaDiagnostic("provenance-adversarial.ts", 114, 19),
    schemaDiagnostic("provenance-adversarial.ts", 116, 19),
    schemaDiagnostic("provenance-adversarial.ts", 119, 19),
    schemaDiagnostic("provenance-adversarial.ts", 121, 19),
    schemaDiagnostic("provenance-adversarial.ts", 123, 19),
    schemaDiagnostic("provenance-adversarial.ts", 125, 19),
    schemaDiagnostic("provenance-adversarial.ts", 129, 19),
    schemaDiagnostic("provenance-adversarial.ts", 133, 19),
    schemaDiagnostic("provenance-adversarial.ts", 137, 19),
    schemaDiagnostic("provenance-adversarial.ts", 140, 19),
    schemaDiagnostic(
      "provenance-adversarial.ts",
      142,
      51,
      "Nested operation data contract has no compiler-proven Schema origin."
    ),
    schemaDiagnostic("provenance-adversarial.ts", 147, 19),
    schemaDiagnostic("provenance-adversarial.ts", 155, 19),
    schemaDiagnostic("provenance-adversarial.ts", 166, 19),
    schemaDiagnostic("provenance-adversarial.ts", 170, 19),
    schemaDiagnostic("provenance-adversarial.ts", 176, 19),
    schemaDiagnostic(
      "structural-spoof.ts",
      3,
      37,
      "Nested operation data contract has no compiler-proven Schema origin."
    ),
  ]);

  const boundedDiagnostics = analyzeSchemaContracts({
    cwd: projectRoot,
    includeIgnoredPathsForTesting: true,
    projectPath: configPath,
    provenanceLimits: {
      maxDepth: 1,
      maxWorkItems: 1,
      maxShallowTypeDepth: 1,
      maxShallowTypes: 1,
    },
  });
  assert.deepEqual(
    analyzeSchemaContracts({
      cwd: projectRoot,
      includeIgnoredPathsForTesting: true,
      projectPath: configPath,
      provenanceLimits: {
        maxDepth: 1,
        maxWorkItems: 1,
        maxShallowTypeDepth: 1,
        maxShallowTypes: 1,
      },
    }),
    boundedDiagnostics,
    "bounded unknown provenance must fail closed with deterministic diagnostics"
  );
  assert.ok(
    boundedDiagnostics.some(
      (diagnostic) =>
        diagnostic.rule === "gaia/schema-first-data-contract" &&
        diagnostic.filePath === "derived.ts"
    ),
    "bounded unknown provenance must use the existing schema-origin diagnostic"
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
