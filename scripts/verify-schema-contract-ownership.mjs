import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
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
      export type RunRemainder = Omit<Run, never>;
      export type RunById = Extract<Run, Run>;
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
      const RunDtoReadSchema = Schema.Struct({
        ...RunDtoSchemaClass.fields,
      });
      export type RunDtoRead = typeof RunDtoReadSchema.Type;
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
    path.join(projectRoot, "imported-schema-class.ts"),
    `
      import type { RunDto as ImportedRunDto } from "./schema.js";

      export type ImportedRunDtoType = typeof ImportedRunDto.Type;
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
      export type Extract<T, U> = {
        readonly manuallyExtracted: string;
      };
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
      import type { Extract, Pick, Wrapper } from "./counterfeit-types.js";

      export type CounterfeitExtract = Extract<Run, Run>;
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
    path.join(projectRoot, "canonical-boundary.ts"),
    `
      import { Schema } from "effect";

      const projection = <M extends string, S extends Schema.Top>(
        method: M,
        params: S
      ) => Schema.Struct({ method: Schema.Literal(method), params });
      const ProjectionSchema = Schema.Union([
        projection("event", Schema.Struct({ value: Schema.String })),
      ]);
      const RawSchema = Schema.Struct({ method: Schema.String, params: Schema.Unknown });
      const BoundarySchema = RawSchema.pipe(Schema.decodeTo(ProjectionSchema));
      const PublicSchema = ProjectionSchema;
      export type PublicProjection = typeof PublicSchema.Type;
      void BoundarySchema;
    `
  );
  await writeFile(
    path.join(projectRoot, "counterfeit-boundary.ts"),
    `
      import { Schema } from "effect";

      declare const fakeStruct: typeof Schema.Struct;
      const projection = <M extends string, S extends Schema.Top>(
        method: M,
        params: S
      ) => fakeStruct({ method: Schema.Literal(method), params });
      const ProjectionSchema = Schema.Union([
        projection("event", Schema.Struct({ value: Schema.String })),
      ]);
      const RawSchema = Schema.Struct({ method: Schema.String, params: Schema.Unknown });
      const BoundarySchema = RawSchema.pipe(Schema.decodeTo(ProjectionSchema));
      const PublicSchema = ProjectionSchema;
      export type CounterfeitProjection = typeof PublicSchema.Type;
      void BoundarySchema;
    `
  );
  await writeFile(
    path.join(projectRoot, "schema-connected-operation-parameter.ts"),
    `
      import { Schema } from "effect";

      const RunIdSchema = Schema.String.pipe(Schema.brand("RunId"));
      export function readRunId(input: { readonly runId: string }) {
        return Schema.decodeUnknownSync(RunIdSchema)(input.runId);
      }
    `
  );
  await writeFile(
    path.join(projectRoot, "unrelated-effect-parameter-laundering.ts"),
    `
      import { Effect } from "effect";

      export function readRunId(input: { readonly runId: string }) {
        void Effect.succeed("unrelated");
        return input.runId;
      }
    `
  );
  await writeFile(
    path.join(projectRoot, "unrelated-effect-named-parameter-laundering.ts"),
    `
      import { Effect } from "effect";

      type Input = { readonly runId: string };
      export function readRunId(input: Input) {
        if (globalThis.Math.random() < 0) {
          return Effect.succeed("unrelated");
        }
        return input.runId;
      }
    `
  );
  await writeFile(
    path.join(projectRoot, "unrelated-schema-named-parameter-laundering.ts"),
    `
      import { Schema } from "effect";

      type Input = { readonly runId: string };
      export function readRunId(input: Input) {
        if (globalThis.Math.random() < 0) {
          return Schema.decodeUnknownSync(Schema.String)("unrelated");
        }
        return input.runId;
      }
    `
  );
  await writeFile(
    path.join(projectRoot, "derived-manual.ts"),
    `
      import type { ManualRun } from "./manual.js";
      export type ManualRunSummary = Pick<ManualRun, "runId">;
      export type ManualRunExtract = Extract<
        ManualRun,
        { readonly runId: string }
      >;
      export type CommandApprovalRequest = Extract<
        ManualRun,
        { readonly runId: string }
      >;
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
    path.join(projectRoot, "framework-shell.tsx"),
    `
      import type { ReactNode } from "react";
      export type SidebarContextProps = {
        readonly state: "expanded" | "collapsed";
        readonly open: boolean;
        readonly setOpen: (open: boolean) => void;
        readonly openMobile: boolean;
        readonly setOpenMobile: (open: boolean) => void;
        readonly isMobile: boolean;
        readonly toggleSidebar: () => void;
      };
      export function RootDocument({
        children,
      }: Readonly<{ children: ReactNode }>) {
        return children;
      }
      export function Card(
        props: React.ComponentProps<"div"> & { size?: "default" | "sm" }
      ) {
        return props.children;
      }
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
    path.join(projectRoot, "opaque-canonical-ancestor.ts"),
    `
      import { Schema } from "effect";

      declare const opaqueDescription: (value: unknown) => string;

      const unsafeConsumer = <S extends Schema.Top>(schema: S) =>
        Schema.String.annotate({ description: opaqueDescription(schema) });

      const LocalOwner = Schema.Struct({ value: Schema.String });
      unsafeConsumer(LocalOwner);
      export type LocalDto = typeof LocalOwner.Type;

      const Fields = { value: Schema.String } as const;
      Schema.String.annotate({
        description: opaqueDescription(Fields),
      });
      const ContainerOwner = Schema.Struct(Fields);
      export type ContainerDto = typeof ContainerOwner.Type;

      const TransparentFields = { value: Schema.String } as const;
      const TransparentOwner = Schema.Struct({ ...TransparentFields });
      export type TransparentDto = typeof TransparentOwner.Type;

      let captured: unknown;
      const DirectIdentityOwner = Schema.Struct({ value: Schema.String });
      Schema.String.annotate({
        description: ((captured = DirectIdentityOwner), "captured"),
      });
      export type DirectIdentityDto = typeof DirectIdentityOwner.Type;
      void captured;

      let receiverCaptured: unknown;
      const ReceiverOwner = Schema.Struct({ value: Schema.String });
      ((receiverCaptured = ReceiverOwner), Schema.String).annotate({
        title: "unsafe receiver",
      });
      export type ReceiverDto = typeof ReceiverOwner.Type;
      void receiverCaptured;
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
  await writeFile(
    path.join(projectRoot, "cross-file-union-owner.ts"),
    `
      import { Schema } from "effect";
      import { HarnessNameSchema, RunIdSchema } from "./schema.js";

      const ReceiptBase = {
        harnessName: HarnessNameSchema,
        runId: RunIdSchema,
      } as const;
      export const RecoveryReceiptSchema = Schema.Union([
        Schema.Struct({ ...ReceiptBase, state: Schema.Literal("pending") }),
        Schema.Struct({ ...ReceiptBase, state: Schema.Literal("done") }),
      ]);
      export type RecoveryReceipt = typeof RecoveryReceiptSchema.Type;
      export const ContinuationReceiptSchema = Schema.Union([
        Schema.Struct({ ...ReceiptBase, state: Schema.Literal("pending") }),
        Schema.Struct({ ...ReceiptBase, state: Schema.Literal("done") }),
      ]);
      export type ContinuationReceipt = typeof ContinuationReceiptSchema.Type;
      export const CorrelationReceiptSchema = Schema.Union([
        Schema.Struct({ ...ReceiptBase, state: Schema.Literal("pending") }),
        Schema.Struct({ ...ReceiptBase, state: Schema.Literal("done") }),
      ]);
      export type CorrelationReceipt = typeof CorrelationReceiptSchema.Type;
      export const DesktopOriginReceiptSchema = Schema.Union([
        Schema.Struct({ ...ReceiptBase, state: Schema.Literal("pending") }),
        Schema.Struct({ ...ReceiptBase, state: Schema.Literal("done") }),
      ]);
      export type DesktopOriginReceipt =
        typeof DesktopOriginReceiptSchema.Type;
    `
  );
  await writeFile(
    path.join(projectRoot, "cross-file-union-consumer.ts"),
    `
      import { Schema } from "effect";
      import {
        ContinuationReceiptSchema,
        CorrelationReceiptSchema,
        DesktopOriginReceiptSchema,
        RecoveryReceiptSchema,
      } from "./cross-file-union-owner.js";

      export const MachineEventSchema = Schema.Union([
        Schema.Struct({ receipt: RecoveryReceiptSchema }),
        Schema.Struct({ receipt: ContinuationReceiptSchema }),
        Schema.Struct({ receipt: CorrelationReceiptSchema }),
        Schema.Struct({ receipt: DesktopOriginReceiptSchema }),
      ]);
      export type MachineEvent = typeof MachineEventSchema.Type;
      export const parseMachineEvent =
        Schema.decodeUnknownSync(MachineEventSchema);
    `
  );
  await writeFile(
    path.join(projectRoot, "cross-file-union-use.ts"),
    `
      import { Schema } from "effect";
      import { MachineEventSchema } from "./cross-file-union-consumer.js";

      export const encodeMachineEvent = Schema.encodeSync(MachineEventSchema);
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
    "canonical-boundary.ts",
    "counterfeit-boundary.ts",
    "counterfeit-schema-owner.ts",
    "cross-file-union-consumer.ts",
    "cross-file-union-owner.ts",
    "cross-file-union-use.ts",
    "derived.ts",
    "external-schema-containers.d.ts",
    "imported-schema-class.ts",
    "opaque-canonical-ancestor.ts",
    "provenance-adversarial.ts",
    "reexport.ts",
    "schema-connected-operation-parameter.ts",
    "schema.ts",
    "unrelated-effect-named-parameter-laundering.ts",
    "unrelated-effect-parameter-laundering.ts",
    "unrelated-schema-named-parameter-laundering.ts",
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
    schemaDiagnostic("counterfeit-boundary.ts", 15, 19),
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
    schemaDiagnostic("counterfeit.ts", 9, 19),
    schemaDiagnostic("derived-manual.ts", 3, 19),
    schemaDiagnostic("derived-manual.ts", 4, 19),
    schemaDiagnostic(
      "derived-manual.ts",
      6,
      9,
      "Nested operation data contract has no compiler-proven Schema origin."
    ),
    schemaDiagnostic("derived-manual.ts", 8, 19),
    schemaDiagnostic(
      "derived-manual.ts",
      10,
      9,
      "Nested operation data contract has no compiler-proven Schema origin."
    ),
    schemaDiagnostic("fake-type.ts", 3, 19),
    schemaDiagnostic("fake-type.ts", 4, 19),
    schemaDiagnostic("manual.ts", 1, 13),
    schemaDiagnostic("mixed-framework.tsx", 2, 19),
    schemaDiagnostic("opaque-canonical-ancestor.ts", 11, 19),
    schemaDiagnostic("opaque-canonical-ancestor.ts", 18, 19),
    schemaDiagnostic("opaque-canonical-ancestor.ts", 29, 19),
    schemaDiagnostic("opaque-canonical-ancestor.ts", 37, 19),
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
    schemaDiagnostic("unrelated-effect-named-parameter-laundering.ts", 4, 12),
    schemaDiagnostic(
      "unrelated-effect-parameter-laundering.ts",
      4,
      40,
      "Nested operation data contract has no compiler-proven Schema origin."
    ),
    schemaDiagnostic("unrelated-schema-named-parameter-laundering.ts", 4, 12),
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

  const analyzeIsolatedProject = async (prefix, files) => {
    const isolatedRoot = await mkdtemp(path.join(repoRoot, prefix));
    try {
      await writeFile(
        path.join(isolatedRoot, "tsconfig.json"),
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
          include: ["**/*.ts", "**/*.tsx"],
        })
      );
      for (const [filePath, source] of files) {
        const absolutePath = path.join(isolatedRoot, filePath);
        await mkdir(path.dirname(absolutePath), { recursive: true });
        await writeFile(absolutePath, source);
      }
      return analyzeSchemaContracts({
        cwd: isolatedRoot,
        includeIgnoredPathsForTesting: true,
        projectPath: path.join(isolatedRoot, "tsconfig.json"),
      });
    } finally {
      await rm(isolatedRoot, { force: true, recursive: true });
    }
  };

  const analyzeCoreProject = async (
    prefix,
    files,
    expectedTypeDiagnosticMessages = []
  ) => {
    const isolatedRoot = await mkdtemp(
      path.join(repoRoot, "packages/core/node_modules", prefix)
    );
    try {
      const configPath = path.join(isolatedRoot, "tsconfig.json");
      await writeFile(
        configPath,
        JSON.stringify({
          compilerOptions: {
            exactOptionalPropertyTypes: true,
            module: "NodeNext",
            moduleResolution: "NodeNext",
            noEmit: true,
            skipLibCheck: true,
            strict: true,
            target: "ES2024",
          },
          include: ["*.ts"],
        })
      );
      for (const [filePath, source] of files) {
        await writeFile(path.join(isolatedRoot, filePath), source);
      }
      const config = ts.readConfigFile(configPath, ts.sys.readFile);
      assert.equal(config.error, undefined);
      const parsed = ts.parseJsonConfigFileContent(
        config.config,
        ts.sys,
        isolatedRoot
      );
      const program = ts.createProgram({
        options: parsed.options,
        rootNames: parsed.fileNames,
      });
      assert.deepEqual(
        [
          ...program.getSyntacticDiagnostics(),
          ...program.getSemanticDiagnostics(),
        ].map((diagnostic) =>
          ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")
        ),
        expectedTypeDiagnosticMessages,
        "core-owned fixtures must have exactly the expected type diagnostics"
      );
      return analyzeSchemaContracts({
        cwd: isolatedRoot,
        includeIgnoredPathsForTesting: true,
        projectPath: configPath,
      });
    } finally {
      await rm(isolatedRoot, { force: true, recursive: true });
    }
  };

  const intersectionCapabilityWrapperDiagnostics = await analyzeCoreProject(
    ".gaia-schema-contract-intersection-capability-wrapper-",
    [
      [
        "intersection-capability-wrapper.ts",
        `
          import { Effect, Schema } from "effect";

          type ReviewRunRequest = unknown;
          type ReviewResult = unknown;

          class GaiaReviewerMetadata extends Schema.Class<GaiaReviewerMetadata>(
            "GaiaReviewerMetadata"
          )({ name: Schema.NonEmptyString }) {}

          type GaiaReviewer = GaiaReviewerMetadata & {
            readonly run: (
              request: ReviewRunRequest
            ) => Effect.Effect<ReviewResult>;
          };

          type ReviewerRunOptions = {
            readonly reviewer?: GaiaReviewer;
          };

          class ReverseMetadata extends Schema.Class<ReverseMetadata>(
            "ReverseMetadata"
          )({ name: Schema.NonEmptyString }) {}

          type ReverseCapability = {
            readonly run: () => void;
            readonly stop: () => void;
          } & ReverseMetadata;

          type ReverseCapabilityOptions = {
            readonly capability?: ReverseCapability;
          };
        `,
      ],
    ]
  );
  assert.deepEqual(
    intersectionCapabilityWrapperDiagnostics,
    [],
    "an exact optional readonly wrapper may carry a local Schema.Class metadata and direct callable intersection"
  );

  const intersectionCapabilityProvenanceDiagnostics = await analyzeCoreProject(
    ".gaia-schema-contract-intersection-capability-provenance-",
    [
      [
        "imported-metadata.ts",
        `
            import { Schema } from "effect";
            export class ImportedMetadata extends Schema.Class<ImportedMetadata>(
              "ImportedMetadata"
            )({ name: Schema.NonEmptyString }) {}
          `,
      ],
      [
        "imported-wrapper.ts",
        `
            import type { ImportedMetadata } from "./imported-metadata.js";
            type ImportedCapability = ImportedMetadata & {
              readonly run: () => void;
            };
            type ImportedOptions = {
              readonly capability?: ImportedCapability;
            };
          `,
      ],
      [
        "counterfeit-effect.ts",
        `
            export const Schema = {
              NonEmptyString: "",
              Class:
                <Self>(_name: string) =>
                (_fields: Readonly<Record<string, unknown>>) =>
                  class {},
            };
          `,
      ],
      [
        "counterfeit-wrapper.ts",
        `
            import { Schema } from "./counterfeit-effect.js";
            class CounterfeitMetadata extends Schema.Class<CounterfeitMetadata>(
              "CounterfeitMetadata"
            )({ name: Schema.NonEmptyString }) {}
            type CounterfeitCapability = CounterfeitMetadata & {
              readonly run: () => void;
            };
            type CounterfeitOptions = {
              readonly capability?: CounterfeitCapability;
            };
          `,
      ],
      [
        "local-provenance-rejections.ts",
        `
            import { Schema } from "effect";

            class PlainMetadata {}
            type ManualMetadata = { readonly name: string };
            class AmbiguousMetadata extends Schema.Class<AmbiguousMetadata>(
              "AmbiguousMetadata"
            )({ name: Schema.NonEmptyString }) {}
            interface AmbiguousMetadata {
              readonly refresh: () => void;
            }

            type PlainCapability = PlainMetadata & {
              readonly run: () => void;
            };
            type ManualCapability = ManualMetadata & {
              readonly run: () => void;
            };
            type AmbiguousCapability = AmbiguousMetadata & {
              readonly run: () => void;
            };

            type PlainOptions = {
              readonly capability?: PlainCapability;
            };
            type ManualOptions = {
              readonly capability?: ManualCapability;
            };
            type AmbiguousOptions = {
              readonly capability?: AmbiguousCapability;
            };
          `,
      ],
    ]
  );
  assert.deepEqual(
    intersectionCapabilityProvenanceDiagnostics.reduce((counts, diagnostic) => {
      counts[diagnostic.filePath] = (counts[diagnostic.filePath] ?? 0) + 1;
      return counts;
    }, {}),
    {
      "counterfeit-wrapper.ts": 1,
      "imported-wrapper.ts": 1,
      "local-provenance-rejections.ts": 4,
    },
    "imported, counterfeit, plain, manual, and ambiguous metadata provenance must fail closed"
  );

  const intersectionCapabilityShapeDiagnostics = await analyzeCoreProject(
    ".gaia-schema-contract-intersection-capability-shapes-",
    [
      [
        "intersection-shape-rejections.ts",
        `
          import { Schema } from "effect";

          class Metadata extends Schema.Class<Metadata>("Metadata")({
            name: Schema.NonEmptyString,
          }) {}

          type CanonicalCapability = Metadata & {
            readonly run: () => void;
          };
          type CapabilityAlias = CanonicalCapability;
          type AliasedOptions = {
            readonly capability?: CapabilityAlias;
          };

          type GenericCapability<Value> = Metadata & {
            readonly run: (value: Value) => void;
          };
          type GenericOptions = {
            readonly capability?: GenericCapability<string>;
          };

          type RecordCapability = Metadata & Record<string, () => void>;
          type RecordOptions = {
            readonly capability?: RecordCapability;
          };

          type MappedCapability = Metadata & {
            readonly [Name in "run"]: () => void;
          };
          type MappedOptions = {
            readonly capability?: MappedCapability;
          };

          type ConditionalCapability = Metadata & (
            true extends true ? { readonly run: () => void } : never
          );
          type ConditionalOptions = {
            readonly capability?: ConditionalCapability;
          };

          type NestedCapability = Metadata & (
            { readonly run: () => void } & { readonly stop: () => void }
          );
          type NestedOptions = {
            readonly capability?: NestedCapability;
          };

          type ThreeArmCapability = Metadata &
            { readonly run: () => void } &
            { readonly stop: () => void };
          type ThreeArmOptions = {
            readonly capability?: ThreeArmCapability;
          };

          type NoCallCapability = Metadata & unknown;
          type NoCallIntersectionOptions = {
            readonly capability?: NoCallCapability;
          };

          type MixedCapability = Metadata & {
            readonly name: string;
            readonly run: () => void;
          };
          type MixedIntersectionOptions = {
            readonly capability?: MixedCapability;
          };

          type RequiredOptions = {
            readonly capability: CanonicalCapability;
          };
          type MutableOptions = {
            capability?: CanonicalCapability;
          };
          type DataBearingOptions = {
            readonly capability?: CanonicalCapability;
            readonly metadata?: Metadata;
          };
          type InlineIntersectionOptions = {
            readonly capability?: Metadata & {
              readonly run: () => void;
            };
          };
        `,
      ],
    ]
  );
  assert.equal(
    intersectionCapabilityShapeDiagnostics.length,
    13,
    "aliased, generic, Record, mapped, conditional, nested, third-arm, non-callable, mixed, required, mutable, data-bearing, and inline intersection wrappers must report"
  );

  const intersectionCapabilityCycleDiagnostics = await analyzeCoreProject(
    ".gaia-schema-contract-intersection-capability-cycles-",
    [
      [
        "intersection-cycle-rejections.ts",
        `
          import { Schema } from "effect";

          class Metadata extends Schema.Class<Metadata>("Metadata")({
            name: Schema.NonEmptyString,
          }) {}

          type DirectCycle = Metadata & {
            readonly run: (next: DirectCycle) => void;
          };
          type DirectCycleOptions = {
            readonly capability?: DirectCycle;
          };

          type IndirectCycle = Metadata & {
            readonly run: (next: IndirectLink) => void;
          };
          type IndirectLink = IndirectCycle;
          type IndirectCycleOptions = {
            readonly capability?: IndirectCycle;
          };
        `,
      ],
    ]
  );
  assert.equal(
    intersectionCapabilityCycleDiagnostics.length,
    2,
    "direct and same-file indirect callable intersection cycles must fail closed"
  );

  const unresolvedCallableCapabilityDiagnostics = await analyzeCoreProject(
    ".gaia-schema-contract-unresolved-callable-capability-",
    [
      [
        "unresolved-callable-capability.ts",
        `
          import { Schema } from "effect";

          class Metadata extends Schema.Class<Metadata>("Metadata")({
            name: Schema.NonEmptyString,
          }) {}

          type UnresolvedCallableCapability = Metadata & {
            readonly run: (request: MissingRequest) => void;
          };
          type UnresolvedCallableOptions = {
            readonly capability?: UnresolvedCallableCapability;
          };
        `,
      ],
    ],
    ["Cannot find name 'MissingRequest'."]
  );
  assert.equal(
    unresolvedCallableCapabilityDiagnostics.length,
    1,
    "an unresolved callable-arm identifier must fail closed"
  );

  const unresolvedAndClassMediatedDiagnostics = await analyzeCoreProject(
    ".gaia-schema-contract-qualified-and-class-mediated-",
    [
      [
        "qualified-and-class-mediated.ts",
        `
          import { Schema } from "effect";

          class Metadata extends Schema.Class<Metadata>("Metadata")({
            name: Schema.NonEmptyString,
          }) {}

          type QualifiedCapability = Metadata & {
            readonly run: (request: Missing.Request) => void;
          };
          type QualifiedOptions = {
            readonly capability?: QualifiedCapability;
          };

          class CycleLink {
            next!: CyclicCapability;
          }
          type CyclicCapability = Metadata & {
            readonly run: (link: CycleLink) => void;
          };
          type CyclicOptions = {
            readonly capability?: CyclicCapability;
          };
        `,
      ],
    ],
    ["Cannot find namespace 'Missing'."]
  );
  assert.deepEqual(
    unresolvedAndClassMediatedDiagnostics,
    [
      schemaDiagnostic("qualified-and-class-mediated.ts", 11, 16),
      schemaDiagnostic("qualified-and-class-mediated.ts", 21, 16),
    ],
    "unresolved qualified and class-mediated callable arms must report their exact wrappers"
  );

  const methodAndNamespaceCycleDiagnostics = await analyzeCoreProject(
    ".gaia-schema-contract-method-and-namespace-cycles-",
    [
      [
        "method-and-namespace-cycle-rejections.ts",
        `
          import { Schema } from "effect";

          class Metadata extends Schema.Class<Metadata>("Metadata")({
            name: Schema.NonEmptyString,
          }) {}

          class CycleLink {
            next(): CyclicCapability {
              throw new Error();
            }
          }

          type CyclicCapability = Metadata & {
            readonly run: (link: CycleLink) => void;
          };

          type CyclicOptions = {
            readonly capability?: CyclicCapability;
          };

          namespace Links {
            export type Cycle = NamespaceCyclicCapability;
          }

          type NamespaceCyclicCapability = Metadata & {
            readonly run: (link: Links.Cycle) => void;
          };

          type NamespaceCyclicOptions = {
            readonly capability?: NamespaceCyclicCapability;
          };
        `,
      ],
    ]
  );
  assert.deepEqual(
    methodAndNamespaceCycleDiagnostics,
    [
      schemaDiagnostic("method-and-namespace-cycle-rejections.ts", 18, 16),
      schemaDiagnostic("method-and-namespace-cycle-rejections.ts", 30, 16),
    ],
    "instance-method and namespace-qualified cycles must report their exact wrappers"
  );

  const accessorGenericAndLocalNamespaceDiagnostics = await analyzeCoreProject(
    ".gaia-schema-contract-accessor-generic-local-namespace-",
    [
      [
        "accessor-generic-and-local-namespace-rejections.ts",
        `
          import { Schema } from "effect";

          class Metadata extends Schema.Class<Metadata>("Metadata")({
            name: Schema.NonEmptyString,
          }) {}

          class GetterLink {
            get next(): GetterCapability {
              throw new Error();
            }
          }
          type GetterCapability = Metadata & {
            readonly run: (link: GetterLink) => void;
          };
          type GetterOptions = {
            readonly capability?: GetterCapability;
          };

          class SetterLink {
            set next(value: SetterCapability) {}
          }
          type SetterCapability = Metadata & {
            readonly run: (link: SetterLink) => void;
          };
          type SetterOptions = {
            readonly capability?: SetterCapability;
          };

          class ConstraintLink {
            next<Value extends ConstraintCapability>(): void {}
          }
          type ConstraintCapability = Metadata & {
            readonly run: (link: ConstraintLink) => void;
          };
          type ConstraintOptions = {
            readonly capability?: ConstraintCapability;
          };

          class DefaultLink {
            next<Value = DefaultCapability>(): void {}
          }
          type DefaultCapability = Metadata & {
            readonly run: (link: DefaultLink) => void;
          };
          type DefaultOptions = {
            readonly capability?: DefaultCapability;
          };

          namespace Links {
            export type Request = string;
          }

          type NamespaceCapability = Metadata & {
            readonly run: (request: Links.Request) => void;
          };
          type NamespaceOptions = {
            readonly capability?: NamespaceCapability;
          };
        `,
      ],
    ]
  );
  assert.deepEqual(
    accessorGenericAndLocalNamespaceDiagnostics,
    [
      schemaDiagnostic(
        "accessor-generic-and-local-namespace-rejections.ts",
        16,
        16
      ),
      schemaDiagnostic(
        "accessor-generic-and-local-namespace-rejections.ts",
        26,
        16
      ),
      schemaDiagnostic(
        "accessor-generic-and-local-namespace-rejections.ts",
        36,
        16
      ),
      schemaDiagnostic(
        "accessor-generic-and-local-namespace-rejections.ts",
        46,
        16
      ),
      schemaDiagnostic(
        "accessor-generic-and-local-namespace-rejections.ts",
        57,
        16
      ),
    ],
    "accessor, generic-method, and local qualified-root wrappers must report at exact locations"
  );

  const parameterPropertyAndAbstractMethodDiagnostics =
    await analyzeCoreProject(
      ".gaia-schema-contract-parameter-property-abstract-method-",
      [
        [
          "parameter-property-and-abstract-method-rejections.ts",
          `
          import { Schema } from "effect";

          class Metadata extends Schema.Class<Metadata>("Metadata")({
            name: Schema.NonEmptyString,
          }) {}

          class ParameterPropertyLink {
            constructor(readonly next: ParameterPropertyCapability) {}
          }
          type ParameterPropertyCapability = Metadata & {
            readonly run: (link: ParameterPropertyLink) => void;
          };
          type ParameterPropertyOptions = {
            readonly capability?: ParameterPropertyCapability;
          };

          abstract class AbstractMethodLink {
            abstract next(value: AbstractMethodCapability): void;
          }
          type AbstractMethodCapability = Metadata & {
            readonly run: (link: AbstractMethodLink) => void;
          };
          type AbstractMethodOptions = {
            readonly capability?: AbstractMethodCapability;
          };
        `,
        ],
      ]
    );
  assert.deepEqual(
    parameterPropertyAndAbstractMethodDiagnostics,
    [
      schemaDiagnostic(
        "parameter-property-and-abstract-method-rejections.ts",
        14,
        16
      ),
      schemaDiagnostic(
        "parameter-property-and-abstract-method-rejections.ts",
        24,
        16
      ),
    ],
    "constructor parameter-property and abstract method cycles must report exact wrappers"
  );

  const ordinaryConstructorParameterDiagnostics = await analyzeCoreProject(
    ".gaia-schema-contract-ordinary-constructor-parameter-",
    [
      [
        "ordinary-constructor-parameter-accepted.ts",
        `
          import { Schema } from "effect";

          class Metadata extends Schema.Class<Metadata>("Metadata")({
            name: Schema.NonEmptyString,
          }) {}

          class Link {
            constructor(next: Capability) {
              void next;
            }
          }

          type Capability = Metadata & {
            readonly run: (link: Link) => void;
          };

          type Options = {
            readonly capability?: Capability;
          };
        `,
      ],
    ]
  );
  assert.deepEqual(
    ordinaryConstructorParameterDiagnostics,
    [],
    "an ordinary constructor-only parameter must not count as an instance-property edge"
  );

  const collectionReceiverProvenanceDiagnostics = await analyzeCoreProject(
    ".gaia-schema-contract-collection-receiver-provenance-",
    [
      [
        "schema-collection-receiver.ts",
        `
          import { Schema } from "effect";

          class Item extends Schema.Class<Item>("Item")({
            id: Schema.NonEmptyString,
          }) {}

          type Batch = {
            readonly items: ReadonlyArray<Item>;
          };

          export function collectIds(input: Batch) {
            return input.items.map((item) => item.id);
          }
        `,
      ],
      [
        "counterfeit-collection-receiver.ts",
        `
          class CounterfeitItem {
            constructor(readonly id: string) {}
          }

          type CounterfeitBatch = {
            readonly items: ReadonlyArray<CounterfeitItem>;
          };

          export function collectIds(input: CounterfeitBatch) {
            return input.items.map((item) => item.id);
          }
        `,
      ],
    ]
  );
  assert.equal(
    collectionReceiverProvenanceDiagnostics.some(
      (diagnostic) => diagnostic.filePath === "schema-collection-receiver.ts"
    ),
    false,
    "a readonly built-in collection of Schema class values has semantic receiver provenance"
  );
  assert.ok(
    collectionReceiverProvenanceDiagnostics.some(
      (diagnostic) =>
        diagnostic.filePath === "counterfeit-collection-receiver.ts"
    ),
    "a same-shaped collection of arbitrary class values must remain rejected"
  );

  const ephemeralOperationRecordDiagnostics = await analyzeCoreProject(
    ".gaia-schema-contract-ephemeral-operation-record-",
    [
      [
        "private-operation-record.ts",
        `
          type OperationRecord = {
            readonly attempt: number;
            readonly note: string;
          };

          class LocalCoordinator {
            #record(input: OperationRecord) {
              return input.note.trim();
            }

            run() {
              return this.#record({ attempt: 1, note: "local" });
            }
          }

          void LocalCoordinator;
        `,
      ],
      [
        "escaping-operation-record.ts",
        `
          type EscapingOperationRecord = {
            readonly attempt: number;
            readonly note: string;
          };

          export class PublicCoordinator {
            record(input: EscapingOperationRecord) {
              return input.note.trim();
            }
          }
        `,
      ],
    ]
  );
  assert.equal(
    ephemeralOperationRecordDiagnostics.some(
      (diagnostic) => diagnostic.filePath === "private-operation-record.ts"
    ),
    false,
    "a readonly operation record confined to a private local method is non-escaping"
  );
  assert.ok(
    ephemeralOperationRecordDiagnostics.some(
      (diagnostic) => diagnostic.filePath === "escaping-operation-record.ts"
    ),
    "a same-shaped record exposed by a public method on an exported class must remain rejected"
  );

  const capabilityWrapperDiagnostics = await analyzeCoreProject(
    ".gaia-schema-contract-capability-wrapper-",
    [
      [
        "capability-wrapper.ts",
        `
          import { Schema } from "effect";

          const ReviewerNameSchema = Schema.String.pipe(
            Schema.brand("ReviewerName")
          );
          type ReviewerName = typeof ReviewerNameSchema.Type;
          type MixedReviewerCapability = {
            readonly name: ReviewerName;
            readonly run: () => Promise<void>;
          };
          type ReviewerInjectionOptions = {
            readonly reviewer?: MixedReviewerCapability;
          };
        `,
      ],
    ]
  );
  assert.deepEqual(
    capabilityWrapperDiagnostics.map(({ filePath, line }) => ({
      filePath,
      line,
    })),
    [],
    "a callable capability with schema-derived configuration and its precise optional readonly wrapper are executable contracts"
  );

  const rejectedCapabilityWrapperDiagnostics = await analyzeCoreProject(
    ".gaia-schema-contract-rejected-capability-wrappers-",
    [
      [
        "rejected-capability-wrappers.ts",
        `
          import { Schema } from "effect";

          const RunIdSchema = Schema.String.pipe(Schema.brand("RunId"));
          type RunId = typeof RunIdSchema.Type;
          type CallableCapability = {
            readonly run: () => Promise<void>;
          };
          type RequiredCapabilityOptions = {
            readonly capability: CallableCapability;
          };
          type MutableCapabilityOptions = {
            capability?: CallableCapability;
          };
          type DataCapabilityOptions = {
            readonly capability?: CallableCapability;
            readonly runId?: RunId;
          };
          type NoCallCapability = {
            readonly runId: RunId;
          };
          type NoCallCapabilityOptions = {
            readonly capability?: NoCallCapability;
          };
          type CircularCapability = {
            readonly next?: CircularCapability;
          };
          type CircularCapabilityOptions = {
            readonly capability?: CircularCapability;
          };
          type GenericCapability<Value> = {
            readonly run: (value: Value) => void;
          };
          type GenericCapabilityOptions = {
            readonly capability?: GenericCapability<RunId>;
          };
          type GenericWrapper<Capability> = {
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
          type MixedCapability = {
            readonly runId: RunId;
            readonly run: () => void;
          };
          type CapabilityAlias = MixedCapability;
          type AliasedCapabilityOptions = {
            readonly capability?: CapabilityAlias;
          };
        `,
      ],
      [
        "opaque-capability.d.ts",
        `
          export interface OpaqueCapability {
            readonly run(): void;
          }
        `,
      ],
      [
        "opaque-capability-wrapper.ts",
        `
          import type { OpaqueCapability } from "./opaque-capability.js";
          type OpaqueCapabilityOptions = {
            readonly capability?: OpaqueCapability;
          };
        `,
      ],
    ]
  );
  assert.deepEqual(
    rejectedCapabilityWrapperDiagnostics.reduce((counts, diagnostic) => {
      counts[diagnostic.filePath] = (counts[diagnostic.filePath] ?? 0) + 1;
      return counts;
    }, {}),
    {
      "opaque-capability-wrapper.ts": 1,
      "rejected-capability-wrappers.ts": 10,
    },
    "direct and schema-configured executable capabilities are accepted while required, mutable, generic, aliased, circular, opaque, and non-callable wrappers report"
  );

  const xstateMetadataDiagnostics = await analyzeCoreProject(
    ".gaia-schema-contract-xstate-metadata-",
    [
      [
        "machine.ts",
        `
          import { Schema } from "effect";
          import { setup } from "xstate";

          const ContextSchema = Schema.Struct({ runId: Schema.String });
          type Context = typeof ContextSchema.Type;
          const EventSchema = Schema.Struct({ type: Schema.Literal("RUN") });
          type Event = typeof EventSchema.Type;
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
      ],
    ]
  );
  assert.deepEqual(
    xstateMetadataDiagnostics,
    [],
    "only exact XState setup action and guard metadata maps are manual types"
  );

  const rejectedXStateMetadataDiagnostics = await analyzeCoreProject(
    ".gaia-schema-contract-rejected-xstate-metadata-",
    [
      [
        "fake-xstate.ts",
        `
          export const setup = <A, B, C, D, E, F>(input: unknown): unknown =>
            input;
        `,
      ],
      [
        "rejected-xstate-metadata.ts",
        `
          import { Schema } from "effect";
          import { setup } from "xstate";

          const ContextSchema = Schema.Struct({ runId: Schema.String });
          type Context = typeof ContextSchema.Type;
          const EventSchema = Schema.Struct({ type: Schema.Literal("RUN") });
          type Event = typeof EventSchema.Type;
          type ExactMetadata = { readonly exact: undefined };
          type RecordMetadata = Record<string, undefined>;
          type MappedMetadata = {
            readonly [Key in "recordRun"]: undefined;
          };
          type GenericMetadata<Key extends string> = {
            readonly [Name in Key]: undefined;
          };
          type ArbitraryMetadata = { readonly recordRun: string };
          type MixedMetadata = {
            readonly recordRun: undefined;
            readonly onRun: () => void;
          };
          type CallbackMetadata = {
            readonly onRun: () => void;
          };
          type HiddenMetadata = {
            readonly recordRun: { readonly runId: string };
          };
          type MutableMetadata = { recordRun: undefined };
          type OptionalMetadata = { readonly recordRun?: undefined };
          type DataMetadata = { readonly recordRun: unknown };
          export type ExportedMetadata = { readonly recordRun: undefined };
          type ReusedMetadata = { readonly recordRun: undefined };
          type HiddenReuse = ReusedMetadata;
          type WrongPositionMetadata = {};

          setup<Context, Event, Record<never, never>, Record<never, string>, RecordMetadata, ExactMetadata>({});
          setup<Context, Event, Record<never, never>, Record<never, string>, MappedMetadata, ExactMetadata>({});
          setup<Context, Event, Record<never, never>, Record<never, string>, GenericMetadata<"recordRun">, ExactMetadata>({});
          setup<Context, Event, Record<never, never>, Record<never, string>, ArbitraryMetadata, ExactMetadata>({});
          setup<Context, Event, Record<never, never>, Record<never, string>, MixedMetadata, ExactMetadata>({});
          setup<Context, Event, Record<never, never>, Record<never, string>, CallbackMetadata, ExactMetadata>({});
          setup<Context, Event, Record<never, never>, Record<never, string>, HiddenMetadata, ExactMetadata>({});
          setup<Context, Event, Record<never, never>, Record<never, string>, MutableMetadata, OptionalMetadata>({});
          setup<Context, Event, Record<never, never>, Record<never, string>, DataMetadata, ExactMetadata>({});
          setup<Context, Event, Record<never, never>, Record<never, string>, ExportedMetadata, ExactMetadata>({});
          setup<Context, Event, Record<never, never>, Record<never, string>, ReusedMetadata, ExactMetadata>({});
          setup<Context, Event, WrongPositionMetadata, Record<never, string>, ExactMetadata, ExactMetadata>({});
          void (0 as unknown as HiddenReuse);
        `,
      ],
      [
        "counterfeit-xstate.ts",
        `
          import { setup } from "./fake-xstate.js";
          type CounterfeitMetadata = { readonly recordRun: undefined };
          setup<unknown, unknown, unknown, unknown, CounterfeitMetadata, CounterfeitMetadata>({});
        `,
      ],
      [
        "shadowed-xstate.ts",
        `
          import { setup } from "xstate";
          import { setup as counterfeitSetup } from "./fake-xstate.js";
          type ShadowedMetadata = { readonly recordRun: undefined };
          function build(setup: typeof counterfeitSetup): unknown {
            return setup<unknown, unknown, unknown, unknown, ShadowedMetadata, ShadowedMetadata>({});
          }
          void setup;
          void build;
        `,
      ],
    ]
  );
  assert.deepEqual(
    rejectedXStateMetadataDiagnostics.reduce((counts, diagnostic) => {
      counts[diagnostic.filePath] = (counts[diagnostic.filePath] ?? 0) + 1;
      return counts;
    }, {}),
    {
      "counterfeit-xstate.ts": 1,
      "rejected-xstate-metadata.ts": 14,
      "shadowed-xstate.ts": 1,
    },
    "generic, counterfeit, shadowed, reused, and data-bearing XState metadata must report"
  );

  const rejectedCrossFileUnionDiagnostics = await analyzeCoreProject(
    ".gaia-schema-contract-rejected-cross-file-unions-",
    [
      [
        "unsafe-unions.ts",
        `
          import { Schema } from "effect";

          const CounterfeitLeaf =
            {} as unknown as typeof Schema.String;
          export const CounterfeitUnionSchema = Schema.Union([
            CounterfeitLeaf,
            Schema.String,
          ]);
          export type CounterfeitUnion =
            typeof CounterfeitUnionSchema.Type;

          const MutableBase = { value: Schema.String };
          MutableBase.value = CounterfeitLeaf;
          export const MutableUnionSchema = Schema.Union([
            Schema.Struct({ ...MutableBase, state: Schema.Literal("ready") }),
          ]);
          export type MutableUnion = typeof MutableUnionSchema.Type;

          let escaped: unknown;
          export const EscapedUnionSchema = Schema.Union([
            Schema.String,
            Schema.Number,
          ]);
          escaped = EscapedUnionSchema;
          export type EscapedUnion = typeof EscapedUnionSchema.Type;

          const InnerBase = { value: Schema.String } as const;
          const NestedBase = { ...InnerBase, count: Schema.Number } as const;
          export const NestedUnionSchema = Schema.Union([
            Schema.Struct({ ...NestedBase, state: Schema.Literal("ready") }),
          ]);
          export type NestedUnion = typeof NestedUnionSchema.Type;
          void escaped;
        `,
      ],
      [
        "unsafe-union-use.ts",
        `
          import { Schema } from "effect";
          import {
            CounterfeitUnionSchema,
            EscapedUnionSchema,
            MutableUnionSchema,
            NestedUnionSchema,
          } from "./unsafe-unions.js";

          export const CombinedUnsafeUnionSchema = Schema.Union([
            CounterfeitUnionSchema,
            EscapedUnionSchema,
            MutableUnionSchema,
            NestedUnionSchema,
          ]);
        `,
      ],
      [
        "local-only-union.ts",
        `
          import { Schema } from "effect";
          const LocalBase = { value: Schema.String } as const;
          export const LocalOnlyUnionSchema = Schema.Union([
            Schema.Struct({ ...LocalBase, state: Schema.Literal("ready") }),
          ]);
          export type LocalOnlyUnion = typeof LocalOnlyUnionSchema.Type;
        `,
      ],
    ]
  );
  assert.deepEqual(
    rejectedCrossFileUnionDiagnostics.reduce((counts, diagnostic) => {
      counts[diagnostic.filePath] = (counts[diagnostic.filePath] ?? 0) + 1;
      return counts;
    }, {}),
    {
      "local-only-union.ts": 1,
      "unsafe-unions.ts": 4,
    },
    "counterfeit, mutable, escaped, nested, and local-only union provenance must report"
  );

  const registerDiagnostics = await analyzeIsolatedProject(
    ".gaia-schema-contract-register-",
    [
      [
        "manual-register.tsx",
        `
          const makeManualDto = () => ({ runId: "run-1" });
          interface Register {
            router: ReturnType<typeof makeManualDto>;
          }
        `,
      ],
      [
        "apps/dashboard/src/router.tsx",
        `
          export {};
          declare function getRouter(): unknown;
          declare module "@tanstack/react-router" {
            interface Register {
              router: ReturnType<typeof getRouter>;
            }
          }
        `,
      ],
    ]
  );
  assert.ok(
    registerDiagnostics.some(
      (diagnostic) =>
        diagnostic.filePath === "manual-register.tsx" &&
        diagnostic.rule === "gaia/schema-first-data-contract"
    ),
    "local Register.router ReturnType wrappers must not hide inferred manual DTOs"
  );
  assert.equal(
    registerDiagnostics.some(
      (diagnostic) => diagnostic.filePath === "apps/dashboard/src/router.tsx"
    ),
    false,
    "only the exact dashboard TanStack router Register augmentation remains accepted"
  );

  const providerPathDiagnostics = await analyzeIsolatedProject(
    ".gaia-schema-contract-provider-path-",
    [
      [
        "apps/dashboard/src/codex-app-server-protocol.ts",
        `
          import { Schema } from "effect";
          const FileRequest = Schema.Struct({
            method: Schema.Literal("item/commandExecution/requestApproval"),
          });
          const CodexServerRequestProjectionSchema = Schema.Union([
            FileRequest,
          ]);
          export const CodexServerRequestSchema =
            CodexServerRequestProjectionSchema;
          export type CodexServerRequest = typeof CodexServerRequestSchema.Type;
          export type FileApprovalRequest = Extract<
            CodexServerRequest,
            { readonly method: "item/commandExecution/requestApproval" }
          >;
        `,
      ],
    ]
  );
  assert.ok(
    providerPathDiagnostics.every(
      (diagnostic) =>
        diagnostic.filePath !==
          "apps/dashboard/src/codex-app-server-protocol.ts" ||
        diagnostic.message !==
          "Nested operation data contract has no compiler-proven Schema origin."
    ),
    "direct selectors over a compiler-proven Schema union must not depend on a repository path allowance"
  );

  const generatedProjectRoot = await mkdtemp(
    path.join(repoRoot, ".gaia-schema-contract-generated-")
  );
  try {
    await writeFile(
      path.join(generatedProjectRoot, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          exactOptionalPropertyTypes: true,
          module: "NodeNext",
          moduleResolution: "NodeNext",
          noEmit: true,
          skipLibCheck: true,
          strict: true,
          target: "ES2024",
        },
        include: ["*.ts"],
      })
    );
    await writeFile(
      path.join(generatedProjectRoot, "routeTree.gen.ts"),
      `export type GeneratedRoute = { readonly routeId: string };`
    );
    await writeFile(
      path.join(generatedProjectRoot, "manual.ts"),
      `export type ManualRun = { readonly runId: string };`
    );
    assert.deepEqual(
      analyzeSchemaContracts({
        cwd: generatedProjectRoot,
        projectPath: path.join(generatedProjectRoot, "tsconfig.json"),
      }),
      [schemaDiagnostic("manual.ts", 1, 13)],
      "generated files matching **/*.gen.* must be excluded from the compiler stream"
    );
  } finally {
    await rm(generatedProjectRoot, { force: true, recursive: true });
  }

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
    "ownership.ts:3:4 gaia/no-brand-cast ownership finding Remedy: decode with the owning Schema",
    "syntax.ts:1:2 gaia/schema-first-data-contract syntax finding Remedy: define a Schema",
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
