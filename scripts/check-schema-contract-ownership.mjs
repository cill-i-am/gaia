import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const anchorFileName = "__gaia_schema_contract_anchor.ts";
const xstateAnchorFileName = "__gaia_xstate_contract_anchor.ts";
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const anchorSource = `
  import { Schema } from "effect";
  import { HttpApiEndpoint, HttpApiSchema } from "effect/unstable/httpapi";
  import { vi } from "vitest";
  export type __GaiaSchemaTop = Schema.Top;
  export type __GaiaSchemaConstraint = Schema.Constraint;
  export const __GaiaPlainSchema = Schema.String;
  export type __GaiaPlainType = typeof __GaiaPlainSchema.Type;
  export const __GaiaSuspendedSchema = Schema.suspend(
    () => __GaiaPlainSchema
  );
  export const __GaiaStructSchema = Schema.Struct({
    value: __GaiaPlainSchema
  });
  export const __GaiaStructFields = __GaiaStructSchema.fields;
  export class __GaiaClassSchema extends Schema.Class<__GaiaClassSchema>(
    "__GaiaClassSchema"
  )({ value: __GaiaPlainSchema }) {}
  export const __GaiaClassFields = __GaiaClassSchema.fields;
  export const __GaiaUnionSchema = Schema.Union([__GaiaPlainSchema]);
  export const __GaiaUnionFactory = Schema.Union;
  export const __GaiaUnionMembers = __GaiaUnionSchema.members;
  export const __GaiaLiteralSchema = Schema.Literals(["one", "two"]);
  export const __GaiaLiteralValues = __GaiaLiteralSchema.literals;
  export const __GaiaHttpGet = HttpApiEndpoint.get;
  export const __GaiaHttpPost = HttpApiEndpoint.post;
  export const __GaiaHttpStreamSse = HttpApiSchema.StreamSse;
  export const __GaiaVitestHoisted = vi.hoisted;
  export const __GaiaVitestMock = vi.mock;
  export const __GaiaSchemaDeclare = Schema.declare;
  export const __GaiaSchemaDecodeTo = Schema.decodeTo;
  export const __GaiaEventSourceConstructor = EventSource;
  export type __GaiaEvent = Event;
  export type __GaiaMessageEvent = MessageEvent;
  export const __GaiaBrandedSchema = Schema.String.pipe(
    Schema.brand("__GaiaBrandAnchor")
  );
  export type __GaiaBrandedType = typeof __GaiaBrandedSchema.Type;
  export const __GaiaPipedSchema = __GaiaPlainSchema.pipe(
    Schema.brand("__GaiaPipeAnchor")
  );
  export type __GaiaCanonicalSchemaType =
    Schema.Schema.Type<typeof __GaiaBrandedSchema>;
  export type __GaiaCanonicalPick = Pick<__GaiaBrandedType, never>;
  export type __GaiaCanonicalOmit = Omit<__GaiaBrandedType, never>;
  export type __GaiaCanonicalExtract = Extract<
    __GaiaBrandedType,
    __GaiaBrandedType
  >;
  export type __GaiaExtract<T, U> = Extract<T, U>;
`;
const xstateAnchorSource = `
  import { setup } from "xstate";
  export const __GaiaXStateSetup = setup;
`;

const schemaFirstRemedy =
  "Define the owning Effect Schema and derive this contract from its decoded Type.";
const brandCastRemedy =
  "Decode with the owning Effect Schema or parser and carry its branded result inward.";
const displayAndProseNames = new Set([
  "content",
  "description",
  "displayName",
  "label",
  "labels",
  "message",
  "reason",
  "remediation",
  "summary",
  "text",
  "title",
  "tooltip",
]);
const terminalSemanticTokens = new Set([
  "branch",
  "branches",
  "command",
  "commands",
  "digest",
  "digests",
  "directories",
  "directory",
  "handle",
  "handles",
  "hash",
  "hashes",
  "id",
  "identifier",
  "identifiers",
  "ids",
  "model",
  "models",
  "oid",
  "oids",
  "path",
  "paths",
  "ref",
  "refs",
  "remote",
  "remotes",
  "repo",
  "repos",
  "repositories",
  "repository",
  "sha",
  "shas",
  "timestamp",
  "timestamps",
  "uri",
  "uris",
  "url",
  "urls",
  "version",
  "versions",
]);
const lifecycleTimePrefixes = new Set([
  "canceled",
  "completed",
  "created",
  "expired",
  "expires",
  "merged",
  "published",
  "received",
  "recorded",
  "started",
  "updated",
]);
const semanticDomainNames = new Set([
  "branchName",
  "harnessName",
  "providerName",
  "remoteName",
  "repositoryName",
  "reviewerName",
  "skillName",
]);
const frameworkStateNames = new Set([
  "asChild",
  "className",
  "collapsible",
  "defaultOpen",
  "disabled",
  "inset",
  "isActive",
  "isMobile",
  "open",
  "openMobile",
  "pending",
  "showCloseButton",
  "showIcon",
  "showOnHover",
  "side",
  "size",
  "state",
  "style",
  "variant",
  "withHandle",
]);
const frameworkTypeNames = new Set([
  "ComponentProps",
  "ComponentPropsWithRef",
  "ComponentPropsWithoutRef",
  "Element",
  "Props",
  "ReactElement",
  "ReactNode",
  "VariantProps",
]);
const isGeneratedFilePath = (fileName) =>
  path.basename(fileName).includes(".gen.");

const resolveAlias = (checker, symbol) => {
  let current = symbol;
  const seen = new Set();
  while ((current.flags & ts.SymbolFlags.Alias) !== 0 && !seen.has(current)) {
    seen.add(current);
    current = checker.getAliasedSymbol(current);
  }
  return current;
};

const getValueTypeForEntityName = (checker, entityName) => {
  const symbol = checker.getSymbolAtLocation(entityName);
  if (symbol === undefined) return undefined;
  const resolved = resolveAlias(checker, symbol);
  const declaration = resolved.valueDeclaration ?? resolved.declarations?.[0];
  return declaration === undefined
    ? undefined
    : checker.getTypeOfSymbolAtLocation(resolved, declaration);
};

const getValueSymbolForEntityName = (checker, entityName) => {
  const symbol = checker.getSymbolAtLocation(entityName);
  return symbol === undefined ? undefined : resolveAlias(checker, symbol);
};

const isCallableMember = (member) => {
  if (
    ts.isCallSignatureDeclaration(member) ||
    ts.isConstructSignatureDeclaration(member) ||
    ts.isMethodSignature(member)
  ) {
    return true;
  }
  return (
    ts.isPropertySignature(member) &&
    member.type !== undefined &&
    ts.isFunctionTypeNode(member.type)
  );
};

const isAllCallable = (members) =>
  members.length > 0 && members.every(isCallableMember);

const getPropertyName = (name) => {
  if (name === undefined) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return undefined;
};

const tokenizeName = (name) =>
  name
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2")
    .split(/[^A-Za-z0-9]+/u)
    .filter(Boolean)
    .map((token) => token.toLowerCase());

const isSemanticName = (name) => {
  if (semanticDomainNames.has(name)) return true;
  const tokens = tokenizeName(name);
  const terminal = tokens.at(-1);
  if (terminal === undefined) return false;
  if (terminalSemanticTokens.has(terminal)) return true;
  return (
    terminal === "at" &&
    tokens.length >= 2 &&
    lifecycleTimePrefixes.has(tokens.at(-2))
  );
};

const getTypeReferenceName = (node) => {
  if (!ts.isTypeReferenceNode(node)) return undefined;
  if (ts.isIdentifier(node.typeName)) return node.typeName.text;
  return (
    ts.isQualifiedName(node.typeName) &&
    `${getEntityNameText(node.typeName.left)}.${node.typeName.right.text}`
  );
};

const getEntityNameText = (node) => {
  if (ts.isIdentifier(node)) return node.text;
  return `${getEntityNameText(node.left)}.${node.right.text}`;
};

function isLiteralFrameworkStateType(node) {
  if (
    node.kind === ts.SyntaxKind.BooleanKeyword ||
    node.kind === ts.SyntaxKind.NumberKeyword
  ) {
    return true;
  }
  if (ts.isLiteralTypeNode(node)) return true;
  return (
    ts.isUnionTypeNode(node) &&
    node.types.length > 0 &&
    node.types.every(isLiteralFrameworkStateType)
  );
}

function isFrameworkDisplayType(node) {
  if (node.kind === ts.SyntaxKind.StringKeyword) return true;
  if (isFrameworkTypeNode(node)) return true;
  return (
    ts.isUnionTypeNode(node) &&
    node.types.length > 0 &&
    node.types.every(
      (candidate) =>
        candidate.kind === ts.SyntaxKind.StringKeyword ||
        isFrameworkTypeNode(candidate)
    )
  );
}

function isFrameworkStructuralMember(member) {
  if (
    ts.isCallSignatureDeclaration(member) ||
    ts.isConstructSignatureDeclaration(member) ||
    ts.isMethodSignature(member) ||
    (ts.isPropertySignature(member) &&
      member.type !== undefined &&
      ts.isFunctionTypeNode(member.type))
  ) {
    return true;
  }
  if (!ts.isPropertySignature(member) || member.type === undefined) {
    return false;
  }
  const name = getPropertyName(member.name);
  return (
    isFrameworkTypeNode(member.type, { allowReadonly: true }) ||
    (name !== undefined &&
      ((displayAndProseNames.has(name) &&
        isFrameworkDisplayType(member.type)) ||
        (frameworkStateNames.has(name) &&
          isLiteralFrameworkStateType(member.type))))
  );
}

function isFrameworkTypeNode(node, { allowReadonly = false } = {}) {
  if (!ts.isTypeReferenceNode(node)) return false;
  const typeName = getTypeReferenceName(node);
  if (typeName === "Readonly") {
    const argument = node.typeArguments?.[0];
    return (
      allowReadonly &&
      node.typeArguments?.length === 1 &&
      argument !== undefined &&
      ts.isTypeLiteralNode(argument) &&
      argument.members.length > 0 &&
      argument.members.every(isFrameworkStructuralMember)
    );
  }
  if (typeName === undefined) return false;
  const rightName = typeName.split(".").at(-1);
  return (
    rightName !== undefined &&
    (frameworkTypeNames.has(rightName) ||
      (typeName.includes(".") && rightName.endsWith("Props")))
  );
}

const getSchemaTopType = (checker, anchorFile) => {
  const declaration = anchorFile.statements.find(
    (statement) =>
      ts.isTypeAliasDeclaration(statement) &&
      statement.name.text === "__GaiaSchemaTop"
  );
  if (declaration === undefined || !ts.isTypeAliasDeclaration(declaration)) {
    throw new Error(
      "Gaia schema-contract checker could not resolve Schema.Top"
    );
  }
  return checker.getTypeFromTypeNode(declaration.type);
};

const getAnchorType = (checker, anchorFile, name) => {
  const declaration = anchorFile.statements.find(
    (statement) =>
      ts.isTypeAliasDeclaration(statement) && statement.name.text === name
  );
  if (declaration === undefined || !ts.isTypeAliasDeclaration(declaration)) {
    throw new Error(`Gaia schema-contract checker could not resolve ${name}`);
  }
  return checker.getTypeFromTypeNode(declaration.type);
};

const getAnchorTypeDeclaration = (anchorFile, name) => {
  const declaration = anchorFile.statements.find(
    (statement) =>
      ts.isTypeAliasDeclaration(statement) && statement.name.text === name
  );
  if (declaration === undefined || !ts.isTypeAliasDeclaration(declaration)) {
    throw new Error(`Gaia schema-contract checker could not resolve ${name}`);
  }
  return declaration;
};

const getCanonicalDecodedTypeProperty = (checker, anchorFile) => {
  const declaration = getAnchorTypeDeclaration(anchorFile, "__GaiaPlainType");
  if (
    !ts.isTypeQueryNode(declaration.type) ||
    !ts.isQualifiedName(declaration.type.exprName)
  ) {
    throw new Error(
      "Gaia schema-contract checker could not resolve Schema decoded Type property"
    );
  }
  const symbol = checker.getSymbolAtLocation(declaration.type.exprName.right);
  if (symbol === undefined || (symbol.declarations?.length ?? 0) === 0) {
    throw new Error(
      "Gaia schema-contract checker could not prove Schema decoded Type property provenance"
    );
  }
  return {
    declarationFiles: new Set(
      symbol.declarations.map((declaration) => declaration.getSourceFile())
    ),
    escapedName: symbol.escapedName,
  };
};

const getCanonicalProjectionSymbols = (checker, anchorFile) => {
  const symbols = new Set();
  for (const name of [
    "__GaiaCanonicalExtract",
    "__GaiaCanonicalOmit",
    "__GaiaCanonicalPick",
  ]) {
    const declaration = getAnchorTypeDeclaration(anchorFile, name);
    if (!ts.isTypeReferenceNode(declaration.type)) {
      throw new Error(
        `Gaia schema-contract checker could not resolve canonical projection ${name}`
      );
    }
    const symbol = checker.getSymbolAtLocation(declaration.type.typeName);
    if (symbol === undefined) {
      throw new Error(
        `Gaia schema-contract checker could not prove canonical projection ${name}`
      );
    }
    symbols.add(resolveAlias(checker, symbol));
  }
  return symbols;
};

const getCanonicalSchemaDeclarationFiles = (checker, anchorFile) => {
  const declaration = getAnchorTypeDeclaration(anchorFile, "__GaiaSchemaTop");
  if (!ts.isTypeReferenceNode(declaration.type)) {
    throw new Error(
      "Gaia schema-contract checker could not resolve canonical Schema declarations"
    );
  }
  const symbol = checker.getSymbolAtLocation(declaration.type.typeName);
  if (symbol === undefined) {
    throw new Error(
      "Gaia schema-contract checker could not prove canonical Schema declarations"
    );
  }
  return new Set(
    (resolveAlias(checker, symbol).declarations ?? []).map((candidate) =>
      candidate.getSourceFile()
    )
  );
};

const getCanonicalSchemaTypeSymbol = (checker, anchorFile) => {
  const declaration = getAnchorTypeDeclaration(
    anchorFile,
    "__GaiaCanonicalSchemaType"
  );
  if (!ts.isTypeReferenceNode(declaration.type)) {
    throw new Error(
      "Gaia schema-contract checker could not resolve Schema.Schema.Type"
    );
  }
  const symbol = checker.getSymbolAtLocation(declaration.type.typeName);
  if (symbol === undefined) {
    throw new Error(
      "Gaia schema-contract checker could not prove Schema.Schema.Type provenance"
    );
  }
  return resolveAlias(checker, symbol);
};

const getCanonicalSchemaPipeSymbol = (checker, anchorFile) => {
  const declaration = anchorFile.statements.find(
    (statement) =>
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some(
        (candidate) =>
          candidate.name.getText(anchorFile) === "__GaiaPipedSchema"
      )
  );
  const variable =
    declaration !== undefined && ts.isVariableStatement(declaration)
      ? declaration.declarationList.declarations.find(
          (candidate) =>
            candidate.name.getText(anchorFile) === "__GaiaPipedSchema"
        )
      : undefined;
  if (
    variable?.initializer === undefined ||
    !ts.isCallExpression(variable.initializer) ||
    !ts.isPropertyAccessExpression(variable.initializer.expression)
  ) {
    throw new Error(
      "Gaia schema-contract checker could not resolve Schema pipe composition"
    );
  }
  const symbol = checker.getSymbolAtLocation(
    variable.initializer.expression.name
  );
  if (symbol === undefined) {
    throw new Error(
      "Gaia schema-contract checker could not prove Schema pipe composition"
    );
  }
  return resolveAlias(checker, symbol);
};

const getCanonicalSchemaClassSymbol = (checker, anchorFile) => {
  const declaration = anchorFile.statements.find(
    (statement) =>
      ts.isClassDeclaration(statement) &&
      statement.name?.text === "__GaiaClassSchema"
  );
  const heritage =
    declaration !== undefined && ts.isClassDeclaration(declaration)
      ? declaration.heritageClauses?.find(
          (clause) => clause.token === ts.SyntaxKind.ExtendsKeyword
        )
      : undefined;
  const schemaClass = heritage?.types[0]?.expression;
  const factory =
    schemaClass !== undefined && ts.isCallExpression(schemaClass)
      ? schemaClass.expression
      : undefined;
  const member =
    factory !== undefined &&
    ts.isCallExpression(factory) &&
    ts.isPropertyAccessExpression(factory.expression)
      ? factory.expression.name
      : undefined;
  const symbol =
    member === undefined ? undefined : checker.getSymbolAtLocation(member);
  if (symbol === undefined) {
    throw new Error(
      "Gaia schema-contract checker could not prove Schema.Class provenance"
    );
  }
  return resolveAlias(checker, symbol);
};

const getCanonicalSchemaSuspendSymbol = (checker, anchorFile) => {
  const declaration = anchorFile.statements.find(
    (statement) =>
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some(
        (candidate) =>
          candidate.name.getText(anchorFile) === "__GaiaSuspendedSchema"
      )
  );
  const variable =
    declaration !== undefined && ts.isVariableStatement(declaration)
      ? declaration.declarationList.declarations.find(
          (candidate) =>
            candidate.name.getText(anchorFile) === "__GaiaSuspendedSchema"
        )
      : undefined;
  if (
    variable?.initializer === undefined ||
    !ts.isCallExpression(variable.initializer)
  ) {
    throw new Error(
      "Gaia schema-contract checker could not resolve Schema suspend composition"
    );
  }
  const symbol = checker.getSymbolAtLocation(variable.initializer.expression);
  if (symbol === undefined) {
    throw new Error(
      "Gaia schema-contract checker could not prove Schema suspend composition"
    );
  }
  return resolveAlias(checker, symbol);
};

const getCanonicalSchemaContainerPropertySymbols = (checker, anchorFile) => {
  const symbols = new Map();
  for (const name of [
    "__GaiaStructFields",
    "__GaiaClassFields",
    "__GaiaUnionMembers",
  ]) {
    const statement = anchorFile.statements.find(
      (candidate) =>
        ts.isVariableStatement(candidate) &&
        candidate.declarationList.declarations.some(
          (declaration) => declaration.name.getText(anchorFile) === name
        )
    );
    const declaration =
      statement !== undefined && ts.isVariableStatement(statement)
        ? statement.declarationList.declarations.find(
            (candidate) => candidate.name.getText(anchorFile) === name
          )
        : undefined;
    if (
      declaration?.initializer === undefined ||
      !ts.isPropertyAccessExpression(declaration.initializer)
    ) {
      throw new Error(
        `Gaia schema-contract checker could not resolve canonical container property ${name}`
      );
    }
    const symbol = checker.getSymbolAtLocation(declaration.initializer.name);
    if (symbol === undefined) {
      throw new Error(
        `Gaia schema-contract checker could not prove canonical container property ${name}`
      );
    }
    const resolved = resolveAlias(checker, symbol);
    const declarations = new Set(
      (resolved.declarations ?? []).map(
        (candidate) =>
          `${candidate.getSourceFile().fileName}:${candidate.getStart()}:${candidate.getEnd()}`
      )
    );
    if (declarations.size === 0) {
      throw new Error(
        `Gaia schema-contract checker could not anchor canonical container property ${name}`
      );
    }
    const existing = symbols.get(resolved.escapedName);
    symbols.set(
      resolved.escapedName,
      new Set([...(existing ?? []), ...declarations])
    );
  }
  return symbols;
};

const getAnchorInitializerSymbol = (checker, anchorFile, name) => {
  const statement = anchorFile.statements.find(
    (candidate) =>
      ts.isVariableStatement(candidate) &&
      candidate.declarationList.declarations.some(
        (declaration) => declaration.name.getText(anchorFile) === name
      )
  );
  const declaration =
    statement !== undefined && ts.isVariableStatement(statement)
      ? statement.declarationList.declarations.find(
          (candidate) => candidate.name.getText(anchorFile) === name
        )
      : undefined;
  if (declaration?.initializer === undefined) {
    throw new Error(`Gaia schema-contract checker could not resolve ${name}`);
  }
  const location = ts.isPropertyAccessExpression(declaration.initializer)
    ? declaration.initializer.name
    : declaration.initializer;
  const symbol = checker.getSymbolAtLocation(location);
  if (symbol === undefined) {
    throw new Error(`Gaia schema-contract checker could not prove ${name}`);
  }
  return resolveAlias(checker, symbol);
};

const getAnchorTypeReferenceSymbol = (checker, anchorFile, name) => {
  const declaration = anchorFile.statements.find(
    (candidate) =>
      ts.isTypeAliasDeclaration(candidate) && candidate.name.text === name
  );
  if (
    declaration === undefined ||
    !ts.isTypeAliasDeclaration(declaration) ||
    !ts.isTypeReferenceNode(declaration.type)
  ) {
    throw new Error(`Gaia schema-contract checker could not resolve ${name}`);
  }
  const symbol = checker.getSymbolAtLocation(declaration.type.typeName);
  if (symbol === undefined) {
    throw new Error(`Gaia schema-contract checker could not prove ${name}`);
  }
  return resolveAlias(checker, symbol);
};

const isCanonicalSchemaContainerProperty = (checker, proof, symbol) => {
  const resolved = resolveAlias(checker, symbol);
  const canonicalDeclarations =
    proof.canonicalSchemaContainerPropertySymbols.get(resolved.escapedName);
  return (
    canonicalDeclarations !== undefined &&
    (resolved.declarations ?? []).some((declaration) =>
      canonicalDeclarations.has(
        `${declaration.getSourceFile().fileName}:${declaration.getStart()}:${declaration.getEnd()}`
      )
    )
  );
};

const hasSameDeclaration = (checker, left, right) => {
  const rightDeclarations = new Set(
    (resolveAlias(checker, right).declarations ?? []).map(
      (declaration) =>
        `${declaration.getSourceFile().fileName}:${declaration.getStart()}:${declaration.getEnd()}`
    )
  );
  return (
    rightDeclarations.size > 0 &&
    (resolveAlias(checker, left).declarations ?? []).some((declaration) =>
      rightDeclarations.has(
        `${declaration.getSourceFile().fileName}:${declaration.getStart()}:${declaration.getEnd()}`
      )
    )
  );
};

const isCanonicalSchemaPipeProperty = (checker, proof, symbol) =>
  hasSameDeclaration(checker, symbol, proof.canonicalSchemaPipeSymbol);

const createSchemaProof = (checker, anchorFile, xstateAnchorFile) => ({
  canonicalDecodedTypeProperty: getCanonicalDecodedTypeProperty(
    checker,
    anchorFile
  ),
  canonicalProjectionSymbols: getCanonicalProjectionSymbols(
    checker,
    anchorFile
  ),
  canonicalSchemaDeclarationFiles: getCanonicalSchemaDeclarationFiles(
    checker,
    anchorFile
  ),
  canonicalSchemaClassSymbol: getCanonicalSchemaClassSymbol(
    checker,
    anchorFile
  ),
  canonicalSchemaPipeSymbol: getCanonicalSchemaPipeSymbol(checker, anchorFile),
  canonicalSchemaContainerPropertySymbols:
    getCanonicalSchemaContainerPropertySymbols(checker, anchorFile),
  canonicalSchemaSuspendSymbol: getCanonicalSchemaSuspendSymbol(
    checker,
    anchorFile
  ),
  canonicalSchemaUnionSymbol: getAnchorInitializerSymbol(
    checker,
    anchorFile,
    "__GaiaUnionFactory"
  ),
  canonicalSchemaTypeSymbol: getCanonicalSchemaTypeSymbol(checker, anchorFile),
  effectSchemaConsumers: [
    {
      argumentIndex: 2,
      roots: new Set([
        "error",
        "headers",
        "params",
        "payload",
        "query",
        "success",
      ]),
      symbol: getAnchorInitializerSymbol(checker, anchorFile, "__GaiaHttpGet"),
    },
    {
      argumentIndex: 2,
      roots: new Set([
        "error",
        "headers",
        "params",
        "payload",
        "query",
        "success",
      ]),
      symbol: getAnchorInitializerSymbol(checker, anchorFile, "__GaiaHttpPost"),
    },
    {
      argumentIndex: 0,
      roots: new Set(["data", "error"]),
      symbol: getAnchorInitializerSymbol(
        checker,
        anchorFile,
        "__GaiaHttpStreamSse"
      ),
    },
  ],
  extractTypeSymbol: getAnchorTypeReferenceSymbol(
    checker,
    anchorFile,
    "__GaiaExtract"
  ),
  eventSourceConstructorSymbol: getAnchorInitializerSymbol(
    checker,
    anchorFile,
    "__GaiaEventSourceConstructor"
  ),
  eventTypeSymbol: getAnchorTypeReferenceSymbol(
    checker,
    anchorFile,
    "__GaiaEvent"
  ),
  messageEventTypeSymbol: getAnchorTypeReferenceSymbol(
    checker,
    anchorFile,
    "__GaiaMessageEvent"
  ),
  literalMetadataSymbol: getAnchorInitializerSymbol(
    checker,
    anchorFile,
    "__GaiaLiteralValues"
  ),
  schemaDeclareSymbol: getAnchorInitializerSymbol(
    checker,
    anchorFile,
    "__GaiaSchemaDeclare"
  ),
  schemaDecodeToSymbol: getAnchorInitializerSymbol(
    checker,
    anchorFile,
    "__GaiaSchemaDecodeTo"
  ),
  vitestHoistedSymbol: getAnchorInitializerSymbol(
    checker,
    anchorFile,
    "__GaiaVitestHoisted"
  ),
  vitestMockSymbol: getAnchorInitializerSymbol(
    checker,
    anchorFile,
    "__GaiaVitestMock"
  ),
  schemaConstraintType: getAnchorType(
    checker,
    anchorFile,
    "__GaiaSchemaConstraint"
  ),
  schemaTopType: getSchemaTopType(checker, anchorFile),
  xstateSetupSymbol: getAnchorInitializerSymbol(
    checker,
    xstateAnchorFile,
    "__GaiaXStateSetup"
  ),
});

const getCanonicalBrandMarker = (checker, anchorFile) => {
  const plainType = getAnchorType(checker, anchorFile, "__GaiaPlainType");
  const brandedType = getAnchorType(checker, anchorFile, "__GaiaBrandedType");
  const plainPropertyNames = new Set(
    checker
      .getPropertiesOfType(plainType)
      .map((property) => property.escapedName)
  );
  const candidates = checker
    .getPropertiesOfType(brandedType)
    .filter(
      (property) =>
        !plainPropertyNames.has(property.escapedName) &&
        (property.declarations?.length ?? 0) > 0
    );

  if (candidates.length !== 1) {
    throw new Error(
      `Gaia schema-contract checker expected one canonical Effect Brand marker, found ${candidates.length}`
    );
  }

  return {
    declarations: new Set(candidates[0].declarations),
    escapedName: candidates[0].escapedName,
  };
};

const hasCanonicalBrandMarker = (checker, type, marker) => {
  const property = checker.getPropertyOfType(type, marker.escapedName);
  if (property === undefined) return false;
  return (
    property.declarations?.some((declaration) =>
      marker.declarations.has(declaration)
    ) === true
  );
};

const containsCanonicalBrandMarker = (
  checker,
  type,
  marker,
  seenTypes = new Set()
) => {
  if (seenTypes.has(type)) return false;
  seenTypes.add(type);
  if (hasCanonicalBrandMarker(checker, type, marker)) return true;

  if (type.isUnionOrIntersection()) {
    return type.types.some((member) =>
      containsCanonicalBrandMarker(checker, member, marker, seenTypes)
    );
  }

  const isCallableType =
    type.getCallSignatures().length > 0 ||
    type.getConstructSignatures().length > 0;
  if (!isCallableType) {
    const typeArguments = [
      ...(type.aliasTypeArguments ?? []),
      ...((type.flags & ts.TypeFlags.Object) !== 0 &&
      (type.objectFlags & ts.ObjectFlags.Reference) !== 0
        ? checker.getTypeArguments(type)
        : []),
    ];
    if (
      typeArguments.some((argument) =>
        containsCanonicalBrandMarker(checker, argument, marker, seenTypes)
      )
    ) {
      return true;
    }
  }

  for (const indexInfo of checker.getIndexInfosOfType(type)) {
    if (
      containsCanonicalBrandMarker(checker, indexInfo.type, marker, seenTypes)
    ) {
      return true;
    }
  }

  if (
    (type.flags &
      (ts.TypeFlags.Any |
        ts.TypeFlags.BigIntLike |
        ts.TypeFlags.BooleanLike |
        ts.TypeFlags.ESSymbolLike |
        ts.TypeFlags.Never |
        ts.TypeFlags.Null |
        ts.TypeFlags.NumberLike |
        ts.TypeFlags.StringLike |
        ts.TypeFlags.Undefined |
        ts.TypeFlags.Unknown |
        ts.TypeFlags.Void)) !==
    0
  ) {
    return false;
  }

  for (const property of checker.getPropertiesOfType(type)) {
    const declaration = property.valueDeclaration ?? property.declarations?.[0];
    if (declaration === undefined) continue;
    const propertyType = checker.getTypeOfSymbolAtLocation(
      property,
      declaration
    );
    if (
      containsCanonicalBrandMarker(checker, propertyType, marker, seenTypes)
    ) {
      return true;
    }
  }

  return false;
};

const isSchemaValueType = (checker, proof, valueType) => {
  if (!checker.isTypeAssignableTo(valueType, proof.schemaTopType)) return false;
  const decodedProperty = checker.getPropertyOfType(
    valueType,
    proof.canonicalDecodedTypeProperty.escapedName
  );
  return (
    decodedProperty?.declarations?.some((declaration) =>
      proof.canonicalDecodedTypeProperty.declarationFiles.has(
        declaration.getSourceFile()
      )
    ) === true
  );
};

const hasCanonicalSchemaDeclaration = (checker, proof, symbol) =>
  (resolveAlias(checker, symbol).declarations ?? []).some((declaration) =>
    proof.canonicalSchemaDeclarationFiles.has(declaration.getSourceFile())
  );

const defaultProvenanceLimits = Object.freeze({
  maxDepth: 64,
  maxShallowTypeDepth: 16,
  maxShallowTypes: 256,
  maxWorkItems: 4096,
});
const proofUnseen = 0;
const proofVisiting = 1;
const proofProven = 2;
const proofUnsafe = 3;

const isConstVariableDeclaration = (declaration) =>
  ts.isVariableDeclaration(declaration) &&
  ts.isVariableDeclarationList(declaration.parent) &&
  (declaration.parent.flags & ts.NodeFlags.Const) !== 0;

const getVariableStatement = (declaration) => {
  const list = declaration.parent;
  return ts.isVariableDeclarationList(list) &&
    ts.isVariableStatement(list.parent)
    ? list.parent
    : undefined;
};

const isExportedVariableDeclaration = (declaration) => {
  const statement = getVariableStatement(declaration);
  return (
    statement?.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
    ) === true
  );
};

const createProgramReferenceIndex = (
  checker,
  program,
  anchorFiles,
  includeIgnoredPathsForTesting
) => {
  const references = new Map();
  let complete = true;
  const visit = (node) => {
    if (ts.isIdentifier(node)) {
      try {
        const symbol = checker.getSymbolAtLocation(node);
        if (symbol !== undefined) {
          const resolved = resolveAlias(checker, symbol);
          const entries = references.get(resolved) ?? [];
          entries.push(node);
          references.set(resolved, entries);
        }
      } catch {
        complete = false;
      }
    }
    ts.forEachChild(node, visit);
  };
  for (const sourceFile of program.getSourceFiles()) {
    if (
      anchorFiles.has(sourceFile) ||
      sourceFile.isDeclarationFile ||
      (!includeIgnoredPathsForTesting &&
        isGeneratedFilePath(sourceFile.fileName)) ||
      (!includeIgnoredPathsForTesting &&
        sourceFile.fileName.includes(`${path.sep}node_modules${path.sep}`))
    ) {
      continue;
    }
    visit(sourceFile);
  }
  return { complete, references };
};

const isDeclarationName = (node) =>
  (ts.isVariableDeclaration(node.parent) ||
    ts.isBindingElement(node.parent) ||
    ts.isClassDeclaration(node.parent) ||
    ts.isFunctionDeclaration(node.parent) ||
    ts.isImportClause(node.parent) ||
    ts.isImportSpecifier(node.parent) ||
    ts.isParameter(node.parent) ||
    ts.isPropertyDeclaration(node.parent) ||
    ts.isTypeAliasDeclaration(node.parent)) &&
  node.parent.name === node;

const isTypeOnlyReference = (node) => {
  let current = node.parent;
  while (current !== undefined && !ts.isStatement(current)) {
    if (ts.isTypeNode(current)) return true;
    current = current.parent;
  }
  return false;
};

const isImportOrExportReference = (node) =>
  ts.isImportSpecifier(node.parent) ||
  ts.isExportSpecifier(node.parent) ||
  ts.isImportClause(node.parent) ||
  ts.isNamespaceImport(node.parent);

const isWithin = (node, container) =>
  node.getStart() >= container.getStart() &&
  node.getEnd() <= container.getEnd();

const getReferenceAccess = (node) => {
  let current = node;
  while (
    (ts.isElementAccessExpression(current.parent) ||
      ts.isPropertyAccessExpression(current.parent) ||
      ts.isNonNullExpression(current.parent) ||
      ts.isParenthesizedExpression(current.parent) ||
      ts.isSatisfiesExpression(current.parent) ||
      ts.isAsExpression(current.parent) ||
      ts.isTypeAssertionExpression(current.parent)) &&
    current.parent.expression === current
  ) {
    current = current.parent;
  }
  return current;
};

const isWriteReference = (node) => {
  const access = getReferenceAccess(node);
  const parent = access.parent;
  if (
    (ts.isPrefixUnaryExpression(parent) ||
      ts.isPostfixUnaryExpression(parent)) &&
    (parent.operator === ts.SyntaxKind.PlusPlusToken ||
      parent.operator === ts.SyntaxKind.MinusMinusToken)
  ) {
    return true;
  }
  if (
    ts.isDeleteExpression(parent) ||
    (ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      isWithin(access, parent.left))
  ) {
    return true;
  }
  return false;
};

const findInitializerDeclaration = (node) => {
  let current = node.parent;
  while (current !== undefined && !ts.isStatement(current)) {
    if (
      ts.isVariableDeclaration(current) &&
      current.initializer !== undefined &&
      isWithin(node, current.initializer)
    ) {
      return current;
    }
    current = current.parent;
  }
  return undefined;
};

const getCanonicalCallee = (checker, proof, expression) => {
  let current = expression;
  let receiver;
  const seen = new Set();
  for (let depth = 0; depth < defaultProvenanceLimits.maxDepth; depth += 1) {
    let symbol;
    try {
      symbol = checker.getSymbolAtLocation(current);
    } catch {
      return undefined;
    }
    if (symbol === undefined) return undefined;
    const resolved = resolveAlias(checker, symbol);
    if (seen.has(resolved)) return undefined;
    seen.add(resolved);
    if (hasCanonicalSchemaDeclaration(checker, proof, resolved)) {
      return { receiver, symbol: resolved };
    }
    const declarations = (resolved.declarations ?? []).filter(
      ts.isVariableDeclaration
    );
    if (
      declarations.length !== 1 ||
      !isConstVariableDeclaration(declarations[0]) ||
      declarations[0].initializer === undefined ||
      (!ts.isIdentifier(declarations[0].initializer) &&
        !ts.isPropertyAccessExpression(declarations[0].initializer))
    ) {
      return undefined;
    }
    current = declarations[0].initializer;
    if (ts.isPropertyAccessExpression(current)) {
      receiver = current.expression;
    }
  }
  return undefined;
};

const getCanonicalCalleeSymbol = (checker, proof, expression) =>
  getCanonicalCallee(checker, proof, expression)?.symbol;

const isCanonicalCallShape = (checker, proof, node) => {
  if (getCanonicalCalleeSymbol(checker, proof, node.expression) !== undefined) {
    return true;
  }
  return (
    ts.isCallExpression(node.expression) &&
    getCanonicalCalleeSymbol(checker, proof, node.expression.expression) !==
      undefined
  );
};

const getFunctionReturnExpressions = (node) => {
  if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) return [node.body];
  const expressions = [];
  const visit = (candidate) => {
    if (candidate !== node && ts.isFunctionLike(candidate)) return;
    if (ts.isReturnStatement(candidate)) {
      if (candidate.expression !== undefined)
        expressions.push(candidate.expression);
      return;
    }
    ts.forEachChild(candidate, visit);
  };
  visit(node.body);
  return expressions;
};

const shallowTypeMayContainSchema = (checker, proof, rootType, limits) => {
  const work = [{ depth: 0, type: rootType }];
  const seen = new Set();
  while (work.length > 0) {
    const { depth, type } = work.pop();
    if (
      seen.has(type) ||
      seen.size >= limits.maxShallowTypes ||
      depth > limits.maxShallowTypeDepth
    ) {
      if (
        seen.size >= limits.maxShallowTypes ||
        depth > limits.maxShallowTypeDepth
      ) {
        return true;
      }
      continue;
    }
    seen.add(type);
    try {
      if (isSchemaValueType(checker, proof, type)) return true;
      const constraint = checker.getBaseConstraintOfType(type);
      if (constraint !== undefined && constraint !== type) {
        work.push({ depth: depth + 1, type: constraint });
      }
      if (type.isUnionOrIntersection()) {
        for (const member of type.types)
          work.push({ depth: depth + 1, type: member });
      }
      for (const argument of type.aliasTypeArguments ?? []) {
        work.push({ depth: depth + 1, type: argument });
      }
      if (
        (type.flags & ts.TypeFlags.Object) !== 0 &&
        (type.objectFlags & ts.ObjectFlags.Reference) !== 0
      ) {
        for (const argument of checker.getTypeArguments(type)) {
          work.push({ depth: depth + 1, type: argument });
        }
      }
      for (const indexInfo of checker.getIndexInfosOfType(type)) {
        work.push({ depth: depth + 1, type: indexInfo.type });
      }
      if (
        (type.flags & ts.TypeFlags.Object) !== 0 &&
        !checker.isArrayType(type) &&
        !checker.isTupleType(type)
      ) {
        for (const property of checker.getPropertiesOfType(type)) {
          const declaration =
            property.valueDeclaration ?? property.declarations?.[0];
          if (declaration === undefined) return true;
          work.push({
            depth: depth + 1,
            type: checker.getTypeOfSymbolAtLocation(property, declaration),
          });
        }
      }
    } catch {
      return true;
    }
  }
  return false;
};

const parameterTypeMayContainSchema = (checker, proof, rootType, limits) => {
  const work = [{ depth: 0, type: rootType }];
  const seen = new Set();
  while (work.length > 0) {
    const { depth, type } = work.pop();
    if (seen.has(type)) continue;
    if (
      seen.size >= limits.maxShallowTypes ||
      depth > limits.maxShallowTypeDepth
    ) {
      return true;
    }
    seen.add(type);
    try {
      if (checker.isTypeAssignableTo(type, proof.schemaConstraintType)) {
        return true;
      }
      const constraint = checker.getBaseConstraintOfType(type);
      if (constraint !== undefined && constraint !== type) {
        work.push({ depth: depth + 1, type: constraint });
      }
      if (type.isUnionOrIntersection()) {
        for (const member of type.types) {
          work.push({ depth: depth + 1, type: member });
        }
      }
      if (checker.isArrayType(type) || checker.isTupleType(type)) {
        for (const argument of checker.getTypeArguments(type)) {
          work.push({ depth: depth + 1, type: argument });
        }
      }
      for (const indexInfo of checker.getIndexInfosOfType(type)) {
        work.push({ depth: depth + 1, type: indexInfo.type });
      }
    } catch {
      return true;
    }
  }
  return false;
};

const createSchemaProvenanceSession = (
  checker,
  proof,
  limits,
  {
    allowCanonicalContainerMemberReferences = false,
    allowCanonicalFactoryContainerReferences = false,
  } = {}
) => {
  const states = new Map();
  const edges = new Map();
  const symbolWork = [];
  const queuedSymbols = new Set();
  const root = { root: true };
  let unsafe = false;
  let workItems = 0;

  const consume = (depth = 0) => {
    workItems += 1;
    if (workItems > limits.maxWorkItems || depth > limits.maxDepth) {
      unsafe = true;
      return false;
    }
    return true;
  };

  const getSymbol = (node) => {
    try {
      const symbol = checker.getSymbolAtLocation(node);
      return symbol === undefined ? undefined : resolveAlias(checker, symbol);
    } catch {
      unsafe = true;
      return undefined;
    }
  };

  const expressionMayContainSchema = (node) => {
    try {
      if (
        shallowTypeMayContainSchema(
          checker,
          proof,
          checker.getTypeAtLocation(node),
          limits
        )
      ) {
        return true;
      }
    } catch {
      return true;
    }
    const work = [{ depth: 0, node }];
    let seen = 0;
    while (work.length > 0 && seen < limits.maxShallowTypes) {
      const item = work.pop();
      if (item.depth > limits.maxShallowTypeDepth) return true;
      seen += 1;
      try {
        if (
          isSchemaValueType(
            checker,
            proof,
            checker.getTypeAtLocation(item.node)
          )
        ) {
          return true;
        }
      } catch {
        return true;
      }
      if (ts.isFunctionLike(item.node) && item.node !== node) continue;
      if (
        ts.isIdentifier(item.node) ||
        ts.isPropertyAccessExpression(item.node)
      ) {
        try {
          const symbol = checker.getSymbolAtLocation(item.node);
          const resolved =
            symbol === undefined ? undefined : resolveAlias(checker, symbol);
          for (const declaration of resolved?.declarations ?? []) {
            if (
              ts.isVariableDeclaration(declaration) &&
              declaration.initializer !== undefined &&
              declaration.initializer !== item.node
            ) {
              work.push({
                depth: item.depth + 1,
                node: declaration.initializer,
              });
            }
          }
        } catch {
          return true;
        }
      }
      ts.forEachChild(item.node, (child) =>
        work.push({ depth: item.depth + 1, node: child })
      );
    }
    return work.length > 0;
  };

  const getSchemaBearingArguments = (node) => {
    let signature;
    try {
      signature = checker.getResolvedSignature(node);
    } catch {
      return undefined;
    }
    if (signature === undefined) return undefined;
    const parameters = signature.getParameters();
    const schemaArguments = [];
    for (let index = 0; index < node.arguments.length; index += 1) {
      let parameter = parameters[index];
      if (parameter === undefined && parameters.length > 0) {
        const last = parameters.at(-1);
        const declaration = last?.valueDeclaration ?? last?.declarations?.[0];
        if (declaration !== undefined && ts.isParameter(declaration)) {
          if (declaration.dotDotDotToken !== undefined) parameter = last;
        }
      }
      const declaration =
        parameter?.valueDeclaration ?? parameter?.declarations?.[0];
      if (parameter === undefined || declaration === undefined) {
        return undefined;
      }
      try {
        const parameterTypes = [
          checker.getTypeOfSymbolAtLocation(parameter, declaration),
        ];
        if (ts.isParameter(declaration) && declaration.type !== undefined) {
          parameterTypes.push(checker.getTypeAtLocation(declaration.type));
        }
        if (
          parameterTypes.some((type) =>
            parameterTypeMayContainSchema(checker, proof, type, limits)
          )
        ) {
          schemaArguments.push(node.arguments[index]);
        }
      } catch {
        return undefined;
      }
    }
    return schemaArguments;
  };

  const getNestedArgumentPath = (reference, argument) => {
    const path = [];
    let current = reference;
    while (current !== argument) {
      const parent = current.parent;
      if (parent === undefined || !isWithin(reference, parent))
        return undefined;
      if (
        ts.isParenthesizedExpression(parent) ||
        ts.isSatisfiesExpression(parent) ||
        ts.isNonNullExpression(parent) ||
        (ts.isAsExpression(parent) && ts.isConstTypeReference(parent.type)) ||
        ts.isSpreadAssignment(parent) ||
        ts.isSpreadElement(parent) ||
        ts.isObjectLiteralExpression(parent)
      ) {
        current = parent;
        continue;
      }
      if (
        ts.isPropertyAccessExpression(parent) &&
        parent.expression === current
      ) {
        const property = getSymbol(parent.name);
        const currentProperty = ts.isPropertyAccessExpression(current)
          ? getSymbol(current.name)
          : undefined;
        const containerMember =
          allowCanonicalContainerMemberReferences &&
          currentProperty !== undefined &&
          isCanonicalSchemaContainerProperty(checker, proof, currentProperty);
        if (
          !containerMember &&
          (property === undefined ||
            !isCanonicalSchemaContainerProperty(checker, proof, property))
        ) {
          return undefined;
        }
        current = parent;
        continue;
      }
      if (ts.isPropertyAssignment(parent) && parent.initializer === current) {
        const name = getPropertyName(parent.name);
        if (name === undefined) return undefined;
        path.unshift(name);
        current = parent;
        continue;
      }
      if (ts.isShorthandPropertyAssignment(parent) && parent.name === current) {
        path.unshift(parent.name.text);
        current = parent;
        continue;
      }
      if (ts.isArrayLiteralExpression(parent)) {
        path.unshift("*");
        current = parent;
        continue;
      }
      return undefined;
    }
    return path;
  };

  const isCanonicalFactoryReference = (checker, proof, reference) => {
    let current = reference.parent;
    while (current !== undefined && !ts.isStatement(current)) {
      if (ts.isCallExpression(current)) {
        if (!isCanonicalCallShape(checker, proof, current)) {
          current = current.parent;
          continue;
        }
        const schemaArguments = getSchemaBearingArguments(current);
        if (schemaArguments === undefined) return false;
        const argument = schemaArguments.find((candidate) =>
          isWithin(reference, candidate)
        );
        if (argument === undefined) return false;
        return getNestedArgumentPath(reference, argument) !== undefined;
      }
      current = current.parent;
    }
    return false;
  };

  const isCanonicalSuspendReturnReference = (reference, call) => {
    const canonicalCallee = getCanonicalCallee(checker, proof, call.expression);
    if (canonicalCallee?.symbol !== proof.canonicalSchemaSuspendSymbol) {
      return false;
    }
    const callback = call.arguments[0];
    if (
      callback === undefined ||
      (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))
    ) {
      return false;
    }
    return getFunctionReturnExpressions(callback).some(
      (returned) => getNestedArgumentPath(reference, returned) !== undefined
    );
  };

  const isExactEffectConsumerReference = (reference) => {
    let current = reference.parent;
    while (current !== undefined && !ts.isStatement(current)) {
      if (ts.isCallExpression(current)) {
        let callee;
        let signature;
        try {
          const symbol = checker.getSymbolAtLocation(current.expression);
          callee =
            symbol === undefined ? undefined : resolveAlias(checker, symbol);
          signature = checker.getResolvedSignature(current);
        } catch {
          return false;
        }
        const consumer =
          callee === undefined
            ? undefined
            : proof.effectSchemaConsumers.find((candidate) =>
                hasSameDeclaration(checker, callee, candidate.symbol)
              );
        if (
          callee !== undefined &&
          consumer !== undefined &&
          signature?.declaration !== undefined &&
          (callee.declarations ?? []).some((declaration) =>
            isWithin(signature.declaration, declaration)
          )
        ) {
          const argumentIndex = current.arguments.findIndex((argument) =>
            isWithin(reference, argument)
          );
          if (argumentIndex !== consumer.argumentIndex) return false;
          const argument = current.arguments[argumentIndex];
          const nestedPath = getNestedArgumentPath(reference, argument);
          if (
            nestedPath === undefined ||
            nestedPath.length === 0 ||
            !consumer.roots.has(nestedPath[0])
          ) {
            return false;
          }
          try {
            const contextual = checker.getContextualType(reference);
            return (
              contextual !== undefined &&
              parameterTypeMayContainSchema(checker, proof, contextual, limits)
            );
          } catch {
            return false;
          }
        }
      }
      current = current.parent;
    }
    return false;
  };

  const localConsumerStates = new Map();
  const getLocalConsumer = (call, argumentIndex) => {
    let symbol;
    try {
      symbol = checker.getSymbolAtLocation(call.expression);
    } catch {
      return undefined;
    }
    if (symbol === undefined) return undefined;
    const resolved = resolveAlias(checker, symbol);
    if ((resolved.declarations ?? []).length !== 1) return undefined;
    const declaration = resolved.declarations[0];
    let implementation;
    let parameters;
    if (
      ts.isFunctionDeclaration(declaration) &&
      declaration.body !== undefined
    ) {
      if (
        declaration.modifiers?.some(
          (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
        )
      ) {
        return undefined;
      }
      implementation = declaration;
      parameters = declaration.parameters;
    } else if (
      ts.isVariableDeclaration(declaration) &&
      isConstVariableDeclaration(declaration) &&
      declaration.initializer !== undefined &&
      (ts.isArrowFunction(declaration.initializer) ||
        ts.isFunctionExpression(declaration.initializer)) &&
      !isExportedVariableDeclaration(declaration)
    ) {
      implementation = declaration.initializer;
      parameters = implementation.parameters;
    } else {
      return undefined;
    }
    if (
      implementation.getSourceFile() !== call.getSourceFile() ||
      parameters[argumentIndex] === undefined
    ) {
      return undefined;
    }
    const parameter = parameters[argumentIndex];
    const parameterSymbol = getSymbol(parameter.name);
    if (parameterSymbol === undefined || parameter.type === undefined) {
      return undefined;
    }
    try {
      if (
        !parameterTypeMayContainSchema(
          checker,
          proof,
          checker.getTypeAtLocation(parameter.type),
          limits
        )
      ) {
        return undefined;
      }
    } catch {
      return undefined;
    }
    return { parameterSymbol, resolved };
  };

  const isLocalSafeConsumerReference = (reference) => {
    let current = reference.parent;
    while (current !== undefined && !ts.isStatement(current)) {
      if (ts.isCallExpression(current)) {
        const argumentIndex = current.arguments.findIndex(
          (argument) =>
            unwrapAliasExpression(argument) === getReferenceAccess(reference)
        );
        if (argumentIndex < 0) return false;
        const consumer = getLocalConsumer(current, argumentIndex);
        if (consumer === undefined) return false;
        const state = localConsumerStates.get(consumer.parameterSymbol);
        if (state === proofProven) return true;
        if (state === proofVisiting || state === proofUnsafe) return false;
        localConsumerStates.set(consumer.parameterSymbol, proofVisiting);
        for (const use of proof.referenceIndex.references.get(
          consumer.parameterSymbol
        ) ?? []) {
          if (
            !consume() ||
            isDeclarationName(use) ||
            isTypeOnlyReference(use)
          ) {
            continue;
          }
          if (
            isWriteReference(use) ||
            (!isCanonicalFactoryReference(checker, proof, use) &&
              !isExactEffectConsumerReference(use) &&
              !isLocalSafeConsumerReference(use))
          ) {
            localConsumerStates.set(consumer.parameterSymbol, proofUnsafe);
            return false;
          }
        }
        localConsumerStates.set(consumer.parameterSymbol, proofProven);
        return true;
      }
      current = current.parent;
    }
    return false;
  };

  const addEdge = (from, symbol, lazy) => {
    const resolved = resolveAlias(checker, symbol);
    const current = edges.get(from) ?? [];
    current.push({ lazy, symbol: resolved });
    edges.set(from, current);
    if (
      !hasCanonicalSchemaDeclaration(checker, proof, resolved) &&
      !queuedSymbols.has(resolved)
    ) {
      queuedSymbols.add(resolved);
      states.set(resolved, proofUnseen);
      symbolWork.push(resolved);
    }
  };

  const getContainerClosure = (
    initialSymbol,
    { safeConsumptionFirst = false } = {}
  ) => {
    if (!proof.referenceIndex.complete) {
      unsafe = true;
      return [];
    }
    const queue = [resolveAlias(checker, initialSymbol)];
    const declarations = new Map();
    const aliasEdges = new Map();
    const seen = new Set();
    while (queue.length > 0 && !unsafe) {
      const symbol = queue.pop();
      if (!consume() || seen.has(symbol)) continue;
      seen.add(symbol);
      const candidates = (symbol.declarations ?? []).filter(
        ts.isVariableDeclaration
      );
      if (
        candidates.length !== 1 ||
        !isConstVariableDeclaration(candidates[0]) ||
        candidates[0].initializer === undefined ||
        candidates[0].getSourceFile().isDeclarationFile ||
        isExportedVariableDeclaration(candidates[0])
      ) {
        unsafe = true;
        break;
      }
      declarations.set(symbol, candidates[0]);
      for (const reference of proof.referenceIndex.references.get(symbol) ??
        []) {
        if (
          !consume() ||
          isDeclarationName(reference) ||
          isTypeOnlyReference(reference)
        ) {
          continue;
        }
        if (isWriteReference(reference)) {
          unsafe = true;
          break;
        }
        if (
          allowCanonicalFactoryContainerReferences &&
          isCanonicalFactoryReference(checker, proof, reference)
        ) {
          continue;
        }
        if (
          safeConsumptionFirst &&
          (isCanonicalFactoryReference(checker, proof, reference) ||
            isExactEffectConsumerReference(reference) ||
            isLocalSafeConsumerReference(reference))
        ) {
          continue;
        }
        const aliasDeclaration = findInitializerDeclaration(reference);
        if (aliasDeclaration !== undefined) {
          if (
            !isConstVariableDeclaration(aliasDeclaration) ||
            isExportedVariableDeclaration(aliasDeclaration) ||
            !ts.isIdentifier(aliasDeclaration.name)
          ) {
            unsafe = true;
            break;
          }
          const aliasSymbol = getSymbol(aliasDeclaration.name);
          if (aliasSymbol === undefined) {
            unsafe = true;
            break;
          }
          const outgoing = aliasEdges.get(symbol) ?? [];
          outgoing.push(aliasSymbol);
          aliasEdges.set(symbol, outgoing);
          queue.push(aliasSymbol);
          continue;
        }
        if (!isCanonicalFactoryReference(checker, proof, reference)) {
          unsafe = true;
          break;
        }
      }
    }
    if (unsafe) return [];

    const indegrees = new Map([...seen].map((symbol) => [symbol, 0]));
    for (const outgoing of aliasEdges.values()) {
      for (const target of outgoing) {
        if (indegrees.has(target))
          indegrees.set(target, indegrees.get(target) + 1);
      }
    }
    const ready = [...indegrees]
      .filter(([, degree]) => degree === 0)
      .map(([symbol]) => symbol);
    let visited = 0;
    while (ready.length > 0) {
      const symbol = ready.pop();
      visited += 1;
      for (const target of aliasEdges.get(symbol) ?? []) {
        if (!indegrees.has(target)) continue;
        const next = indegrees.get(target) - 1;
        indegrees.set(target, next);
        if (next === 0) ready.push(target);
      }
    }
    if (visited !== indegrees.size) {
      unsafe = true;
      return [];
    }
    return [...declarations.values()].map(
      (declaration) => declaration.initializer
    );
  };

  const unwrapAliasExpression = (node) => {
    let current = node;
    while (
      ts.isNonNullExpression(current) ||
      ts.isParenthesizedExpression(current) ||
      ts.isSatisfiesExpression(current)
    ) {
      current = current.expression;
    }
    return current;
  };

  const isImmutableContainerInitializer = (node) => {
    let current = node;
    while (
      ts.isNonNullExpression(current) ||
      ts.isParenthesizedExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      (ts.isAsExpression(current) && ts.isConstTypeReference(current.type))
    ) {
      current = current.expression;
    }
    if (
      ts.isObjectLiteralExpression(current) ||
      ts.isArrayLiteralExpression(current)
    ) {
      return true;
    }
    return (
      ts.isConditionalExpression(current) &&
      isImmutableContainerInitializer(current.whenTrue) &&
      isImmutableContainerInitializer(current.whenFalse)
    );
  };

  const getIdentityAlias = (reference) => {
    const declaration = findInitializerDeclaration(reference);
    if (
      declaration === undefined ||
      !isConstVariableDeclaration(declaration) ||
      declaration.initializer === undefined ||
      !ts.isIdentifier(declaration.name)
    ) {
      return undefined;
    }
    const initializer = unwrapAliasExpression(declaration.initializer);
    const access = unwrapAliasExpression(getReferenceAccess(reference));
    if (initializer !== access) return undefined;
    if (ts.isPropertyAccessExpression(initializer)) {
      const property = getSymbol(initializer.name);
      if (
        property === undefined ||
        !isCanonicalSchemaContainerProperty(checker, proof, property) ||
        isExportedVariableDeclaration(declaration)
      ) {
        return undefined;
      }
    }
    const alias = getSymbol(declaration.name);
    return alias;
  };

  const isSafeCanonicalReference = (reference) => {
    if (
      ts.isBinaryExpression(reference.parent) &&
      reference.parent.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword &&
      isWithin(reference, reference.parent.right)
    ) {
      return true;
    }
    let metadataAccess;
    let metadataCurrent = reference.parent;
    while (metadataCurrent !== undefined && !ts.isStatement(metadataCurrent)) {
      if (ts.isPropertyAccessExpression(metadataCurrent)) {
        const property = getSymbol(metadataCurrent.name);
        if (
          property !== undefined &&
          hasSameDeclaration(checker, property, proof.literalMetadataSymbol) &&
          isWithin(reference, metadataCurrent.expression)
        ) {
          metadataAccess = metadataCurrent;
          break;
        }
      }
      metadataCurrent = metadataCurrent.parent;
    }
    if (metadataAccess !== undefined) {
      const property = getSymbol(metadataAccess.name);
      if (
        property !== undefined &&
        hasSameDeclaration(checker, property, proof.literalMetadataSymbol)
      ) {
        try {
          return !shallowTypeMayContainSchema(
            checker,
            proof,
            checker.getTypeAtLocation(metadataAccess),
            limits
          );
        } catch {
          return false;
        }
      }
    }
    if (
      isExactEffectConsumerReference(reference) ||
      isLocalSafeConsumerReference(reference)
    ) {
      return true;
    }
    let current = reference.parent;
    while (current !== undefined && !ts.isStatement(current)) {
      if (ts.isCallExpression(current)) {
        if (isCanonicalFactoryReference(checker, proof, reference)) return true;
        if (isCanonicalSuspendReturnReference(reference, current)) return true;
        const canonicalCallee = getCanonicalCallee(
          checker,
          proof,
          current.expression
        );
        const receiver =
          canonicalCallee?.receiver ??
          (ts.isPropertyAccessExpression(current.expression)
            ? current.expression.expression
            : undefined);
        if (
          canonicalCallee !== undefined &&
          receiver !== undefined &&
          getNestedArgumentPath(reference, receiver) !== undefined
        ) {
          return true;
        }
        if (ts.isPropertyAccessExpression(current.expression)) {
          const method = getSymbol(current.expression.name);
          if (
            method !== undefined &&
            isCanonicalSchemaPipeProperty(checker, proof, method) &&
            getNestedArgumentPath(reference, current.expression.expression) !==
              undefined
          ) {
            return true;
          }
        }
        return false;
      }
      current = current.parent;
    }
    const access = unwrapAliasExpression(getReferenceAccess(reference));
    if (ts.isPropertyAccessExpression(access)) {
      const property = getSymbol(access.name);
      return (
        getCanonicalCallee(checker, proof, access) !== undefined ||
        (property !== undefined &&
          isCanonicalSchemaPipeProperty(checker, proof, property)) ||
        (property !== undefined &&
          isCanonicalSchemaContainerProperty(checker, proof, property) &&
          (ts.isSpreadAssignment(access.parent) ||
            ts.isSpreadElement(access.parent)))
      );
    }
    return false;
  };

  const hasUnsafeSchemaIdentity = (initialSymbol) => {
    if (!proof.referenceIndex.complete) return true;
    const queue = [resolveAlias(checker, initialSymbol)];
    const seen = new Set();
    while (queue.length > 0) {
      const symbol = queue.pop();
      if (!consume() || seen.has(symbol)) continue;
      seen.add(symbol);
      for (const reference of proof.referenceIndex.references.get(symbol) ??
        []) {
        if (
          !consume() ||
          isDeclarationName(reference) ||
          isTypeOnlyReference(reference) ||
          isImportOrExportReference(reference)
        ) {
          continue;
        }
        if (isWriteReference(reference)) return true;
        const identityAlias = getIdentityAlias(reference);
        if (identityAlias !== undefined) {
          queue.push(identityAlias);
          continue;
        }
        if (isSafeCanonicalReference(reference)) continue;
        const containerDeclaration = findInitializerDeclaration(reference);
        const containerInitializer =
          containerDeclaration?.initializer === undefined
            ? undefined
            : unwrapAliasExpression(containerDeclaration.initializer);
        if (
          containerDeclaration !== undefined &&
          ts.isIdentifier(containerDeclaration.name) &&
          containerInitializer !== undefined &&
          isImmutableContainerInitializer(containerInitializer)
        ) {
          const container = getSymbol(containerDeclaration.name);
          if (
            container !== undefined &&
            getContainerClosure(container, {
              safeConsumptionFirst: true,
            }).length > 0
          ) {
            continue;
          }
        }
        return true;
      }
    }
    return unsafe;
  };

  const processExpressions = (initialItems) => {
    const work = [...initialItems];
    const seenNodes = new Set();
    while (work.length > 0 && !unsafe) {
      const item = work.pop();
      let node = item.node;
      if (!consume(item.depth)) break;
      if (seenNodes.has(node)) continue;
      seenNodes.add(node);

      if (
        ts.isNonNullExpression(node) ||
        ts.isParenthesizedExpression(node) ||
        ts.isSatisfiesExpression(node) ||
        ts.isSpreadElement(node) ||
        ((ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) &&
          ts.isConstTypeReference(node.type))
      ) {
        work.push({ ...item, depth: item.depth + 1, node: node.expression });
        continue;
      }
      if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
        unsafe = true;
        break;
      }

      if (ts.isObjectLiteralExpression(node)) {
        for (const property of node.properties) {
          if (ts.isPropertyAssignment(property)) {
            work.push({
              ...item,
              depth: item.depth + 1,
              node: property.initializer,
            });
          } else if (ts.isShorthandPropertyAssignment(property)) {
            work.push({ ...item, depth: item.depth + 1, node: property.name });
          } else if (ts.isSpreadAssignment(property)) {
            work.push({
              ...item,
              depth: item.depth + 1,
              node: property.expression,
            });
          } else {
            unsafe = true;
            break;
          }
        }
        continue;
      }
      if (ts.isArrayLiteralExpression(node)) {
        for (const element of node.elements) {
          work.push({
            ...item,
            depth: item.depth + 1,
            node: ts.isSpreadElement(element) ? element.expression : element,
          });
        }
        continue;
      }
      if (ts.isConditionalExpression(node)) {
        work.push(
          { ...item, depth: item.depth + 1, node: node.whenTrue },
          { ...item, depth: item.depth + 1, node: node.whenFalse }
        );
        continue;
      }

      if (ts.isCallExpression(node)) {
        const canonicalCallee = getCanonicalCallee(
          checker,
          proof,
          node.expression
        );
        if (canonicalCallee !== undefined) {
          const receiver =
            canonicalCallee.receiver ??
            (ts.isPropertyAccessExpression(node.expression)
              ? node.expression.expression
              : undefined);
          if (receiver !== undefined) {
            try {
              if (
                isSchemaValueType(
                  checker,
                  proof,
                  checker.getTypeAtLocation(receiver)
                )
              ) {
                work.push({ ...item, depth: item.depth + 1, node: receiver });
              }
            } catch {
              unsafe = true;
              break;
            }
          }
          if (canonicalCallee.symbol === proof.canonicalSchemaSuspendSymbol) {
            const callback = node.arguments[0];
            if (
              callback === undefined ||
              (!ts.isArrowFunction(callback) &&
                !ts.isFunctionExpression(callback))
            ) {
              unsafe = true;
              break;
            }
            const returns = getFunctionReturnExpressions(callback);
            if (returns.length === 0) {
              unsafe = true;
              break;
            }
            for (const returned of returns) {
              work.push({
                ...item,
                depth: item.depth + 1,
                lazy: true,
                node: returned,
              });
            }
          } else {
            const schemaArguments = getSchemaBearingArguments(node);
            if (schemaArguments === undefined) {
              unsafe = true;
              break;
            }
            for (const argument of schemaArguments) {
              work.push({ ...item, depth: item.depth + 1, node: argument });
            }
          }
          continue;
        }

        if (
          ts.isCallExpression(node.expression) &&
          getCanonicalCalleeSymbol(
            checker,
            proof,
            node.expression.expression
          ) !== undefined
        ) {
          work.push({ ...item, depth: item.depth + 1, node: node.expression });
          const schemaArguments = getSchemaBearingArguments(node);
          if (schemaArguments === undefined) {
            unsafe = true;
            break;
          }
          for (const argument of schemaArguments) {
            work.push({ ...item, depth: item.depth + 1, node: argument });
          }
          continue;
        }

        if (ts.isPropertyAccessExpression(node.expression)) {
          const method = getSymbol(node.expression.name);
          if (
            method !== undefined &&
            isCanonicalSchemaPipeProperty(checker, proof, method)
          ) {
            work.push({
              ...item,
              depth: item.depth + 1,
              node: node.expression.expression,
            });
            for (const argument of node.arguments) {
              if (!ts.isCallExpression(argument)) {
                unsafe = true;
                break;
              }
              work.push({ ...item, depth: item.depth + 1, node: argument });
            }
            continue;
          }
        }
        unsafe = true;
        continue;
      }

      if (ts.isPropertyAccessExpression(node)) {
        const property = getSymbol(node.name);
        if (
          property !== undefined &&
          isCanonicalSchemaContainerProperty(checker, proof, property)
        ) {
          work.push({
            ...item,
            depth: item.depth + 1,
            node: node.expression,
          });
          continue;
        }
        if (
          allowCanonicalContainerMemberReferences &&
          ts.isPropertyAccessExpression(node.expression)
        ) {
          const containerProperty = getSymbol(node.expression.name);
          let memberType;
          try {
            memberType = checker.getTypeAtLocation(node);
          } catch {
            memberType = undefined;
          }
          if (
            containerProperty !== undefined &&
            isCanonicalSchemaContainerProperty(
              checker,
              proof,
              containerProperty
            ) &&
            memberType !== undefined &&
            isSchemaValueType(checker, proof, memberType)
          ) {
            work.push({
              ...item,
              depth: item.depth + 1,
              node: node.expression.expression,
            });
            continue;
          }
        }
      }

      if (
        ts.isIdentifier(node) ||
        ts.isPropertyAccessExpression(node) ||
        ts.isElementAccessExpression(node)
      ) {
        if (
          ts.isElementAccessExpression(node) &&
          node.argumentExpression !== undefined &&
          !ts.isStringLiteralLike(node.argumentExpression) &&
          !ts.isNumericLiteral(node.argumentExpression)
        ) {
          unsafe = true;
          break;
        }
        let valueType;
        try {
          valueType = checker.getTypeAtLocation(node);
        } catch {
          unsafe = true;
          break;
        }
        const symbol = getSymbol(node);
        if (isSchemaValueType(checker, proof, valueType)) {
          if (symbol === undefined) {
            unsafe = true;
            break;
          }
          addEdge(item.owner, symbol, item.lazy);
          continue;
        }
        if (expressionMayContainSchema(node)) {
          if (symbol === undefined) {
            unsafe = true;
            break;
          }
          const initializers = getContainerClosure(symbol);
          if (initializers.length === 0) {
            unsafe = true;
            break;
          }
          for (const initializer of initializers) {
            work.push({ ...item, depth: item.depth + 1, node: initializer });
          }
          continue;
        }
        unsafe = true;
        break;
      }

      if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
        const returns = getFunctionReturnExpressions(node);
        if (returns.length === 0 && expressionMayContainSchema(node)) {
          unsafe = true;
        }
        for (const returned of returns) {
          work.push({ ...item, depth: item.depth + 1, node: returned });
        }
        continue;
      }

      unsafe = true;
    }
  };

  const processSymbol = (symbol) => {
    if (!consume()) return;
    if (hasCanonicalSchemaDeclaration(checker, proof, symbol)) {
      states.set(symbol, proofProven);
      return;
    }
    states.set(symbol, proofVisiting);
    const declarations = symbol.declarations ?? [];
    const variableDeclarations = declarations.filter(ts.isVariableDeclaration);
    if (variableDeclarations.length === 1) {
      const declaration = variableDeclarations[0];
      if (
        !isConstVariableDeclaration(declaration) ||
        declaration.initializer === undefined ||
        declaration.getSourceFile().isDeclarationFile ||
        hasUnsafeSchemaIdentity(symbol)
      ) {
        states.set(symbol, proofUnsafe);
        unsafe = true;
        return;
      }
      processExpressions([
        { depth: 0, lazy: false, node: declaration.initializer, owner: symbol },
      ]);
      return;
    }
    const classDeclaration = declarations.find(ts.isClassDeclaration);
    if (classDeclaration !== undefined) {
      if (hasUnsafeSchemaIdentity(symbol)) {
        states.set(symbol, proofUnsafe);
        unsafe = true;
        return;
      }
      const heritage = classDeclaration.heritageClauses?.flatMap((clause) =>
        clause.types.map((type) => type.expression)
      );
      if (heritage === undefined || heritage.length === 0) {
        states.set(symbol, proofUnsafe);
        unsafe = true;
        return;
      }
      processExpressions(
        heritage.map((node) => ({ depth: 0, lazy: false, node, owner: symbol }))
      );
      return;
    }
    states.set(symbol, proofUnsafe);
    unsafe = true;
  };

  const finish = () => {
    while (symbolWork.length > 0) {
      if (unsafe) break;
      const symbol = symbolWork.shift();
      if (states.get(symbol) === proofUnseen) processSymbol(symbol);
    }
    if (unsafe || [...states.values()].includes(proofUnsafe)) return false;
    const nodes = new Set([root, ...states.keys()]);
    const indegrees = new Map([...nodes].map((node) => [node, 0]));
    for (const [from, outgoing] of edges) {
      if (!nodes.has(from)) continue;
      for (const edge of outgoing) {
        if (edge.lazy || !nodes.has(edge.symbol)) continue;
        indegrees.set(edge.symbol, indegrees.get(edge.symbol) + 1);
      }
    }
    const ready = [...indegrees]
      .filter(([, degree]) => degree === 0)
      .map(([node]) => node);
    let visited = 0;
    while (ready.length > 0) {
      const node = ready.pop();
      visited += 1;
      for (const edge of edges.get(node) ?? []) {
        if (edge.lazy || !indegrees.has(edge.symbol)) continue;
        const next = indegrees.get(edge.symbol) - 1;
        indegrees.set(edge.symbol, next);
        if (next === 0) ready.push(edge.symbol);
      }
    }
    if (visited !== indegrees.size) return false;
    for (const symbol of states.keys()) states.set(symbol, proofProven);
    return true;
  };

  return {
    proveExpression(node) {
      processExpressions([{ depth: 0, lazy: false, node, owner: root }]);
      return finish();
    },
    proveSymbol(symbol) {
      addEdge(root, symbol, false);
      return finish();
    },
  };
};

const getProvenanceLimits = (proof) => ({
  ...defaultProvenanceLimits,
  ...proof.provenanceLimits,
});

const isCanonicalSchemaApiCall = (checker, proof, node) =>
  ts.isCallExpression(node) &&
  createSchemaProvenanceSession(
    checker,
    proof,
    getProvenanceLimits(proof)
  ).proveExpression(node);

const isCanonicalSchemaValueSymbol = (checker, proof, symbol) =>
  createSchemaProvenanceSession(
    checker,
    proof,
    getProvenanceLimits(proof)
  ).proveSymbol(resolveAlias(checker, symbol));

function isCanonicalSchemaValueExpression(checker, proof, node) {
  try {
    if (!isSchemaValueType(checker, proof, checker.getTypeAtLocation(node))) {
      return false;
    }
  } catch {
    return false;
  }
  return createSchemaProvenanceSession(
    checker,
    proof,
    getProvenanceLimits(proof)
  ).proveExpression(node);
}

const hasCanonicalContainerMemberExpression = (checker, proof, root) => {
  let found = false;
  const visit = (node) => {
    if (found) return;
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isPropertyAccessExpression(node.expression)
    ) {
      const containerProperty = checker.getSymbolAtLocation(
        node.expression.name
      );
      let valueType;
      try {
        valueType = checker.getTypeAtLocation(node);
      } catch {
        valueType = undefined;
      }
      if (
        containerProperty !== undefined &&
        isCanonicalSchemaContainerProperty(checker, proof, containerProperty) &&
        valueType !== undefined &&
        isSchemaValueType(checker, proof, valueType)
      ) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
};

const isCanonicalContainerProjectionSchemaSymbol = (checker, proof, symbol) => {
  const resolved = resolveAlias(checker, symbol);
  const declaration = (resolved.declarations ?? []).find(
    (candidate) =>
      ts.isVariableDeclaration(candidate) &&
      isConstVariableDeclaration(candidate) &&
      candidate.initializer !== undefined &&
      hasCanonicalContainerMemberExpression(
        checker,
        proof,
        candidate.initializer
      )
  );
  if (declaration === undefined) return false;
  return createSchemaProvenanceSession(
    checker,
    proof,
    getProvenanceLimits(proof),
    { allowCanonicalContainerMemberReferences: true }
  ).proveSymbol(resolved);
};

const isSchemaValueEntity = (checker, proof, entityName) => {
  const symbol = getValueSymbolForEntityName(checker, entityName);
  const valueType = getValueTypeForEntityName(checker, entityName);
  return (
    symbol !== undefined &&
    valueType !== undefined &&
    isSchemaValueType(checker, proof, valueType) &&
    (isCanonicalSchemaValueSymbol(checker, proof, symbol) ||
      isCanonicalContainerProjectionSchemaSymbol(checker, proof, symbol))
  );
};

const isCanonicalProjectionTypeNode = (checker, proof, node) => {
  if (!ts.isTypeReferenceNode(node) || node.typeArguments?.[0] === undefined) {
    return false;
  }
  const symbol = checker.getSymbolAtLocation(node.typeName);
  return (
    symbol !== undefined &&
    proof.canonicalProjectionSymbols.has(resolveAlias(checker, symbol))
  );
};

const isCanonicalSchemaTypeProjectionCandidate = (checker, proof, node) => {
  if (!ts.isTypeReferenceNode(node)) return false;
  const symbol = checker.getSymbolAtLocation(node.typeName);
  return (
    symbol !== undefined &&
    resolveAlias(checker, symbol) === proof.canonicalSchemaTypeSymbol
  );
};

const isCanonicalSchemaTypeProjection = (checker, proof, node) => {
  if (
    !isCanonicalSchemaTypeProjectionCandidate(checker, proof, node) ||
    node.typeArguments?.length !== 1 ||
    !ts.isTypeQueryNode(node.typeArguments[0])
  ) {
    return false;
  }
  return isSchemaValueEntity(checker, proof, node.typeArguments[0].exprName);
};

const hasCanonicalDecodedTypeProperty = (checker, proof, node) => {
  if (ts.isTypeQueryNode(node) && ts.isQualifiedName(node.exprName)) {
    const propertySymbol = checker.getSymbolAtLocation(node.exprName.right);
    const schemaValueType = getValueTypeForEntityName(
      checker,
      node.exprName.left
    );
    if (
      schemaValueType === undefined ||
      !isSchemaValueType(checker, proof, schemaValueType)
    ) {
      return false;
    }
    const decodedProperty = checker.getPropertyOfType(
      schemaValueType,
      proof.canonicalDecodedTypeProperty.escapedName
    );
    return (
      decodedProperty !== undefined &&
      propertySymbol !== undefined &&
      propertySymbol.escapedName === decodedProperty.escapedName &&
      propertySymbol.declarations?.some((declaration) =>
        decodedProperty.declarations?.includes(declaration)
      ) === true
    );
  }

  if (
    !ts.isIndexedAccessTypeNode(node) ||
    !ts.isTypeQueryNode(node.objectType) ||
    !ts.isLiteralTypeNode(node.indexType) ||
    !ts.isStringLiteral(node.indexType.literal)
  ) {
    return false;
  }
  const schemaValueType = getValueTypeForEntityName(
    checker,
    node.objectType.exprName
  );
  if (
    schemaValueType === undefined ||
    !isSchemaValueType(checker, proof, schemaValueType)
  ) {
    return false;
  }
  const indexedProperty = checker.getPropertyOfType(
    schemaValueType,
    node.indexType.literal.text
  );
  const decodedProperty = checker.getPropertyOfType(
    schemaValueType,
    proof.canonicalDecodedTypeProperty.escapedName
  );
  return (
    indexedProperty !== undefined &&
    decodedProperty !== undefined &&
    indexedProperty.escapedName === decodedProperty.escapedName &&
    indexedProperty.declarations?.some((declaration) =>
      decodedProperty.declarations?.includes(declaration)
    ) === true
  );
};

const getDecodedAccessEntityName = (node) => {
  if (ts.isTypeQueryNode(node) && ts.isQualifiedName(node.exprName)) {
    return node.exprName.left;
  }
  if (ts.isIndexedAccessTypeNode(node) && ts.isTypeQueryNode(node.objectType)) {
    return node.objectType.exprName;
  }
  return undefined;
};

const isCanonicalDecodedTypeAccess = (checker, proof, node) => {
  const entityName = getDecodedAccessEntityName(node);
  return (
    entityName !== undefined &&
    hasCanonicalDecodedTypeProperty(checker, proof, node) &&
    isSchemaValueEntity(checker, proof, entityName)
  );
};

const unwrapConstContainerInitializer = (node) => {
  let current = node;
  while (
    ts.isNonNullExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    (ts.isAsExpression(current) && ts.isConstTypeReference(current.type))
  ) {
    current = current.expression;
  }
  return current;
};

const getLocalConstObjectInitializer = (checker, sourceFile, expression) => {
  if (!ts.isIdentifier(expression)) return undefined;
  const symbol = checker.getSymbolAtLocation(expression);
  const declarations =
    symbol === undefined
      ? []
      : (resolveAlias(checker, symbol).declarations ?? []).filter(
          ts.isVariableDeclaration
        );
  if (
    declarations.length !== 1 ||
    declarations[0].getSourceFile() !== sourceFile ||
    !isConstVariableDeclaration(declarations[0]) ||
    declarations[0].initializer === undefined
  ) {
    return undefined;
  }
  const initializer = unwrapConstContainerInitializer(
    declarations[0].initializer
  );
  return ts.isObjectLiteralExpression(initializer) ? initializer : undefined;
};

const hasNestedLocalContainerSpread = (checker, ownerDeclaration) => {
  let nested = false;
  const sourceFile = ownerDeclaration.getSourceFile();
  const visit = (node) => {
    if (nested) return;
    if (ts.isSpreadAssignment(node)) {
      const initializer = getLocalConstObjectInitializer(
        checker,
        sourceFile,
        node.expression
      );
      if (initializer?.properties.some(ts.isSpreadAssignment) === true) {
        nested = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ownerDeclaration.initializer);
  return nested;
};

const hasCrossFileValueReference = (proof, symbol, sourceFile) =>
  proof.referenceIndex.complete &&
  (proof.referenceIndex.references.get(symbol) ?? []).some(
    (reference) =>
      reference.getSourceFile() !== sourceFile &&
      !isDeclarationName(reference) &&
      !isTypeOnlyReference(reference) &&
      !isImportOrExportReference(reference)
  );

const isCanonicalCrossFileUnionDecodedTypeAccess = (checker, proof, node) => {
  if (
    !ts.isTypeQueryNode(node) ||
    !ts.isQualifiedName(node.exprName) ||
    !hasCanonicalDecodedTypeProperty(checker, proof, node)
  ) {
    return false;
  }
  const symbol = getValueSymbolForEntityName(checker, node.exprName.left);
  if (symbol === undefined) return false;
  const declarations = (symbol.declarations ?? []).filter(
    ts.isVariableDeclaration
  );
  if (
    declarations.length !== 1 ||
    !isConstVariableDeclaration(declarations[0]) ||
    !isExportedVariableDeclaration(declarations[0]) ||
    declarations[0].initializer === undefined ||
    !ts.isCallExpression(declarations[0].initializer) ||
    hasNestedLocalContainerSpread(checker, declarations[0])
  ) {
    return false;
  }
  const unionSymbol = getCanonicalCalleeSymbol(
    checker,
    proof,
    declarations[0].initializer.expression
  );
  const canonicalUnion =
    unionSymbol !== undefined &&
    hasSameDeclaration(checker, unionSymbol, proof.canonicalSchemaUnionSymbol);
  const crossFileValueReference = hasCrossFileValueReference(
    proof,
    symbol,
    declarations[0].getSourceFile()
  );
  const provenanceLimits = getProvenanceLimits(proof);
  const canonicalProvenance =
    canonicalUnion &&
    crossFileValueReference &&
    createSchemaProvenanceSession(
      checker,
      proof,
      {
        ...provenanceLimits,
        maxWorkItems: provenanceLimits.maxWorkItems * 2,
      },
      {
        allowCanonicalContainerMemberReferences: true,
        allowCanonicalFactoryContainerReferences: true,
      }
    ).proveSymbol(symbol);
  return canonicalProvenance;
};

const isCanonicalDecodeToTargetReference = (checker, proof, reference) => {
  let current = reference.parent;
  while (current !== undefined && !ts.isStatement(current)) {
    if (
      ts.isCallExpression(current) &&
      current.arguments[0] !== undefined &&
      isWithin(reference, current.arguments[0])
    ) {
      const callee = getCanonicalCalleeSymbol(
        checker,
        proof,
        current.expression
      );
      return (
        callee !== undefined &&
        hasSameDeclaration(checker, callee, proof.schemaDecodeToSymbol)
      );
    }
    current = current.parent;
  }
  return false;
};

const getClosedLocalFunction = (checker, call) => {
  const symbol = checker.getSymbolAtLocation(call.expression);
  if (symbol === undefined) return undefined;
  const declarations = resolveAlias(checker, symbol).declarations ?? [];
  if (declarations.length !== 1) return undefined;
  const declaration = declarations[0];
  if (
    ts.isFunctionDeclaration(declaration) &&
    declaration.body !== undefined &&
    !hasExportModifier(declaration)
  ) {
    return declaration;
  }
  if (
    ts.isVariableDeclaration(declaration) &&
    isConstVariableDeclaration(declaration) &&
    declaration.initializer !== undefined &&
    (ts.isArrowFunction(declaration.initializer) ||
      ts.isFunctionExpression(declaration.initializer)) &&
    !isExportedVariableDeclaration(declaration)
  ) {
    return declaration.initializer;
  }
  return undefined;
};

const isClosedCanonicalSchemaFactoryCall = (checker, proof, call) => {
  const implementation = getClosedLocalFunction(checker, call);
  if (
    implementation === undefined ||
    implementation.parameters.length !== call.arguments.length
  ) {
    return false;
  }
  const parameterSymbols = new Set();
  for (let index = 0; index < implementation.parameters.length; index += 1) {
    const parameter = implementation.parameters[index];
    if (!ts.isIdentifier(parameter.name)) return false;
    const parameterSymbol = checker.getSymbolAtLocation(parameter.name);
    if (parameterSymbol === undefined) return false;
    parameterSymbols.add(resolveAlias(checker, parameterSymbol));
    let parameterType;
    try {
      parameterType = checker.getTypeAtLocation(parameter);
    } catch {
      return false;
    }
    if (
      parameterTypeMayContainSchema(
        checker,
        proof,
        parameterType,
        getProvenanceLimits(proof)
      ) &&
      !isCanonicalSchemaValueExpression(checker, proof, call.arguments[index])
    ) {
      return false;
    }
  }
  const returns = getFunctionReturnExpressions(implementation);
  if (returns.length !== 1 || !ts.isCallExpression(returns[0])) return false;
  let safe = true;
  const validate = (node) => {
    if (!safe) return;
    if (
      ts.isAsExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isNonNullExpression(node)
    ) {
      safe = false;
      return;
    }
    if (ts.isCallExpression(node)) {
      if (!isCanonicalCallShape(checker, proof, node)) {
        safe = false;
        return;
      }
      for (const argument of node.arguments) validate(argument);
      return;
    }
    if (ts.isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      if (
        symbol !== undefined &&
        parameterSymbols.has(resolveAlias(checker, symbol))
      ) {
        return;
      }
      if (
        isDeclarationName(node) ||
        (ts.isPropertyAssignment(node.parent) && node.parent.name === node) ||
        (ts.isShorthandPropertyAssignment(node.parent) &&
          node.parent.name === node)
      ) {
        return;
      }
      safe = false;
      return;
    }
    if (ts.isFunctionLike(node)) {
      safe = false;
      return;
    }
    ts.forEachChild(node, validate);
  };
  validate(returns[0]);
  return safe;
};

const isCanonicalBoundaryRootInitializer = (checker, proof, initializer) => {
  if (!ts.isCallExpression(initializer)) return false;
  if (!isCanonicalCallShape(checker, proof, initializer)) return false;
  let schemaType;
  try {
    schemaType = checker.getTypeAtLocation(initializer);
  } catch {
    return false;
  }
  if (!isSchemaValueType(checker, proof, schemaType)) return false;
  const proveMember = (node) => {
    if (ts.isSpreadElement(node)) return false;
    if (ts.isArrayLiteralExpression(node)) {
      return node.elements.every(proveMember);
    }
    return (
      isCanonicalSchemaValueExpression(checker, proof, node) ||
      (ts.isCallExpression(node) &&
        isClosedCanonicalSchemaFactoryCall(checker, proof, node))
    );
  };
  return initializer.arguments.every(proveMember);
};

const isCanonicalBoundarySchemaSymbol = (checker, proof, symbol) => {
  if (!proof.referenceIndex.complete) return false;
  const resolved = resolveAlias(checker, symbol);
  if (
    !(proof.referenceIndex.references.get(resolved) ?? []).some((reference) =>
      isCanonicalDecodeToTargetReference(checker, proof, reference)
    )
  ) {
    return false;
  }
  const limits = getProvenanceLimits(proof);
  const proven = createSchemaProvenanceSession(
    checker,
    proof,
    { ...limits, maxWorkItems: limits.maxWorkItems * 4 },
    {
      allowCanonicalContainerMemberReferences: true,
      allowCanonicalFactoryContainerReferences: true,
    }
  ).proveSymbol(resolved);
  if (proven) return true;
  return (resolved.declarations ?? []).some(
    (declaration) =>
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer !== undefined &&
      isCanonicalBoundaryRootInitializer(
        checker,
        proof,
        declaration.initializer
      )
  );
};

const isCanonicalDeclaredSchemaClassSymbol = (checker, proof, symbol) => {
  const resolved = resolveAlias(checker, symbol);
  if (!(resolved.declarations ?? []).some(ts.isClassDeclaration)) return false;
  return createSchemaProvenanceSession(
    checker,
    proof,
    getProvenanceLimits(proof),
    { allowCanonicalContainerMemberReferences: true }
  ).proveSymbol(resolved);
};

const isCanonicalBoundarySchemaInitializer = (
  checker,
  proof,
  initializer,
  seenSymbols = new Set()
) => {
  if (
    ts.isIdentifier(initializer) ||
    ts.isPropertyAccessExpression(initializer)
  ) {
    const symbol = checker.getSymbolAtLocation(initializer);
    if (symbol === undefined) return false;
    const resolved = resolveAlias(checker, symbol);
    if (seenSymbols.has(resolved)) return false;
    seenSymbols.add(resolved);
    if (
      isCanonicalBoundarySchemaSymbol(checker, proof, resolved) ||
      isCanonicalDeclaredSchemaClassSymbol(checker, proof, resolved)
    ) {
      return true;
    }
    return (resolved.declarations ?? []).some((declaration) => {
      if (
        !ts.isVariableDeclaration(declaration) ||
        !isConstVariableDeclaration(declaration) ||
        declaration.initializer === undefined
      ) {
        return false;
      }
      return isCanonicalBoundarySchemaInitializer(
        checker,
        proof,
        declaration.initializer,
        seenSymbols
      );
    });
  }
  return false;
};

const isBoundaryDecodedSchemaEntity = (checker, proof, entityName) => {
  const symbol = getValueSymbolForEntityName(checker, entityName);
  if (symbol === undefined) return false;
  const resolved = resolveAlias(checker, symbol);
  return (resolved.declarations ?? []).some((declaration) => {
    if (
      !ts.isVariableDeclaration(declaration) ||
      !ts.isIdentifier(declaration.name) ||
      declaration.initializer === undefined
    ) {
      return false;
    }
    return isCanonicalBoundarySchemaInitializer(
      checker,
      proof,
      declaration.initializer
    );
  });
};

const isBoundaryDecodedTypeAccess = (checker, proof, node) => {
  const entityName = getDecodedAccessEntityName(node);
  return (
    entityName !== undefined &&
    hasCanonicalDecodedTypeProperty(checker, proof, node) &&
    isBoundaryDecodedSchemaEntity(checker, proof, entityName)
  );
};

const isSchemaDerivedTypeNode = (
  checker,
  proof,
  node,
  seenSymbols = new Set()
) => {
  if (ts.isParenthesizedTypeNode(node)) {
    return isSchemaDerivedTypeNode(checker, proof, node.type, seenSymbols);
  }

  if (ts.isTypeQueryNode(node) || ts.isIndexedAccessTypeNode(node)) {
    return (
      isCanonicalDecodedTypeAccess(checker, proof, node) ||
      isCanonicalCrossFileUnionDecodedTypeAccess(checker, proof, node) ||
      isBoundaryDecodedTypeAccess(checker, proof, node)
    );
  }

  if (ts.isTypeReferenceNode(node)) {
    if (isCanonicalSchemaTypeProjection(checker, proof, node)) return true;

    if (isCanonicalProjectionTypeNode(checker, proof, node)) {
      return isSchemaDerivedTypeNode(
        checker,
        proof,
        node.typeArguments[0],
        seenSymbols
      );
    }

    const symbol = checker.getSymbolAtLocation(node.typeName);
    if (symbol === undefined) return false;
    const resolved = resolveAlias(checker, symbol);
    if (seenSymbols.has(resolved)) return false;
    seenSymbols.add(resolved);

    for (const declaration of resolved.declarations ?? []) {
      if (
        ts.isTypeAliasDeclaration(declaration) &&
        isSchemaDerivedTypeNode(checker, proof, declaration.type, seenSymbols)
      ) {
        return true;
      }
      if (ts.isClassDeclaration(declaration)) {
        const classSymbol = checker.getSymbolAtLocation(declaration.name);
        if (
          classSymbol !== undefined &&
          (isCanonicalSchemaValueSymbol(checker, proof, classSymbol) ||
            isCanonicalDeclaredSchemaClassSymbol(checker, proof, classSymbol))
        ) {
          return true;
        }
      }
    }
  }

  return false;
};

const isSchemaOwnerTypeArgument = (checker, proof, node) =>
  isSchemaDerivedTypeNode(checker, proof, node) ||
  (ts.isTypeQueryNode(node) &&
    isSchemaValueEntity(checker, proof, node.exprName));

const hasSchemaOwnerTypeArgument = (checker, proof, node) =>
  ts.isTypeReferenceNode(node) &&
  node.typeArguments?.some((argument) =>
    isSchemaOwnerTypeArgument(checker, proof, argument)
  ) === true;

const isCanonicalProjectionSelectorTypeLiteral = (
  checker,
  proof,
  _sourceFile,
  node
) => {
  const parent = node.parent;
  if (
    !ts.isTypeReferenceNode(parent) ||
    !isCanonicalProjectionTypeNode(checker, proof, parent)
  ) {
    return false;
  }
  const typeArguments = parent.typeArguments ?? [];
  if (typeArguments[0] === undefined || typeArguments[0] === node) {
    return false;
  }
  return (
    ts.isTypeAliasDeclaration(parent.parent) &&
    isSchemaDerivedTypeNode(checker, proof, typeArguments[0])
  );
};

const isSchemaIndexedAccess = (checker, proof, node) =>
  ts.isIndexedAccessTypeNode(node) &&
  ts.isTypeQueryNode(node.objectType) &&
  isSchemaValueEntity(checker, proof, node.objectType.exprName);

const isDecodedTypeAccessCandidate = (checker, proof, node) => {
  if (ts.isTypeQueryNode(node) && ts.isQualifiedName(node.exprName)) {
    return (
      checker.getSymbolAtLocation(node.exprName.right)?.escapedName ===
      proof.canonicalDecodedTypeProperty.escapedName
    );
  }
  return (
    ts.isIndexedAccessTypeNode(node) &&
    ts.isTypeQueryNode(node.objectType) &&
    ts.isLiteralTypeNode(node.indexType) &&
    ts.isStringLiteral(node.indexType.literal) &&
    node.indexType.literal.text ===
      String(proof.canonicalDecodedTypeProperty.escapedName)
  );
};

const getContractMembers = (declaration) => {
  if (ts.isInterfaceDeclaration(declaration)) return declaration.members;
  if (
    ts.isTypeAliasDeclaration(declaration) &&
    ts.isTypeLiteralNode(declaration.type)
  ) {
    return declaration.type.members;
  }
  return undefined;
};

const hasReadonlyModifier = (node) =>
  node.modifiers?.some(
    (modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword
  ) === true;

const getDirectStructuralTypeDeclaration = (checker, sourceFile, reference) => {
  if (
    !ts.isTypeReferenceNode(reference) ||
    !ts.isIdentifier(reference.typeName) ||
    (reference.typeArguments?.length ?? 0) > 0
  ) {
    return undefined;
  }
  const symbol = checker.getSymbolAtLocation(reference.typeName);
  if (symbol === undefined) return undefined;
  const resolved = resolveAlias(checker, symbol);
  const declarations = resolved.declarations?.filter(
    (declaration) =>
      declaration.getSourceFile() === sourceFile &&
      (ts.isInterfaceDeclaration(declaration) ||
        (ts.isTypeAliasDeclaration(declaration) &&
          ts.isTypeLiteralNode(declaration.type)))
  );
  if (declarations?.length !== 1) return undefined;
  const declaration = declarations[0];
  if (
    (declaration.typeParameters?.length ?? 0) > 0 ||
    (ts.isInterfaceDeclaration(declaration) &&
      (declaration.heritageClauses?.length ?? 0) > 0)
  ) {
    return undefined;
  }
  return declaration;
};

const hasCompilerStructuralReferenceCycle = (
  checker,
  sourceFile,
  declaration,
  active = new Set()
) => {
  if (active.has(declaration)) return true;
  const members = getContractMembers(declaration);
  if (members === undefined) return false;
  const nextActive = new Set(active).add(declaration);
  let cycle = false;
  const visit = (node) => {
    if (cycle) return;
    if (ts.isTypeReferenceNode(node)) {
      const target = getDirectStructuralTypeDeclaration(
        checker,
        sourceFile,
        node
      );
      if (
        target !== undefined &&
        hasCompilerStructuralReferenceCycle(
          checker,
          sourceFile,
          target,
          nextActive
        )
      ) {
        cycle = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  for (const member of members) visit(member);
  return cycle;
};

const hasCompilerLocalTypeReferenceCycle = (
  checker,
  sourceFile,
  node,
  activeDeclarations
) => {
  let unsafe = false;
  const visitClassMemberTypes = (member, active) => {
    if (
      member.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword
      )
    ) {
      return;
    }
    if (ts.isPropertyDeclaration(member)) {
      if (member.type !== undefined) visit(member.type, active);
      return;
    }
    if (ts.isConstructorDeclaration(member)) {
      for (const parameter of member.parameters) {
        if (
          ts.isParameterPropertyDeclaration(parameter, member) &&
          parameter.type !== undefined
        ) {
          visit(parameter.type, active);
        }
      }
      return;
    }
    if (
      !ts.isMethodDeclaration(member) &&
      !ts.isGetAccessorDeclaration(member) &&
      !ts.isSetAccessorDeclaration(member)
    ) {
      return;
    }
    if (ts.isMethodDeclaration(member)) {
      for (const typeParameter of member.typeParameters ?? []) {
        if (typeParameter.constraint !== undefined) {
          visit(typeParameter.constraint, active);
        }
        if (typeParameter.default !== undefined) {
          visit(typeParameter.default, active);
        }
      }
    }
    for (const parameter of member.parameters) {
      if (parameter.type !== undefined) visit(parameter.type, active);
    }
    if (member.type !== undefined) visit(member.type, active);
  };
  const visitLocalDeclaration = (target, active) => {
    if (active.has(target)) {
      unsafe = true;
      return;
    }
    const nextActive = new Set(active).add(target);
    if (ts.isInterfaceDeclaration(target)) {
      for (const member of target.members) visit(member, nextActive);
    } else if (ts.isTypeAliasDeclaration(target)) {
      visit(target.type, nextActive);
    } else {
      for (const member of target.members) {
        visitClassMemberTypes(member, nextActive);
      }
    }
  };
  const getQualifiedRoot = (typeName) => {
    let root = typeName;
    while (ts.isQualifiedName(root)) root = root.left;
    return ts.isIdentifier(root) ? root : undefined;
  };
  const visit = (current, active) => {
    if (unsafe) return;
    if (ts.isTypeReferenceNode(current)) {
      let resolvedDeclarations;
      if (!ts.isIdentifier(current.typeName)) {
        const root = getQualifiedRoot(current.typeName);
        const rootSymbol =
          root === undefined ? undefined : checker.getSymbolAtLocation(root);
        const rootDeclaration = rootSymbol?.declarations?.[0];
        const targetSymbol = checker.getSymbolAtLocation(current.typeName);
        resolvedDeclarations =
          targetSymbol === undefined
            ? undefined
            : resolveAlias(checker, targetSymbol).declarations;
        if (
          rootSymbol === undefined ||
          (rootSymbol.declarations?.length ?? 0) !== 1 ||
          rootDeclaration === undefined ||
          (!ts.isImportSpecifier(rootDeclaration) &&
            !ts.isNamespaceImport(rootDeclaration) &&
            !ts.isImportClause(rootDeclaration) &&
            !ts.isImportEqualsDeclaration(rootDeclaration)) ||
          targetSymbol === undefined ||
          (resolvedDeclarations?.length ?? 0) === 0 ||
          resolvedDeclarations?.some(
            (candidate) => candidate.getSourceFile() === sourceFile
          )
        ) {
          unsafe = true;
          return;
        }
      } else {
        const symbol = checker.getSymbolAtLocation(current.typeName);
        if (symbol === undefined) {
          unsafe = true;
          return;
        }
        resolvedDeclarations = resolveAlias(checker, symbol).declarations;
      }
      if (
        resolvedDeclarations === undefined ||
        resolvedDeclarations.length === 0
      ) {
        unsafe = true;
        return;
      }
      const localDeclarations = resolvedDeclarations.filter(
        (candidate) => candidate.getSourceFile() === sourceFile
      );
      if (localDeclarations.length > 1) {
        unsafe = true;
        return;
      }
      const target = localDeclarations.find(
        (candidate) =>
          ts.isInterfaceDeclaration(candidate) ||
          ts.isTypeAliasDeclaration(candidate) ||
          ts.isClassDeclaration(candidate)
      );
      if (target !== undefined) visitLocalDeclaration(target, active);
    }
    ts.forEachChild(current, (child) => visit(child, active));
  };
  visit(node, activeDeclarations);
  return unsafe;
};

const getDirectLocalCanonicalSchemaClass = (
  checker,
  proof,
  sourceFile,
  node
) => {
  if (
    !ts.isTypeReferenceNode(node) ||
    !ts.isIdentifier(node.typeName) ||
    (node.typeArguments?.length ?? 0) > 0
  ) {
    return undefined;
  }
  const symbol = checker.getSymbolAtLocation(node.typeName);
  if (symbol === undefined) return undefined;
  const declarations = resolveAlias(checker, symbol).declarations ?? [];
  if (declarations.length !== 1) return undefined;
  const declaration = declarations[0];
  if (
    !ts.isClassDeclaration(declaration) ||
    declaration.getSourceFile() !== sourceFile ||
    declaration.name === undefined ||
    (declaration.typeParameters?.length ?? 0) > 0
  ) {
    return undefined;
  }
  const extendsClauses = (declaration.heritageClauses ?? []).filter(
    (clause) => clause.token === ts.SyntaxKind.ExtendsKeyword
  );
  if (extendsClauses.length !== 1 || extendsClauses[0].types.length !== 1) {
    return undefined;
  }
  const schemaClass = extendsClauses[0].types[0].expression;
  if (
    !ts.isCallExpression(schemaClass) ||
    schemaClass.arguments.length !== 1 ||
    !ts.isObjectLiteralExpression(schemaClass.arguments[0]) ||
    !ts.isCallExpression(schemaClass.expression) ||
    schemaClass.expression.arguments.length !== 1 ||
    !ts.isPropertyAccessExpression(schemaClass.expression.expression) ||
    (schemaClass.expression.typeArguments?.length ?? 0) !== 1
  ) {
    return undefined;
  }
  const factory = schemaClass.expression;
  const selfType = factory.typeArguments[0];
  const classSymbol = checker.getSymbolAtLocation(declaration.name);
  const selfSymbol =
    ts.isTypeReferenceNode(selfType) && ts.isIdentifier(selfType.typeName)
      ? checker.getSymbolAtLocation(selfType.typeName)
      : undefined;
  const factorySymbol = checker.getSymbolAtLocation(factory.expression.name);
  return classSymbol !== undefined &&
    selfSymbol !== undefined &&
    factorySymbol !== undefined &&
    hasSameDeclaration(checker, selfSymbol, classSymbol) &&
    hasSameDeclaration(
      checker,
      factorySymbol,
      proof.canonicalSchemaClassSymbol
    ) &&
    isCanonicalSchemaValueSymbol(checker, proof, classSymbol)
    ? declaration
    : undefined;
};

const getDirectIntersectionCapabilityDeclaration = (
  checker,
  proof,
  sourceFile,
  reference
) => {
  if (
    !ts.isTypeReferenceNode(reference) ||
    !ts.isIdentifier(reference.typeName) ||
    (reference.typeArguments?.length ?? 0) > 0
  ) {
    return undefined;
  }
  const symbol = checker.getSymbolAtLocation(reference.typeName);
  if (symbol === undefined) return undefined;
  const declarations = resolveAlias(checker, symbol).declarations ?? [];
  if (declarations.length !== 1) return undefined;
  const declaration = declarations[0];
  if (
    !ts.isTypeAliasDeclaration(declaration) ||
    declaration.getSourceFile() !== sourceFile ||
    (declaration.typeParameters?.length ?? 0) > 0 ||
    !ts.isIntersectionTypeNode(declaration.type) ||
    declaration.type.types.length !== 2
  ) {
    return undefined;
  }
  const callableArms = declaration.type.types.filter(
    (type) => ts.isTypeLiteralNode(type) && isAllCallable(type.members)
  );
  const schemaArms = declaration.type.types.filter(
    (type) =>
      getDirectLocalCanonicalSchemaClass(checker, proof, sourceFile, type) !==
      undefined
  );
  if (callableArms.length !== 1 || schemaArms.length !== 1) return undefined;
  return hasCompilerLocalTypeReferenceCycle(
    checker,
    sourceFile,
    callableArms[0],
    new Set([declaration])
  )
    ? undefined
    : declaration;
};

const isCapabilityWrapperTypeAlias = (
  checker,
  proof,
  sourceFile,
  declaration
) => {
  if (
    !ts.isTypeLiteralNode(declaration.type) ||
    (declaration.typeParameters?.length ?? 0) > 0 ||
    declaration.type.members.length === 0
  ) {
    return false;
  }
  return declaration.type.members.every((member) => {
    if (
      !ts.isPropertySignature(member) ||
      !hasReadonlyModifier(member) ||
      member.questionToken === undefined ||
      member.type === undefined
    ) {
      return false;
    }
    const target = getDirectStructuralTypeDeclaration(
      checker,
      sourceFile,
      member.type
    );
    const members =
      target === undefined ? undefined : getContractMembers(target);
    const structuralCapability =
      target !== undefined &&
      target !== declaration &&
      members?.some(isCallableMember) === true &&
      !hasCompilerStructuralReferenceCycle(checker, sourceFile, target);
    return (
      structuralCapability ||
      getDirectIntersectionCapabilityDeclaration(
        checker,
        proof,
        sourceFile,
        member.type
      ) !== undefined
    );
  });
};

const isCanonicalXStateSetupMetadataReference = (checker, proof, reference) => {
  const typeReference = reference.parent;
  if (
    !ts.isTypeReferenceNode(typeReference) ||
    typeReference.typeName !== reference
  ) {
    return false;
  }
  const call = typeReference.parent;
  if (!ts.isCallExpression(call)) return false;
  const argumentIndex = call.typeArguments?.indexOf(typeReference);
  if (argumentIndex !== 4 && argumentIndex !== 5) return false;
  const setupSymbol = checker.getSymbolAtLocation(call.expression);
  return (
    setupSymbol !== undefined &&
    hasSameDeclaration(checker, setupSymbol, proof.xstateSetupSymbol)
  );
};

const isXStateSetupMetadataAlias = (checker, proof, declaration) => {
  if (!proof.referenceIndex.complete) return false;
  const symbol = checker.getSymbolAtLocation(declaration.name);
  if (symbol === undefined) return false;
  const references = proof.referenceIndex.references.get(
    resolveAlias(checker, symbol)
  );
  const uses = (references ?? []).filter(
    (reference) => !isDeclarationName(reference)
  );
  return (
    uses.length > 0 &&
    uses.every((reference) =>
      isCanonicalXStateSetupMetadataReference(checker, proof, reference)
    )
  );
};

const hasExactXStateSetupMetadataShape = (declaration) =>
  declaration.typeParameters === undefined &&
  declaration.modifiers?.some(
    (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
  ) !== true &&
  ts.isTypeLiteralNode(declaration.type) &&
  declaration.type.members.length > 0 &&
  declaration.type.members.every(
    (member) =>
      ts.isPropertySignature(member) &&
      member.questionToken === undefined &&
      member.type?.kind === ts.SyntaxKind.UndefinedKeyword &&
      (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) &&
      member.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword
      ) === true
  );

const isTanStackRouterRegisterAugmentation = (declaration) =>
  declaration !== undefined &&
  ts.isInterfaceDeclaration(declaration) &&
  declaration.name.text === "Register" &&
  ts.isModuleBlock(declaration.parent) &&
  ts.isModuleDeclaration(declaration.parent.parent) &&
  ts.isStringLiteral(declaration.parent.parent.name) &&
  declaration.parent.parent.name.text === "@tanstack/react-router";

const isReturnTypeOfLocalValue = (node) =>
  ts.isTypeReferenceNode(node) &&
  getTypeReferenceName(node) === "ReturnType" &&
  node.typeArguments?.length === 1 &&
  ts.isTypeQueryNode(node.typeArguments[0]) &&
  ts.isIdentifier(node.typeArguments[0].exprName);

const isFrameworkReturnTypeMember = (_sourceFile, declaration, member) =>
  isTanStackRouterRegisterAugmentation(declaration) &&
  ts.isPropertySignature(member) &&
  getPropertyName(member.name) === "router" &&
  member.type !== undefined &&
  isReturnTypeOfLocalValue(member.type);

const isFrameworkMember = (checker, proof, sourceFile, declaration, member) => {
  if (
    ts.isCallSignatureDeclaration(member) ||
    ts.isConstructSignatureDeclaration(member) ||
    ts.isMethodSignature(member) ||
    (ts.isPropertySignature(member) &&
      member.type !== undefined &&
      ts.isFunctionTypeNode(member.type))
  ) {
    return true;
  }
  if (!ts.isPropertySignature(member) || member.type === undefined) {
    return false;
  }
  const name = getPropertyName(member.name);
  return (
    isFrameworkTypeNode(member.type, { allowReadonly: true }) ||
    isFrameworkReturnTypeMember(sourceFile, declaration, member) ||
    isSchemaDerivedTypeNode(checker, proof, member.type) ||
    (name !== undefined &&
      ((displayAndProseNames.has(name) &&
        isFrameworkDisplayType(member.type)) ||
        (frameworkStateNames.has(name) &&
          isLiteralFrameworkStateType(member.type))))
  );
};

const isFrameworkProps = (checker, proof, sourceFile, declaration) => {
  const members = getContractMembers(declaration);
  return (
    members !== undefined &&
    sourceFile.fileName.endsWith(".tsx") &&
    members.length > 0 &&
    members.every((member) =>
      isFrameworkMember(checker, proof, sourceFile, declaration, member)
    )
  );
};

const hasFrameworkIntersectionContext = (node) =>
  ts.isIntersectionTypeNode(node.parent) &&
  node.parent.types.some(
    (candidate) => candidate !== node && isFrameworkTypeNode(candidate)
  );

const hasFrameworkReadonlyContext = (node) =>
  ts.isTypeReferenceNode(node.parent) &&
  getTypeReferenceName(node.parent) === "Readonly" &&
  node.parent.typeArguments?.length === 1 &&
  node.parent.typeArguments[0] === node;

const isFrameworkTypeLiteral = (checker, proof, sourceFile, node) =>
  sourceFile.fileName.endsWith(".tsx") &&
  node.members.length > 0 &&
  node.members.every((member) =>
    isFrameworkMember(checker, proof, sourceFile, undefined, member)
  ) &&
  (isAllCallable(node.members) ||
    hasFrameworkIntersectionContext(node) ||
    hasFrameworkReadonlyContext(node));

const typeHasRuntimeCapability = (
  checker,
  type,
  ownerSourceFile,
  seenTypes = new Set(),
  depth = 0
) => {
  if (seenTypes.has(type) || depth > 24) return false;
  seenTypes.add(type);
  if (
    (type.flags &
      (ts.TypeFlags.Any |
        ts.TypeFlags.BigIntLike |
        ts.TypeFlags.BooleanLike |
        ts.TypeFlags.EnumLike |
        ts.TypeFlags.Never |
        ts.TypeFlags.Null |
        ts.TypeFlags.NumberLike |
        ts.TypeFlags.StringLike |
        ts.TypeFlags.Undefined |
        ts.TypeFlags.Unknown |
        ts.TypeFlags.Void)) !==
    0
  ) {
    return false;
  }
  const signatures = [
    ...checker.getSignaturesOfType(type, ts.SignatureKind.Call),
    ...checker.getSignaturesOfType(type, ts.SignatureKind.Construct),
  ];
  if (
    signatures.some((signature) => {
      const declaration = signature.getDeclaration();
      if (declaration === undefined) return false;
      const declarationFile = declaration.getSourceFile();
      return (
        declarationFile !== ownerSourceFile &&
        declarationFile.fileName.includes(`${path.sep}node_modules${path.sep}`)
      );
    })
  ) {
    return true;
  }
  if (type.isUnionOrIntersection()) {
    return type.types.some((member) =>
      typeHasRuntimeCapability(
        checker,
        member,
        ownerSourceFile,
        seenTypes,
        depth + 1
      )
    );
  }
  if (checker.isArrayType(type) || checker.isTupleType(type)) return false;
  for (const property of checker.getPropertiesOfType(type)) {
    const declaration = property.valueDeclaration ?? property.declarations?.[0];
    if (declaration === undefined) continue;
    const propertyType = checker.getTypeOfSymbolAtLocation(
      property,
      declaration
    );
    if (
      typeHasRuntimeCapability(
        checker,
        propertyType,
        ownerSourceFile,
        seenTypes,
        depth + 1
      )
    ) {
      return true;
    }
  }
  return false;
};

const getMemberTypeNode = (member) =>
  ts.isPropertySignature(member) || ts.isPropertyDeclaration(member)
    ? member.type
    : undefined;

const isRawStringTypeNode = (node) => {
  if (node.kind === ts.SyntaxKind.StringKeyword) return true;
  if (ts.isParenthesizedTypeNode(node)) return isRawStringTypeNode(node.type);
  if (ts.isUnionTypeNode(node)) {
    return node.types.some(isRawStringTypeNode);
  }
  if (ts.isArrayTypeNode(node)) return isRawStringTypeNode(node.elementType);
  if (
    ts.isTypeReferenceNode(node) &&
    (getTypeReferenceName(node) === "Array" ||
      getTypeReferenceName(node) === "ReadonlyArray") &&
    node.typeArguments?.length === 1
  ) {
    return isRawStringTypeNode(node.typeArguments[0]);
  }
  return false;
};

const isSchemaOwnedDataTypeNode = (checker, proof, node) => {
  if (isSchemaDerivedTypeNode(checker, proof, node)) {
    return { owned: true, schema: true };
  }
  if (
    node.kind === ts.SyntaxKind.BooleanKeyword ||
    node.kind === ts.SyntaxKind.NumberKeyword ||
    node.kind === ts.SyntaxKind.StringKeyword ||
    node.kind === ts.SyntaxKind.UndefinedKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword ||
    ts.isLiteralTypeNode(node)
  ) {
    return { owned: true, schema: false };
  }
  if (ts.isParenthesizedTypeNode(node)) {
    return isSchemaOwnedDataTypeNode(checker, proof, node.type);
  }
  if (ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node)) {
    const results = node.types.map((candidate) =>
      isSchemaOwnedDataTypeNode(checker, proof, candidate)
    );
    return {
      owned: results.every((result) => result.owned),
      schema: results.some((result) => result.schema),
    };
  }
  if (ts.isArrayTypeNode(node)) {
    return isSchemaOwnedDataTypeNode(checker, proof, node.elementType);
  }
  if (ts.isTupleTypeNode(node)) {
    const results = node.elements.map((candidate) =>
      isSchemaOwnedDataTypeNode(checker, proof, candidate)
    );
    return {
      owned: results.every((result) => result.owned),
      schema: results.some((result) => result.schema),
    };
  }
  if (ts.isTypeReferenceNode(node)) {
    const name = getTypeReferenceName(node);
    if (
      (name === "Array" || name === "ReadonlyArray" || name === "Readonly") &&
      node.typeArguments?.length === 1
    ) {
      return isSchemaOwnedDataTypeNode(checker, proof, node.typeArguments[0]);
    }
  }
  return { owned: false, schema: false };
};

const hasExportModifier = (node) =>
  node.modifiers?.some(
    (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
  ) === true;

const getDirectTypeReferenceDeclaration = (checker, node) => {
  if (
    !ts.isTypeReferenceNode(node) ||
    !ts.isIdentifier(node.typeName) ||
    (node.typeArguments?.length ?? 0) > 0
  ) {
    return undefined;
  }
  const symbol = checker.getSymbolAtLocation(node.typeName);
  if (symbol === undefined) return undefined;
  const declarations = resolveAlias(checker, symbol).declarations ?? [];
  return declarations.length === 1 ? declarations[0] : undefined;
};

const isDirectCallableTypeReference = (checker, node) => {
  const declaration = getDirectTypeReferenceDeclaration(checker, node);
  return (
    declaration !== undefined &&
    !declaration.getSourceFile().isDeclarationFile &&
    ts.isTypeAliasDeclaration(declaration) &&
    (declaration.typeParameters?.length ?? 0) === 0 &&
    ts.isFunctionTypeNode(declaration.type)
  );
};

const isConcreteClassTypeReference = (checker, node) => {
  const declaration = getDirectTypeReferenceDeclaration(checker, node);
  return (
    declaration !== undefined &&
    !declaration.getSourceFile().isDeclarationFile &&
    ts.isClassDeclaration(declaration)
  );
};

const findContainingParameter = (node) => {
  let current = node.parent;
  while (current !== undefined && !ts.isStatement(current)) {
    if (
      ts.isParameter(current) &&
      current.type !== undefined &&
      isWithin(node, current.type)
    ) {
      return current;
    }
    current = current.parent;
  }
  return undefined;
};

const isPrivateFunctionImplementation = (functionNode) => {
  if (ts.isFunctionDeclaration(functionNode)) {
    return !hasExportModifier(functionNode);
  }
  if (
    (ts.isArrowFunction(functionNode) ||
      ts.isFunctionExpression(functionNode)) &&
    ts.isVariableDeclaration(functionNode.parent) &&
    functionNode.parent.initializer === functionNode
  ) {
    return !isExportedVariableDeclaration(functionNode.parent);
  }
  return false;
};

const isNonEscapingParameterContract = (checker, proof, node) => {
  if (!proof.referenceIndex.complete) return false;
  const parameter = findContainingParameter(node);
  const functionNode = parameter?.parent;
  if (
    parameter === undefined ||
    functionNode === undefined ||
    !ts.isFunctionLike(functionNode) ||
    !isPrivateFunctionImplementation(functionNode)
  ) {
    return false;
  }
  if (ts.isObjectBindingPattern(parameter.name)) return true;
  if (!ts.isIdentifier(parameter.name)) return false;
  const symbol = checker.getSymbolAtLocation(parameter.name);
  if (symbol === undefined) return false;
  for (const reference of proof.referenceIndex.references.get(symbol) ?? []) {
    if (isDeclarationName(reference) || isTypeOnlyReference(reference)) {
      continue;
    }
    if (isWriteReference(reference)) return false;
    const access = getReferenceAccess(reference);
    if (
      access === reference ||
      (!ts.isPropertyAccessExpression(access) &&
        !ts.isElementAccessExpression(access))
    ) {
      return false;
    }
  }
  return true;
};

const functionHasCanonicalSchemaBoundary = (checker, proof, functionNode) => {
  let proven = false;
  const visit = (candidate) => {
    if (proven) return;
    if (candidate !== functionNode && ts.isFunctionLike(candidate)) return;
    if (
      ts.isTypeNode(candidate) &&
      isSchemaDerivedTypeNode(checker, proof, candidate)
    ) {
      proven = true;
      return;
    }
    if (ts.isPropertyAccessExpression(candidate)) {
      const ownerSymbol = checker.getSymbolAtLocation(candidate.expression);
      let ownerType;
      try {
        ownerType = checker.getTypeAtLocation(candidate.expression);
      } catch {
        ownerType = undefined;
      }
      if (
        (ownerSymbol !== undefined &&
          isCanonicalSchemaValueSymbol(checker, proof, ownerSymbol)) ||
        (ownerType !== undefined &&
          isSchemaValueType(checker, proof, ownerType))
      ) {
        proven = true;
        return;
      }
      const root = getCallRootExpression(candidate);
      const binding = getImportBinding(
        checker,
        checker.getSymbolAtLocation(root)
      );
      if (
        binding !== undefined &&
        (binding.moduleName === "effect" ||
          binding.moduleName.startsWith("effect/") ||
          binding.moduleName.startsWith("@effect/"))
      ) {
        proven = true;
        return;
      }
    }
    ts.forEachChild(candidate, visit);
  };
  visit(functionNode);
  return proven;
};

const isSchemaBoundOperationParameterContract = (checker, proof, node) => {
  if (!proof.referenceIndex.complete) return false;
  const parameter = findContainingParameter(node);
  const functionNode = parameter?.parent;
  if (
    parameter === undefined ||
    functionNode === undefined ||
    !ts.isFunctionLike(functionNode) ||
    !ts.isIdentifier(parameter.name) ||
    !functionHasCanonicalSchemaBoundary(checker, proof, functionNode)
  ) {
    return false;
  }
  const symbol = checker.getSymbolAtLocation(parameter.name);
  if (symbol === undefined) return false;
  const uses = (proof.referenceIndex.references.get(symbol) ?? []).filter(
    (reference) =>
      !isDeclarationName(reference) && !isTypeOnlyReference(reference)
  );
  return (
    uses.length > 0 &&
    uses.every((reference) => {
      if (isWriteReference(reference)) return false;
      const access = getReferenceAccess(reference);
      if (
        access === reference &&
        ts.isVariableDeclaration(reference.parent) &&
        reference.parent.initializer === reference &&
        ts.isObjectBindingPattern(reference.parent.name)
      ) {
        return true;
      }
      if (access === reference && ts.isCallExpression(reference.parent)) {
        const call = reference.parent;
        if (call.arguments.includes(reference)) {
          const calleeSymbol = checker.getSymbolAtLocation(call.expression);
          const declarations =
            calleeSymbol === undefined
              ? []
              : (resolveAlias(checker, calleeSymbol).declarations ?? []);
          if (
            declarations.some((declaration) => {
              let implementation;
              if (ts.isFunctionDeclaration(declaration)) {
                implementation = declaration;
              } else if (
                ts.isVariableDeclaration(declaration) &&
                declaration.initializer !== undefined &&
                (ts.isArrowFunction(declaration.initializer) ||
                  ts.isFunctionExpression(declaration.initializer))
              ) {
                implementation = declaration.initializer;
              }
              return (
                implementation !== undefined &&
                functionHasCanonicalSchemaBoundary(
                  checker,
                  proof,
                  implementation
                )
              );
            })
          ) {
            return true;
          }
        }
      }
      return (
        access !== reference &&
        (ts.isPropertyAccessExpression(access) ||
          ts.isElementAccessExpression(access))
      );
    })
  );
};

const isSchemaBoundProjectionContract = (checker, proof, node) => {
  const functionNode = getEnclosingFunctionLike(node);
  if (
    functionNode === undefined ||
    !functionHasCanonicalSchemaBoundary(checker, proof, functionNode)
  ) {
    return false;
  }
  if (functionNode.type !== undefined && isWithin(node, functionNode.type)) {
    return (
      ts.isMethodDeclaration(functionNode) &&
      ts.isPrivateIdentifier(functionNode.name)
    );
  }
  return findContainingParameter(node) === undefined;
};

const isCanonicalVitestObservationContract = (checker, proof, node) => {
  let current = node.parent;
  while (current !== undefined && !ts.isSourceFile(current)) {
    if (ts.isCallExpression(current)) {
      const symbol = checker.getSymbolAtLocation(current.expression);
      if (
        symbol !== undefined &&
        (hasSameDeclaration(checker, symbol, proof.vitestHoistedSymbol) ||
          hasSameDeclaration(checker, symbol, proof.vitestMockSymbol))
      ) {
        return true;
      }
    }
    current = current.parent;
  }
  return false;
};

const getCallRootExpression = (expression) => {
  let current = expression;
  while (
    ts.isCallExpression(current) ||
    ts.isPropertyAccessExpression(current) ||
    ts.isElementAccessExpression(current)
  ) {
    current = current.expression;
  }
  return current;
};

const getImportBinding = (checker, symbol) => {
  for (const declaration of symbol?.declarations ?? []) {
    if (
      !ts.isImportSpecifier(declaration) &&
      !ts.isNamespaceImport(declaration) &&
      !ts.isImportClause(declaration)
    ) {
      continue;
    }
    const importDeclaration = ts.isImportSpecifier(declaration)
      ? declaration.parent.parent.parent
      : ts.isNamespaceImport(declaration)
        ? declaration.parent.parent
        : declaration.parent;
    if (
      !ts.isImportDeclaration(importDeclaration) ||
      !ts.isStringLiteral(importDeclaration.moduleSpecifier)
    ) {
      continue;
    }
    return {
      importedName: ts.isImportSpecifier(declaration)
        ? (declaration.propertyName ?? declaration.name).text
        : ts.isNamespaceImport(declaration)
          ? "*"
          : "default",
      moduleName: importDeclaration.moduleSpecifier.text,
    };
  }
  const resolved =
    symbol === undefined ? undefined : resolveAlias(checker, symbol);
  if (resolved !== undefined && resolved !== symbol) {
    return getImportBinding(checker, resolved);
  }
  return undefined;
};

const isCanonicalTestCall = (checker, proof, call) => {
  const root = getCallRootExpression(call.expression);
  const symbol = checker.getSymbolAtLocation(root);
  let binding = getImportBinding(checker, symbol);
  if (binding === undefined) {
    const parameter = (symbol?.declarations ?? []).find(ts.isParameter);
    const callback = parameter?.parent;
    const layerCall = callback?.parent;
    if (
      callback !== undefined &&
      ts.isFunctionLike(callback) &&
      layerCall !== undefined &&
      ts.isCallExpression(layerCall) &&
      layerCall.arguments.includes(callback)
    ) {
      const layerRoot = getCallRootExpression(layerCall.expression);
      const layerBinding = getImportBinding(
        checker,
        checker.getSymbolAtLocation(layerRoot)
      );
      if (
        layerBinding?.moduleName === "@effect/vitest" &&
        layerBinding.importedName === "layer"
      ) {
        binding = { importedName: "it", moduleName: "@effect/vitest" };
      }
    }
  }
  return (
    binding !== undefined &&
    (binding.moduleName === "vitest" ||
      binding.moduleName === "@effect/vitest") &&
    new Set(["afterEach", "beforeEach", "it", "test"]).has(binding.importedName)
  );
};

const findEnclosingCanonicalTestCall = (checker, proof, node) => {
  let current = node.parent;
  while (current !== undefined && !ts.isSourceFile(current)) {
    if (
      ts.isCallExpression(current) &&
      isCanonicalTestCall(checker, proof, current)
    ) {
      return current;
    }
    current = current.parent;
  }
  return undefined;
};

const declarationIsUsedOnlyFromCanonicalTests = (
  checker,
  proof,
  declaration
) => {
  if (!proof.referenceIndex.complete || declaration.name === undefined) {
    return false;
  }
  const symbol = checker.getSymbolAtLocation(declaration.name);
  if (symbol === undefined) return false;
  const uses = (proof.referenceIndex.references.get(symbol) ?? []).filter(
    (reference) =>
      !isDeclarationName(reference) && !isTypeOnlyReference(reference)
  );
  return (
    uses.length > 0 &&
    uses.every(
      (reference) =>
        findEnclosingCanonicalTestCall(checker, proof, reference) !== undefined
    )
  );
};

const isCanonicalTestObservationContract = (checker, proof, node) => {
  if (findEnclosingCanonicalTestCall(checker, proof, node) !== undefined) {
    return true;
  }
  const functionNode = getEnclosingFunctionLike(node);
  if (
    functionNode === undefined ||
    functionNode.name === undefined ||
    !(
      ts.isFunctionDeclaration(functionNode) ||
      ts.isFunctionExpression(functionNode)
    )
  ) {
    return false;
  }
  return declarationIsUsedOnlyFromCanonicalTests(checker, proof, functionNode);
};

const getEnclosingFunctionLike = (node) => {
  let current = node.parent;
  while (current !== undefined && !ts.isSourceFile(current)) {
    if (ts.isFunctionLike(current)) return current;
    current = current.parent;
  }
  return undefined;
};

const functionHasCanonicalPlatformOrigin = (
  checker,
  proof,
  functionNode,
  seenFunctions = new Set(),
  depth = 0
) => {
  if (
    functionNode === undefined ||
    functionNode.body === undefined ||
    seenFunctions.has(functionNode) ||
    depth > 8
  ) {
    return false;
  }
  seenFunctions.add(functionNode);
  let proven = false;
  const visit = (candidate) => {
    if (proven) return;
    if (candidate !== functionNode && ts.isFunctionLike(candidate)) return;
    if (ts.isNewExpression(candidate)) {
      const symbol = checker.getSymbolAtLocation(candidate.expression);
      if (
        symbol !== undefined &&
        hasSameDeclaration(checker, symbol, proof.eventSourceConstructorSymbol)
      ) {
        proven = true;
        return;
      }
    }
    if (ts.isTypeReferenceNode(candidate)) {
      const symbol = checker.getSymbolAtLocation(candidate.typeName);
      if (
        symbol !== undefined &&
        (hasSameDeclaration(checker, symbol, proof.eventTypeSymbol) ||
          hasSameDeclaration(checker, symbol, proof.messageEventTypeSymbol))
      ) {
        proven = true;
        return;
      }
    }
    if (ts.isCallExpression(candidate)) {
      const symbol = checker.getSymbolAtLocation(candidate.expression);
      const declarations =
        symbol === undefined
          ? []
          : (resolveAlias(checker, symbol).declarations ?? []);
      for (const declaration of declarations) {
        let implementation;
        if (ts.isFunctionDeclaration(declaration)) {
          implementation = declaration;
        } else if (
          ts.isVariableDeclaration(declaration) &&
          declaration.initializer !== undefined &&
          (ts.isArrowFunction(declaration.initializer) ||
            ts.isFunctionExpression(declaration.initializer))
        ) {
          implementation = declaration.initializer;
        }
        if (
          implementation !== undefined &&
          functionHasCanonicalPlatformOrigin(
            checker,
            proof,
            implementation,
            seenFunctions,
            depth + 1
          )
        ) {
          proven = true;
          return;
        }
      }
    }
    ts.forEachChild(candidate, visit);
  };
  visit(functionNode);
  return proven;
};

const isPlatformBoundaryDeclaration = (
  checker,
  proof,
  declaration,
  seenDeclarations = new Set()
) => {
  if (!proof.referenceIndex.complete || seenDeclarations.has(declaration)) {
    return false;
  }
  seenDeclarations.add(declaration);
  const symbol = checker.getSymbolAtLocation(declaration.name);
  if (symbol === undefined) return false;
  for (const reference of proof.referenceIndex.references.get(symbol) ?? []) {
    if (isDeclarationName(reference)) continue;
    const functionNode = getEnclosingFunctionLike(reference);
    if (functionHasCanonicalPlatformOrigin(checker, proof, functionNode)) {
      return true;
    }
    let classNode = reference.parent;
    while (
      classNode !== undefined &&
      !ts.isClassDeclaration(classNode) &&
      !ts.isSourceFile(classNode)
    ) {
      classNode = classNode.parent;
    }
    if (classNode !== undefined && ts.isClassDeclaration(classNode)) {
      for (const clause of classNode.heritageClauses ?? []) {
        for (const heritageType of clause.types) {
          const heritageSymbol = checker.getSymbolAtLocation(
            heritageType.expression
          );
          const target =
            heritageSymbol === undefined
              ? undefined
              : (resolveAlias(checker, heritageSymbol).declarations ?? []).find(
                  (candidate) =>
                    ts.isTypeAliasDeclaration(candidate) ||
                    ts.isInterfaceDeclaration(candidate)
                );
          if (
            target !== undefined &&
            target !== declaration &&
            isPlatformBoundaryDeclaration(
              checker,
              proof,
              target,
              seenDeclarations
            )
          ) {
            return true;
          }
        }
      }
    }
  }
  return false;
};

const isPlatformBoundaryContract = (checker, proof, node) => {
  let current = node;
  while (current !== undefined && !ts.isSourceFile(current)) {
    if (
      (ts.isTypeAliasDeclaration(current) ||
        ts.isInterfaceDeclaration(current)) &&
      isPlatformBoundaryDeclaration(checker, proof, current)
    ) {
      return true;
    }
    if (ts.isClassDeclaration(current)) {
      for (const clause of current.heritageClauses ?? []) {
        for (const heritageType of clause.types) {
          const symbol = checker.getSymbolAtLocation(heritageType.expression);
          const declaration =
            symbol === undefined
              ? undefined
              : (resolveAlias(checker, symbol).declarations ?? []).find(
                  (candidate) =>
                    ts.isTypeAliasDeclaration(candidate) ||
                    ts.isInterfaceDeclaration(candidate)
                );
          if (
            declaration !== undefined &&
            isPlatformBoundaryDeclaration(checker, proof, declaration)
          ) {
            return true;
          }
        }
      }
    }
    current = current.parent;
  }
  return false;
};

const isLiteralSelectorType = (node) => {
  if (ts.isLiteralTypeNode(node)) return true;
  if (ts.isParenthesizedTypeNode(node)) return isLiteralSelectorType(node.type);
  return (
    ts.isUnionTypeNode(node) &&
    node.types.length > 0 &&
    node.types.every(isLiteralSelectorType)
  );
};

const hasRawSemanticContractMember = (members) =>
  members.some((member) => {
    if (!ts.isPropertySignature(member) || member.type === undefined) {
      return false;
    }
    const name = getPropertyName(member.name);
    return (
      name !== undefined &&
      isSemanticName(name) &&
      isRawStringTypeNode(member.type)
    );
  });

const hasLiteralDiscriminant = (members) =>
  members.some(
    (member) =>
      ts.isPropertySignature(member) &&
      member.type !== undefined &&
      isLiteralSelectorType(member.type)
  );

const isCanonicalExtractSelector = (checker, proof, node) => {
  let current = node.parent;
  while (current !== undefined && ts.isTypeNode(current)) {
    if (ts.isTypeReferenceNode(current)) {
      const symbol = checker.getSymbolAtLocation(current.typeName);
      return (
        symbol !== undefined &&
        hasSameDeclaration(checker, symbol, proof.extractTypeSymbol) &&
        current.typeArguments?.[1] !== undefined &&
        isWithin(node, current.typeArguments[1])
      );
    }
    current = current.parent;
  }
  return false;
};

const isClosedTypePredicateContract = (checker, node, members) => {
  let predicate = node.parent;
  while (predicate !== undefined && ts.isTypeNode(predicate)) {
    if (ts.isTypePredicateNode(predicate)) break;
    predicate = predicate.parent;
  }
  if (predicate === undefined || !ts.isTypePredicateNode(predicate)) {
    return false;
  }
  const functionNode = predicate.parent;
  if (!ts.isFunctionLike(functionNode) || functionNode.body === undefined) {
    return false;
  }
  const parameterName = ts.isIdentifier(predicate.parameterName)
    ? predicate.parameterName.text
    : undefined;
  if (parameterName === undefined) return false;
  const checked = new Set();
  const visit = (candidate) => {
    if (
      ts.isBinaryExpression(candidate) &&
      candidate.operatorToken.kind === ts.SyntaxKind.InKeyword &&
      ts.isStringLiteralLike(candidate.left) &&
      ts.isIdentifier(candidate.right) &&
      candidate.right.text === parameterName
    ) {
      checked.add(candidate.left.text);
    }
    if (
      ts.isPropertyAccessExpression(candidate) &&
      ts.isIdentifier(candidate.expression) &&
      candidate.expression.text === parameterName
    ) {
      checked.add(candidate.name.text);
    }
    if (candidate !== functionNode && ts.isFunctionLike(candidate)) return;
    ts.forEachChild(candidate, visit);
  };
  visit(functionNode.body);
  return members.every((member) => {
    if (!ts.isPropertySignature(member) || member.type === undefined) {
      return false;
    }
    const name = getPropertyName(member.name);
    return (
      name !== undefined &&
      (member.questionToken !== undefined ||
        member.type.kind === ts.SyntaxKind.UnknownKeyword ||
        isLiteralSelectorType(member.type) ||
        checked.has(name))
    );
  });
};

const isTypedDiscriminantContract = (checker, proof, node, members) =>
  !hasRawSemanticContractMember(members) &&
  hasLiteralDiscriminant(members) &&
  (isCanonicalExtractSelector(checker, proof, node) ||
    ts.isUnionTypeNode(node.parent));

const isOperationalContract = (
  checker,
  proof,
  owner,
  members,
  seenOwners = new Set()
) => {
  if (seenOwners.has(owner)) return false;
  const nextSeenOwners = new Set(seenOwners).add(owner);
  if (
    ts.isTypeAliasDeclaration(owner) &&
    members.length === 1 &&
    ts.isPropertySignature(members[0]) &&
    hasReadonlyModifier(members[0]) &&
    members[0].questionToken !== undefined &&
    members[0].type !== undefined &&
    ts.isTypeReferenceNode(members[0].type)
  ) {
    return false;
  }
  let hasCapability = false;
  let hasDirectCapability = false;
  let hasExternalRuntimeCapability = false;
  let hasSchemaOwnedValue = false;
  let hasClosedConfigValue = false;
  let schemaOwned = true;
  let hasRawSemanticData = false;
  for (const member of members) {
    if (isCallableMember(member)) {
      hasCapability = true;
      hasDirectCapability = true;
      continue;
    }
    const typeNode = getMemberTypeNode(member);
    if (typeNode === undefined) {
      schemaOwned = false;
      continue;
    }
    let memberType;
    if (isDirectCallableTypeReference(checker, typeNode)) {
      hasCapability = true;
    }
    if (isConcreteClassTypeReference(checker, typeNode)) {
      hasClosedConfigValue = true;
    }
    const referencedDeclaration = getDirectTypeReferenceDeclaration(
      checker,
      typeNode
    );
    const referencedMembers =
      referencedDeclaration === undefined
        ? undefined
        : getContractMembers(referencedDeclaration);
    if (
      referencedDeclaration !== undefined &&
      referencedMembers !== undefined &&
      !referencedDeclaration.getSourceFile().isDeclarationFile &&
      isOperationalContract(
        checker,
        proof,
        referencedDeclaration,
        referencedMembers,
        nextSeenOwners
      )
    ) {
      hasCapability = true;
    }
    const structuralDeclaration = getDirectStructuralTypeDeclaration(
      checker,
      owner.getSourceFile(),
      typeNode
    );
    const structuralMembers =
      structuralDeclaration === undefined
        ? undefined
        : getContractMembers(structuralDeclaration);
    if (
      structuralDeclaration !== undefined &&
      structuralDeclaration !== owner &&
      !structuralDeclaration.getSourceFile().isDeclarationFile &&
      structuralMembers?.some(isCallableMember) === true &&
      !hasCompilerStructuralReferenceCycle(
        checker,
        owner.getSourceFile(),
        structuralDeclaration
      )
    ) {
      hasCapability = true;
    }
    try {
      memberType = checker.getTypeFromTypeNode(typeNode);
    } catch {
      memberType = undefined;
    }
    if (
      memberType !== undefined &&
      !isSchemaValueType(checker, proof, memberType) &&
      typeHasRuntimeCapability(checker, memberType, owner.getSourceFile())
    ) {
      hasCapability = true;
      hasExternalRuntimeCapability = true;
    }
    const owned = isSchemaOwnedDataTypeNode(checker, proof, typeNode);
    schemaOwned &&= owned.owned;
    const memberName = getPropertyName(member.name);
    hasRawSemanticData ||=
      memberName !== undefined &&
      isSemanticName(memberName) &&
      isRawStringTypeNode(typeNode);
    hasSchemaOwnedValue ||= owned.schema;
  }
  return (
    (hasCapability &&
      (!hasRawSemanticData || !hasExportModifier(owner)) &&
      (hasDirectCapability ||
        hasExternalRuntimeCapability ||
        hasSchemaOwnedValue ||
        hasClosedConfigValue)) ||
    (schemaOwned && hasSchemaOwnedValue)
  );
};

const findEnclosingFunctionOrSource = (node) => {
  let current = node.parent;
  while (current !== undefined && !ts.isSourceFile(current)) {
    if (ts.isFunctionLike(current)) return current;
    current = current.parent;
  }
  return current;
};

const isClosedLocalEphemeralContract = (checker, proof, declaration) => {
  if (
    !proof.referenceIndex.complete ||
    hasExportModifier(declaration) ||
    !ts.isTypeLiteralNode(declaration.type) ||
    declaration.type.members.length === 0 ||
    declaration.type.members.some(
      (member) =>
        !ts.isPropertySignature(member) ||
        !hasReadonlyModifier(member) ||
        member.type === undefined
    ) ||
    hasRawSemanticContractMember(declaration.type.members)
  ) {
    return false;
  }
  const symbol = checker.getSymbolAtLocation(declaration.name);
  if (symbol === undefined) return false;
  const references = (proof.referenceIndex.references.get(symbol) ?? []).filter(
    (reference) => !isDeclarationName(reference)
  );
  return (
    references.length > 0 &&
    references.every((reference) => {
      if (reference.getSourceFile() !== declaration.getSourceFile())
        return false;
      const typeReference = reference.parent;
      const typeArgumentCall = typeReference?.parent;
      if (
        typeReference !== undefined &&
        ts.isTypeReferenceNode(typeReference) &&
        typeArgumentCall !== undefined &&
        ts.isCallExpression(typeArgumentCall) &&
        (typeArgumentCall.typeArguments?.indexOf(typeReference) === 4 ||
          typeArgumentCall.typeArguments?.indexOf(typeReference) === 5)
      ) {
        return false;
      }
      const owner = findEnclosingFunctionOrSource(reference);
      return (
        owner !== undefined &&
        !ts.isSourceFile(owner) &&
        (isPrivateFunctionImplementation(owner) ||
          (ts.isMethodDeclaration(owner) &&
            (ts.isPrivateIdentifier(owner.name) ||
              ((ts.isClassDeclaration(owner.parent) ||
                ts.isClassExpression(owner.parent)) &&
                !hasExportModifier(owner.parent)))))
      );
    })
  );
};

const isClosedReadonlyProjectionMap = (checker, proof, declaration) => {
  if (
    !proof.referenceIndex.complete ||
    !ts.isTypeLiteralNode(declaration.type) ||
    declaration.type.members.length === 0 ||
    declaration.type.members.some(
      (member) =>
        !ts.isPropertySignature(member) ||
        !hasReadonlyModifier(member) ||
        member.type === undefined
    ) ||
    hasRawSemanticContractMember(declaration.type.members)
  ) {
    return false;
  }
  const symbol = checker.getSymbolAtLocation(declaration.name);
  if (symbol === undefined) return false;
  const references = (proof.referenceIndex.references.get(symbol) ?? []).filter(
    (reference) => !isDeclarationName(reference)
  );
  return (
    references.length > 0 &&
    references.every((reference) => {
      let current = reference.parent;
      while (
        current !== undefined &&
        !ts.isSatisfiesExpression(current) &&
        !ts.isStatement(current)
      ) {
        current = current.parent;
      }
      return (
        current !== undefined &&
        ts.isSatisfiesExpression(current) &&
        ts.isObjectLiteralExpression(current.expression)
      );
    })
  );
};

const isSchemaDeclaredCapabilityResult = (checker, proof, declaration) => {
  if (
    !proof.referenceIndex.complete ||
    !ts.isTypeLiteralNode(declaration.type) ||
    declaration.type.members.length === 0 ||
    declaration.type.members.some(
      (member) =>
        !ts.isPropertySignature(member) ||
        !hasReadonlyModifier(member) ||
        member.type === undefined
    ) ||
    hasRawSemanticContractMember(declaration.type.members)
  ) {
    return false;
  }
  const resultSymbol = checker.getSymbolAtLocation(declaration.name);
  if (resultSymbol === undefined) return false;
  for (const reference of proof.referenceIndex.references.get(resultSymbol) ??
    []) {
    if (isDeclarationName(reference)) continue;
    let current = reference.parent;
    while (
      current !== undefined &&
      !ts.isFunctionTypeNode(current) &&
      !ts.isTypeAliasDeclaration(current)
    ) {
      current = current.parent;
    }
    if (current === undefined || !ts.isFunctionTypeNode(current)) continue;
    const runnerDeclaration = current.parent;
    if (!ts.isTypeAliasDeclaration(runnerDeclaration)) continue;
    const runnerSymbol = checker.getSymbolAtLocation(runnerDeclaration.name);
    if (runnerSymbol === undefined) continue;
    for (const runnerReference of proof.referenceIndex.references.get(
      runnerSymbol
    ) ?? []) {
      if (isDeclarationName(runnerReference)) continue;
      let call = runnerReference.parent;
      while (
        call !== undefined &&
        !ts.isCallExpression(call) &&
        !ts.isStatement(call)
      ) {
        call = call.parent;
      }
      if (call === undefined || !ts.isCallExpression(call)) continue;
      if (
        call.typeArguments?.some((argument) =>
          isWithin(runnerReference, argument)
        ) !== true
      ) {
        continue;
      }
      const calleeSymbol = checker.getSymbolAtLocation(call.expression);
      if (
        calleeSymbol !== undefined &&
        hasSameDeclaration(checker, calleeSymbol, proof.schemaDeclareSymbol)
      ) {
        return true;
      }
    }
  }
  return false;
};

const createDiagnostic = (cwd, sourceFile, node, rule, message, remedy) => {
  const position = sourceFile.getLineAndCharacterOfPosition(
    node.getStart(sourceFile)
  );
  return {
    column: position.character + 1,
    filePath: path.relative(cwd, sourceFile.fileName).split(path.sep).join("/"),
    line: position.line + 1,
    message,
    remedy,
    rule,
  };
};

const createProgram = (cwd, projectPath) => {
  const config = ts.readConfigFile(projectPath, ts.sys.readFile);
  if (config.error !== undefined) {
    throw new Error(
      ts.flattenDiagnosticMessageText(config.error.messageText, "\n")
    );
  }
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    path.dirname(projectPath)
  );
  const virtualAnchorPath = path.join(
    repoRoot,
    "packages/runtime/src",
    anchorFileName
  );
  const virtualXStateAnchorPath = path.join(
    repoRoot,
    "packages/core/src",
    xstateAnchorFileName
  );
  const virtualSources = new Map([
    [path.resolve(virtualAnchorPath), anchorSource],
    [path.resolve(virtualXStateAnchorPath), xstateAnchorSource],
  ]);
  const host = ts.createCompilerHost(parsed.options, true);
  const originalFileExists = host.fileExists.bind(host);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  const originalReadFile = host.readFile.bind(host);
  host.fileExists = (fileName) =>
    virtualSources.has(path.resolve(fileName)) || originalFileExists(fileName);
  host.readFile = (fileName) =>
    virtualSources.get(path.resolve(fileName)) ?? originalReadFile(fileName);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
    const virtualSource = virtualSources.get(path.resolve(fileName));
    return virtualSource === undefined
      ? originalGetSourceFile(fileName, languageVersion, onError, shouldCreate)
      : ts.createSourceFile(
          fileName,
          virtualSource,
          languageVersion,
          true,
          ts.ScriptKind.TS
        );
  };

  const program = ts.createProgram({
    host,
    options: parsed.options,
    rootNames: [
      ...parsed.fileNames,
      virtualAnchorPath,
      virtualXStateAnchorPath,
    ],
  });
  const anchorFile = program.getSourceFile(virtualAnchorPath);
  const xstateAnchorFile = program.getSourceFile(virtualXStateAnchorPath);
  if (anchorFile === undefined || xstateAnchorFile === undefined) {
    throw new Error("Gaia schema-contract checker could not create its anchor");
  }
  return { anchorFile, program, xstateAnchorFile };
};

/**
 * Analyze one configured TypeScript project for schema-contract ownership.
 *
 * @param {{ cwd: string; includeIgnoredPathsForTesting?: boolean; projectPath: string; provenanceLimits?: Partial<typeof defaultProvenanceLimits> }} options Project, display-root, and optional test-only proof controls.
 * @returns {Array<{ column: number; filePath: string; line: number; message: string; remedy: string; rule: string }>} Compiler-proven schema-contract diagnostics.
 */
export function analyzeSchemaContracts({
  cwd,
  includeIgnoredPathsForTesting = false,
  projectPath,
  provenanceLimits,
}) {
  const { anchorFile, program, xstateAnchorFile } = createProgram(
    cwd,
    projectPath
  );
  const checker = program.getTypeChecker();
  const schemaProof = createSchemaProof(checker, anchorFile, xstateAnchorFile);
  schemaProof.provenanceLimits = provenanceLimits;
  schemaProof.referenceIndex = createProgramReferenceIndex(
    checker,
    program,
    new Set([anchorFile, xstateAnchorFile]),
    includeIgnoredPathsForTesting
  );
  const canonicalBrandMarker = getCanonicalBrandMarker(checker, anchorFile);
  const diagnostics = [];

  for (const sourceFile of program.getSourceFiles()) {
    if (
      sourceFile === anchorFile ||
      sourceFile === xstateAnchorFile ||
      sourceFile.isDeclarationFile ||
      (!includeIgnoredPathsForTesting &&
        isGeneratedFilePath(sourceFile.fileName)) ||
      (!includeIgnoredPathsForTesting &&
        sourceFile.fileName.includes(`${path.sep}node_modules${path.sep}`))
    ) {
      continue;
    }

    const visit = (node) => {
      if (
        (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) &&
        !ts.isConstTypeReference(node.type)
      ) {
        const targetType = checker.getTypeFromTypeNode(node.type);
        if (
          containsCanonicalBrandMarker(
            checker,
            targetType,
            canonicalBrandMarker
          )
        ) {
          diagnostics.push(
            createDiagnostic(
              cwd,
              sourceFile,
              node,
              "gaia/no-brand-cast",
              "Type assertion manufactures a compiler-proven Effect branded value.",
              brandCastRemedy
            )
          );
        }
      }

      if (ts.isTypeAliasDeclaration(node)) {
        const xstateSetupMetadataAlias = isXStateSetupMetadataAlias(
          checker,
          schemaProof,
          node
        );
        const exactXStateSetupMetadataAlias =
          xstateSetupMetadataAlias && hasExactXStateSetupMetadataShape(node);
        const manualTypeLiteral =
          ts.isTypeLiteralNode(node.type) &&
          !isAllCallable(node.type.members) &&
          !isOperationalContract(
            checker,
            schemaProof,
            node,
            node.type.members
          ) &&
          !isFrameworkProps(checker, schemaProof, sourceFile, node) &&
          !isCapabilityWrapperTypeAlias(
            checker,
            schemaProof,
            sourceFile,
            node
          ) &&
          !isClosedLocalEphemeralContract(checker, schemaProof, node) &&
          !isClosedReadonlyProjectionMap(checker, schemaProof, node) &&
          !isSchemaDeclaredCapabilityResult(checker, schemaProof, node) &&
          !isPlatformBoundaryContract(checker, schemaProof, node) &&
          !exactXStateSetupMetadataAlias;
        const invalidXStateSetupMetadataAlias =
          xstateSetupMetadataAlias && !exactXStateSetupMetadataAlias;
        const unprovenProjection =
          isCanonicalProjectionTypeNode(checker, schemaProof, node.type) &&
          !isSchemaDerivedTypeNode(checker, schemaProof, node.type);
        const unprovenSchemaTypeProjection =
          isCanonicalSchemaTypeProjectionCandidate(
            checker,
            schemaProof,
            node.type
          ) && !isSchemaDerivedTypeNode(checker, schemaProof, node.type);
        const unprovenSchemaGeneric =
          hasSchemaOwnerTypeArgument(checker, schemaProof, node.type) &&
          !isSchemaDerivedTypeNode(checker, schemaProof, node.type);
        const unprovenIndexedAccess =
          isSchemaIndexedAccess(checker, schemaProof, node.type) &&
          !isSchemaDerivedTypeNode(checker, schemaProof, node.type);
        const canonicalCrossFileUnionProjection =
          isCanonicalCrossFileUnionDecodedTypeAccess(
            checker,
            schemaProof,
            node.type
          );
        const fakeSchemaType =
          isDecodedTypeAccessCandidate(checker, schemaProof, node.type) &&
          !isSchemaDerivedTypeNode(checker, schemaProof, node.type) &&
          !canonicalCrossFileUnionProjection;

        if (
          manualTypeLiteral ||
          unprovenProjection ||
          unprovenSchemaTypeProjection ||
          unprovenSchemaGeneric ||
          unprovenIndexedAccess ||
          fakeSchemaType ||
          invalidXStateSetupMetadataAlias
        ) {
          diagnostics.push(
            createDiagnostic(
              cwd,
              sourceFile,
              node.name,
              "gaia/schema-first-data-contract",
              "Serializable data contract has no compiler-proven Schema origin.",
              schemaFirstRemedy
            )
          );
        }
      }

      if (
        ts.isInterfaceDeclaration(node) &&
        !isAllCallable(node.members) &&
        !isOperationalContract(checker, schemaProof, node, node.members) &&
        !isFrameworkProps(checker, schemaProof, sourceFile, node) &&
        !isPlatformBoundaryContract(checker, schemaProof, node)
      ) {
        diagnostics.push(
          createDiagnostic(
            cwd,
            sourceFile,
            node.name,
            "gaia/schema-first-data-contract",
            "Serializable data contract has no compiler-proven Schema origin.",
            schemaFirstRemedy
          )
        );
      }

      if (
        ts.isTypeLiteralNode(node) &&
        !ts.isTypeAliasDeclaration(node.parent) &&
        !ts.isIntersectionTypeNode(node.parent) &&
        !isCanonicalProjectionSelectorTypeLiteral(
          checker,
          schemaProof,
          sourceFile,
          node
        ) &&
        !isFrameworkTypeLiteral(checker, schemaProof, sourceFile, node) &&
        !isCanonicalVitestObservationContract(checker, schemaProof, node) &&
        !isCanonicalTestObservationContract(checker, schemaProof, node) &&
        !isSchemaBoundProjectionContract(checker, schemaProof, node) &&
        !isTypedDiscriminantContract(
          checker,
          schemaProof,
          node,
          node.members
        ) &&
        !isClosedTypePredicateContract(checker, node, node.members) &&
        !isNonEscapingParameterContract(checker, schemaProof, node) &&
        !isSchemaBoundOperationParameterContract(checker, schemaProof, node) &&
        !isPlatformBoundaryContract(checker, schemaProof, node) &&
        !isOperationalContract(checker, schemaProof, node, node.members) &&
        !isAllCallable(node.members)
      ) {
        diagnostics.push(
          createDiagnostic(
            cwd,
            sourceFile,
            node,
            "gaia/schema-first-data-contract",
            "Nested operation data contract has no compiler-proven Schema origin.",
            schemaFirstRemedy
          )
        );
      }

      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  return diagnostics.sort(
    (left, right) =>
      left.filePath.localeCompare(right.filePath) ||
      left.line - right.line ||
      left.column - right.column ||
      left.rule.localeCompare(right.rule)
  );
}

const isMain =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  const cwd = process.cwd();
  const projectPath = path.resolve(cwd, process.argv[2] ?? "tsconfig.json");
  const diagnostics = analyzeSchemaContracts({ cwd, projectPath });
  for (const diagnostic of diagnostics) {
    process.stdout.write(
      `${diagnostic.filePath}:${diagnostic.line}:${diagnostic.column} ${diagnostic.rule} ${diagnostic.message} Remedy: ${diagnostic.remedy}\n`
    );
  }
  process.exitCode = diagnostics.length === 0 ? 0 : 1;
}
